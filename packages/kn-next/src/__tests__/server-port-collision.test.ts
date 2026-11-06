/**
 * Spawned-server specs flaked with `server exited before ready (code=0
 * signal=null)` and an empty server log.
 *
 * Cause: the Nitro node/bun server (srvx) starts with `this.serve().catch(() =>
 * {})`, so an EADDRINUSE on listen is swallowed. Nothing is left keeping the
 * event loop alive and the process exits 0, printing nothing. The specs chose
 * their port as `20000 + random * 20000`: 36% of that range is the Linux
 * ephemeral range (32768-60999), where any outbound socket (a package fetch,
 * a build step) may hold the port. Both failing ports in CI were in it
 * (35728, 35638).
 *
 * Two guards: specs pick ports with `pickServerPort` (below the ephemeral range,
 * verified bindable), and a silent exit is diagnosed with the port's state
 * rather than reported as a bare "code=0".
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
    type BindOutcome,
    canBind,
    pickServerPort,
    tryBind,
} from "./helpers/free-port";
import { waitForHttpOk } from "./helpers/wait-for-http-ok";

const holders: Server[] = [];
afterEach(() => {
    for (const h of holders.splice(0)) h.close();
});

/**
 * Hold a port the way another process's listener or outbound socket would, on
 * the wildcard (`::`, or `0.0.0.0` where IPv6 is disabled). Returns the host.
 */
async function hold(port: number): Promise<string> {
    for (const host of ["::", "0.0.0.0"]) {
        const s = createServer();
        const bound = await new Promise<boolean>((resolve) => {
            s.once("error", () => resolve(false));
            s.listen({ port, host }, () => resolve(true));
        });
        if (bound) {
            holders.push(s);
            return host;
        }
    }
    throw new Error(`could not hold port ${port}`);
}

const rejection = (p: Promise<unknown>) =>
    p.then(
        () => undefined,
        (e: Error) => e,
    );

const alwaysFree = async () => true;

describe("pickServerPort", () => {
    it("never picks from the Linux ephemeral range, for any process or draw", async () => {
        // Distinct slices (pid % 64), since a port is handed out once.
        for (const pid of [0, 1, 63, 12345, 99999]) {
            for (const r of [0, 0.5, 0.999999]) {
                const port = await pickServerPort({
                    pid,
                    random: () => r,
                    isFree: alwaysFree,
                });
                expect(port).toBeGreaterThanOrEqual(20000);
                expect(port).toBeLessThan(32768);
            }
        }
    });

    it("concurrent test processes draw from different slices", async () => {
        const a = await pickServerPort({
            pid: 1000,
            random: () => 0.5,
            isFree: alwaysFree,
        });
        const b = await pickServerPort({
            pid: 1001,
            random: () => 0.5,
            isFree: alwaysFree,
        });
        expect(a).not.toBe(b);
        // Slices are disjoint: the top of one never reaches the bottom of the next.
        const top = await pickServerPort({
            pid: 2,
            random: () => 0.999999,
            isFree: alwaysFree,
        });
        const bottom = await pickServerPort({
            pid: 3,
            random: () => 0,
            isFree: alwaysFree,
        });
        expect(top).toBeLessThan(bottom);
    });

    it("skips a port that is already held and takes the next free draw", async () => {
        // pid 0 is the first slice: base 20000, 199 wide. Draw 0.1 -> 20019.
        const busy = 20000 + Math.floor(0.1 * 199);
        await hold(busy);
        const draws = [0.1, 0.7];
        const port = await pickServerPort({
            pid: 0,
            random: () => draws.shift() ?? 0.7,
        });
        expect(port).not.toBe(busy);
        expect(draws).toEqual([]);
    });

    it("does not hand the same port out twice in one process", async () => {
        const first = await pickServerPort({
            pid: 5,
            random: () => 0.33,
            isFree: alwaysFree,
        });
        const seq = [0.33, 0.34];
        const second = await pickServerPort({
            pid: 5,
            random: () => seq.shift() ?? 0.35,
            isFree: alwaysFree,
        });
        expect(second).not.toBe(first);
    });

    it("gives up loudly after bounded attempts instead of looping", async () => {
        const err = await rejection(
            pickServerPort({
                random: () => 0.2,
                attempts: 3,
                isFree: async () => false,
            }),
        );
        expect(err?.message).toMatch(/no free port/);
    });
});

describe("canBind", () => {
    const script =
        (v6: BindOutcome, v4: BindOutcome) =>
        async (_port: number, host: string): Promise<BindOutcome> =>
            host === "::" ? v6 : v4;

    it("falls back to 0.0.0.0 when IPv6 is unavailable instead of reading every port as taken", async () => {
        expect(await canBind(1, script("unsupported", "ok"))).toBe(true);
    });

    it("still reports a port taken on 0.0.0.0 when IPv6 is unavailable", async () => {
        expect(await canBind(1, script("unsupported", "busy"))).toBe(false);
    });

    it("does not fall back when :: itself reports the port busy", async () => {
        const tried: string[] = [];
        const ok = await canBind(1, async (_p, host) => {
            tried.push(host);
            return "busy";
        });
        expect(ok).toBe(false);
        expect(tried).toEqual(["::"]);
    });

    it("classifies a real held port as busy", async () => {
        const port = await pickServerPort();
        const host = await hold(port);
        expect(await tryBind(port, host)).toBe("busy");
        expect(await canBind(port)).toBe(false);
    });
});

describe("silent exit diagnosis", () => {
    // A server that swallows its own listen error, as srvx does: when the
    // port is taken it has no handles left and exits 0 with no output.
    const swallowListenError = (port: number, host: string) =>
        spawn(
            "node",
            [
                "-e",
                `const s=require("net").createServer();s.on("error",()=>{});s.listen({port:${port},host:"${host}"})`,
            ],
            { stdio: "ignore" },
        );

    async function run(port: number, host: string) {
        const child = swallowListenError(port, host);
        let exited: string | null = null;
        child.on("exit", (code, signal) => {
            exited = `code=${code} signal=${signal}`;
        });
        try {
            return await rejection(
                waitForHttpOk(`http://127.0.0.1:${port}/`, {
                    deadlineMs: 20_000,
                    intervalMs: 50,
                    // The holder accepts the probe and never answers it.
                    probeTimeoutMs: 300,
                    log: () => "",
                    exited: () => exited,
                }),
            );
        } finally {
            child.kill("SIGKILL");
        }
    }

    it("a swallowed EADDRINUSE says the port is held by another process", async () => {
        const port = await pickServerPort();
        const host = await hold(port);
        const err = await run(port, host);
        expect(err?.message).toContain("server exited before ready (code=0");
        expect(err?.message).toContain(
            `port ${port} is held by another process`,
        );
        // Under the 5 s default probe timeout: the exit is seen after the
        // 300 ms probe, not after a full default probe.
    }, 4_000);

    it("a silent exit on a free port does not claim a collision", async () => {
        const port = await pickServerPort();
        // Free port: the child would listen fine, so fake the exit state
        // instead of racing a real server.
        const err = await rejection(
            waitForHttpOk(`http://127.0.0.1:${port}/`, {
                deadlineMs: 5_000,
                intervalMs: 10,
                log: () => "",
                exited: () => "code=0 signal=null",
            }),
        );
        expect(err?.message).toContain("printed no output");
        expect(err?.message).toContain(`port ${port} is free now`);
        expect(err?.message).not.toContain("held by another process");
    });

    it("keeps the server log when there is one, with no silent-exit hint", async () => {
        const port = await pickServerPort();
        const err = await rejection(
            waitForHttpOk(`http://127.0.0.1:${port}/`, {
                deadlineMs: 5_000,
                intervalMs: 10,
                log: () => "boom: something real\n",
                exited: () => "code=1 signal=null",
            }),
        );
        expect(err?.message).toContain("--- server output ---");
        expect(err?.message).toContain("boom: something real");
        expect(err?.message).not.toContain("printed no output");
    });
});

describe("no spec draws a server port at random", () => {
    // Scan the whole directory rather than listing the known specs, so a new
    // spec that spells the draw differently is still caught. A random draw
    // near a port (same statement, or a 4+ digit multiplier) is the pattern.
    const dir = import.meta.dir;
    const self = "server-port-collision.test.ts";
    const specs = readdirSync(dir).filter((f) =>
        /\.test\.[cm]?[jt]sx?$/.test(f),
    );

    /** Offending lines of `src`, judged with a few lines of context. */
    function randomPortDraws(src: string): string[] {
        const lines = src.split("\n");
        const hits: string[] = [];
        lines.forEach((line, i) => {
            if (!/Math\.random\(\)/.test(line)) return;
            const near = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
            if (
                /Math\.random\(\)\s*\*\s*\(?\s*\d{4,}/.test(line) ||
                /\d{4,}\s*\+[^\n]*Math\.random\(\)/.test(line) ||
                /\bport\b/i.test(near)
            )
                hits.push(`${i + 1}: ${line.trim()}`);
        });
        return hits;
    }

    it("scans a non-trivial set of specs", () => {
        expect(specs.length).toBeGreaterThan(50);
    });

    it("the detector flags differently-spelled port draws", () => {
        for (const draw of [
            "const port = 20000 + Math.floor(Math.random() * 20000);",
            "const p = Math.round(Math.random() * 9999) + 30000;",
            "const p = Math.floor(30000 + Math.random() * (5000));",
            "const listenOn =\n  Math.random() > 0.5 ? 1 : 2;\nconst port = 3;",
        ])
            expect(randomPortDraws(draw).length).toBeGreaterThan(0);
        expect(
            randomPortDraws("const id = Math.random().toString(36);"),
        ).toEqual([]);
    });

    it("no spec in the directory draws a port from Math.random", () => {
        const offenders = specs
            .filter((f) => f !== self)
            .flatMap((f) =>
                randomPortDraws(readFileSync(join(dir, f), "utf8")).map(
                    (h) => `${f}:${h}`,
                ),
            );
        expect(offenders).toEqual([]);
    });

    it("a spec that hands the server a port (NITRO_PORT) takes it from pickServerPort", () => {
        const offenders = specs.filter((f) => {
            if (f === self) return false;
            const src = readFileSync(join(dir, f), "utf8");
            return /NITRO_PORT/.test(src) && !/pickServerPort\(/.test(src);
        });
        expect(offenders).toEqual([]);
    });
});
