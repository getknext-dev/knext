/**
 * The CDN routing artifact reaches the standalone tree through the SAME shared
 * step `knext build`, `deploy` and `preview` all run (`compileArtifactForDeploy`).
 *
 * `onBuildComplete` writes `knext-cdn-routing.json` into the project's `.next`
 * before Next writes the standalone directory, and Next copies only the files it
 * traced, so the build must stage the file into `.next/standalone/.next/` itself:
 * for the node image (which ships that tree), and on Bun BEFORE the executable is
 * compiled (the compile embeds every `.json` under `.next`).
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnativeNextConfig } from "../config";

// biome-ignore lint/suspicious/noExplicitAny: thin mock plumbing
type AnyFn = (...args: any[]) => any;

/** Whether the artifact was already in the standalone tree when the compile ran. */
let stagedAtCompile: boolean | undefined;
const buildStandaloneExecutable = mock<AnyFn>(
    (opts: { cwd: string; arch: string }) => {
        stagedAtCompile = existsSync(
            join(
                opts.cwd,
                ".next",
                "standalone",
                ".next",
                "knext-cdn-routing.json",
            ),
        );
        return join(opts.cwd, `knext-standalone-exec-${opts.arch}`);
    },
);
mock.module("../cli/standalone-exec-build", () => ({
    buildStandaloneExecutable: (...a: unknown[]) =>
        buildStandaloneExecutable(...a),
    standaloneExecFileName: (arch: string) => `knext-standalone-exec-${arch}`,
}));
mock.module("../cli/vinext-build", () => ({
    buildVinextExecutable: () => "",
    stageSharpForVinextNode: () => ({ staged: true }),
    stageOgHarfbuzzForVinextNode: () => ({ staged: [], warnings: [] }),
}));

const { compileArtifactForDeploy } = await import("../cli/build-artifact");

const tempRoots: string[] = [];
afterAll(() => {
    for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
});

const ARTIFACT = JSON.stringify({
    version: 1,
    conditional: [],
    basePath: "",
    i18n: null,
    middleware: "none",
});

function cfg(over: Partial<KnativeNextConfig> = {}): KnativeNextConfig {
    return { name: "app", registry: "reg", ...over } as KnativeNextConfig;
}

function app(withArtifact: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-compile-cdn-"));
    tempRoots.push(dir);
    const standalone = join(dir, ".next", "standalone");
    mkdirSync(join(standalone, ".next"), { recursive: true });
    mkdirSync(join(standalone, "node_modules", "next"), { recursive: true });
    writeFileSync(
        join(standalone, "node_modules", "next", "package.json"),
        JSON.stringify({ name: "next", version: "16.4.0" }),
    );
    writeFileSync(
        join(standalone, "server.js"),
        `const nextConfig = ${JSON.stringify({ output: "standalone" })}\n`,
    );
    if (withArtifact) {
        writeFileSync(join(dir, ".next", "knext-cdn-routing.json"), ARTIFACT);
    }
    return dir;
}

const staged = (dir: string) =>
    join(dir, ".next", "standalone", ".next", "knext-cdn-routing.json");

beforeEach(() => {
    buildStandaloneExecutable.mockClear();
    stagedAtCompile = undefined;
});

describe("compileArtifactForDeploy stages the CDN routing artifact", () => {
    it("node runtime: copies it into the standalone tree the image ships", () => {
        const dir = app(true);
        compileArtifactForDeploy(cfg({ runtime: "node" }), dir);
        expect(readFileSync(staged(dir), "utf8")).toBe(ARTIFACT);
        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
    });

    it("bun runtime: it is in the tree BEFORE the executable is compiled", () => {
        const dir = app(true);
        compileArtifactForDeploy(cfg({ runtime: "bun" }), dir);
        expect(buildStandaloneExecutable).toHaveBeenCalledTimes(1);
        expect(stagedAtCompile).toBe(true);
        expect(readFileSync(staged(dir), "utf8")).toBe(ARTIFACT);
    });

    it("a build with no artifact (an older adapter) stages nothing and still compiles", () => {
        const dir = app(false);
        compileArtifactForDeploy(cfg({ runtime: "bun" }), dir);
        expect(existsSync(staged(dir))).toBe(false);
        expect(stagedAtCompile).toBe(false);
        expect(buildStandaloneExecutable).toHaveBeenCalledTimes(1);
    });
});
