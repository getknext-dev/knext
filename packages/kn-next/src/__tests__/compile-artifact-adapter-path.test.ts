/**
 * The call site of the Next.js < 16.4.0 `adapterPath` workaround.
 *
 * `compileArtifactForDeploy` is the one step `knext build`, `deploy` and
 * `preview` share between the project build and the image, so it is where the
 * standalone tree's runtime config is blanked -- for BOTH runtimes (the node
 * image ships the same tree) and, on bun, BEFORE the executable is compiled, so
 * the compiled binary bundles the blanked config rather than the original.
 *
 * The unit behaviour is `standalone-adapter-path.test.ts`; the served proof is
 * `standalone-adapter-path-404.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
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

/** What `server.js` held at the instant the compile ran. */
let serverAtCompile: string | undefined;
const buildStandaloneExecutable = mock<AnyFn>(
    (opts: { cwd: string; arch: string }) => {
        serverAtCompile = readFileSync(
            join(opts.cwd, ".next", "standalone", "server.js"),
            "utf8",
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

const ADAPTER = "/build/agent/adapter.mjs";

function cfg(over: Partial<KnativeNextConfig> = {}): KnativeNextConfig {
    return { name: "app", registry: "reg", ...over } as KnativeNextConfig;
}

/** An app dir holding a built standalone tree on the given Next.js version. */
function appWithStandalone(nextVersion: string): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-compile-adapterpath-"));
    tempRoots.push(dir);
    const standalone = join(dir, ".next", "standalone");
    mkdirSync(join(standalone, ".next"), { recursive: true });
    mkdirSync(join(standalone, "node_modules", "next"), { recursive: true });
    writeFileSync(
        join(standalone, "node_modules", "next", "package.json"),
        JSON.stringify({ name: "next", version: nextVersion }),
    );
    writeFileSync(
        join(standalone, "server.js"),
        `const nextConfig = ${JSON.stringify({ output: "standalone", adapterPath: ADAPTER })}\n`,
    );
    writeFileSync(
        join(standalone, ".next", "required-server-files.json"),
        JSON.stringify({ config: { adapterPath: ADAPTER } }, null, 2),
    );
    return dir;
}

const serverJs = (dir: string) =>
    readFileSync(join(dir, ".next", "standalone", "server.js"), "utf8");

beforeEach(() => {
    buildStandaloneExecutable.mockClear();
    serverAtCompile = undefined;
});

describe("compileArtifactForDeploy -- the adapterPath workaround", () => {
    it("node runtime: blanks the config the image will ship (Next 16.3.6)", () => {
        const dir = appWithStandalone("16.3.6");
        const result = compileArtifactForDeploy(cfg({ runtime: "node" }), dir);

        expect(result.compiled).toBe(false);
        expect(result.adapterPathWorkaround?.applied).toBe(true);
        expect(serverJs(dir)).toContain('"adapterPath":""');
        expect(serverJs(dir)).not.toContain(ADAPTER);
        expect(
            readFileSync(
                join(
                    dir,
                    ".next",
                    "standalone",
                    ".next",
                    "required-server-files.json",
                ),
                "utf8",
            ),
        ).not.toContain(ADAPTER);
        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
    });

    it("bun runtime: the config is blanked BEFORE the compile reads server.js", () => {
        const dir = appWithStandalone("16.3.6");
        const result = compileArtifactForDeploy(cfg({ runtime: "bun" }), dir);

        expect(result.compiled).toBe(true);
        expect(result.adapterPathWorkaround?.applied).toBe(true);
        expect(buildStandaloneExecutable).toHaveBeenCalledTimes(1);
        // The compile saw the blanked config, not the original.
        expect(serverAtCompile).toContain('"adapterPath":""');
        expect(serverAtCompile).not.toContain(ADAPTER);
    });

    it.each([
        "node",
        "bun",
    ] as const)("%s runtime: Next 16.4.0 is left byte-for-byte alone", (runtime) => {
        const dir = appWithStandalone("16.4.0");
        const before = serverJs(dir);
        const result = compileArtifactForDeploy(cfg({ runtime }), dir);

        expect(result.adapterPathWorkaround?.applied).toBe(false);
        expect(serverJs(dir)).toBe(before);
        if (runtime === "bun") expect(serverAtCompile).toBe(before);
    });

    it.each([
        "node",
        "bun",
    ] as const)("%s runtime: a config format the workaround cannot rewrite FAILS the build, compiling nothing", (runtime) => {
        const dir = appWithStandalone("16.3.6");
        writeFileSync(
            join(dir, ".next", "standalone", "server.js"),
            `const nextConfig = { adapterPath: '${ADAPTER}' }\n`,
        );
        expect(() => compileArtifactForDeploy(cfg({ runtime }), dir)).toThrow(
            "adapterPath",
        );
        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
    });

    it("does not inspect a standalone dir that has no server.js", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-compile-adapterpath-"));
        tempRoots.push(dir);
        mkdirSync(join(dir, ".next", "standalone"), { recursive: true });
        const result = compileArtifactForDeploy(cfg({ runtime: "node" }), dir);
        expect(result.adapterPathWorkaround).toBeUndefined();
    });
});
