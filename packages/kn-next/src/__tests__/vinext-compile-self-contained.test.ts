/**
 * #1460 — `vinext-compile.mjs --self-contained 1`: the binary needs NOTHING
 * beside it.
 *
 * Every binary here is copied ALONE into a fresh empty directory and run with
 * that directory as cwd, so the build tree cannot answer for it. The fixture is
 * nitro-shaped where it matters: `globalThis.__nitro_main__ = import.meta.url`
 * and public files read as `resolve(<entry dir>, "../public/…")`, exactly as
 * nitro's bun preset reads them; a real `sharp` (with the host's real native
 * tree) is imported statically, as knext-bun-entry.mjs does.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");
const REPO = resolve(import.meta.dir, "../../../..");
const PUBLIC_MARK = "/*KNEXT_1460_PUBLIC_VERBATIM_7c2e*/";

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) {
        try {
            chmodSync(d, 0o755);
        } catch {}
        rmSync(d, { recursive: true, force: true });
    }
});
function temp(prefix: string): string {
    // realpath: macOS tmpdir is a /var -> /private/var symlink, and
    // vinext-compile matches server modules by resolved path.
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temps.push(d);
    return d;
}
function write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
}

/** The installed sharp and its native packages for THIS host (as the app has them). */
function hostSharp(): { sharpDir: string; nativeDirs: string[] } {
    const from = join(REPO, "apps/file-manager");
    const sharpDir = dirname(Bun.resolveSync("sharp/package.json", from));
    const imgDir = dirname(
        dirname(realpathSync(Bun.resolveSync("sharp/package.json", from))),
    );
    const img = join(imgDir, "@img");
    const libc =
        process.platform === "linux" &&
        !(
            process.report?.getReport?.() as
                | { header?: { glibcVersionRuntime?: string } }
                | undefined
        )?.header?.glibcVersionRuntime
            ? "musl"
            : "";
    const platform = `${process.platform}${libc}-${process.arch}`;
    const nativeDirs = [`sharp-${platform}`, `sharp-libvips-${platform}`].map(
        (name) => {
            try {
                return dirname(
                    realpathSync(
                        Bun.resolveSync(`@img/${name}/package.json`, sharpDir),
                    ),
                );
            } catch {
                return join(img, name);
            }
        },
    );
    return { sharpDir, nativeDirs };
}

const ENTRY = `globalThis.__nitro_main__ = import.meta.url;
import sharp from "sharp";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const serverDir = dirname(fileURLToPath(globalThis.__nitro_main__));
let pub = "missing";
try { pub = readFileSync(resolve(serverDir, "../public/nested/chunk.js"), "utf8"); } catch (e) { pub = "ERR " + e.code; }
console.log("PUBLIC " + (pub.startsWith(${JSON.stringify(PUBLIC_MARK)}) ? "verbatim " + pub.length : pub.slice(0, 60)));
const tmp = process.env.KNEXT_NATIVE_TMPDIR;
console.log("BOOT-TMP " + JSON.stringify(readdirSync(tmp)));
const make = () => sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
(async () => {
  if (!process.argv.includes("use")) return;
  for (const n of [1, 2]) {
    try { console.log("SHARP" + n + " ok " + (await make()).length); }
    catch (e) { console.log("SHARP" + n + " fail " + String(e.message).split("\\n")[0]); }
  }
  console.log("AFTER-TMP " + JSON.stringify(readdirSync(tmp)));
})();
`;

/** A nitro-shaped app root: `.output/{server,public}`, `native/`, and sharp resolvable. */
function sharpApp(): string {
    const work = temp("knext-1460-app-");
    const { sharpDir, nativeDirs } = hostSharp();
    mkdirSync(join(work, "node_modules"), { recursive: true });
    symlinkSync(sharpDir, join(work, "node_modules", "sharp"));
    for (const dir of nativeDirs) {
        cpSync(dir, join(work, "native", dir.split("/").at(-1) ?? ""), {
            recursive: true,
            dereference: true,
        });
    }
    // > 64 KiB, so a streamed read would be the path a static server takes.
    write(
        join(work, ".output/public/nested/chunk.js"),
        `${PUBLIC_MARK}\n${"x".repeat(70_000)}\n`,
    );
    write(join(work, ".output/public/file.svg"), "<svg/>\n");
    write(join(work, ".output/server/index.mjs"), ENTRY);
    write(
        join(work, "package.json"),
        JSON.stringify({ name: "app", private: true, type: "module" }),
    );
    return work;
}

function compile(
    work: string,
    extra: string[],
    env: Record<string, string> = {},
): ReturnType<typeof spawnSync> & { exe: string } {
    const exe = join(work, "knext-1460-exec");
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
        { cwd: work, encoding: "utf8", env: { ...process.env, ...env } },
    );
    return Object.assign(r, { exe });
}

/** Copy ONLY the binary into an empty directory and run it from there. */
function runAlone(
    exe: string,
    args: string[],
    nativeTmp: string,
): ReturnType<typeof spawnSync> & { dir: string } {
    const dir = temp("knext-1460-empty-");
    const target = join(dir, "server");
    cpSync(exe, target);
    const r = spawnSync(target, args, {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
        env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            KNEXT_NATIVE_TMPDIR: nativeTmp,
        } as unknown as NodeJS.ProcessEnv,
    });
    return Object.assign(r, { dir });
}

describe("#1460 self-contained compile: nothing beside the binary", () => {
    let work: string;
    let build: ReturnType<typeof compile>;
    beforeAll(() => {
        work = sharpApp();
        build = compile(work, [
            "--self-contained",
            "1",
            "--native-dir",
            "native",
        ]);
    }, 180_000);

    it("builds, and proves bytecode on the self-contained entry", () => {
        expect(build.status, String(build.stderr)).toBe(0);
        expect(String(build.stdout)).toContain(
            "self-contained: nothing needs to sit beside the binary (sharp: embedded, unpacked on first use); bytecode verified",
        );
    });

    it("serves .output/public from INSIDE the binary, byte-for-byte, from an empty directory", () => {
        const r = runAlone(build.exe, [], temp("knext-1460-nt-"));
        expect(r.status, String(r.stderr)).toBe(0);
        expect(String(r.stdout)).toContain(
            `PUBLIC verbatim ${PUBLIC_MARK.length + 1 + 70_000 + 1}`,
        );
        expect(readdirSync(r.dir)).toEqual(["server"]);
    });

    it("boot does NOT unpack sharp — the native tree is untouched until first use", () => {
        const nt = temp("knext-1460-nt-");
        const r = runAlone(build.exe, [], nt);
        expect(String(r.stdout)).toContain("BOOT-TMP []");
        expect(readdirSync(nt)).toEqual([]);
    });

    it("the first sharp call unpacks once and works; the second reuses it", () => {
        const nt = temp("knext-1460-nt-");
        const r = runAlone(build.exe, ["use"], nt);
        const out = String(r.stdout);
        expect(out, String(r.stderr)).toContain("BOOT-TMP []");
        expect(out).toMatch(/SHARP1 ok \d+/);
        expect(out).toMatch(/SHARP2 ok \d+/);
        const after = readdirSync(nt);
        expect(after).toHaveLength(1);
        // #1460 round 2: the directory name now carries the uid too (a
        // pure content hash would let another local user pre-create it and
        // deny extraction to every other uid).
        expect(after[0]).toMatch(/^knext-native-(?:\d+|nouid)-[0-9a-f]{16}$/);
    });

    it("an unwritable temp dir fails the sharp call with the named cause — twice, no hang, no crash", () => {
        const nt = temp("knext-1460-ro-");
        chmodSync(nt, 0o555);
        const started = performance.now();
        const r = runAlone(build.exe, ["use"], nt);
        const out = String(r.stdout);
        expect(r.status, String(r.stderr)).toBe(0);
        expect(out).toMatch(
            /SHARP1 fail knext: could not unpack sharp's native libraries/,
        );
        expect(out).toMatch(
            /SHARP2 fail knext: could not unpack sharp's native libraries/,
        );
        expect(performance.now() - started).toBeLessThan(30_000);
    });
});

describe("#1460 self-contained forces strict requires", () => {
    // The rolldown vinext itself builds with — a real `__require(name)` shape.
    const vinextRequire = createRequire(require.resolve("vinext/package.json"));

    async function dynamicRequireApp(): Promise<string> {
        const { rolldown } = (await import(
            pathToFileURL(vinextRequire.resolve("rolldown")).href
        )) as {
            rolldown(input: Record<string, unknown>): Promise<{
                write(output: Record<string, unknown>): Promise<unknown>;
            }>;
        };
        const work = temp("knext-1460-strict-");
        write(
            join(work, "src/d.cjs"),
            "module.exports = (name) => require(name);\n",
        );
        write(
            join(work, "src/index.mjs"),
            'import d from "./d.cjs";\nglobalThis.d = d;\nconsole.log("RESULT:ok");\n',
        );
        const bundle = await rolldown({
            input: join(work, "src/index.mjs"),
            platform: "node",
        });
        await bundle.write({
            dir: join(work, ".output/server"),
            format: "esm",
            entryFileNames: "index.mjs",
        });
        write(
            join(work, "package.json"),
            JSON.stringify({ name: "app", private: true, type: "module" }),
        );
        return work;
    }

    it("a non-literal runtime require FAILS a self-contained build, with no env var set", async () => {
        const work = await dynamicRequireApp();
        const env = { KNEXT_COMPILE_STRICT_REQUIRES: "" };
        const disk = compile(work, [], env);
        expect(disk.status, String(disk.stderr)).toBe(0);
        const sc = compile(work, ["--self-contained", "1"], env);
        expect(sc.status).toBe(1);
        expect(String(sc.stderr)).toMatch(
            /non-literal package name[\s\S]*KNEXT_COMPILE_STRICT_REQUIRES=1/,
        );
    }, 120_000);
});

describe("#1460 self-contained: the sidecar set must be empty (except sharp)", () => {
    function appWithTracedPackages(): string {
        const work = temp("knext-1460-sidecar-");
        write(
            join(work, ".output/server/index.mjs"),
            'console.log("RESULT:ok");\n',
        );
        const nm = join(work, ".output/server/node_modules");
        // A package with a native addon — cannot load from inside the binary.
        write(
            join(nm, "fake-native/package.json"),
            '{"name":"fake-native","version":"1.0.0"}',
        );
        write(
            join(nm, "fake-native/build/Release/fake.node"),
            "not really an addon",
        );
        // Scoped, too: scanned, not enumerated.
        write(
            join(nm, "@scope/native-b/package.json"),
            '{"name":"@scope/native-b","version":"1.0.0"}',
        );
        write(join(nm, "@scope/native-b/binding.gyp"), "{}");
        // sharp and its @img packages are the one exception (embedded + unpacked).
        write(
            join(nm, "sharp/package.json"),
            '{"name":"sharp","version":"1.0.0"}',
        );
        write(join(nm, "@img/sharp-x/lib/sharp-x.node"), "addon");
        // A plain-JS package is fine: it is bundled.
        write(
            join(nm, "plain/package.json"),
            '{"name":"plain","version":"1.0.0"}',
        );
        write(join(nm, "plain/index.js"), "module.exports = 1;\n");
        write(
            join(work, "package.json"),
            JSON.stringify({ name: "app", private: true, type: "module" }),
        );
        return work;
    }

    it("every traced package with a native addon fails the build — sharp/@img excepted", () => {
        const work = appWithTracedPackages();
        const sc = compile(work, ["--self-contained", "1"]);
        expect(sc.status).toBe(1);
        const err = String(sc.stderr);
        expect(err).toContain(
            "self-contained: @scope/native-b, fake-native ship(s) a native addon",
        );
        expect(err).not.toMatch(/@img|sharp,|plain/);
    }, 120_000);

    it("disk mode is unchanged: the same tree builds (the sidecar serves those packages)", () => {
        const work = appWithTracedPackages();
        const disk = compile(work, []);
        expect(disk.status, String(disk.stderr)).toBe(0);
    }, 120_000);
});
