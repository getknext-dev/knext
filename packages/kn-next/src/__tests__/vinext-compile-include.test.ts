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
