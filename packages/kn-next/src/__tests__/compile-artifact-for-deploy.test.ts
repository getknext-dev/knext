/**
 * #1339 review round 2, finding #1 (jev 0.90, BLOCKER) — `kn-next deploy`/
 * `preview` never compiled the standalone bun exec (or the vinext exec):
 * `runtime-image.ts` picks `standalone-bun` and stages a Dockerfile that
 * unconditionally `COPY`s `knext-standalone-exec-<arch>`, but only
 * `build.ts` ever called `buildStandaloneExecutable`/`buildVinextExecutable`
 * — a bare-config deploy either failed the docker build (no such file) or
 * shipped a STALE binary left over from an earlier `kn-next build`.
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
    utimesSync,
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
    compileArtifactForDeploy,
    compiledExecPathFor,
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
    it("names the standalone-bun exec + its source for the default cell", () => {
        const target = compiledExecPathFor(cfg(), dir);
        expect(target).toEqual({
            execPath: join(dir, "knext-standalone-exec-linux-x64"),
            sourcePath: join(dir, ".next", "standalone", "server.js"),
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

    it("names the vinext exec + its source for build: 'vinext'", () => {
        const target = compiledExecPathFor(cfg({ build: "vinext" }), dir);
        expect(target).toEqual({
            execPath: join(dir, "knext-exec-linux-x64"),
            sourcePath: join(dir, ".output", "server", "index.mjs"),
        });
    });
});

describe("assertCompiledArtifactFresh — the --skip-build fail-closed guard", () => {
    it("THROWS when the exec is MISSING but the source exists", () => {
        standaloneServer();
        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(
            UsageError,
        );
        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(
            /missing/i,
        );
    });

    it("THROWS when the exec is STALE (older than its source)", () => {
        standaloneServer();
        const execPath = join(dir, "knext-standalone-exec-linux-x64");
        writeFileSync(execPath, "");
        const past = new Date(Date.now() - 60_000);
        utimesSync(execPath, past, past);
        // Bump the source's mtime to NOW, after the (stale) exec.
        utimesSync(
            join(dir, ".next", "standalone", "server.js"),
            new Date(),
            new Date(),
        );

        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(
            UsageError,
        );
        expect(() => assertCompiledArtifactFresh(cfg(), dir)).toThrow(/older/i);
    });

    it("does NOT throw when the exec is fresh (newer than its source)", () => {
        standaloneServer();
        const execPath = join(dir, "knext-standalone-exec-linux-x64");
        // Compile AFTER the source — same order a real build follows.
        writeFileSync(execPath, "");

        expect(() => assertCompiledArtifactFresh(cfg(), dir)).not.toThrow();
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
