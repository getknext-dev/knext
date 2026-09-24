/**
 * vinext-compile staticizes `createRequire(import.meta.url)` externals in EVERY
 * module of nitro's server output, not only the entry (#1314).
 *
 * nitro splits its server bundle into `index.mjs` + `chunks/*.mjs`, and a chunk
 * can carry its own module-scope `__require = createRequire(import.meta.url)`
 * reaching a package nitro left external. Before #1314 only the entry was
 * rewritten, so such a call stayed a RUNTIME require: the build succeeded with
 * no warning, the binary worked in place (it resolved from the build tree's
 * `.output/server/node_modules`), and threw `Cannot find module` once deployed
 * without that directory — the same failure class as the #1309 otel crash.
 *
 * Every build here is deployed to a DIFFERENT directory than it was compiled
 * in, so build-time paths cannot mask a missing bundle.
 */

import { afterAll, describe, expect, it } from "bun:test";
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
import { join, resolve } from "node:path";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");
const MARKER = "KNEXT_1314_CHUNK_DEP_MARKER_3f7a";
const LIVE = "KNEXT_1314_CHUNK_DEP_LIVE_SIDECAR_c91e";

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function temp(prefix: string): string {
    // realpath: macOS tmpdir is a /var -> /private/var symlink, and
    // vinext-compile matches server modules by resolved path.
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temps.push(d);
    return d;
}
function write(path: string, body: string): void {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, body);
}

/**
 * A chunked nitro-shaped server output: the entry imports a chunk whose
 * `createRequire(import.meta.url)` binding requires a traced CommonJS external.
 */
function chunkedOutput(extraChunk?: string): { work: string; server: string } {
    const work = temp("knext-1314-");
    write(
        join(work, "package.json"),
        JSON.stringify({ name: "app", private: true, type: "module" }),
    );
    const server = join(work, ".output", "server");
    write(
        join(server, "node_modules", "chunk-dep", "package.json"),
        JSON.stringify({ name: "chunk-dep", version: "1.0.0", main: "lib/main.js" }),
    );
    write(
        join(server, "node_modules", "chunk-dep", "lib", "main.js"),
        `module.exports = ${JSON.stringify(MARKER)};\n`,
    );
    // The exact shape nitro/rolldown emits for a CJS dependency reaching an
    // external, here in a CHUNK rather than the entry.
    write(
        join(server, "chunks", "a.mjs"),
        'import { createRequire } from "node:module";\n' +
            "var __require = createRequire(import.meta.url);\n" +
            'export function load() { return __require("chunk-dep"); }\n',
    );
    const imports = ['import { load } from "./chunks/a.mjs";'];
    if (extraChunk) {
        write(join(server, "chunks", "b.mjs"), extraChunk);
        imports.push('import "./chunks/b.mjs";');
    }
    write(
        join(server, "index.mjs"),
        `${imports.join("\n")}\nconsole.log("RESULT:" + load());\n`,
    );
    return { work, server };
}

function compile(
    work: string,
    server: string,
    env: Record<string, string> = {},
): ReturnType<typeof spawnSync> & { exe: string } {
    const exe = join(work, "knext-1314-exec");
    const r = spawnSync(
        process.execPath,
        [COMPILE, "--entry", join(server, "index.mjs"), "--outfile", exe],
        { cwd: work, encoding: "utf8", env: { ...process.env, ...env } },
    );
    return Object.assign(r, { exe });
}

/** Copy the binary (and optionally `.output/server/node_modules`) elsewhere and run it. */
function deployAndRun(
    work: string,
    exe: string,
    withSidecar: boolean,
): ReturnType<typeof spawnSync> {
    const deployed = temp("knext-1314-deploy-");
    const target = join(deployed, "server");
    cpSync(exe, target);
    if (withSidecar) {
        cpSync(
            join(work, ".output", "server", "node_modules"),
            join(deployed, ".output", "server", "node_modules"),
            { recursive: true },
        );
        // Rewrite the DEPLOYED sidecar copy after the compile: only a load from
        // the sidecar can print LIVE.
        write(
            join(deployed, ".output", "server", "node_modules", "chunk-dep", "lib", "main.js"),
            `module.exports = ${JSON.stringify(LIVE)};\n`,
        );
    }
    return spawnSync(target, [], { cwd: deployed, encoding: "utf8", timeout: 60_000 });
}

describe("vinext-compile staticizes createRequire externals in nitro chunks (#1314)", () => {
    it("bundles a chunk's createRequire(import.meta.url) external: the binary loads it with no node_modules beside it", () => {
        const { work, server } = chunkedOutput();
        const build = compile(work, server);
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
        // names the package AND the chunk that reached it
        expect(build.stdout).toContain("chunk-dep (chunks/a.mjs)");

        const run = deployAndRun(work, build.exe, false);
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toContain(`RESULT:${MARKER}`);
    }, 120_000);

    it("a chunk's CommonJS external loads from the sidecar when it is deployed beside the binary (same as the entry's)", () => {
        const { work, server } = chunkedOutput();
        const build = compile(work, server);
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

        const run = deployAndRun(work, build.exe, true);
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toContain(`RESULT:${LIVE}`);
    }, 120_000);

    const UNRESOLVABLE_CHUNK =
        'import { createRequire } from "node:module";\n' +
        "var __require = createRequire(import.meta.url);\n" +
        'export function optional() { return __require("knext-1314-not-installed"); }\n';

    it("warns, naming the chunk, when a chunk runtime-requires a package that cannot be bundled", () => {
        const { work, server } = chunkedOutput(UNRESOLVABLE_CHUNK);
        const build = compile(work, server);
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
        expect(`${build.stdout}${build.stderr}`).toContain(
            "knext-1314-not-installed (chunks/b.mjs)",
        );
    }, 120_000);

    it("fails the build under KNEXT_COMPILE_STRICT_REQUIRES=1 for the same chunk", () => {
        const { work, server } = chunkedOutput(UNRESOLVABLE_CHUNK);
        const build = compile(work, server, { KNEXT_COMPILE_STRICT_REQUIRES: "1" });
        expect(build.status).not.toBe(0);
        expect(`${build.stdout}${build.stderr}`).toContain(
            "chunks/b.mjs runtime-requires package(s)",
        );
        expect(`${build.stdout}${build.stderr}`).toContain("knext-1314-not-installed");
    }, 120_000);
});
