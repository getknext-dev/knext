/**
 * #188 path 3 — IN-REALM edge-sandbox fetch instrumentation.
 *
 * Path 2 (PR #206, run 28657820369) proved that under bun even a SUCCESSFUL
 * sandbox fetch is invisible to a host-realm main-graph diagnostics_channel
 * subscriber (calibrated null), so instrument-from-outside is structurally
 * blocked on the runtime where the hang lives. Path 3 therefore instruments
 * INSIDE next's sandbox wiring: a debug-lane-only, harness-side patch of the
 * FIXTURE's staged standalone `next/dist/server/web/sandbox/context.js`
 * (v16.2.0) wraps
 *   (a) the base primitives fetch (`__fetch`, captured by next's `extend`
 *       before its own wrapper is built), and
 *   (b) next's host-realm `context.fetch` wrapper,
 * with per-call phase logging (call → connect → headers/resolve → body →
 * settled) plus a stall watchdog that names the LAST SEEN PHASE of any call
 * in-flight too long — the exact discrimination every previous reduction
 * missed. Socket-level phases (DNS/connect/TLS/first-byte) come from
 * instrumenting host `net`/`tls` connect: the bundled undici provably
 * executes host-side (`@edge-runtime/primitives` `load()` runs in the host
 * realm; its objects are injected into the vm context) and reaches the
 * network through `require('net')`/`require('tls')`.
 *
 * Hard constraints tested here:
 *   - strictly opt-in: KNEXT_SANDBOX_FETCH_DEBUG must be EXACTLY '1' —
 *     acquire() returns null otherwise (the patched hook then leaves next's
 *     wiring byte-for-byte on the original code path);
 *   - the patcher only rewrites the exact v16.2.0 anchors, is idempotent,
 *     validates the patched file parses, and FAILS LOUD (patched:false +
 *     reason) on anchor drift — never a silent half-patch;
 *   - phase tracking + watchdog name where a hang stalls (the deliverable).
 */

import { execFileSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const MODULE_PATH = resolve(
    import.meta.dirname,
    "../adapters/sandbox-fetch-realm-debug.cjs",
);
/** Verbatim copy of next@16.2.0 dist/server/web/sandbox/context.js (npm tarball). */
const CONTEXT_FIXTURE = resolve(
    import.meta.dirname,
    "fixtures/next-16.2.0-sandbox-context.js.txt",
);

// biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
const mod: any = require(MODULE_PATH);

describe("sandbox-fetch-realm-debug — opt-in gating", () => {
    it("shouldInstall() is true ONLY for exactly '1'", () => {
        expect(mod.shouldInstall({ KNEXT_SANDBOX_FETCH_DEBUG: "1" })).toBe(
            true,
        );
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

    it("acquire() returns null when disabled — no logging, no process-wide patching", () => {
        const handle = mod.acquire({
            env: {},
            log: () => {
                throw new Error("disabled acquire must not log");
            },
            instrumentSockets: false,
        });
        expect(handle).toBeNull();
    });
});

describe("sandbox-fetch-realm-debug — base-fetch phase wrapping", () => {
    function makeHandle(lines: string[], nowRef: { t: number }) {
        const handle = mod.acquire({
            env: { KNEXT_SANDBOX_FETCH_DEBUG: "1" },
            moduleName: "middleware",
            log: (line: string) => lines.push(line),
            now: () => nowRef.t,
            instrumentSockets: false, // unit scope: no process-wide net/tls patching
            watchdog: false,
        });
        expect(handle).not.toBeNull();
        return handle;
    }

    it("logs call → resolved with elapsed ms, and tracks nothing after settle", async () => {
        const lines: string[] = [];
        const nowRef = { t: 1_000 };
        const handle = makeHandle(lines, nowRef);

        const response = {
            status: 200,
            text: async () => "body",
        };
        const wrapped = handle.wrapBaseFetch(async (_input: unknown) => {
            nowRef.t = 1_250;
            return response;
        });

        const res = await wrapped("https://echo.example/api", {
            method: "POST",
        });
        expect(res.status).toBe(200);

        const call = lines.find((l) =>
            /base-fetch#\d+ call POST https:\/\/echo\.example\/api/.test(l),
        );
        expect(
            call,
            `expected a call line, got:\n${lines.join("\n")}`,
        ).toBeTruthy();
        const resolved = lines.find((l) =>
            /base-fetch#\d+ resolved status=200 \+250ms/.test(l),
        );
        expect(
            resolved,
            `expected a resolved line, got:\n${lines.join("\n")}`,
        ).toBeTruthy();
        expect(handle.pending()).toEqual([]);
    });

    it("logs rejected with the error message", async () => {
        const lines: string[] = [];
        const handle = makeHandle(lines, { t: 0 });
        const wrapped = handle.wrapBaseFetch(async () => {
            throw new Error("boom");
        });
        await expect(wrapped("https://echo.example/x")).rejects.toThrow("boom");
        expect(
            lines.some((l) => /base-fetch#\d+ rejected .*boom/.test(l)),
        ).toBe(true);
        expect(handle.pending()).toEqual([]);
    });

    it("instruments body consumption on the resolved response (text/json/arrayBuffer)", async () => {
        const lines: string[] = [];
        const nowRef = { t: 0 };
        const handle = makeHandle(lines, nowRef);
        const wrapped = handle.wrapBaseFetch(async () => ({
            status: 200,
            text: async () => {
                nowRef.t += 40;
                return "hello";
            },
        }));
        const res = await wrapped("https://echo.example/api");
        const out = await res.text();
        expect(out).toBe("hello");
        expect(
            lines.some((l) => /base-fetch#\d+ body\.text\(\) start/.test(l)),
        ).toBe(true);
        expect(
            lines.some((l) =>
                /base-fetch#\d+ body\.text\(\) done \+40ms/.test(l),
            ),
        ).toBe(true);
    });

    it("the stall report names the LAST SEEN PHASE of a never-settling call", async () => {
        const lines: string[] = [];
        const nowRef = { t: 0 };
        const handle = makeHandle(lines, nowRef);
        const wrapped = handle.wrapBaseFetch(() => new Promise(() => {})); // never settles
        void wrapped("https://echo.example/hang", { method: "POST" });
        nowRef.t = 30_000;
        const stalled = handle.stalled(20_000);
        expect(stalled).toHaveLength(1);
        expect(stalled[0].phase).toBe("base-fetch:call");
        expect(stalled[0].ageMs).toBe(30_000);
        expect(stalled[0].detail).toContain("https://echo.example/hang");
    });
});

describe("sandbox-fetch-realm-debug — context.fetch (outer wrapper) wrapping", () => {
    it("logs entry and settled around next's wrapper — discriminates stall-before-dispatch", async () => {
        const lines: string[] = [];
        const nowRef = { t: 100 };
        const handle = mod.acquire({
            env: { KNEXT_SANDBOX_FETCH_DEBUG: "1" },
            log: (line: string) => lines.push(line),
            now: () => nowRef.t,
            instrumentSockets: false,
            watchdog: false,
        });
        const wrapped = handle.wrapContextFetch(async (_input: unknown) => {
            nowRef.t = 400;
            return { status: 405 };
        });
        const res = await wrapped("https://echo.example/api", {
            method: "DELETE",
        });
        expect(res.status).toBe(405);
        expect(
            lines.some((l) =>
                /context-fetch#\d+ call DELETE https:\/\/echo\.example\/api/.test(
                    l,
                ),
            ),
        ).toBe(true);
        expect(
            lines.some((l) =>
                /context-fetch#\d+ resolved status=405 \+300ms/.test(l),
            ),
        ).toBe(true);
    });

    it("supports Request-shaped input (reads .url/.method) without consuming it", async () => {
        const lines: string[] = [];
        const handle = mod.acquire({
            env: { KNEXT_SANDBOX_FETCH_DEBUG: "1" },
            log: (line: string) => lines.push(line),
            instrumentSockets: false,
            watchdog: false,
        });
        const input = { url: "https://echo.example/req", method: "PATCH" };
        const wrapped = handle.wrapContextFetch(async () => ({ status: 200 }));
        await wrapped(input);
        expect(
            lines.some((l) =>
                /context-fetch#\d+ call PATCH https:\/\/echo\.example\/req/.test(
                    l,
                ),
            ),
        ).toBe(true);
    });
});

describe("sandbox-fetch-realm-debug — the context.js patcher", () => {
    function makeFakeStandalone(contextSource: string): {
        appDir: string;
        contextPath: string;
    } {
        // realpath the tmpdir up front (macOS /var -> /private/var) so the
        // patcher's realpath-normalized contextPath compares equal.
        const appDir = mkdtempSync(join(realpathSync(tmpdir()), "knext-sfrd-"));
        const pkgDir = join(appDir, "node_modules", "next");
        const ctxPath = join(
            pkgDir,
            "dist",
            "server",
            "web",
            "sandbox",
            "context.js",
        );
        mkdirSync(dirname(ctxPath), { recursive: true });
        writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({
                name: "next",
                version: "16.2.0",
                main: "./dist/server/next.js",
            }),
        );
        writeFileSync(ctxPath, contextSource);
        return { appDir, contextPath: ctxPath };
    }

    const realContext = readFileSync(CONTEXT_FIXTURE, "utf8");

    it("patches the verbatim v16.2.0 context.js at BOTH anchors and the result parses", () => {
        const { appDir, contextPath } = makeFakeStandalone(realContext);
        const log: string[] = [];
        const result = mod.patchSandboxContext({
            appDir,
            log: (l: string) => log.push(l),
        });
        expect(result.patched).toBe(true);
        expect(result.contextPath).toBe(contextPath);
        const patched = readFileSync(contextPath, "utf8");
        // base-fetch anchor rewritten, guarded on the exact env pair
        expect(patched).toContain("knext-sandbox-fetch-realm-debug");
        expect(patched).toContain("KNEXT_SANDBOX_FETCH_DEBUG");
        expect(patched).toContain("KNEXT_SANDBOX_FETCH_REALM_DEBUG_MODULE");
        expect(patched).toContain("wrapBaseFetch");
        expect(patched).toContain("wrapContextFetch");
        // the original base capture must be gone (replaced, not duplicated)
        expect(patched.match(/const __fetch = context\.fetch;/g)).toBeNull();
        // syntax gate: the patched file must remain valid CommonJS
        execFileSync(process.execPath, ["--check", contextPath], {
            stdio: "pipe",
        });
    });

    it("is idempotent — a second run reports already-patched and does not double-wrap", () => {
        const { appDir, contextPath } = makeFakeStandalone(realContext);
        expect(mod.patchSandboxContext({ appDir, log: () => {} }).patched).toBe(
            true,
        );
        const once = readFileSync(contextPath, "utf8");
        const again = mod.patchSandboxContext({ appDir, log: () => {} });
        expect(again.patched).toBe(true);
        expect(again.already).toBe(true);
        expect(readFileSync(contextPath, "utf8")).toBe(once);
    });

    it("fails LOUD (patched:false + reason) when an anchor is missing or ambiguous", () => {
        const noAnchor = realContext.replace(
            "const __fetch = context.fetch;",
            "/* moved */",
        );
        const { appDir } = makeFakeStandalone(noAnchor);
        const result = mod.patchSandboxContext({ appDir, log: () => {} });
        expect(result.patched).toBe(false);
        expect(String(result.reason)).toMatch(/anchor/i);

        const doubled = realContext.replace(
            "const __fetch = context.fetch;",
            "const __fetch = context.fetch;\n            const __fetch2 = context.fetch; const __fetch3 = (0, eval)('const __fetch = context.fetch;');",
        );
        const dup = makeFakeStandalone(doubled);
        const dupResult = mod.patchSandboxContext({
            appDir: dup.appDir,
            log: () => {},
        });
        expect(dupResult.patched).toBe(false);
    });

    it("fails LOUD when next's sandbox context.js cannot be resolved from the app dir", () => {
        const appDir = mkdtempSync(join(tmpdir(), "knext-sfrd-empty-"));
        const result = mod.patchSandboxContext({ appDir, log: () => {} });
        expect(result.patched).toBe(false);
        expect(String(result.reason)).toMatch(/resolve|not found/i);
    });

    it("the injected hook stays inert when the debug env is off (steady-state containment)", async () => {
        const { appDir, contextPath } = makeFakeStandalone(realContext);
        mod.patchSandboxContext({ appDir, log: () => {} });
        const patched = readFileSync(contextPath, "utf8");
        // Execute ONLY the injected base-fetch hook lines in isolation with the
        // debug env OFF: the hook must fall through to the original context.fetch
        // and never require() anything.
        const hookLines = patched
            .split("\n")
            .filter((l) => l.includes("knext-sandbox-fetch-realm-debug"))
            .join("\n");
        expect(hookLines.length).toBeGreaterThan(0);
        // `process` and `require` are shadowed via an inner function's parameters
        // (a CJS module body cannot const-redeclare its own wrapper parameters).
        const probe = `
      'use strict';
      module.exports = (function (process, require) {
        const context = { fetch: async () => ({ status: 200 }) };
        const options = { moduleName: 'middleware' };
        ${hookLines}
        return { same: __fetch === context.fetch, sfrd: __knextSfrd };
      })(
        { env: {}, stderr: { write() {} } },
        () => { throw new Error('hook must not require when disabled'); },
      );
    `;
        const probePath = join(appDir, "hook-probe.cjs");
        writeFileSync(probePath, probe);
        // biome-ignore lint/suspicious/noExplicitAny: dynamic probe module
        const probed: any = require(probePath);
        expect(probed.sfrd).toBeNull();
        expect(probed.same).toBe(true);
    });
});
