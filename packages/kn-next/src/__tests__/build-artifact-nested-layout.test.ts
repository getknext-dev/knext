/**
 * The shared compile step (`compileArtifactForDeploy`) and the freshness probe
 * (`compiledExecPathFor`) under a deliberate monorepo root.
 *
 * With `outputFileTracingRoot` set above the app, Next writes
 * `.next/standalone/<app path>/server.js` and the traced workspace files beside
 * it. Every consumer of "where is the server" has to follow, or `build`,
 * `deploy` and `preview` each disagree about it:
 *
 *   - the bun-export heal walks BOTH the hoisted `node_modules` at the tree
 *     root and the app's own under the nested directory;
 *   - the "no server to compile" check looks at the nested path;
 *   - the compiled executable is built from the nested server;
 *   - the freshness stamp's source path is the nested server.
 *
 * The flat layout, and an ACCIDENTAL nested one (no explicit root), keep their
 * previous behaviour.
 */

import { afterAll, describe, expect, it, mock } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

// The real executable build shells out to `bun build --compile`; this test is
// about WHICH server it is handed, so record the call and write a placeholder.
const execBuilds: Array<{ cwd: string; arch: string }> = [];
const __real = { ...(await import("../cli/standalone-exec-build")) };
mock.module("../cli/standalone-exec-build", () => ({
    ...__real,
    buildStandaloneExecutable: (opts: { cwd: string; arch: string }) => {
        execBuilds.push({ cwd: opts.cwd, arch: opts.arch });
        const out = join(opts.cwd, __real.standaloneExecFileName(opts.arch));
        writeFileSync(out, "binary");
        return out;
    },
}));

const { compileArtifactForDeploy, compiledExecPathFor } = await import(
    "../cli/build-artifact"
);

const WEB_CONFIG = `const path = require("node:path");
module.exports = {
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "..", ".."),
    turbopack: { root: path.join(__dirname, "..", "..") },
};
`;

const REACT_DOM = {
    name: "fake-react-dom",
    version: "19.9.9",
    exports: {
        "./server": {
            bun: "./server.bun.js",
            node: "./server.node.js",
            default: "./server.node.js",
        },
    },
};

function tree(files: Record<string, string>): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "knext-nested-")));
    tempRoots.push(base);
    for (const [rel, contents] of Object.entries(files)) {
        const abs = join(base, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents);
    }
    return base;
}

const cfg = (runtime: "bun" | "node") =>
    ({
        name: "web",
        registry: "r",
        build: "turbopack",
        runtime,
    }) as never;

/** A workspace after `next build` with an explicit root above `apps/web`. */
function nestedWorkspace(extra: Record<string, string> = {}): string {
    return tree({
        "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
        "apps/web/package.json": "{}",
        "apps/web/next.config.js": WEB_CONFIG,
        // The hoisted source package, one level above the app.
        "node_modules/fake-react-dom/package.json": JSON.stringify(REACT_DOM),
        "node_modules/fake-react-dom/server.node.js": "module.exports='n';\n",
        "node_modules/fake-react-dom/server.bun.js": "module.exports='b';\n",
        // Traced copies: one hoisted at the tree root, one in the app's own
        // node_modules under the nested directory. Neither has the bun target.
        "apps/web/.next/standalone/node_modules/fake-react-dom/package.json":
            JSON.stringify(REACT_DOM),
        "apps/web/.next/standalone/node_modules/fake-react-dom/server.node.js":
            "module.exports='n';\n",
        "apps/web/.next/standalone/apps/web/node_modules/fake-react-dom/package.json":
            JSON.stringify(REACT_DOM),
        "apps/web/.next/standalone/apps/web/node_modules/fake-react-dom/server.node.js":
            "module.exports='n';\n",
        "apps/web/.next/standalone/apps/web/server.js": "// nested server\n",
        ...extra,
    });
}

describe("compileArtifactForDeploy with a deliberate monorepo root", () => {
    it("heals the bun-condition targets under the tree root AND under the nested app directory", () => {
        const base = nestedWorkspace();
        const app = join(base, "apps", "web");
        const result = compileArtifactForDeploy(cfg("node"), app);
        expect(result.compiled).toBe(false);
        expect(result.healed).toBeDefined();
        const standalone = join(app, ".next", "standalone");
        expect(
            existsSync(
                join(
                    standalone,
                    "node_modules",
                    "fake-react-dom",
                    "server.bun.js",
                ),
            ),
        ).toBe(true);
        expect(
            existsSync(
                join(
                    standalone,
                    "apps",
                    "web",
                    "node_modules",
                    "fake-react-dom",
                    "server.bun.js",
                ),
            ),
        ).toBe(true);
        expect(result.healed?.copied.length).toBe(2);
    });

    it("compiles the executable when the NESTED server is there, and stamps it", () => {
        const base = nestedWorkspace();
        const app = join(base, "apps", "web");
        execBuilds.length = 0;
        const result = compileArtifactForDeploy(cfg("bun"), app);
        expect(result.compiled).toBe(true);
        expect(execBuilds).toEqual([{ cwd: app, arch: "linux-x64" }]);
        expect(existsSync(`${result.binaryPath}.buildstamp`)).toBe(true);
    });

    it("names the NESTED path when the server is missing, not the flat one", () => {
        const base = nestedWorkspace();
        const app = join(base, "apps", "web");
        rmSync(join(app, ".next", "standalone", "apps", "web", "server.js"));
        execBuilds.length = 0;
        let message = "";
        try {
            compileArtifactForDeploy(cfg("bun"), app);
        } catch (err) {
            message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain(
            join("standalone", "apps", "web", "server.js"),
        );
        expect(execBuilds).toEqual([]);
    });

    it("compiledExecPathFor probes the nested server, and the whole standalone tree for the stamp", () => {
        const base = nestedWorkspace();
        const app = join(base, "apps", "web");
        const probe = compiledExecPathFor(cfg("bun"), app);
        expect(probe?.sourcePath).toBe(
            join(app, ".next", "standalone", "apps", "web", "server.js"),
        );
        expect(probe?.sourceDirs).toEqual([join(app, ".next", "standalone")]);
        expect(probe?.execPath).toBe(
            join(app, "knext-standalone-exec-linux-x64"),
        );
    });
});

describe("the flat layout and the accidental nested layout keep their behaviour", () => {
    it("flat: the compile step probes .next/standalone/server.js", () => {
        const base = tree({
            "app/package.json": "{}",
            "app/.next/standalone/server.js": "// flat\n",
        });
        const app = join(base, "app");
        expect(compiledExecPathFor(cfg("bun"), app)?.sourcePath).toBe(
            join(app, ".next", "standalone", "server.js"),
        );
        execBuilds.length = 0;
        const result = compileArtifactForDeploy(cfg("bun"), app);
        expect(result.compiled).toBe(true);
        expect(execBuilds).toEqual([{ cwd: app, arch: "linux-x64" }]);
    });

    it("a stray parent lockfile + nested output, NO explicit root: still fails with the real cause", () => {
        const base = tree({
            "package-lock.json": "{}",
            "app/package.json": "{}",
            "app/next.config.js":
                'module.exports = { output: "standalone" };\n',
            "app/.next/standalone/app/server.js": "// nested by accident\n",
        });
        const app = join(base, "app");
        execBuilds.length = 0;
        let message = "";
        try {
            compileArtifactForDeploy(cfg("bun"), app);
        } catch (err) {
            message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain(join(base, "package-lock.json"));
        expect(message).toMatch(/outputFileTracingRoot/);
        expect(execBuilds).toEqual([]);
        // The accidental tree was not packaged on the way to failing.
        expect(existsSync(join(app, "knext-standalone-exec-linux-x64"))).toBe(
            false,
        );
        expect(readFileSync(join(app, "package.json"), "utf8")).toBe("{}");
    });
});
