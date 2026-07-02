/**
 * #188 (Bun-lane fix round 1, triage of run 28607626868) — Bun keep-alive guard.
 *
 * Bucket 1 (30/39 bun-lane failures) was `FetchError: … socket hang up` on
 * specific requests against the standalone server booted under Bun. The
 * cache-control-normalize preload was EXONERATED by the one-flag discriminator
 * (KNEXT_CACHE_CONTROL_NORMALIZE=0 reproduced the identical hang-ups). The real
 * cause, isolated to a dependency-free plain `node:http` repro:
 *
 *   Bun ≤1.3.14 (linux + darwin) resets a REUSED keep-alive socket when the
 *   next request arrives immediately after the previous response completed —
 *   the client (node-fetch@2 over Node's keep-alive globalAgent, i.e. exactly
 *   the official harness's fetchViaHTTP) sees ECONNRESET → "socket hang up".
 *   Single requests and delayed reuse (≥~50ms) succeed; Bun canary 1.4.0 is
 *   fixed. Small/fast responses (tiny 404s, draft-mode enables, header dumps,
 *   SVG assets) lose the race — matching the failing families exactly.
 *
 * Mitigation (this module): under affected Bun versions only, advertise
 * `Connection: close` on every response so well-behaved clients never reuse
 * the socket. Node is NEVER patched — the Node lane's serving bytes stay
 * byte-identical.
 */

import { Agent, createServer, get as httpGet } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const MODULE_PATH = resolve(
    import.meta.dirname,
    "../adapters/bun-keepalive-guard.cjs",
);

// biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
const mod: any = require(MODULE_PATH);

describe("bun-keepalive-guard — version/env gating (shouldInstall)", () => {
    it("installs on affected Bun versions (≤1.3.x)", () => {
        expect(mod.shouldInstall({}, { bun: "1.3.14" })).toBe(true);
        expect(mod.shouldInstall({}, { bun: "1.3.5" })).toBe(true);
        expect(mod.shouldInstall({}, { bun: "1.2.0" })).toBe(true);
    });

    it("never installs under Node (no bun version present)", () => {
        expect(mod.shouldInstall({}, {})).toBe(false);
        expect(mod.shouldInstall({}, undefined)).toBe(false);
        // even when force-enabled: the guard is a Bun mitigation, never Node
        expect(mod.shouldInstall({ KNEXT_BUN_KEEPALIVE_GUARD: "1" }, {})).toBe(
            false,
        );
    });

    it("self-disables on fixed Bun versions (≥1.4.0 — verified on canary 1.4.0)", () => {
        expect(mod.shouldInstall({}, { bun: "1.4.0" })).toBe(false);
        expect(mod.shouldInstall({}, { bun: "2.0.1" })).toBe(false);
    });

    it("assumes affected when the Bun version is unparseable (fail-safe)", () => {
        expect(mod.shouldInstall({}, { bun: "weird" })).toBe(true);
    });

    it("honors the kill switch KNEXT_BUN_KEEPALIVE_GUARD=0", () => {
        expect(
            mod.shouldInstall(
                { KNEXT_BUN_KEEPALIVE_GUARD: "0" },
                { bun: "1.3.14" },
            ),
        ).toBe(false);
    });

    it("honors the force switch KNEXT_BUN_KEEPALIVE_GUARD=1 on fixed Bun versions", () => {
        expect(
            mod.shouldInstall(
                { KNEXT_BUN_KEEPALIVE_GUARD: "1" },
                { bun: "9.9.9" },
            ),
        ).toBe(true);
    });
});

describe("bun-keepalive-guard — preload side effect is Node-inert", () => {
    it("does not patch http.createServer when required under Node", () => {
        // The module was required at the top of this file under Node (vitest):
        // the exported symbol marker must NOT be present on node:http.
        const http = require("node:http");
        expect(http[Symbol.for("knext.bunKeepaliveGuard.installed")]).toBe(
            undefined,
        );
    });
});

function requestOnce(
    port: number,
    agent: Agent,
): Promise<{ status: number; connection: string | undefined; body: string }> {
    return new Promise((resolvePromise, reject) => {
        const req = httpGet(
            { host: "127.0.0.1", port, path: "/", agent },
            (res) => {
                let body = "";
                res.on("data", (c) => {
                    body += c;
                });
                res.on("end", () =>
                    resolvePromise({
                        status: res.statusCode ?? 0,
                        connection: res.headers.connection,
                        body,
                    }),
                );
            },
        );
        req.on("error", reject);
    });
}

describe("bun-keepalive-guard — guardServer behavior (real node:http server)", () => {
    it("advertises Connection: close on every response, before the app handler runs", async () => {
        const srv = mod.guardServer(
            createServer((_req, res) => {
                res.writeHead(200, { "content-length": "2" });
                res.end("ok");
            }),
        );
        await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
        const port = (srv.address() as AddressInfo).port;
        const agent = new Agent({ keepAlive: true, maxSockets: 1 });
        try {
            // sequential immediate reuse — the exact Bucket-1 client shape
            const first = await requestOnce(port, agent);
            const second = await requestOnce(port, agent);
            expect(first.status).toBe(200);
            expect(first.connection).toBe("close");
            expect(first.body).toBe("ok");
            expect(second.status).toBe(200);
            expect(second.connection).toBe("close");
        } finally {
            agent.destroy();
            await new Promise((r) => srv.close(r));
        }
    });

    it("lets an app handler that explicitly sets Connection win (guard runs first)", async () => {
        const srv = mod.guardServer(
            createServer((_req, res) => {
                res.setHeader("Connection", "keep-alive");
                res.end("ok");
            }),
        );
        await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
        const port = (srv.address() as AddressInfo).port;
        const agent = new Agent({ keepAlive: true, maxSockets: 1 });
        try {
            const res = await requestOnce(port, agent);
            expect(res.connection).toBe("keep-alive");
        } finally {
            agent.destroy();
            await new Promise((r) => srv.close(r));
        }
    });
});

describe("bun-keepalive-guard — runtime wiring", () => {
    it("node-server.ts loads the guard preload only under Bun", () => {
        const { readFileSync } = require("node:fs");
        const src = readFileSync(
            resolve(import.meta.dirname, "../adapters/node-server.ts"),
            "utf8",
        );
        expect(src).toContain("bun-keepalive-guard.cjs");
        expect(src).toContain("process.versions.bun");
    });
});
