/**
 * #1339 review round 2, finding #1 (jev 0.90, BLOCKER) — `knext deploy`/
 * `preview` never compiled the standalone bun exec (or the vinext exec):
 * `runtime-image.ts` picks `standalone-bun` and stages a Dockerfile that
 * unconditionally `COPY`s `knext-standalone-exec-<arch>`, but only
 * `build.ts` ever called `buildStandaloneExecutable`/`buildVinextExecutable`
 * — a bare-config deploy either failed the docker build (no such file) or
 * shipped a STALE binary left over from an earlier `knext build`.
 *
 * This suite pins the shared fix directly (`build-artifact.ts`'s
 * `compileArtifactForDeploy`/`assertCompiledArtifactFresh`), independent of
 * the deploy.ts/preview.ts wiring tests, which prove the CALL SITE.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnativeNextConfig } from "../config";

// biome-ignore lint/suspicious/noExplicitAny: thin mock plumbing
type AnyFn = (...args: any[]) => any;

const buildStandaloneExecutable = mock<AnyFn>(
    (opts: { cwd: string; arch: string }) =>
        join(opts.cwd, `knext-standalone-exec-${opts.arch}`),
);
mock.module("../cli/standalone-exec-build", () => ({
    buildStandaloneExecutable: (...a: unknown[]) =>
        buildStandaloneExecutable(...a),
    standaloneExecFileName: (arch: string) => `knext-standalone-exec-${arch}`,
}));

const buildVinextExecutable = mock<AnyFn>(
    (opts: { cwd: string; arch: string }) =>
        join(opts.cwd, `knext-exec-${opts.arch}`),
);
mock.module("../cli/vinext-build", () => ({
    buildVinextExecutable: (...a: unknown[]) => buildVinextExecutable(...a),
}));

const healBunExportTargets = mock<AnyFn>(() => ({ copied: [], skipped: [] }));
mock.module("../adapters/standalone-bun-exports", () => ({
    healBunExportTargets: (...a: unknown[]) => healBunExportTargets(...a),
}));

const {
    assertCompiledArtifactFresh,
    buildStampPathFor,
    compileArtifactForDeploy,
    compiledExecPathFor,
    hashBuildIdentity,
} = await import("../cli/build-artifact");
const { UsageError } = await import("../cli/shared");

let dir: string;

function cfg(over: Partial<KnativeNextConfig> = {}): KnativeNextConfig {
    return {
        name: "app",
        registry: "reg",
        ...over,
    } as KnativeNextConfig;
}

function standaloneServer(): void {
    mkdirSync(join(dir, ".next", "standalone"), { recursive: true });
    writeFileSync(join(dir, ".next", "standalone", "server.js"), "");
}

function vinextOutput(): void {
    mkdirSync(join(dir, ".output", "server"), { recursive: true });
    writeFileSync(join(dir, ".output", "server", "index.mjs"), "");
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-compile-artifact-"));
    buildStandaloneExecutable.mockClear();
    buildVinextExecutable.mockClear();
    healBunExportTargets.mockClear();
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("compileArtifactForDeploy", () => {
    it("bare config (build+runtime absent) compiles the standalone-bun executable — the actual default cell", () => {
        standaloneServer();
        const result = compileArtifactForDeploy(cfg(), dir);

        expect(result.compiled).toBe(true);
        expect(buildStandaloneExecutable).toHaveBeenCalledTimes(1);
        expect(buildStandaloneExecutable).toHaveBeenCalledWith(
            expect.objectContaining({ cwd: dir, arch: "linux-x64" }),
        );
        expect(buildVinextExecutable).not.toHaveBeenCalled();
    });

    it("heals bun exports on the standalone shape even when runtime is node", () => {
        standaloneServer();
        const result = compileArtifactForDeploy(
            cfg({ build: "turbopack", runtime: "node" }),
            dir,
        );

        expect(healBunExportTargets).toHaveBeenCalledTimes(1);
        expect(result.compiled).toBe(false);
        expect(result.healed).toBeDefined();
        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
    });

    it("does not heal when there is no standalone dir to heal", () => {
        compileArtifactForDeploy(
            cfg({ build: "turbopack", runtime: "node" }),
            dir,
        );
        expect(healBunExportTargets).not.toHaveBeenCalled();
    });

    it("compiles the vinext single executable for build: 'vinext'", () => {
        vinextOutput();
        const result = compileArtifactForDeploy(cfg({ build: "vinext" }), dir);

        expect(result.compiled).toBe(true);
        expect(buildVinextExecutable).toHaveBeenCalledTimes(1);
        expect(buildVinextExecutable).toHaveBeenCalledWith(
            expect.objectContaining({
                cwd: dir,
                arch: "linux-x64",
                skipViteBuild: true,
            }),
        );
        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
    });

    it("compiles nothing for vinext × node — the V8 compile cache is baked at docker build time", () => {
        const result = compileArtifactForDeploy(
            cfg({ build: "vinext", runtime: "node" }),
            dir,
        );

        expect(result.compiled).toBe(false);
        expect(buildVinextExecutable).not.toHaveBeenCalled();
        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
    });
});

describe("compiledExecPathFor", () => {
    it("names the standalone-bun exec + its source (entry file AND the whole tree) for the default cell", () => {
        const target = compiledExecPathFor(cfg(), dir);
        expect(target).toEqual({
            execPath: join(dir, "knext-standalone-exec-linux-x64"),
            sourcePath: join(dir, ".next", "standalone", "server.js"),
            sourceDirs: [join(dir, ".next", "standalone")],
            builderId: "turbopack",
            runtimeId: "bun",
        });
    });

    it("returns null for the node runtime — nothing to compile", () => {
        expect(
            compiledExecPathFor(
                cfg({ build: "turbopack", runtime: "node" }),
                dir,
            ),
        ).toBeNull();
    });

    it("names the vinext exec + its source, scoped to .output/server + .output/public — NEVER the whole .output root (#1414 rev-2)", () => {
        const target = compiledExecPathFor(cfg({ build: "vinext" }), dir);
        expect(target).toEqual({
            execPath: join(dir, "knext-exec-linux-x64"),
            sourcePath: join(dir, ".output", "server", "index.mjs"),
            sourceDirs: [
                join(dir, ".output", "server"),
                join(dir, ".output", "public"),
            ],
            builderId: "vinext",
            runtimeId: "bun",
        });
    });
});

describe("assertCompiledArtifactFresh — the --skip-build fail-closed guard (#1351: content-hash stamp, not mtime)", () => {
    it("THROWS when the exec is MISSING but the source exists", () => {
        standaloneServer();
        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(
            UsageError,
        );
        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(
            /missing/i,
        );
    });

    it("THROWS when the exec exists but has NO freshness stamp — cannot verify, fail closed", () => {
        standaloneServer();
        const execPath = join(dir, "knext-standalone-exec-linux-x64");
        writeFileSync(execPath, "");
        // No .buildstamp sidecar written — an exec from before this check
        // existed, or one copied in from elsewhere.

        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(
            UsageError,
        );
        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(/stamp/i);
    });

    it("THROWS when the stamp does not match the source's CURRENT content (stale) — even with a NEWER mtime, the mtime-spoofing case mtime comparison could not catch", () => {
        standaloneServer();
        const execPath = join(dir, "knext-standalone-exec-linux-x64");
        writeFileSync(execPath, "");
        writeFileSync(buildStampPathFor(execPath), "not-the-real-hash", "utf8");
        // Give the exec a mtime far NEWER than the source — under the OLD
        // mtime check this would have looked fresh. The content-hash stamp
        // must still catch it: content, not clock, is the ground truth.

        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(
            UsageError,
        );
        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(/stale/i);
    });

    it("does NOT throw when the stamp matches a hash of the tree's CURRENT content", () => {
        standaloneServer();
        const execPath = join(dir, "knext-standalone-exec-linux-x64");
        writeFileSync(execPath, "");
        const sourceDir = join(dir, ".next", "standalone");
        writeFileSync(
            buildStampPathFor(execPath),
            hashBuildIdentity([sourceDir], {
                builderId: "turbopack",
                runtimeId: "bun",
            }),
            "utf8",
        );

        expect(() => assertCompiledArtifactFresh(cfg(), dir)).not.toThrow();
    });

    it("compileArtifactForDeploy writes a stamp assertCompiledArtifactFresh then accepts, end to end", () => {
        standaloneServer();
        const execPath = join(dir, "knext-standalone-exec-linux-x64");
        // The mocked buildStandaloneExecutable only RETURNS a path — it does
        // not touch the filesystem, so create the exec file the same way the
        // real compile step would leave it before this test simulates a
        // --skip-build deploy reading it back.
        writeFileSync(execPath, "");

        compileArtifactForDeploy(cfg(), dir);

        expect(() => assertCompiledArtifactFresh(cfg(), dir)).not.toThrow();
    });

    it("a source edited AFTER compileArtifactForDeploy ran is caught as stale, even though the exec's mtime is still newer", () => {
        standaloneServer();
        const execPath = join(dir, "knext-standalone-exec-linux-x64");
        writeFileSync(execPath, "");
        compileArtifactForDeploy(cfg(), dir);

        // Edit the source in place — same mtime relationship a real
        // `git checkout`/rsync/tarball-extract false-negative would produce
        // (exec still looks newer), but the CONTENT changed.
        writeFileSync(
            join(dir, ".next", "standalone", "server.js"),
            "// edited after compile",
        );

        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(/stale/i);
    });

    it("#1414 reviewer repro: a NON-entry-file change (a page under .next/standalone/.next/server/app) is caught even though server.js is rewritten byte-identical — the entry-file-only hash could not see this", () => {
        standaloneServer();
        const execPath = join(dir, "knext-standalone-exec-linux-x64");
        writeFileSync(execPath, "");
        compileArtifactForDeploy(cfg(), dir);
        expect(() => assertCompiledArtifactFresh(cfg(), dir)).not.toThrow();

        // Change a page deep in the standalone tree — NOT server.js itself.
        mkdirSync(join(dir, ".next", "standalone", ".next", "server", "app"), {
            recursive: true,
        });
        writeFileSync(
            join(
                dir,
                ".next",
                "standalone",
                ".next",
                "server",
                "app",
                "page.js",
            ),
            "// changed page content",
        );
        // Rewrite server.js with the SAME bytes it already had — simulating
        // a build that regenerates the fixed launcher unchanged while the
        // app's own route code changed underneath it.
        writeFileSync(join(dir, ".next", "standalone", "server.js"), "");

        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(/stale/i);
    });

    it("#1414 vinext equivalent: a changed static asset under .output/public is caught even though index.mjs is rewritten byte-identical", () => {
        vinextOutput();
        const execPath = join(dir, "knext-exec-linux-x64");
        writeFileSync(execPath, "");
        compileArtifactForDeploy(cfg({ build: "vinext" }), dir);
        expect(() =>
            assertCompiledArtifactFresh(cfg({ build: "vinext" }), dir),
        ).not.toThrow();

        // Change a static asset under .output/public — NOT server/index.mjs.
        // This is the real vinext build-output location for such assets
        // (`.output/public/_next/static/<build-id>/...`); a top-level
        // `.output/_ssr` sibling is NOT hashed (#1414 rev-2 — see the
        // preflight-pollution regression test below for why).
        mkdirSync(join(dir, ".output", "public", "_next", "static"), {
            recursive: true,
        });
        writeFileSync(
            join(dir, ".output", "public", "_next", "static", "chunk-a.mjs"),
            "// changed static asset",
        );
        // Rewrite the entry with the SAME bytes it already had.
        writeFileSync(join(dir, ".output", "server", "index.mjs"), "");

        expect(() =>
            assertCompiledArtifactFresh(cfg({ build: "vinext" }), dir),
        ).toThrow(/stale/i);
    });

    it("rev-1414 review regression: writing knext's OWN preflight CR into .output between the stamp and the assert does NOT falsely mark a vinext --skip-build deploy stale", () => {
        // This is the real deploy.ts sequence, reproduced at the level this
        // suite already pins directly: `compileArtifactForDeploy` writes the
        // stamp during a fresh build (as `knext build` does); a LATER,
        // SEPARATE `knext deploy --skip-build` invocation first runs
        // `runPrunePreflight` (deploy.ts:368-369), which writes
        // `.output/nextapp-preflight-cr.yaml` directly under `.output` —
        // BEFORE `assertCompiledArtifactFresh` (deploy.ts:629) ever runs. A
        // full (non-skip-build) deploy does the same with
        // `.output/nextapp-cr.yaml` and `.output/buildx-metadata.json`
        // (deploy.ts:540, :960). Hashing the whole `.output` root meant this
        // ALWAYS failed as stale, on every non-dry-run vinext deploy,
        // regardless of whether anything about the actual build output
        // changed — never actually stale, just polluted by knext's own
        // bookkeeping files landing inside the hashed tree.
        vinextOutput();
        const execPath = join(dir, "knext-exec-linux-x64");
        writeFileSync(execPath, "");
        compileArtifactForDeploy(cfg({ build: "vinext" }), dir);

        // Simulate runPrunePreflight/the full-deploy CR/metadata writers —
        // all three land directly at the `.output` ROOT, never inside
        // `.output/server` or `.output/public`.
        writeFileSync(
            join(dir, ".output", "nextapp-preflight-cr.yaml"),
            "kind: NextApp\n",
        );
        writeFileSync(
            join(dir, ".output", "nextapp-cr.yaml"),
            "kind: NextApp\n",
        );
        writeFileSync(
            join(dir, ".output", "buildx-metadata.json"),
            '{"containerimage.digest":"sha256:deadbeef"}',
        );

        expect(() =>
            assertCompiledArtifactFresh(cfg({ build: "vinext" }), dir),
        ).not.toThrow();
    });

    it("a symlink under .next/standalone re-pointed to a DIFFERENT target is caught as stale — collectEntriesSorted hashes the link's target string (#1414 untested branch)", () => {
        standaloneServer();
        const execPath = join(dir, "knext-standalone-exec-linux-x64");
        writeFileSync(execPath, "");
        const linkPath = join(dir, ".next", "standalone", "asset-link");
        // Targets need not exist on disk — symlinkSync/readlinkSync only
        // ever deal in the link's TEXT, never follow it (see
        // collectEntriesSorted's doc comment: symlinks are hashed by where
        // they point, not by walking into the target).
        symlinkSync("original-target", linkPath);

        compileArtifactForDeploy(cfg(), dir);
        expect(() => assertCompiledArtifactFresh(cfg(), dir)).not.toThrow();

        // Re-point the SAME symlink to a different target — no file content
        // anywhere changed, only what the link resolves to.
        unlinkSync(linkPath);
        symlinkSync("different-target", linkPath);

        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(/stale/i);
    });

    it("is a no-op for the node runtime — nothing to compile, nothing to check", () => {
        // No exec, no source — would throw if this target needed a compile.
        expect(() =>
            assertCompiledArtifactFresh(
                cfg({ build: "turbopack", runtime: "node" }),
                dir,
            ),
        ).not.toThrow();
    });

    it("is a no-op when the SOURCE itself is missing — a different, already-reported failure", () => {
        // No standalone tree at all: #1184's own fail-fast check owns this
        // case elsewhere; this guard must not double-report it.
        expect(() => assertCompiledArtifactFresh(cfg(), dir)).not.toThrow();
    });
});
