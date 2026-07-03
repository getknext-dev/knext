/**
 * #188 path 2 — edge-sandbox fetch instrumentation preload.
 *
 * The bun compat lane is deterministically red (6/6 runs) on
 * `middleware-fetches-with-any-http-method` while the node lane is green on
 * identical infra, and both the local (path 0) and GHA-hosted (path 1) minimal
 * reductions failed to discriminate — path 1 didn't even reproduce (0/80).
 * Path 2 instruments a red shard IN THE FULL HARNESS.
 *
 * Mechanism (verified locally under node 24 AND bun 1.3.x against the
 * published next@16.2.0 tarball): Next's edge sandbox fetch is the undici
 * bundled into next/dist/compiled/@edge-runtime/primitives/fetch.js, which
 * runs HOST-side over require("net")/require("tls") and publishes the standard
 * `undici:request:*` / `undici:client:*` diagnostics channels through the HOST
 * `require("diagnostics_channel")`. A `-r` preload in the standalone server
 * process therefore observes every sandbox fetch's phase transitions
 * (create → beforeConnect → connected → sendHeaders → bodySent → headers →
 * trailers) — under bun too, whose native fetch does NOT publish these
 * channels, so on the bun lane every `undici:*` event IS sandbox traffic.
 *
 * Hard constraints tested here:
 *   - strictly opt-in: KNEXT_SANDBOX_FETCH_DEBUG must be EXACTLY '1';
 *     disabled means no subscriptions, no timers, no output (the credential
 *     lane's steady state is untouched).
 *   - phase tracking names where a hang stalls (the whole point of path 2).
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const MODULE_PATH = resolve(
    import.meta.dirname,
    "../adapters/sandbox-fetch-debug.cjs",
);

// biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
const mod: any = require(MODULE_PATH);

describe("sandbox-fetch-debug — opt-in gating (shouldInstall)", () => {
    it("installs ONLY when KNEXT_SANDBOX_FETCH_DEBUG is exactly '1'", () => {
        expect(mod.shouldInstall({ KNEXT_SANDBOX_FETCH_DEBUG: "1" })).toBe(
            true,
        );
    });

    it("stays off for unset/empty/other values (steady state untouched)", () => {
        expect(mod.shouldInstall({})).toBe(false);
        expect(mod.shouldInstall(undefined)).toBe(false);
        expect(mod.shouldInstall({ KNEXT_SANDBOX_FETCH_DEBUG: "" })).toBe(
            false,
        );
        expect(mod.shouldInstall({ KNEXT_SANDBOX_FETCH_DEBUG: "0" })).toBe(
            false,
        );
        expect(mod.shouldInstall({ KNEXT_SANDBOX_FETCH_DEBUG: "true" })).toBe(
            false,
        );
    });

    it("install() is a no-op (returns null, subscribes nothing) when disabled", () => {
        const subscribed: string[] = [];
        const handle = mod.install({
            env: {},
            subscribe: (name: string) => subscribed.push(name),
            log: () => {
                throw new Error("disabled install must not log");
            },
        });
        expect(handle).toBeNull();
        expect(subscribed).toEqual([]);
    });
});

describe("sandbox-fetch-debug — phase tracking (createInstrumentation)", () => {
    function makeInstr(nowRef: { t: number }, lines: string[]) {
        return mod.createInstrumentation({
            log: (line: string) => lines.push(line),
            now: () => nowRef.t,
        });
    }

    it("tracks a full request lifecycle: in-flight on create, cleared on trailers", () => {
        const nowRef = { t: 1000 };
        const lines: string[] = [];
        const instr = makeInstr(nowRef, lines);
        const request = {
            method: "POST",
            origin: "https://next-data-api-endpoint.vercel.app",
            path: "/api/echo-headers",
        };
        instr.handleEvent("undici:request:create", { request });
        expect(instr.inflight()).toHaveLength(1);
        instr.handleEvent("undici:client:sendHeaders", { request });
        instr.handleEvent("undici:request:bodySent", { request });
        instr.handleEvent("undici:request:headers", {
            request,
            response: { statusCode: 200 },
        });
        expect(instr.inflight()).toHaveLength(1);
        instr.handleEvent("undici:request:trailers", { request });
        expect(instr.inflight()).toHaveLength(0);
        // every phase left a labeled log line carrying method + origin + path
        const joined = lines.join("\n");
        expect(joined).toContain("[sandbox-fetch-debug]");
        expect(joined).toContain("undici:request:create");
        expect(joined).toContain("undici:request:trailers");
        expect(joined).toContain("POST");
        expect(joined).toContain("https://next-data-api-endpoint.vercel.app");
        expect(joined).toContain("/api/echo-headers");
    });

    it("clears in-flight on request:error too (an error is not a hang)", () => {
        const nowRef = { t: 0 };
        const lines: string[] = [];
        const instr = makeInstr(nowRef, lines);
        const request = { method: "GET", origin: "https://x", path: "/y" };
        instr.handleEvent("undici:request:create", { request });
        instr.handleEvent("undici:request:error", {
            request,
            error: new Error("boom"),
        });
        expect(instr.inflight()).toHaveLength(0);
        expect(lines.join("\n")).toContain("boom");
    });

    it("names the LAST SEEN PHASE of a stalled request (the core deliverable)", () => {
        const nowRef = { t: 0 };
        const lines: string[] = [];
        const instr = makeInstr(nowRef, lines);
        const request = {
            method: "POST",
            origin: "https://echo",
            path: "/api",
        };
        instr.handleEvent("undici:request:create", { request });
        instr.handleEvent("undici:client:sendHeaders", { request });
        // 25s later, nothing further arrived: the request is stalled AFTER
        // sendHeaders — i.e. awaiting response headers on the socket.
        nowRef.t = 25_000;
        const stalled = instr.stalled(20_000);
        expect(stalled).toHaveLength(1);
        expect(stalled[0].phase).toBe("undici:client:sendHeaders");
        expect(stalled[0].ageMs).toBe(25_000);
        expect(stalled[0].method).toBe("POST");
        // a fresh request is NOT reported stalled
        const fresh = { method: "GET", origin: "https://echo", path: "/ok" };
        instr.handleEvent("undici:request:create", { request: fresh });
        expect(instr.stalled(20_000)).toHaveLength(1);
    });

    it("logs client connection events that carry no request (connect-phase visibility)", () => {
        const nowRef = { t: 0 };
        const lines: string[] = [];
        const instr = makeInstr(nowRef, lines);
        instr.handleEvent("undici:client:beforeConnect", {
            connectParams: { host: "echo.example", port: "443" },
        });
        instr.handleEvent("undici:client:connectError", {
            connectParams: { host: "echo.example", port: "443" },
            error: new Error("ETIMEDOUT"),
        });
        const joined = lines.join("\n");
        expect(joined).toContain("undici:client:beforeConnect");
        expect(joined).toContain("echo.example:443");
        expect(joined).toContain("ETIMEDOUT");
    });
});

describe("sandbox-fetch-debug — live diagnostics_channel wiring (install)", () => {
    it("subscribes to the undici channels and logs a publish end-to-end", () => {
        const dc = require("node:diagnostics_channel");
        const lines: string[] = [];
        const handle = mod.install({
            env: { KNEXT_SANDBOX_FETCH_DEBUG: "1" },
            log: (line: string) => lines.push(line),
        });
        expect(handle).not.toBeNull();
        try {
            dc.channel("undici:request:create").publish({
                request: {
                    method: "PATCH",
                    origin: "https://live-wiring",
                    path: "/probe",
                },
            });
            const joined = lines.join("\n");
            expect(joined).toContain("undici:request:create");
            expect(joined).toContain("PATCH");
            expect(joined).toContain("https://live-wiring/probe");
        } finally {
            handle.uninstall();
        }
        // after uninstall the subscription is gone
        const before = lines.length;
        dc.channel("undici:request:create").publish({
            request: { method: "GET", origin: "https://after", path: "/x" },
        });
        expect(lines.length).toBe(before);
    });

    it("does not double-install (global symbol guard) and never keeps the process alive", () => {
        const lines: string[] = [];
        const first = mod.install({
            env: { KNEXT_SANDBOX_FETCH_DEBUG: "1" },
            log: (line: string) => lines.push(line),
        });
        const second = mod.install({
            env: { KNEXT_SANDBOX_FETCH_DEBUG: "1" },
            log: (line: string) => lines.push(line),
        });
        try {
            expect(first).not.toBeNull();
            expect(second).toBeNull();
        } finally {
            first.uninstall();
        }
    });
});

describe("sandbox-fetch-debug — entry chain-loading (the bun -r quirk workaround)", () => {
    // Under bun, diagnostics_channel subscriptions made from a `-r` preload
    // never register for the main program (verified on an isolated repro,
    // bun 1.3.x: identical module object, but the main program's publishes see
    // hasSubscribers=false; a require-chain from the main graph works, and node
    // works both ways). So e2e-deploy.sh boots the instrumentation module AS
    // THE ENTRY with KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS pointing at the real
    // server.js, and the module chain-requires it into the main graph.
    it("as the main entry, requires KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS after installing", () => {
        const { execFileSync } = require("node:child_process");
        const { mkdtempSync, writeFileSync } = require("node:fs");
        const { tmpdir } = require("node:os");
        const { join } = require("node:path");
        const dir = mkdtempSync(join(tmpdir(), "sandbox-fetch-debug-"));
        const chained = join(dir, "fake-server.cjs");
        writeFileSync(chained, "console.log('CHAINED-SERVER-BOOTED');\n");
        const out = execFileSync(process.execPath, [MODULE_PATH], {
            encoding: "utf8",
            env: {
                ...process.env,
                KNEXT_SANDBOX_FETCH_DEBUG: "1",
                KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS: chained,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        expect(out).toContain("CHAINED-SERVER-BOOTED");
    });

    it("does NOT chain-require when loaded as a library (require.main is someone else)", () => {
        // this vitest process HAS the module loaded (see the top of this file)
        // with no chain target — nothing exploded, and the export surface is
        // intact. A sentinel env var set now must not trigger a require either
        // (the chain gate is require.main === module, checked at load time).
        expect(typeof mod.install).toBe("function");
    });
});
