/**
 * #2758 - a webpack `next build` rewrites `import.meta.url` to a string literal
 * `file:///<build machine path>/...`. @getknext/lib resolved ioredis (and
 * pino-pretty, @cerbos/grpc, minio) through `createRequire(import.meta.url)`, so
 * the build machine's absolute path shipped in the server chunk: a path leak, and
 * output that differs between two machines building the same commit.
 *
 * Both halves are asserted over a REAL build of the lib (tsup, the shipped
 * config) bundled by the webpack Next itself ships:
 *
 *   1. the chunk contains no absolute build path (neither this checkout's path
 *      nor any `file:///<abs>` literal), and
 *   2. ioredis still resolves at runtime from where the chunk is deployed, on
 *      Node AND Bun, and the unbundled dist still resolves lib-relative.
 *
 * A guard that only checks the absence of the path would be satisfied by a loader
 * that no longer loads anything; a guard that only checks the load would be
 * satisfied by the old leak. Hence both.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../../..");
const LIB = join(REPO, "packages/lib");
const KN_NEXT = join(REPO, "packages/kn-next");

let work = "";
let libCopy = "";
let dist = "";
let serverDir = "";
let chunkPath = "";
let chunkSource = "";
/** Where the lib's own dependencies live, i.e. what a deployed `node_modules` holds. */
let libNodeModules = "";

function run(cmd: string, args: string[], cwd: string, timeout = 120_000) {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The file in `dir` that defines `loadRedisCtor` (esbuild's chunk name is a content hash). */
function findLoaderChunk(dir: string): string {
    const hit = readdirSync(dir)
        .filter((f) => f.endsWith(".js"))
        .find((f) =>
            readFileSync(join(dir, f), "utf8").includes(
                "function loadRedisCtor",
            ),
        );
    if (!hit) throw new Error(`no chunk in ${dir} defines loadRedisCtor`);
    return join(dir, hit);
}

beforeAll(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), "knext-2758-")));

    // 1. Build the lib with its own shipped tsup config, from a copy so a
    //    concurrent test never sees a half-cleaned packages/lib/dist.
    libCopy = join(work, "packages/lib");
    mkdirSync(libCopy, { recursive: true });
    for (const f of ["package.json", "tsup.config.ts", "tsconfig.json"]) {
        cpSync(join(LIB, f), join(libCopy, f));
    }
    cpSync(join(LIB, "src"), join(libCopy, "src"), {
        recursive: true,
        filter: (p) => !p.includes("__tests__"),
    });
    libNodeModules = join(LIB, "node_modules");
    symlinkSync(libNodeModules, join(libCopy, "node_modules"));
    // The tsup config imports `tsup` itself: resolve it from the workspace root.
    symlinkSync(join(REPO, "node_modules"), join(work, "node_modules"));
    const built = run(join(REPO, "node_modules/.bin/tsup"), [], libCopy);
    if (built.code !== 0) throw new Error(`lib build failed:\n${built.out}`);
    dist = join(libCopy, "dist");

    // 2. Bundle the chunk that holds the ioredis loader with the webpack Next ships,
    //    shaped like a Next server build (node target, node: builtins external).
    const nextDir = join(
        createRequire(join(KN_NEXT, "package.json")).resolve(
            "next/package.json",
        ),
        "..",
    );
    const wp = createRequire(import.meta.url)(
        join(nextDir, "dist/compiled/webpack/webpack.js"),
    ) as {
        webpack?: unknown;
        default?: unknown;
    };
    const webpack = (wp.webpack ?? wp.default) as (cfg: unknown) => {
        run(
            cb: (
                e: Error | null,
                s?: { hasErrors(): boolean; toString(o: unknown): string },
            ) => void,
        ): void;
        close(cb: () => void): void;
    };

    // The deployed layout: <root>/node_modules (traced deps) beside <root>/server/chunks.
    const deployRoot = join(work, "standalone");
    serverDir = join(deployRoot, "server", "chunks");
    mkdirSync(serverDir, { recursive: true });
    symlinkSync(libNodeModules, join(deployRoot, "node_modules"));

    return new Promise<void>((done, fail) => {
        const compiler = webpack({
            mode: "production",
            target: "node",
            context: work,
            entry: { loader: findLoaderChunk(dist) },
            output: {
                path: serverDir,
                filename: "[name].js",
                libraryTarget: "commonjs2",
            },
            optimization: {
                minimize: false,
                moduleIds: "named",
                concatenateModules: false,
            },
            externals: [
                (
                    { request }: { request?: string },
                    cb: (e?: Error | null, r?: string) => void,
                ) =>
                    request &&
                    !request.startsWith(".") &&
                    !request.startsWith("/")
                        ? cb(null, `commonjs ${request}`)
                        : cb(),
            ],
            resolve: { extensions: [".js", ".mjs"] },
        });
        compiler.run((err, stats) => {
            compiler.close(() => {
                if (err) return fail(err);
                if (stats?.hasErrors())
                    return fail(
                        new Error(stats.toString({ all: false, errors: true })),
                    );
                chunkPath = join(serverDir, "loader.js");
                chunkSource = readFileSync(chunkPath, "utf8");
                // From here the build directory can no longer supply ioredis: only the
                // deployed layout (and, for the unbundled dist, the lib's own
                // node_modules, re-linked by those tests) can.
                rmSync(join(libCopy, "node_modules"), { force: true });
                rmSync(join(work, "node_modules"), { force: true });
                done();
            });
        });
    });
}, 180_000);

// A fresh, empty working directory INSIDE `work`, removed with it in afterAll
// (a plain mkdir, not mkdtemp: its lifetime is `work`'s).
let cwdCount = 0;
function freshCwd(): string {
    const dir = join(work, `cwd-${cwdCount++}`);
    mkdirSync(dir);
    return dir;
}

afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
});

describe("a webpack build of @getknext/lib carries no build machine path (#2758)", () => {
    it("the fixture really is a webpack bundle of the ioredis loader", () => {
        expect(existsSync(chunkPath)).toBe(true);
        expect(chunkSource).toContain("__webpack_require__");
        expect(chunkSource).toContain("loadRedisCtor");
    });

    it("contains no occurrence of the checkout or build directory", () => {
        for (const needle of [REPO, work]) {
            expect(chunkSource.includes(needle), `chunk leaks ${needle}`).toBe(
                false,
            );
        }
    });

    it("contains no absolute file: URL literal", () => {
        const literals = chunkSource.match(/file:\/\/\/[^\s"'`)]+/g) ?? [];
        expect(literals).toEqual([]);
    });
});

describe("the loader still resolves ioredis at runtime (#2758)", () => {
    // cwd is an EMPTY directory unrelated to the lib or the deployment, so a
    // resolution that only works from cwd, or from the build path, cannot pass.
    it("resolves from the bundled chunk's deployed location, under node", () => {
        const empty = freshCwd();
        const r = run("node", ["-e", probeScript(chunkPath)], empty, 30_000);
        expect(r.out).toContain("OK:function:wait");
    });

    it("resolves from the bundled chunk's deployed location, under bun", () => {
        const empty = freshCwd();
        const r = run(
            process.execPath,
            // --no-install: Bun would otherwise auto-install a package it cannot
            // find, which makes a broken anchor pass.
            ["--no-install", "-e", probeScript(chunkPath)],
            empty,
            30_000,
        );
        expect(r.out).toContain("OK:function:wait");
    });

    it("the unbundled dist still resolves ioredis relative to the lib, under node", () => {
        linkLibModules();
        const empty = freshCwd();
        const r = run(
            "node",
            ["--input-type=module", "-e", distProbe(findLoaderChunk(dist))],
            empty,
            30_000,
        );
        expect(r.out).toContain("OK:function:wait");
    });

    it("the unbundled dist still resolves ioredis relative to the lib, under bun", () => {
        linkLibModules();
        const empty = freshCwd();
        const r = run(
            process.execPath,
            // --no-install: Bun would otherwise auto-install a package it cannot
            // find, which makes a broken anchor pass.
            ["--no-install", "-e", distProbe(findLoaderChunk(dist))],
            empty,
            30_000,
        );
        expect(r.out).toContain("OK:function:wait");
    });
});

/**
 * Build a client through the lib's public path with an EMPTY runtime scope, which
 * selects the ioredis branch even under Bun (the Bun branch never reaches the
 * loader). Prints the constructed client's class name; nothing dials (lazyConnect).
 */
const BUILD = `const c = m.createRedisClient("redis://127.0.0.1:1", "t2758", {}, undefined, {});
console.log("OK:" + typeof c.ping + ":" + c.status); c.disconnect?.();`;

/** The lib's own dependency tree, as an installed package would have it beside dist/. */
function linkLibModules() {
    if (!existsSync(join(libCopy, "node_modules"))) {
        symlinkSync(libNodeModules, join(libCopy, "node_modules"));
    }
}

function probeScript(target: string): string {
    return `const m = require(${JSON.stringify(target)}); ${BUILD}`;
}

function distProbe(target: string): string {
    return `import(${JSON.stringify(`file://${target}`)}).then((m) => { ${BUILD} });`;
}
