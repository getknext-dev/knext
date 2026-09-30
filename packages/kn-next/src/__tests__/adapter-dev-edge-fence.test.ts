// @vitest-environment node
//
// This e2e talks to a real `next dev` child process over a socket; the repo's
// default happy-dom environment enforces a Same-Origin Policy that blocks it.

import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
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
const REPO_ROOT = resolve(here, "../../../..");
// The TRACKED, read-only fixture template — never written to. `next dev`
// itself writes AGENTS.md/CLAUDE.md into its cwd when it detects an AI
// coding agent (`node_modules/next/dist/server/lib/generate-agent-files.js`);
// running it with FIXTURE as cwd left those files untracked in the working
// tree on every run under an agent (#1505/#1658). The live run below always
// happens in a throwaway copy (`workDir`) instead.
const FIXTURE = join(here, "fixtures", "dev-edge-fence");
const ADAPTER_SRC = resolve(here, "../adapters/next-adapter.ts");
const NEXT_BIN = resolve(here, "../../node_modules/.bin/next");
// `workDir` MUST live inside `packages/kn-next/` (never `os.tmpdir()`): `next`
// resolves its OWN dist modules by walking cwd's ancestor directories for a
// `node_modules/next` — a tmpdir outside the repo has no such ancestor and
// `next dev` fails closed with `MODULE_NOT_FOUND: next/dist/pages/_app`
// (round-2 review finding). A sibling of the tracked fixture, under this
// same `fixtures/` dir, walks straight up to `packages/kn-next/node_modules`,
// which already has `next` installed as a devDependency.
//
// NOT `mkdtempSync` (round-3 review finding): `tests/temp-dirs-outside-the-repo.test.ts`
// (#880) reds on ANY `mkdtemp`/`mkdtempSync` call whose prefix argument text
// does not itself name `tmpdir`/`TMP` — unconditionally, with no exception
// mechanism, because the whole point of that half of the guard is that an
// in-repo `mkdtemp` is never legitimate. This directory genuinely needs to be
// in-repo (the paragraph above), so it is created with a plain `mkdirSync`
// instead — a call `tests/temp-dirs-outside-the-repo.test.ts`'s `mkdtemp`-only
// scan does not even look at — and the resulting repo-rooted WRITE is
// licensed instead, by name and reason, in `tests/scratch-space-exceptions.json`'s
// `repoRootedWrites` (the mechanism `#918` provides for exactly this: a
// write that has to land inside the checkout, not one this guard should stop
// seeing). Gitignored (`.dev-edge-fence-work-*/`) so a leftover from a killed
// run is never mistaken for a tracked file.
const WORKDIR_PARENT = join(here, "fixtures");

/** Relative paths of every file under `dir`, sorted — used to prove `FIXTURE` is untouched. */
function listFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const abs = join(d, entry.name);
            if (entry.isDirectory()) walk(abs);
            else out.push(relative(dir, abs));
        }
    };
    walk(dir);
    return out.sort();
}

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

async function bundleAdapter(workDir: string): Promise<void> {
    const adapterBundle = join(workDir, ".knext", "adapter.mjs");
    mkdirSync(dirname(adapterBundle), { recursive: true });
    await build({
        entryPoints: [ADAPTER_SRC],
        outfile: adapterBundle,
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
    writeFileSync(join(workDir, ".knext", ".gitignore"), "*\n");
}

/**
 * Materialize the work copy's TypeScript types from the WORKSPACE's real
 * resolution. The fixture is a TS app on purpose (the .ts instrumentation
 * files are the fence's subject), so `next dev`'s TypeScript preflight
 * requires `@types/react` resolvable from it — and its `node_modules` is
 * untracked, so a CI checkout has none: the dev server booted, printed
 * "Please install @types/react", and died as an unhandled rejection, which
 * this suite could only report as "never answered". That was DETERMINISTIC
 * in CI and invisible locally, where a stale install satisfied it — the
 * exact works-on-my-machine shape. Symlinked fresh on every run so neither
 * environment depends on leftover state.
 */
function materializeFixtureTypes(workDir: string): void {
    const req = createRequire(
        join(REPO_ROOT, "apps", "file-manager", "package.json"),
    );
    const typesDir = join(workDir, "node_modules", "@types");
    mkdirSync(typesDir, { recursive: true });
    for (const pkg of ["@types/react", "@types/react-dom"]) {
        const target = dirname(req.resolve(`${pkg}/package.json`));
        const dest = join(typesDir, pkg.split("/")[1]);
        rmSync(dest, { recursive: true, force: true });
        symlinkSync(target, dest, "dir");
    }
}

let workDir: string | undefined;
/** Always removed in `afterAll`, alongside the dev-server process tree. */
afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
});

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

        // #1658: `next dev` writes AGENTS.md/CLAUDE.md into its cwd when it
        // detects an AI coding agent — so the live run gets a THROWAWAY copy
        // of the fixture, never the tracked one, and the tracked fixture's
        // file listing is asserted unchanged at the end of this test.
        const fixtureListingBefore = listFiles(FIXTURE);
        workDir = join(WORKDIR_PARENT, `.dev-edge-fence-work-${randomUUID()}`);
        cpSync(FIXTURE, workDir, { recursive: true });

        await bundleAdapter(workDir);
        materializeFixtureTypes(workDir);
        // Start from a clean `.next`: a SIGKILLed dev server leaves a stale
        // `.next/dev/lock` behind, and the next run refuses to start ("Another
        // next dev server is already running") — which would look like a fence
        // failure. Hermetic run, not a flaky one.
        rmSync(join(workDir, ".next"), { recursive: true, force: true });

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
                cwd: workDir,
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
                // Per-ATTEMPT budget, sized between two failures rather than
                // guessed:
                //
                //   120s (original) is longer than the poll's own 150s deadline,
                //   so one hung attempt ate it and the SECOND ran past the 180s
                //   test timeout — the informative assertions below never ran and
                //   CI reported a bare timeout.
                //
                //   5s (my first correction) over-shot the other way. `next dev
                //   --webpack` answers its FIRST request only after a cold
                //   compile, which takes longer than that on a CI runner, so every
                //   attempt aborted mid-compile and the loop never converged —
                //   with the server reporting `✓ Ready in 305ms` and bound to the
                //   very address being dialled.
                //
                // 30s leaves room for that compile and still lets the loop iterate
                // ~5 times inside its deadline, so a genuine failure reaches the
                // assertion instead of the test timeout.
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
                    signal: AbortSignal.timeout(30_000),
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

        killTree();
        // #1658 acceptance: the tracked fixture dir is byte-for-byte the same
        // set of files it was before this test ran — no AGENTS.md/CLAUDE.md
        // (or anything else `next dev` writes) leaked into it.
        expect(listFiles(FIXTURE)).toEqual(fixtureListingBefore);
    }, 180_000);
});
