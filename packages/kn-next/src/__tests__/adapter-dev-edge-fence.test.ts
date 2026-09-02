// @vitest-environment node
//
// This e2e talks to a real `next dev` child process over a socket; the repo's
// default happy-dom environment enforces a Same-Origin Policy that blocks it.

import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * #408 item 1 — the dev-phase half of the guarded-instrumentation fence
 * (#342/#344/#356, ADR-0031), pinned against a REAL `next dev`.
 *
 * The fence (an edge-scoped webpack `IgnorePlugin` that replaces
 * `instrumentation-node` with an empty module) shipped in #356 gated on
 * `phase-production-build` only, while the hand-written app hook it replaced
 * covered `next dev` as well. The issue asked which of "dev is unaffected" or
 * "dev needs the fence" is true. MEASURED, not assumed, on next 16.2.11 against
 * the fixture below:
 *
 *   next dev            → Turbopack (the 16.2 default). Compiles clean; `next dev`
 *                         never consults `config.webpack`, so the fence is moot.
 *   next dev --webpack  → the EDGE compile of `instrumentation-node` FAILS:
 *                         `Module build failed: UnhandledSchemeError: Reading from
 *                         "node:fs" is not handled by plugins (Unhandled scheme).`
 *                         — the same class the production build hit before #356.
 *
 * So `next dev --webpack` is the case this test pins: with the fence extended to
 * every phase, the dev server compiles and serves the page. Reverting the fence
 * to `phase-production-build` only turns this test RED (mutation-proved), which
 * is exactly what the old one-line "dev is fine" note could not do.
 *
 * NOTHING here skips. The fixture, `next`, and `esbuild` are all workspace
 * devDependencies of @getknext/core, so a missing precondition is a FAILURE —
 * never a silent pass (the green-by-skip anti-pattern this issue is about).
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "dev-edge-fence");
const ADAPTER_SRC = resolve(here, "../adapters/next-adapter.ts");
// next.config.mjs in the fixture points `adapterPath` here; the bundle is
// generated below from the adapter SOURCE so this test never depends on a
// prior `pnpm --filter @getknext/core build`.
const ADAPTER_BUNDLE = join(FIXTURE, ".knext", "adapter.mjs");
const NEXT_BIN = resolve(here, "../../node_modules/.bin/next");

/** The edge-compile failure the fence exists to prevent. */
const EDGE_COMPILE_FAILURE_RE =
    /UnhandledSchemeError|not handled by plugins|Module not found/;

let child: ReturnType<typeof spawn> | undefined;
/**
 * `next dev` forks a worker, and Next REFUSES to start a second dev server in a
 * directory that still holds a live one ("Another next dev server is already
 * running") — so killing only the wrapper leaves the fixture poisoned for the
 * next run. The child is spawned `detached`, which puts it in its own process
 * group; kill the whole group.
 */
function killTree(): void {
    if (!child?.pid) return;
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        child.kill("SIGKILL");
    }
    child = undefined;
}
afterAll(killTree);

async function freePort(): Promise<number> {
    return await new Promise((res, rej) => {
        const srv = createServer();
        srv.on("error", rej);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => res(port));
        });
    });
}

async function bundleAdapter(): Promise<void> {
    mkdirSync(dirname(ADAPTER_BUNDLE), { recursive: true });
    await build({
        entryPoints: [ADAPTER_SRC],
        outfile: ADAPTER_BUNDLE,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node20",
        // Everything the adapter reaches at RUNTIME is either a node builtin or
        // an optional storage client it dynamic-imports; keep them external so
        // the bundle stays a thin wrapper around the fence under test.
        packages: "external",
    });
    // The bundle is a build artifact of this test run, never committed.
    writeFileSync(join(FIXTURE, ".knext", ".gitignore"), "*\n");
}

describe("#408 — the edge fence covers `next dev --webpack` (real dev server)", () => {
    it("serves a middleware app with guarded instrumentation, with no edge-compile failure", async () => {
        expect(
            existsSync(NEXT_BIN),
            `next binary not found at ${NEXT_BIN} — @getknext/core devDependency missing`,
        ).toBe(true);
        expect(
            existsSync(join(FIXTURE, "next.config.mjs")),
            `dev-edge-fence fixture missing at ${FIXTURE}`,
        ).toBe(true);

        await bundleAdapter();
        // Start from a clean `.next`: a SIGKILLed dev server leaves a stale
        // `.next/dev/lock` behind, and the next run refuses to start ("Another
        // next dev server is already running") — which would look like a fence
        // failure. Hermetic run, not a flaky one.
        rmSync(join(FIXTURE, ".next"), { recursive: true, force: true });

        const port = await freePort();
        let out = "";
        let exited: string | null = null;
        // `-H 127.0.0.1`: bind the interface the poll below dials.
        //
        // Without it `next dev` binds `localhost`, and the CI runner resolves
        // that to `::1` only — so the server reported `✓ Ready in 376ms` and
        // listened happily on IPv6 while every IPv4 probe was refused. The poll
        // then ran its full 150s against a healthy server it could not reach.
        // Locally the two agree, which is why this only ever failed in CI.
        child = spawn(
            NEXT_BIN,
            ["dev", "--webpack", "-p", String(port), "-H", "127.0.0.1"],
            {
                cwd: FIXTURE,
                detached: true,
                env: { ...process.env, NODE_ENV: "development" },
            },
        );
        child.stdout?.on("data", (b) => {
            out += String(b);
        });
        child.stderr?.on("data", (b) => {
            out += String(b);
        });
        child.on("exit", (code, signal) => {
            exited = `code=${code} signal=${signal}`;
        });
        // A spawn that never starts emits `error`, not `exit`. Without this the
        // failure was indistinguishable from a slow server: `exited` stayed null,
        // no output was ever captured, and the poll simply ran out its 150s while
        // the assertions below reported "never answered" with an EMPTY log.
        child.on("error", (err) => {
            exited = `spawn error: ${err?.message ?? err}`;
        });

        // Readiness = the server actually answers, not a log line: `next dev`
        // prints "Ready in …" and only THEN bails out if another dev server holds
        // the directory, so the banner alone would be a false green.
        // The dev server's log, bounded. Embedding the WHOLE of it pushed the
        // assertion's own label out of the runner's failure window, so CI
        // reported the failure with its reason cut off.
        const tail = () =>
            out.split("\n").filter(Boolean).slice(-25).join("\n");
        const deadline = Date.now() + 150_000;
        let res: Response | undefined;
        while (Date.now() < deadline && !exited) {
            try {
                // Short per-ATTEMPT budget, because this is a poll: the loop
                // below re-tries every 500ms until its own 150s deadline.
                //
                // It was 120s, which is longer than the poll is allowed to run
                // and two-thirds of the whole test budget. A dev server that
                // ACCEPTS the connection and then compiles (rather than
                // refusing it) makes one attempt hang for 120s; the second then
                // runs past the 180s test timeout, so the informative
                // assertions below — which print the dev server's own output —
                // never execute. CI reported a bare "timed out after 180000ms"
                // with 2 expect() calls, and the reason was thrown away.
                res = await fetch(`http://127.0.0.1:${port}/`, {
                    signal: AbortSignal.timeout(5_000),
                });
                break;
            } catch {
                await new Promise((r) => setTimeout(r, 500));
            }
        }
        expect(
            exited,
            `next dev exited before serving a request (${exited}):\n${tail()}`,
        ).toBeNull();
        expect(
            res,
            // `out.length` is in the message on purpose: "never answered" and
            // "never said anything" are different failures, and the second one
            // means the process or its piping is broken rather than slow.
            `dev server never answered on :${port} ` +
                `(captured ${out.length} bytes of output, exited=${exited}):\n${tail()}`,
        ).toBeDefined();
        const response = res as Response;
        const body = await response.text();

        expect(
            EDGE_COMPILE_FAILURE_RE.test(out),
            `next dev --webpack hit an edge-compile failure — the adapter fence ` +
                `did not apply in the dev phase:\n${tail()}`,
        ).toBe(false);
        expect(
            response.status,
            `dev server responded ${response.status}:\n${tail()}`,
        ).toBe(200);
        expect(body).toContain("devfix ok");
        // The middleware (which is what forces the edge compile at all) really ran.
        expect(response.headers.get("x-devfix")).toBe("1");
    }, 180_000);
});
