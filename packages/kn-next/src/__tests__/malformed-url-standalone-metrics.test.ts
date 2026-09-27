/**
 * #1313 — does a malformed request URL crash the STANDALONE-cell supervisor?
 *
 * malformed-url-guard.test.ts hardens the vinext entries against h3's
 * `decodeURI`-on-the-path crash (both the node and the compiled-bun cells).
 * This file answers the same question for the OTHER two shipped cells —
 * standalone-on-node and standalone-on-bun/compiled — which do not go through
 * h3/srvx at all: `node-server.ts` spawns Next's own `server.js` for the app
 * port (Next's router already answers a malformed path with its own 404/400
 * and keeps serving — not knext's code to guard), and runs its OWN `:9464`
 * metrics listener via `createLazyMetricsEndpoint`
 * (`../adapters/deferred-supervisor-init.ts`), which IS knext's code and had
 * never been driven with a malformed/odd-target corpus directly.
 *
 * By inspection `createSupervisorMetricsHandler` (`../adapters/metrics.ts`)
 * matches the request target with a plain `req.url === "/metrics"` string
 * compare — never a `new URL(req.url)` parse — so it should already be safe.
 * This proves it behaviourally, under a REAL spawned process, on BOTH
 * runtimes the supervisor ships on (node-server.ts runs under node for the
 * standalone-on-node image and under bun for the standalone-on-bun/compiled
 * image — see its `process.versions.bun` branch).
 *
 * The CURRENT source is bundled fresh with `Bun.build` (target "node") so the
 * bundle runs unmodified under both `node` and `bun` — the same technique
 * malformed-url-guard.test.ts uses to prove the vinext guard survives
 * rolldown's minifier, applied here to prove the standalone listener's
 * behaviour is what ships, not a hand-copied stand-in.
 *
 * The wiring half of this claim — "no shipped node:http handler anywhere in
 * packages/kn-next/src/adapters parses the request target with `new URL`" —
 * is already asserted by malformed-url-guard.test.ts's
 * "no shipped node:http handler parses the request target with new URL"
 * scan, which covers this whole directory (so a FUTURE regression here fails
 * there too, before it needs a live boot to notice). This file is the live,
 * behavioural half for the ONE listener knext's standalone supervisor ships.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const HARNESS = join(HERE, "fixtures/standalone-metrics-endpoint-harness.mjs");
const SOURCE = join(
    REPO_ROOT,
    "packages/kn-next/src/adapters/deferred-supervisor-init.ts",
);

const tmp = mkdtempSync(join(tmpdir(), "knext-standalone-metrics-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Bundle the CURRENT source once for the whole file — target "node" so the
// output resolves and runs unmodified under plain `node` (Bun's bundler
// resolves the TS source's extensionless relative imports; node's own ESM
// resolver cannot), and under `bun` too (a "node"-target ESM bundle is plain
// JS, runtime-agnostic).
const build = await Bun.build({
    entrypoints: [SOURCE],
    target: "node",
    format: "esm",
    outdir: join(tmp, "bundle"),
});
if (!build.success) {
    throw new AggregateError(
        build.logs,
        "failed to bundle deferred-supervisor-init.ts",
    );
}
const BUNDLE = build.outputs[0]?.path;
if (!BUNDLE) throw new Error("Bun.build produced no output");

/** Paths `decodeURI` rejects, plus the query/oversized cases from #1313. */
const MALFORMED = ["/%2/", "/%E0%A4%A/", "/%", "/%%", "/ok/%zz", "/?q=%"];
/** Request TARGETS `node:http` accepts but a naive `new URL(req.url)` throws on. */
const ODD_TARGETS = ["//", "///", "//metrics", "http://[", "http://"];
/** A 1 MiB request path — larger than node's default 16 KiB header limit. */
const HUGE_PATH = `/${"a".repeat(1024 * 1024)}`;

type Booted = { exited: () => string | null; stop: () => void };

function boot(bin: string): Promise<Booted & { port: number }> {
    return new Promise((resolveBoot, rejectBoot) => {
        const child = spawn(bin, [HARNESS], {
            env: { ...process.env, BUNDLE },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let exited: string | null = null;
        child.on("exit", (code, signal) => {
            exited = `exit ${code ?? signal}`;
        });
        const onData = (d: Buffer) => {
            out += d.toString();
            const m = out.match(/LISTENING:(\d+)/);
            if (m) {
                resolveBoot({
                    port: Number(m[1]),
                    exited: () => exited,
                    stop: () => child.kill("SIGKILL"),
                });
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        setTimeout(
            () => rejectBoot(new Error(`harness did not boot: ${out}`)),
            20_000,
        );
    });
}

/** One raw HTTP/1.1 GET — a client library would normalise the target first. */
function rawGet(
    port: number,
    target: string,
): Promise<{ status: number; connectionError: boolean }> {
    return new Promise((resolveGet) => {
        const s = net.connect(port, "127.0.0.1", () =>
            s.write(
                `GET ${target} HTTP/1.1\r\nHost: app.local\r\nConnection: close\r\n\r\n`,
            ),
        );
        let buf = "";
        s.on("data", (d) => {
            buf += d;
        });
        const done = (connectionError: boolean) => {
            const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
            resolveGet({ status: m ? Number(m[1]) : 0, connectionError });
        };
        s.on("close", () => done(false));
        s.on("error", () => resolveGet({ status: 0, connectionError: true }));
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RUNTIMES = [
    { name: "node", bin: "node" },
    // This suite runs under bun, so bun is always available: the bun half runs
    // unconditionally, with the running binary — same discipline as
    // malformed-url-guard.test.ts's live-server RUNTIMES loop.
    { name: "bun", bin: process.execPath },
];

for (const rt of RUNTIMES) {
    describe(`the standalone supervisor's :9464 endpoint under ${rt.name}`, () => {
        it("answers 404 for every malformed/odd target, keeps serving, and the process stays up", async () => {
            const srv = await boot(rt.bin);
            try {
                for (const target of [...MALFORMED, ...ODD_TARGETS]) {
                    const res = await rawGet(srv.port, target);
                    expect({ target, status: res.status }).toEqual({
                        target,
                        status: 404,
                    });
                    await sleep(50);
                    expect({ target, exited: srv.exited() }).toEqual({
                        target,
                        exited: null,
                    });
                }
                // The server is still accepting connections after the whole
                // corpus — the direct "keeps serving" proof.
                const after = await rawGet(srv.port, "/other");
                expect(after.status).toBe(404);
            } finally {
                srv.stop();
            }
        }, 60_000);

        it("a request line far past node's own header-size limit neither hangs nor crashes the process", async () => {
            const srv = await boot(rt.bin);
            try {
                // No status assertion: node/bun may answer 431, reset the
                // connection, or simply close it — all acceptable, NONE of
                // them may hang the client or take the process down.
                await rawGet(srv.port, HUGE_PATH);
                await sleep(200);
                expect(srv.exited()).toBeNull();
                expect((await rawGet(srv.port, "/other")).status).toBe(404);
            } finally {
                srv.stop();
            }
        }, 60_000);
    });
}

// CONTROL: the corpus this file sends is only meaningful if it can fail a
// listener that DOES parse the request target with `new URL` — the exact
// pre-#1313-fix shape the vinext node entry's own :9464 listener used to have
// (see malformed-url-guard.test.ts's control block for that listener). Proves
// this file's harness and corpus can see red, not just green.
describe("control: a naive new URL(req.url) listener", () => {
    it("throws on an odd request target", async () => {
        const script = [
            "const { createServer } = require('node:http');",
            "const srv = createServer((req, res) => {",
            "  const u = new URL(req.url, 'http://x');",
            "  res.writeHead(u.pathname === '/metrics' ? 200 : 404).end();",
            "});",
            "srv.listen(0, '127.0.0.1', () => console.log('LISTENING:' + srv.address().port));",
        ].join("\n");
        const tmpScript = join(tmp, "control.cjs");
        await Bun.write(tmpScript, script);
        const srv = await boot0(tmpScript);
        try {
            const res = await rawGet(srv.port, "//");
            // node:http itself catches the thrown error and answers 400 (it
            // is the http module's `clientError`/`Connection` handling, not
            // application code) — the point this control proves is narrower
            // and still holds: the naive handler's OWN response never
            // completes for this target the way the real listener's does
            // (a clean 404 from application code), so the corpus is capable
            // of telling the two apart.
            expect(res.status).not.toBe(404);
        } finally {
            srv.stop();
        }
    }, 20_000);
});

function boot0(script: string): Promise<Booted & { port: number }> {
    return new Promise((resolveBoot, rejectBoot) => {
        const child = spawn(process.execPath, [script], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let exited: string | null = null;
        child.on("exit", (code, signal) => {
            exited = `exit ${code ?? signal}`;
        });
        const onData = (d: Buffer) => {
            out += d.toString();
            const m = out.match(/LISTENING:(\d+)/);
            if (m) {
                resolveBoot({
                    port: Number(m[1]),
                    exited: () => exited,
                    stop: () => child.kill("SIGKILL"),
                });
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        setTimeout(
            () => rejectBoot(new Error(`control harness did not boot: ${out}`)),
            20_000,
        );
    });
}

describe("the wiring: this module is the one node-server.ts uses", () => {
    it("node-server.ts imports createLazyMetricsEndpoint from ./deferred-supervisor-init", async () => {
        const src = await Bun.file(
            join(REPO_ROOT, "packages/kn-next/src/adapters/node-server.ts"),
        ).text();
        expect(src).toMatch(
            /import\s*\{[^}]*createLazyMetricsEndpoint[^}]*\}\s*from\s*["']\.\/deferred-supervisor-init["']/,
        );
    });
});
