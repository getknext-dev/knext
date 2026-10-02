/**
 * `compile.include` on STOCK Bun (knext.config.ts → `--include-json` →
 * vinext-compile.mjs): user-declared JS/TS modules are embedded in the
 * compiled executable and load from it at runtime — lazily, on the first
 * import — with nothing beside the binary.
 *
 * Mechanism (compile-embed.mjs): stock Bun has no `--compile --include`, so the
 * matched modules are passed as EXTRA entrypoints with `root` = the app root and
 * hash-free naming; Bun embeds every entrypoint, unexecuted, at
 * `$bunfs/root/<path relative to the app root>`.
 *
 * Every binary here is copied ALONE into a fresh empty directory and run there,
 * with the sources deleted, so only the executable can answer the import.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseIncludeJson, planIncludes } from "../adapters/compile-embed.mjs";

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

// The nitro-shaped entry: reports whether the plugin ran at startup, then
// imports it by a specifier computed at RUNTIME (nothing a bundler can follow).
// No top-level await: `--bytecode` emits CommonJS, like the real nitro entry.
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
    const work = temp("knext-include-app-");
    write(join(work, ".output/server/index.mjs"), ENTRY);
    write(join(work, ".output/public/.keep"), "");
    write(join(work, "plugins/greet.js"), PLUGIN);
    write(join(work, "plugins/notes.txt"), "not a module\n");
    write(
        join(work, "package.json"),
        JSON.stringify({ name: "app", private: true, type: "module" }),
    );
    return work;
}

function compile(work: string, extra: string[]) {
    const exe = join(work, "knext-include-exec");
    const r = spawnSync(
        process.execPath,
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
    const dir = temp("knext-include-empty-");
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

const lines = (out: string, tag: string) =>
    out.split("\n").filter((l) => l.startsWith(tag));

describe("compile.include on stock Bun: embedded, lazy, loaded from the executable", () => {
    let withInclude: ReturnType<typeof compile>;
    let without: ReturnType<typeof compile>;
    beforeAll(() => {
        const a = app();
        withInclude = compile(a, ["--include-json", '["plugins/*.js"]']);
        rmSync(join(a, "plugins"), { recursive: true, force: true });
        const b = app();
        without = compile(b, []);
        rmSync(join(b, "plugins"), { recursive: true, force: true });
    }, 180_000);

    it("builds, and says what it embedded", () => {
        expect(withInclude.status, String(withInclude.stderr)).toBe(0);
        expect(String(withInclude.stdout)).toContain(
            "[knext compile] compile.include: embedded 1 module(s): plugins/greet.js",
        );
        // Bytecode is VERIFIED in this mode (the marker check), not just logged.
        expect(String(withInclude.stderr)).not.toContain(
            "failed the bytecode check",
        );
        expect(String(withInclude.stdout)).toContain("(bytecode: on");
    });

    it("the included module is NOT evaluated at startup", () => {
        const out = runAlone(withInclude.exe, []);
        expect(lines(out, "STARTUP")).toEqual(["STARTUP 0"]);
    });

    it("a runtime import loads it from the executable, once, with sources gone", () => {
        const out = runAlone(withInclude.exe, ["greet"]);
        expect(lines(out, "STARTUP")).toEqual(["STARTUP 0"]);
        expect(lines(out, "RESULT")).toEqual(["RESULT plugin-ok after=1"]);
    });

    it("control: the same build WITHOUT compile.include cannot load it (the test discriminates)", () => {
        expect(without.status, String(without.stderr)).toBe(0);
        const out = runAlone(without.exe, ["greet"]);
        expect(lines(out, "RESULT")[0]).toStartWith("RESULT fail");
    });
});

describe("compile.include fails the build instead of embedding nothing", () => {
    it("a glob that matches only non-module files fails, naming them", () => {
        const r = compile(app(), ["--include-json", '["plugins/*.txt"]']);
        expect(r.status).not.toBe(0);
        expect(String(r.stderr)).toContain("plugins/notes.txt");
        expect(String(r.stderr)).toContain("JavaScript/TypeScript modules");
    });

    it("a pattern that matches nothing fails, naming it", () => {
        const r = compile(app(), ["--include-json", '["nope/*.js"]']);
        expect(r.status).not.toBe(0);
        expect(String(r.stderr)).toContain("nope/*.js");
    });

    it("malformed --include-json fails", () => {
        const r = compile(app(), ["--include-json", "not-json"]);
        expect(r.status).not.toBe(0);
    });
});

describe("planIncludes: nothing outside the app root, no secrets by glob", () => {
    /** An app root with a sibling `outside/` holding a module that must never embed. */
    function rooted(): { work: string; outside: string } {
        const parent = temp("knext-include-root-");
        const work = join(parent, "app");
        const outside = join(parent, "outside");
        write(join(work, "plugins/ok.js"), PLUGIN);
        write(join(outside, "secret.js"), 'export default "outside";\n');
        return { work, outside };
    }

    it("refuses a '..' glob up front", () => {
        const { work } = rooted();
        expect(() => planIncludes(work, ["../outside/*.js"])).toThrow(
            /contains '\.\.'/,
        );
        expect(() =>
            planIncludes(work, ["plugins/../../outside/*.js"]),
        ).toThrow(/contains '\.\.'/);
    });

    it("refuses an absolute glob up front", () => {
        const { work, outside } = rooted();
        expect(() => planIncludes(work, [`${outside}/*.js`])).toThrow(
            /is absolute/,
        );
        expect(() => planIncludes(work, ["/etc/*.js"])).toThrow(/is absolute/);
    });

    it("refuses a symlinked directory that resolves outside the root (glob match)", () => {
        const { work, outside } = rooted();
        symlinkSync(outside, join(work, "linkdir"));
        expect(() => planIncludes(work, ["linkdir/*.js"])).toThrow(
            /outside the app root[\s\S]*linkdir\/secret\.js/,
        );
    });

    it("refuses a symlinked file that resolves outside the root; a glob never embeds it", () => {
        const { work, outside } = rooted();
        symlinkSync(join(outside, "secret.js"), join(work, "plugins/link.js"));
        // Named literally: refused, naming it.
        expect(() => planIncludes(work, ["plugins/link.js"])).toThrow(
            /outside the app root[\s\S]*plugins\/link\.js/,
        );
        // By glob: Bun.Glob's file scan does not return a symlinked FILE at all
        // (measured, Bun 1.4.2) — so it is never embedded either way.
        const plan = planIncludes(work, ["plugins/*.js"]);
        expect(plan.relpaths).toEqual(["plugins/ok.js"]);
        expect(plan.entrypoints.some((e) => e.includes("outside"))).toBe(false);
    });

    it("a symlink that stays inside the root is fine", () => {
        const { work } = rooted();
        symlinkSync(
            join(work, "plugins/ok.js"),
            join(work, "plugins/alias.js"),
        );
        expect(
            planIncludes(work, ["plugins/alias.js", "plugins/ok.js"]).relpaths,
        ).toEqual(["plugins/alias.js", "plugins/ok.js"]);
    });

    it("refuses secret-looking matches by glob, allows them as an exact literal", () => {
        const { work } = rooted();
        write(join(work, "config/.env.js"), 'export default "x";\n');
        write(join(work, "config/id_deploy.js"), 'export default "x";\n');
        expect(() => planIncludes(work, ["config/.env*"])).toThrow(
            /look like secrets: config\/\.env\.js/,
        );
        expect(() => planIncludes(work, ["config/*.js"])).toThrow(
            /look like secrets: config\/id_deploy\.js/,
        );
        expect(planIncludes(work, ["config/id_deploy.js"]).relpaths).toEqual([
            "config/id_deploy.js",
        ]);
        expect(planIncludes(work, ["./config/.env.js"]).relpaths).toEqual([
            "config/.env.js",
        ]);
    });

    it("the compile script refuses a '..' include end to end (nothing embedded)", () => {
        const { work } = rooted();
        write(join(work, ".output/server/index.mjs"), ENTRY);
        write(
            join(work, "package.json"),
            JSON.stringify({ name: "app", private: true, type: "module" }),
        );
        const r = compile(work, ["--include-json", '["../outside/*.js"]']);
        expect(r.status).not.toBe(0);
        expect(String(r.stderr)).toContain("contains '..'");
    });
});

describe("parseIncludeJson / planIncludes", () => {
    it("parseIncludeJson: absent → [], a glob list round-trips, junk throws", () => {
        expect(parseIncludeJson(undefined)).toEqual([]);
        expect(parseIncludeJson('["./a/**"]')).toEqual(["./a/**"]);
        for (const bad of ["x", "[]", '"a"', "[1]", '[""]', "{}"]) {
            expect(() => parseIncludeJson(bad)).toThrow();
        }
    });

    it("planIncludes: modules only, outside-root and unmatched refused", () => {
        const work = app();
        const plan = planIncludes(work, ["plugins/*.js"]);
        expect(plan.relpaths).toEqual(["plugins/greet.js"]);
        expect(() => planIncludes(work, ["plugins/*"])).toThrow(
            /plugins\/notes\.txt/,
        );
        expect(() => planIncludes(work, ["../outside.js"])).toThrow();
        expect(() => planIncludes(work, ["missing/*.js"])).toThrow(
            /missing\/\*\.js/,
        );
    });
});
