/**
 * `compile.include` with the opt-in knext-patched Bun toolchain
 * (`compile: { bun: 'knext-patched', include: [...] }`).
 *
 * The two modes share ONE config and ONE plan: `planIncludes` expands the
 * globs and runs every safety check (realpath root containment, `..`/absolute
 * patterns, secret-looking files, native addons, unmatched patterns,
 * non-modules, `node_modules` never descended into). Stock Bun then embeds the
 * checked files as extra entrypoints; the patched toolchain embeds the SAME
 * checked files through its native `compile.include` — never the raw globs,
 * which Bun would re-expand by its own rules (a directory form embeds
 * `node_modules`). Both land at `/$bunfs/root/<path relative to the app root>`.
 *
 * The real patched compile runs when `KNEXT_TEST_PATCHED_BUN` names the
 * patched binary (the release-test matrix and a linux container set it); the
 * stock-Bun half below runs everywhere.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpSync,
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
import {
    embedBuildOptions,
    nativeIncludePaths,
    planIncludes,
} from "../adapters/compile-embed.mjs";
import { validateCompileConfig, wantsPatchedBun } from "../cli/compile-config";
import { compileArgv } from "../cli/vinext-build";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function temp(prefix: string): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temps.push(d);
    return d;
}
function write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
}

describe("config: one compile block, both toolchains", () => {
    const vinext = { build: "vinext" };

    it("accepts bun: 'knext-patched' with and without include on the compiled vinext executable", () => {
        expect(
            validateCompileConfig({
                ...vinext,
                compile: { bun: "knext-patched" },
            }),
        ).toEqual([]);
        expect(
            validateCompileConfig({
                ...vinext,
                runtime: "bun",
                compile: { bun: "knext-patched", include: ["plugins/*.js"] },
            }),
        ).toEqual([]);
        expect(
            validateCompileConfig({ ...vinext, compile: { bun: "stock" } }),
        ).toEqual([]);
    });

    it("include alone is still the stock-Bun path (no toolchain needed)", () => {
        expect(
            validateCompileConfig({
                ...vinext,
                compile: { include: ["plugins/*.js"] },
            }),
        ).toEqual([]);
        expect(wantsPatchedBun({ compile: { include: ["p/*.js"] } })).toBe(
            false,
        );
    });

    it("rejects an unknown toolchain", () => {
        expect(
            validateCompileConfig({
                ...vinext,
                compile: { bun: "canary" },
            }).join("\n"),
        ).toContain("'compile.bun' must be one of: stock, knext-patched");
    });

    it.each([
        ["the default (turbopack) build", {}],
        ["webpack", { build: "webpack" }],
        ["vinext on node", { build: "vinext", runtime: "node" }],
    ])("rejects bun: 'knext-patched' on %s", (_n, target) => {
        expect(
            validateCompileConfig({
                ...target,
                compile: { bun: "knext-patched" },
            }).join("\n"),
        ).toContain(
            "'compile.bun' is supported only on the compiled vinext executable",
        );
    });
});

describe("planIncludes: native addons are refused at plan time, in both modes", () => {
    function appWith(files: Record<string, string>): string {
        const root = temp("knext-include-native-");
        for (const [rel, body] of Object.entries(files))
            write(join(root, rel), body);
        return root;
    }

    it("a .node addon matched by a glob fails the build and says why", () => {
        const root = appWith({
            "plugins/a.js": "export default 1;\n",
            "plugins/crc.node": "\x7fELF",
        });
        expect(() => planIncludes(root, ["plugins/*"])).toThrow(
            /native addon.*plugins\/crc\.node/s,
        );
    });

    it("a .node addon named exactly is refused too (it cannot load from the executable)", () => {
        const root = appWith({ "native/crc.node": "\x7fELF" });
        expect(() => planIncludes(root, ["native/crc.node"])).toThrow(
            /native addon/,
        );
    });

    it("the message names the cure (require it statically so it ships beside the binary)", () => {
        const root = appWith({ "native/x.node": "\x7fELF" });
        let msg = "";
        try {
            planIncludes(root, ["native/x.node"]);
        } catch (e) {
            msg = String((e as Error).message);
        }
        expect(msg).toContain("static require");
    });
});

describe("planIncludes: a directory include never embeds node_modules", () => {
    it("a directory pattern expands to its files minus any node_modules below it", () => {
        const root = temp("knext-include-dir-");
        write(join(root, "plugins/a.js"), "export default 1;\n");
        write(join(root, "plugins/sub/b.ts"), "export default 2;\n");
        write(
            join(root, "plugins/node_modules/dep/index.js"),
            "export default 3;\n",
        );
        const plan = planIncludes(root, ["plugins"]);
        expect(plan.relpaths).toEqual(["plugins/a.js", "plugins/sub/b.js"]);
        expect(plan.relpaths.join(",")).not.toContain("node_modules");
    });
});

describe("native include: knext passes the CHECKED files, relative to the compile cwd", () => {
    function plan() {
        const root = temp("knext-include-rel-");
        write(join(root, "plugins/a.js"), "export default 1;\n");
        write(join(root, "plugins/sub/b.ts"), "export default 2;\n");
        write(join(root, ".output/server/index.mjs"), "export {};\n");
        return { root, plan: planIncludes(root, ["plugins/**/*"]) };
    }

    it("nativeIncludePaths escapes glob characters in file names, so Bun's --include takes each file literally", () => {
        // Measured on the knext-patched Bun: an UNESCAPED `plugins/[id].js`
        // is read as a glob and embeds `plugins/i.js` + `plugins/d.js`
        // instead of the file itself; a backslash before each of
        // [ ] { } * ? makes it match exactly that file.
        const root = temp("knext-include-meta-");
        for (const f of ["[id].js", "a{b}.js", "x*y.js", "q?.js"])
            write(join(root, "plugins", f), "export default 1;\n");
        write(join(root, "plugins/[dir]/n.js"), "export default 2;\n");
        const p = planIncludes(root, [
            "plugins/[id].js",
            "plugins/a{b}.js",
            "plugins/x*y.js",
            "plugins/q?.js",
            "plugins/[dir]/n.js",
        ]);
        expect(nativeIncludePaths(p, root).sort()).toEqual(
            [
                "./plugins/\\[dir\\]/n.js",
                "./plugins/\\[id\\].js",
                "./plugins/a\\{b\\}.js",
                "./plugins/q\\?.js",
                "./plugins/x\\*y.js",
            ].sort(),
        );
    });

    it("a file name with a backslash is refused by planIncludes (both modes), naming the file", () => {
        const root = temp("knext-include-bs-");
        write(join(root, "plugins/back\\slash.js"), "export default 1;\n");
        expect(() => planIncludes(root, ["plugins/*.js"])).toThrow(
            /backslash.*plugins\/back\\slash\.js/s,
        );
    });

    it("nativeIncludePaths refuses a backslash name too (defense in depth for a hand-built plan)", () => {
        const root = temp("knext-include-bs2-");
        const plan = {
            root,
            entrypoints: [join(root, "plugins/back\\slash.js")],
            relpaths: ["plugins/back\\slash.js"],
            report: { excluded: [], nonModule: [], unmatched: [] },
        };
        expect(() => nativeIncludePaths(plan, root)).toThrow(
            /backslash.*plugins\/back\\slash\.js/s,
        );
    });

    it("nativeIncludePaths: ./-relative paths of exactly the planned files", () => {
        const { root, plan: p } = plan();
        expect(nativeIncludePaths(p, root)).toEqual([
            "./plugins/a.js",
            "./plugins/sub/b.ts",
        ]);
    });

    it("refuses a compile cwd that is not the plan root (Bun keeps paths relative to cwd, so $bunfs paths would shift)", () => {
        const { root, plan: p } = plan();
        expect(() => nativeIncludePaths(p, join(root, "plugins"))).toThrow(
            /cwd/,
        );
        expect(() => nativeIncludePaths(p, temp("knext-elsewhere-"))).toThrow(
            /cwd/,
        );
    });

    it("embedBuildOptions(includeSupported): one entrypoint, compile.include = the checked relative files", () => {
        const { root, plan: p } = plan();
        const opts = embedBuildOptions(p, {
            entry: join(root, ".output/server/index.mjs"),
            outfile: join(root, "exe"),
            includeSupported: true,
            cwd: root,
        }) as {
            entrypoints: string[];
            root: string;
            compile: { include?: string[] };
        };
        expect(opts.entrypoints).toEqual([
            join(root, ".output/server/index.mjs"),
        ]);
        expect(opts.compile.include).toEqual([
            "./plugins/a.js",
            "./plugins/sub/b.ts",
        ]);
        expect(opts.root).toBe(root);
    });

    it("embedBuildOptions without includeSupported is unchanged (extra entrypoints, no compile.include)", () => {
        const { root, plan: p } = plan();
        const opts = embedBuildOptions(p, {
            entry: join(root, ".output/server/index.mjs"),
            outfile: join(root, "exe"),
            includeSupported: false,
        }) as { entrypoints: string[]; compile: { include?: string[] } };
        expect(opts.compile.include).toBeUndefined();
        expect(opts.entrypoints).toHaveLength(3);
    });
});

describe("compile argv: the patched compiler + native include flag", () => {
    it("default argv is unchanged: plain bun, no --include-native", () => {
        const argv = compileArgv("linux-x64", "e.mjs", "out");
        expect(argv[0]).toBe("bun");
        expect(argv).not.toContain("--include-native");
        expect(compileArgv("linux-x64", "e.mjs", "out", [], undefined)).toEqual(
            argv,
        );
    });

    it("stock include: plain bun, --include-json, no --include-native", () => {
        const argv = compileArgv("linux-x64", "e.mjs", "out", ["p/*.js"]);
        expect(argv[0]).toBe("bun");
        expect(argv).toContain("--include-json");
        expect(argv).not.toContain("--include-native");
    });

    it("patched + include: the verified binary runs the script and asks for native include", () => {
        const argv = compileArgv(
            "linux-x64",
            "e.mjs",
            "out",
            ["p/*.js"],
            "/cache/bun-linux-x64",
        );
        expect(argv[0]).toBe("/cache/bun-linux-x64");
        expect(argv.slice(-4)).toEqual([
            "--include-json",
            '["p/*.js"]',
            "--include-native",
            "1",
        ]);
    });

    it("patched without include: the verified binary, nothing else added", () => {
        const argv = compileArgv(
            "linux-x64",
            "e.mjs",
            "out",
            [],
            "/cache/bun-linux-x64",
        );
        expect(argv[0]).toBe("/cache/bun-linux-x64");
        expect(argv.slice(1)).toEqual(
            compileArgv("linux-x64", "e.mjs", "out").slice(1),
        );
    });
});

// ---------------------------------------------------------------------------
// Real compiles.

const ENTRY = `globalThis.__nitro_main__ = import.meta.url;
const name = process.argv[2];
console.log("STARTUP " + (globalThis.__knextPluginEvaluated ?? 0));
if (name) (async () => {
  const spec = "/$bunfs/root/plugins/" + name + ".js";
  try {
    const m = await import(spec);
    console.log("RESULT " + m.default + " after=" + (globalThis.__knextPluginEvaluated ?? 0));
  } catch (e) {
    console.log("RESULT fail " + String(e && e.message).split("\\n")[0]);
  }
})();
`;
const PLUGIN =
    "globalThis.__knextPluginEvaluated = (globalThis.__knextPluginEvaluated ?? 0) + 1;\n" +
    'export default "plugin-ok";\n';

function app(): string {
    const work = temp("knext-include-patched-app-");
    write(join(work, ".output/server/index.mjs"), ENTRY);
    write(join(work, ".output/public/.keep"), "");
    write(join(work, "plugins/greet.js"), PLUGIN);
    write(join(work, "plugins/node_modules/dep/index.js"), PLUGIN);
    write(
        join(work, "package.json"),
        JSON.stringify({ name: "app", private: true, type: "module" }),
    );
    return work;
}

function compile(bun: string, work: string, extra: string[]) {
    const exe = join(work, "knext-include-exec");
    const r = spawnSync(
        bun,
        [
            COMPILE,
            "--entry",
            join(work, ".output/server/index.mjs"),
            "--outfile",
            exe,
            ...extra,
        ],
        { cwd: work, encoding: "utf8" },
    );
    return { ...r, exe };
}

function runAlone(exe: string, args: string[]): string {
    const dir = temp("knext-include-patched-empty-");
    const target = join(dir, "server");
    cpSync(exe, target);
    const r = spawnSync(target, args, {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
        env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
        } as unknown as NodeJS.ProcessEnv,
    });
    return `${r.stdout ?? ""}`.trim();
}

describe("native include on a Bun WITHOUT it fails closed (never a binary missing its modules)", () => {
    it("stock Bun + --include-native 1: the build fails and no executable is left behind", () => {
        const work = app();
        // A stock Bun: this test process's own, unless a run under the patched
        // binary names one explicitly.
        const stock = process.env.KNEXT_TEST_STOCK_BUN ?? process.execPath;
        const r = compile(stock, work, [
            "--include-json",
            '["plugins/*.js"]',
            "--include-native",
            "1",
        ]);
        expect(`${r.stderr}${r.stdout}`).toContain(
            "compile.include: not embedded",
        );
        expect(r.status).not.toBe(0);
        expect(existsSync(r.exe)).toBe(false);
    }, 120_000);
});

const PATCHED = process.env.KNEXT_TEST_PATCHED_BUN;

// LANE-BACKED: bun-patched-e2e.yml (the release gate) sets
// KNEXT_REQUIRE_PATCHED_BUN=1 with KNEXT_TEST_PATCHED_BUN, so a missing binary
// FAILS there instead of the real-compile case below quietly skipping.
it("a lane that requires the patched compile gets it (KNEXT_REQUIRE_PATCHED_BUN)", () => {
    if (process.env.KNEXT_REQUIRE_PATCHED_BUN === "1") {
        expect(
            PATCHED,
            "KNEXT_TEST_PATCHED_BUN must name the binary",
        ).toBeTruthy();
        expect(existsSync(PATCHED as string)).toBe(true);
    }
});

describe.skipIf(!PATCHED)(
    "the knext-patched toolchain: native include, embedded, lazy, loaded from the executable",
    () => {
        it("embeds the checked module (not node_modules), lazily, through native --include", () => {
            const work = app();
            const r = compile(PATCHED as string, work, [
                "--include-json",
                '["plugins"]',
                "--include-native",
                "1",
            ]);
            expect(r.status).toBe(0);
            expect(r.stdout).toContain("via native --include");
            expect(r.stdout).toContain(
                "embedded 1 module(s): plugins/greet.js",
            );
            rmSync(join(work, "plugins"), { recursive: true, force: true });
            expect(runAlone(r.exe, [])).toBe("STARTUP 0");
            expect(runAlone(r.exe, ["greet"])).toBe(
                "STARTUP 0\nRESULT plugin-ok after=1",
            );
        }, 180_000);

        it("a file whose name holds glob characters embeds exactly that file, not its glob matches", () => {
            const work = app();
            write(
                join(work, "plugins/[id].js"),
                'export default "BRACKET_FILE_9f2";\n',
            );
            write(join(work, "plugins/i.js"), 'export default "I_FILE_9f2";\n');
            write(join(work, "plugins/d.js"), 'export default "D_FILE_9f2";\n');
            const r = compile(PATCHED as string, work, [
                "--include-json",
                '["plugins/[id].js"]',
                "--include-native",
                "1",
            ]);
            expect(r.status).toBe(0);
            expect(r.stdout).toContain("embedded 1 module(s): plugins/[id].js");
            const exe = readFileSync(r.exe, "latin1");
            expect(exe).toContain("BRACKET_FILE_9f2");
            expect(exe).not.toContain("I_FILE_9f2");
            expect(exe).not.toContain("D_FILE_9f2");
        }, 180_000);
    },
);
