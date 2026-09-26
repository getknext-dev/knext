/**
 * compile-embed (#1451) — the shared embed module for the self-contained
 * single executable, tested against REAL `Bun.build({ compile })` output on the
 * pinned Bun.
 *
 * Every fixture binary is COPIED ALONE into a fresh empty directory, the source
 * tree it was built from is DELETED, and it runs with that empty directory as
 * cwd: a module that resolves only because the build tree is still on disk
 * would otherwise pass (the `--bytecode` + `import.meta.dirname` trap from
 * oven-sh/bun#44059's verification).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifyBytecodeExec } from "../adapters/bytecode-exec-verify.mjs";
import {
    assertPathFidelity,
    embedBuildOptions,
    embeddedPath,
    planEmbed,
    unembeddedDynamicReport,
} from "../adapters/compile-embed.mjs";

const COMPILE_EMBED = resolve(
    import.meta.dirname,
    "../adapters/compile-embed.mjs",
);
const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(name: string): string {
    const d = mkdtempSync(join(tmpdir(), `knext-compile-embed-${name}-`));
    tempDirs.push(d);
    return d;
}

function writeTree(root: string, files: Record<string, string>): void {
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
    }
}

/** Build `entry` + the plan, copy the binary ALONE to an empty dir, delete the source tree. */
async function compileAlone(
    src: string,
    entry: string,
    include: string[],
    opts: {
        format?: "esm" | "cjs";
        bytecode?: boolean;
        exclude?: string[];
    } = {},
): Promise<{
    binary: string;
    runDir: string;
    relpaths: string[];
    bytes: Buffer;
}> {
    const plan = planEmbed({ root: src, include, exclude: opts.exclude });
    const out = tempDir("out");
    const built = await Bun.build(
        embedBuildOptions(plan, {
            entry: join(src, entry),
            outfile: join(out, "app"),
            format: opts.format ?? "esm",
            bytecode: opts.bytecode ?? false,
            includeSupported: false,
        }) as unknown as Parameters<typeof Bun.build>[0],
    );
    expect(built.success).toBe(true);
    const runDir = tempDir("run");
    const binary = join(runDir, "app");
    copyFileSync(join(out, "app"), binary);
    const bytes = readFileSync(binary);
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    return { binary, runDir, relpaths: plan.relpaths, bytes };
}

function run(binary: string, cwd: string, env: Record<string, string> = {}) {
    const r = spawnSync(binary, [], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: {
            PATH: process.env.PATH ?? "",
            TMPDIR: cwd,
            ...env,
        } as NodeJS.ProcessEnv,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const PROBE_IMPORT = `import { runEmbedProbe } from ${JSON.stringify(COMPILE_EMBED)};\nrunEmbedProbe();\n`;

describe("planEmbed", () => {
    function tree() {
        const root = tempDir("plan");
        writeTree(root, {
            "routes/home.js": "",
            "routes/about.mjs": "",
            "chunks/a.cjs": "",
            "chunks/deep/b.js": "",
            "chunks/deep/c.ts": "",
            "chunks/data.json": "{}",
            "chunks/skip.test.js": "",
            "node_modules/x/index.js": "",
            "other.js": "",
        });
        return root;
    }

    it("expands literal files, directories (recursive) and globs; sorted, deduplicated, relative to root", () => {
        const root = tree();
        const plan = planEmbed({
            root,
            include: [
                "other.js",
                "routes",
                "chunks/**/*.{js,cjs}",
                "routes/home.js",
            ],
        });
        expect(plan.relpaths).toEqual([
            "chunks/a.js",
            "chunks/deep/b.js",
            "chunks/skip.test.js",
            "other.js",
            "routes/about.js",
            "routes/home.js",
        ]);
        expect(plan.entrypoints).toEqual(
            [
                "chunks/a.cjs",
                "chunks/deep/b.js",
                "chunks/skip.test.js",
                "other.js",
                "routes/about.mjs",
                "routes/home.js",
            ].map((r) => join(root, r)),
        );
    });

    it("applies exclude globs, never descends into node_modules, and reports what it did not embed", () => {
        const root = tree();
        const plan = planEmbed({
            root,
            include: ["chunks", "node_modules"],
            exclude: ["**/*.test.js"],
        });
        expect(plan.relpaths).toEqual([
            "chunks/a.js",
            "chunks/deep/b.js",
            "chunks/deep/c.js",
        ]);
        expect(plan.report.excluded).toEqual(["chunks/skip.test.js"]);
        expect(plan.report.nonModule).toEqual(["chunks/data.json"]);
        expect(plan.report.unmatched).toEqual(["node_modules"]);
    });

    it("maps a JS/TS source to the path Bun embeds it at ([dir]/[name].js)", () => {
        expect(embeddedPath("a/b.cjs")).toBe("a/b.js");
        expect(embeddedPath("a/b.mjs")).toBe("a/b.js");
        expect(embeddedPath("a/b.tsx")).toBe("a/b.js");
        expect(embeddedPath("a/b.js")).toBe("a/b.js");
    });

    it("fails closed on a missing literal path, a path outside root, and two sources embedding at one path", () => {
        const root = tree();
        expect(() => planEmbed({ root, include: ["nope.js"] })).toThrow(
            /nope\.js/,
        );
        expect(() => planEmbed({ root, include: ["../escape.js"] })).toThrow(
            /outside/,
        );
        writeTree(root, { "routes/home.cjs": "" });
        expect(() => planEmbed({ root, include: ["routes"] })).toThrow(
            /routes\/home\.js/,
        );
    });

    it("embedBuildOptions: extra entrypoints + hash-free [dir]/[name].[ext] naming, or compile.include when supported", () => {
        const root = tree();
        const plan = planEmbed({ root, include: ["routes"] });
        const entry = join(root, "other.js");
        const fallback = embedBuildOptions(plan, {
            entry,
            outfile: "/o/app",
            includeSupported: false,
        }) as {
            entrypoints: string[];
            root: string;
            naming: string;
            compile: { outfile: string; include?: string[] };
        };
        expect(fallback.entrypoints).toEqual([entry, ...plan.entrypoints]);
        expect(fallback.root).toBe(root);
        expect(fallback.naming).toBe("[dir]/[name].[ext]");
        expect(fallback.compile.include).toBeUndefined();
        const native = embedBuildOptions(plan, {
            entry,
            outfile: "/o/app",
            includeSupported: true,
        }) as typeof fallback;
        expect(native.entrypoints).toEqual([entry]);
        expect(native.compile.include).toEqual(plan.entrypoints);
        expect(() =>
            embedBuildOptions(plan, {
                entry: "/elsewhere/e.js",
                outfile: "/o/app",
                includeSupported: false,
            }),
        ).toThrow(/outside/);
    });
});

describe("compiled from an EMPTY dir on the pinned Bun (extra entrypoints)", () => {
    it("(1) a computed import(join(import.meta.dirname, …)) and a nested path resolve; (4) an unplanned file does not", async () => {
        const src = tempDir("esm");
        writeTree(src, {
            "main.mjs":
                PROBE_IMPORT +
                'import { join } from "node:path";\n' +
                'const r = await import(join(import.meta.dirname, "routes", (process.env.ROUTE ?? "home") + ".js"));\n' +
                'const n = await import(join(import.meta.dirname, "a/b", "c" + ".js"));\n' +
                'let neg = "not-loaded";\n' +
                'try { await import(join(import.meta.dirname, "outside" + ".js")); neg = "LOADED"; } catch (e) { neg = "not-loaded: " + e.message.split("\\n")[0]; }\n' +
                'console.log("RESULT " + JSON.stringify({ route: r.default, nested: n.default, neg }));\n',
            "routes/home.js": 'export default "home-ok";\n',
            "a/b/c.js": 'export default "nested-ok";\n',
            "outside.js": 'export default "must-not-load";\n',
        });
        const { binary, runDir, relpaths } = await compileAlone(
            src,
            "main.mjs",
            ["routes", "a"],
        );
        expect(existsSync(src)).toBe(false);
        expect(relpaths).toEqual(["a/b/c.js", "routes/home.js"]);

        const { status, out } = run(binary, runDir);
        expect(status, out).toBe(0);
        const result = JSON.parse(/^RESULT (.*)$/m.exec(out)?.[1] ?? "null");
        expect(result.route).toBe("home-ok");
        expect(result.nested).toBe("nested-ok");
        expect(result.neg).toMatch(/^not-loaded: .*\$bunfs\/root\/outside\.js/);

        // (2) the path-fidelity probe: every planned relpath is at $bunfs/root/<relpath>,
        // and an unplanned one is reported missing (the probe can see red).
        expect(assertPathFidelity(binary, relpaths)).toEqual({
            ok: true,
            missing: [],
        });
        expect(
            assertPathFidelity(binary, [...relpaths, "outside.js", "a/c.js"]),
        ).toEqual({
            ok: false,
            missing: ["outside.js", "a/c.js"],
        });
    }, 120_000);

    it("(1b) CJS: a relative computed require resolves; require(join(__dirname, …)) does NOT on stock Bun (__dirname is the BUILD dir)", async () => {
        // Measured on Bun 1.4.2: the bundler inlines `__dirname`/`__filename` in
        // every embedded CommonJS module as the BUILD directory's absolute path,
        // with and without --bytecode, in both output formats. The runtime value
        // (`eval("__dirname")`) is correct — `/$bunfs/root/<dir>` — but the
        // bundled code never reads it. This test PINS that: if it goes red
        // because the join form now resolves, Bun stopped inlining `__dirname`
        // and the Next-track anchor rewrite (N1) may be unnecessary.
        const src = tempDir("cjs");
        writeTree(src, {
            "main.cjs":
                'const { dirname, join } = require("node:path");\n' +
                'const loader = require(join(dirname(process.argv[1]), "chunks", "loader.cjs"));\n' +
                "const out = {};\n" +
                'try { out.relative = loader.relative("n1"); } catch (e) { out.relative = "ERR " + e.message.split("\\n")[0]; }\n' +
                'try { out.dirnameJoin = loader.dirnameJoin("n1"); } catch (e) { out.dirnameJoin = "ERR " + e.message.split("\\n")[0]; }\n' +
                "out.inlinedDirname = loader.inlinedDirname;\n" +
                'out.runtimeDirname = require(join(dirname(process.argv[1]), "chunks", "rt.cjs"));\n' +
                'console.log("RESULT " + JSON.stringify(out));\n',
            "chunks/loader.cjs":
                'const { join } = require("node:path");\n' +
                'exports.relative = (n) => require("./" + n + ".cjs");\n' +
                'exports.dirnameJoin = (n) => require(join(__dirname, n + ".cjs"));\n' +
                "exports.inlinedDirname = __dirname;\n",
            // Never names `__dirname` as an identifier, so the bundler declares no
            // inlined copy and `eval` reads the runtime module wrapper's value.
            "chunks/rt.cjs": 'module.exports = eval("__dir" + "name");\n',
            "chunks/n1.cjs": 'module.exports = "n1-ok";\n',
        });
        // Bun inlines the REAL path of the build directory.
        const buildDir = join(realpathSync(src), "chunks");
        const { binary, runDir, relpaths } = await compileAlone(
            src,
            "main.cjs",
            ["chunks"],
            {
                format: "cjs",
            },
        );
        expect(relpaths).toEqual([
            "chunks/loader.js",
            "chunks/n1.js",
            "chunks/rt.js",
        ]);
        const { status, out } = run(binary, runDir);
        expect(status, out).toBe(0);
        const result = JSON.parse(/^RESULT (.*)$/m.exec(out)?.[1] ?? "null");
        expect(result.relative).toBe("n1-ok");
        expect(result.runtimeDirname).toBe("/$bunfs/root/chunks");
        expect(result.inlinedDirname).toBe(buildDir);
        expect(result.dirnameJoin).toMatch(/^ERR Cannot find module/);
        expect(result.dirnameJoin).toContain(buildDir);
    }, 120_000);

    it("(3) --bytecode: an INCLUDED, lazily-loaded module carries bytecode (verifyBytecodeExec); the same build without it does not", async () => {
        const marker = `knext-embed-bytecode:${crypto.randomUUID()}`;
        const files = (dir: string) =>
            writeTree(dir, {
                // Resolved relative to the module, not via import.meta.dirname.
                "main.cjs":
                    'const n = process.env.ROUTE || "home";\n' +
                    'console.log("RESULT " + require("./routes/" + n + ".cjs")());\n',
                "routes/home.cjs": `const MARK = ${JSON.stringify(marker)};\nmodule.exports = () => "home-ok " + MARK;\n`,
            });
        const withBc = tempDir("bc");
        files(withBc);
        const bc = await compileAlone(withBc, "main.cjs", ["routes"], {
            format: "cjs",
            bytecode: true,
        });
        const ran = run(bc.binary, bc.runDir);
        expect(ran.status, ran.out).toBe(0);
        expect(ran.out).toContain(`RESULT home-ok ${marker}`);
        // The marker lives ONLY in the included module, so the verifier's pragma
        // check reads that module's own `// @bun @bytecode @bun-cjs` header.
        expect(verifyBytecodeExec(new Uint8Array(bc.bytes), marker)).toEqual({
            ok: true,
        });

        const noBc = tempDir("nobc");
        files(noBc);
        const plain = await compileAlone(noBc, "main.cjs", ["routes"], {
            format: "cjs",
            bytecode: false,
        });
        const verdict = verifyBytecodeExec(new Uint8Array(plain.bytes), marker);
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(
            /WITHOUT --bytecode/,
        );
    }, 120_000);
});

describe("unembeddedDynamicReport", () => {
    it("lists modules whose require/import target is computed, skipping literal-only modules and node_modules", () => {
        const dir = tempDir("report");
        writeTree(dir, {
            "index.mjs":
                'import a from "./a.mjs";\nconst m = await import("./chunks/" + name);\n',
            "literal.mjs":
                'import x from "./x.mjs";\nconst y = await import("./y.mjs");\nrequire("z");\n',
            "chunks/rolldown.mjs":
                'import { createRequire } from "node:module";\nvar __require = createRequire(import.meta.url);\nconst p = __require(pkgName);\n',
            "chunks/cjs.cjs":
                "module.exports = (n) => require(__dirname + '/' + n);\n",
            "chunks/data.json": '{"require(x)": 1}',
            "node_modules/pkg/index.js": "require(anything);\n",
        });
        expect(unembeddedDynamicReport(dir)).toEqual([
            {
                file: "chunks/cjs.cjs",
                computedSites: 1,
                dynamicRequireBindings: [],
            },
            {
                file: "chunks/rolldown.mjs",
                computedSites: 0,
                dynamicRequireBindings: ["__require"],
            },
            { file: "index.mjs", computedSites: 1, dynamicRequireBindings: [] },
        ]);
    });
});
