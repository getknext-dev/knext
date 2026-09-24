/**
 * #1339 round-3 (jev 0.92, BLOCKER, proven with tsup + npm pack) — the
 * compiled adapter script paths (`compileScriptPath` in vinext-build.ts,
 * `standaloneCompileScriptPath` in standalone-exec-build.ts) MUST resolve
 * correctly from a real, tsup-BUILT `dist/`, not just from the source tree
 * every other unit test in this repo runs against.
 *
 * The regression this guards: both resolvers used to compute
 * `dirname(import.meta.url)/../adapters/<script>` — correct as long as the
 * module bundling THIS code landed at `dist/cli/<something>.js` (one level
 * under `dist/`). Round 2 of this PR made `build-artifact.ts` share
 * `vinext-build.ts`/`standalone-exec-build.ts` across THREE tsup entries
 * (`build.ts`, `deploy.ts`, `preview.ts`), and tsup answers "used by
 * multiple entries" by hoisting the shared module into a chunk at the ROOT
 * of `dist/` (`dist/chunk-<hash>.js`) — a depth-relative `..` from there
 * overshoots the package root entirely, landing on `<pkg>/adapters/…`,
 * which does not exist and is not even in the published tarball (`files:
 * ["dist","templates"]`). Every published build/deploy/preview that needs
 * to compile the executable would fail outright.
 *
 * This suite uses the CI-BUILT dist (`ci.yml`'s `lint-and-test` job runs
 * `bun run --filter @getknext/core build` before "Run tests" — the same
 * contract `standalone-image-contract.test.ts` and siblings already rely
 * on) rather than rebuilding tsup itself: `tsup`'s `clean: true` wipes
 * `dist/` before writing it back, and `bun-test.mjs` runs many spec files
 * concurrently, several of which (`public-api-surface.test.ts`,
 * `publish-surface.test.ts`) read `dist/` mid-suite — rebuilding here would
 * race them. It dynamically imports whichever chunk tsup happened to put
 * `buildVinextExecutable` in — DISCOVERED by scanning, not a hardcoded
 * chunk name, because tsup's chunk filenames are content-hashed and change
 * on every source edit — and calls it with an injected `run` so nothing
 * actually shells out to `bun`. The captured argv's script-path argument is
 * asserted to (a) exist on disk and (b) equal the CANONICAL
 * `dist/adapters/vinext-compile.js` location — not merely "some file that
 * happens to exist", which a resolver returning cwd-relative garbage could
 * accidentally satisfy.
 *
 * MUTATION-PROOF (workflow.md: prove it, don't just claim it): reverting
 * `compileScriptPath`/`standaloneCompileScriptPath` to the old
 * `dirname(import.meta.url)/../adapters/…` form, running `bun run build`,
 * and re-running this suite reproduces the EXACT round-3 failure — the
 * resolved path names `<pkg-root>/adapters/vinext-compile.js` (missing
 * `dist/`) and `existsSync` on it is false. Verified locally; not
 * committed (per workflow.md, the mutation is not left in the tree).
 */

import { describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dirname, "..", "..");
const DIST = join(PKG_ROOT, "dist");

/** Every `.js` file under `dist/` (recursive), scanning not enumerating. */
function distJsFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".js")) found.push(full);
        }
    };
    walk(DIST);
    return found;
}

/**
 * Find the dist chunk that exports `buildVinextExecutable` and dynamically
 * import it. NOT a hardcoded path — tsup's shared-chunk filenames are
 * content-hashed, so a fixed path here would silently stop testing anything
 * the moment an unrelated edit changed the hash.
 */
async function findVinextBuildModule(): Promise<{
    // biome-ignore lint/suspicious/noExplicitAny: dynamically imported dist module
    buildVinextExecutable: (opts: any) => string;
}> {
    for (const file of distJsFiles()) {
        let source: string;
        try {
            source = readFileSync(file, "utf8");
        } catch {
            continue;
        }
        if (!source.includes("buildVinextExecutable")) continue;
        const mod = await import(file);
        if (typeof mod.buildVinextExecutable === "function") {
            return mod as {
                // biome-ignore lint/suspicious/noExplicitAny: dynamically imported dist module
                buildVinextExecutable: (opts: any) => string;
            };
        }
    }
    throw new Error(
        "no dist/**/*.js file exports buildVinextExecutable — did the tsup entry graph change?",
    );
}

describe("#1339 round-3 — compiled adapter script paths resolve from a REAL tsup-built dist/", () => {
    it("buildVinextExecutable resolves dist/adapters/vinext-compile.js, not <pkg>/adapters/… (BLOCKER)", async () => {
        // dist is a hard requirement, not a build-it-ourselves step (same
        // discipline as standalone-image-contract.test.ts and siblings):
        // rebuilding here would race the OTHER spec files bun-test.mjs runs
        // concurrently that also read dist/.
        expect(
            existsSync(join(DIST, "adapters", "vinext-compile.js")),
            "dist/adapters/vinext-compile.js missing — run 'bun run build' in " +
                "packages/kn-next before this suite (CI builds @getknext/core " +
                "before tests; see ci.yml's lint-and-test job).",
        ).toBe(true);

        const { buildVinextExecutable } = await findVinextBuildModule();

        const appDir = mkdtempSync(
            join(tmpdir(), "knext-dist-adapter-resolve-"),
        );
        try {
            mkdirSync(join(appDir, ".output", "server"), { recursive: true });
            // Minimal valid ESM — buildVinextExecutable only checks this
            // FILE exists before compiling; the injected `run` below means
            // nothing actually reads its contents.
            writeFileSync(
                join(appDir, ".output", "server", "index.mjs"),
                "export default {};\n",
            );

            let capturedArgv: string[] = [];
            const run = (argv: string[]) => {
                capturedArgv = argv;
            };

            buildVinextExecutable({
                cwd: appDir,
                arch: "linux-x64",
                run,
                bunVersion: "1.4.2", // above the floor — skip the real detectBunVersion(run) call
                skipViteBuild: true,
            });

            // argv is ["bun", "run", <script>, ...] — see compileArgv.
            expect(capturedArgv[0]).toBe("bun");
            expect(capturedArgv[1]).toBe("run");
            const scriptPath = capturedArgv[2];

            expect(
                scriptPath,
                "resolved script path is falsy — buildVinextExecutable's argv shape changed?",
            ).toBeTruthy();
            expect(
                existsSync(scriptPath),
                `compileScriptPath() resolved to '${scriptPath}', which does not exist on disk — ` +
                    "this is the exact round-3 regression (a depth-relative walk landing one level " +
                    "too shallow when tsup hoists the module into a root-level chunk)",
            ).toBe(true);
            // Not just "exists somewhere" — the CANONICAL published location.
            expect(scriptPath).toBe(
                join(DIST, "adapters", "vinext-compile.js"),
            );
        } finally {
            rmSync(appDir, { recursive: true, force: true });
        }
    }, 60_000);

    it("compileArtifactForDeploy resolves dist/adapters/standalone-compile.js, not <pkg>/adapters/… (BLOCKER)", async () => {
        expect(
            existsSync(join(DIST, "adapters", "standalone-compile.js")),
            "dist/adapters/standalone-compile.js missing — run 'bun run build' in " +
                "packages/kn-next before this suite (CI builds @getknext/core " +
                "before tests; see ci.yml's lint-and-test job).",
        ).toBe(true);

        const mod = await findChunkExporting("compileArtifactForDeploy");

        const appDir = mkdtempSync(
            join(tmpdir(), "knext-dist-adapter-resolve-standalone-"),
        );
        try {
            mkdirSync(join(appDir, ".next", "standalone"), {
                recursive: true,
            });
            // A real (but not Next-shaped) file: buildStandaloneExecutable
            // does NOT accept an injectable `run` the way buildVinextExecutable
            // does, so this actually shells out to the REAL `bun run
            // <resolved-path> …` — bun and docker are both on PATH in this
            // environment. A placeholder server.js makes the standalone-compile
            // SCRIPT itself refuse (a content-validation error, asserted below
            // by NAME) — the distinguishing signal that resolution SUCCEEDED:
            // a wrong path fails with "Module not found" naming the WRONG
            // (un-prefixed) location instead.
            writeFileSync(
                join(appDir, ".next", "standalone", "server.js"),
                "console.log(1);\n",
            );

            let thrown: Error | undefined;
            try {
                mod.compileArtifactForDeploy(
                    {
                        name: "a",
                        registry: "r",
                        build: "turbopack",
                        runtime: "bun",
                    },
                    appDir,
                    { arch: "linux-x64" },
                );
            } catch (err) {
                thrown = err as Error;
            }

            expect(
                thrown,
                "compileArtifactForDeploy did not throw — a placeholder " +
                    "server.js should have failed content validation; if it " +
                    "did not, this test can no longer distinguish resolution " +
                    "success from failure",
            ).toBeDefined();
            const message = thrown?.message ?? "";
            expect(
                message,
                `expected the resolved script path in the error to be the CANONICAL ` +
                    `dist/adapters/standalone-compile.js; got: ${message}`,
            ).toContain(join(DIST, "adapters", "standalone-compile.js"));
            // The exact round-3 regression shape: a path missing "dist/".
            expect(message).not.toContain(
                join(PKG_ROOT, "adapters", "standalone-compile.js"),
            );
        } finally {
            rmSync(appDir, { recursive: true, force: true });
        }
    }, 60_000);
});

/**
 * Scan `dist/**\/*.js` for the file exporting `exportName` and dynamically
 * import it. Shared shape with `findVinextBuildModule` above; kept separate
 * because each caller wants a differently-typed handle.
 */
async function findChunkExporting(
    exportName: string,
    // biome-ignore lint/suspicious/noExplicitAny: dynamically imported dist module
): Promise<any> {
    for (const file of distJsFiles()) {
        let source: string;
        try {
            source = readFileSync(file, "utf8");
        } catch {
            continue;
        }
        if (!source.includes(exportName)) continue;
        const mod = await import(file);
        if (typeof mod[exportName] === "function") return mod;
    }
    throw new Error(
        `no dist/**/*.js file exports ${exportName} — did the tsup entry graph change?`,
    );
}
