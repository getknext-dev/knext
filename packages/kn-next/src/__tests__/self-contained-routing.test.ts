/**
 * `--self-contained` routing: ONE resolved boolean reaches both compile paths
 * as an explicit option. Off (the default) the options each path receives
 * deep-equal the shape they had before the flag existed.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    mock,
    spyOn,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnativeNextConfig } from "../config";

// biome-ignore lint/suspicious/noExplicitAny: thin mock plumbing
type AnyFn = (...args: any[]) => any;

const buildStandaloneExecutable = mock<AnyFn>(
    (o: { cwd: string; arch: string }) =>
        join(o.cwd, `knext-standalone-exec-${o.arch}`),
);
const __realSb = { ...(await import("../cli/standalone-exec-build")) };
mock.module("../cli/standalone-exec-build", () => ({
    ...__realSb,
    buildStandaloneExecutable: (...a: unknown[]) =>
        buildStandaloneExecutable(...a),
    standaloneExecFileName: (arch: string) => `knext-standalone-exec-${arch}`,
}));
const buildVinextExecutable = mock<AnyFn>((o: { cwd: string; arch: string }) =>
    join(o.cwd, `knext-exec-${o.arch}`),
);
const __realVb = { ...(await import("../cli/vinext-build")) };
mock.module("../cli/vinext-build", () => ({
    ...__realVb,
    buildVinextExecutable: (...a: unknown[]) => buildVinextExecutable(...a),
}));
mock.module("../adapters/standalone-bun-exports", () => ({
    healBunExportTargets: () => ({ copied: [], skipped: [] }),
}));

let current: Record<string, unknown> = {};
const __real = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    ...__real,
    loadConfig: mock(async () => current),
}));
const __realUp = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    ...__realUp,
    uploadAssets: mock(async () => {}),
}));

const { compileArtifactForDeploy } = await import("../cli/build-artifact");
const { build, buildMain } = await import("../cli/build");

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-f5-route-"));
    buildStandaloneExecutable.mockClear();
    buildVinextExecutable.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function standaloneTree(): void {
    mkdirSync(join(dir, ".next", "standalone"), { recursive: true });
    writeFileSync(join(dir, ".next", "standalone", "server.js"), "");
}
function vinextTree(): void {
    mkdirSync(join(dir, ".output", "server"), { recursive: true });
    writeFileSync(join(dir, ".output", "server", "index.mjs"), "");
}
const cfg = (over: Partial<KnativeNextConfig> = {}): KnativeNextConfig =>
    ({ name: "app", registry: "reg", ...over }) as KnativeNextConfig;

describe("compileArtifactForDeploy routes selfContained explicitly", () => {
    it("standalone: OFF ⇒ options deep-equal the pre-flag shape", () => {
        standaloneTree();
        compileArtifactForDeploy(
            cfg({ build: "turbopack", runtime: "bun" }),
            dir,
        );
        expect(buildStandaloneExecutable.mock.calls[0]?.[0]).toEqual({
            cwd: dir,
            arch: "linux-x64",
        });
    });
    it("standalone: config true ⇒ option carried", () => {
        standaloneTree();
        compileArtifactForDeploy(
            cfg({ build: "turbopack", runtime: "bun", selfContained: true }),
            dir,
        );
        expect(buildStandaloneExecutable.mock.calls[0]?.[0]).toEqual({
            cwd: dir,
            arch: "linux-x64",
            selfContained: true,
        });
    });
    it("vinext: OFF ⇒ options deep-equal the pre-flag shape", () => {
        vinextTree();
        compileArtifactForDeploy(cfg({ build: "vinext" }), dir);
        expect(buildVinextExecutable.mock.calls[0]?.[0]).toEqual({
            cwd: dir,
            arch: "linux-x64",
            skipViteBuild: true,
        });
    });
    it("vinext: config true ⇒ option carried", () => {
        vinextTree();
        compileArtifactForDeploy(
            cfg({ build: "vinext", selfContained: true }),
            dir,
        );
        expect(buildVinextExecutable.mock.calls[0]?.[0]).toEqual({
            cwd: dir,
            arch: "linux-x64",
            skipViteBuild: true,
            selfContained: true,
        });
    });
    it("an explicit option overrides the config key, both directions", () => {
        standaloneTree();
        compileArtifactForDeploy(
            cfg({ build: "turbopack", runtime: "bun", selfContained: false }),
            dir,
            { selfContained: true },
        );
        expect(buildStandaloneExecutable.mock.calls[0]?.[0].selfContained).toBe(
            true,
        );
        buildStandaloneExecutable.mockClear();
        compileArtifactForDeploy(
            cfg({ build: "turbopack", runtime: "bun", selfContained: true }),
            dir,
            { selfContained: false },
        );
        expect(buildStandaloneExecutable.mock.calls[0]?.[0]).toEqual({
            cwd: dir,
            arch: "linux-x64",
        });
    });
});

describe("knext build --self-contained", () => {
    it("the CLI flag routes to the standalone path", async () => {
        standaloneTree();
        current = { name: "app", build: "turbopack", runtime: "bun" };
        spyOn(process, "cwd").mockReturnValue(dir);
        expect(await buildMain(["--skip-next", "--self-contained"])).toBe(0);
        expect(buildStandaloneExecutable.mock.calls[0]?.[0].selfContained).toBe(
            true,
        );
    });
    it("the CLI flag wins over selfContained:false in config", async () => {
        standaloneTree();
        current = {
            name: "app",
            build: "turbopack",
            runtime: "bun",
            selfContained: false,
        };
        spyOn(process, "cwd").mockReturnValue(dir);
        await build({ skipNextBuild: true, selfContained: true });
        expect(buildStandaloneExecutable.mock.calls[0]?.[0].selfContained).toBe(
            true,
        );
    });
    it("the config key alone routes when the flag is absent", async () => {
        standaloneTree();
        current = {
            name: "app",
            build: "turbopack",
            runtime: "bun",
            selfContained: true,
        };
        spyOn(process, "cwd").mockReturnValue(dir);
        await build({ skipNextBuild: true });
        expect(buildStandaloneExecutable.mock.calls[0]?.[0].selfContained).toBe(
            true,
        );
    });
    it("OFF by default: nothing carries the option", async () => {
        standaloneTree();
        current = { name: "app", build: "turbopack", runtime: "bun" };
        spyOn(process, "cwd").mockReturnValue(dir);
        await build({ skipNextBuild: true });
        expect(buildStandaloneExecutable.mock.calls[0]?.[0]).toEqual({
            cwd: dir,
            arch: "linux-x64",
        });
    });
});
