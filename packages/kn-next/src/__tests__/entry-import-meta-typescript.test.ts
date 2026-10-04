/**
 * End-to-end proof of cluster C4b (`twoslash`), against the REAL published
 * `typescript` package (not a hand-written stand-in) through the REAL
 * rolldown vinext itself depends on, compiled with a REAL
 * `bun build --compile --bytecode` via the shipped `vinext-compile.mjs`.
 *
 * #3424's regression bundles `serverExternalPackages` like `typescript` into
 * the Nitro RSC entry instead of leaving it external (the `twoslash` fixture
 * declares `serverExternalPackages: ['twoslash']`, and `twoslash` pulls in
 * `typescript`). nitro's bun preset + knext's vite config template disable
 * code-splitting (`inlineDynamicImports`/no code-splitting), so everything —
 * including the now-unexternalized `typescript` — collapses into the ONE
 * compiled entry.
 *
 * `typescript`'s own compiled `lib/typescript.js` contains one or more
 * occurrences of the text "import.meta" — each one inside a diagnostic
 * MESSAGE STRING that names the language feature by name (TS1343, TS1470, and
 * an option description), never as real syntax. Before the fix, the naive
 * text-only "did anything survive the rewrite" check in `vinext-compile.mjs`
 * counted those substrings as unrewritten `import.meta` uses and aborted the
 * compile — measured as "3 import.meta use(s) survived the rewrite" against
 * typescript 5.9.3 (the exact count is not asserted here, since it is an
 * artifact of typescript's own dist text and would make this test fragile
 * against an unrelated typescript patch bump; `findRealImportMeta` — this
 * fix's own oracle — is what is asserted: it must find ZERO real uses in
 * typescript's dist, matching the fact that none of the occurrences are real
 * syntax).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findRealImportMeta } from "../adapters/entry-import-meta.mjs";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");

const vinextRequire = createRequire(require.resolve("vinext/package.json"));
const { rolldown } = (await import(
    pathToFileURL(vinextRequire.resolve("rolldown")).href
)) as {
    rolldown(input: Record<string, unknown>): Promise<{
        write(output: Record<string, unknown>): Promise<unknown>;
    }>;
};

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

describe("vinext-compile over a bundled typescript (cluster C4b, #3424 regression shape)", () => {
    it('typescript\'s OWN published dist spells "import.meta" at least once, with zero REAL uses (fixture-drift guard)', () => {
        const typescriptMain = realpathSync(require.resolve("typescript"));
        const src = readFileSync(typescriptMain, "utf8");
        const textOccurrences = (src.match(/import\.meta/g) ?? []).length;
        // This is the premise the rest of the describe block depends on: if a
        // future typescript release stops mentioning the feature by name in a
        // diagnostic, the false positive this guards against no longer exists
        // in this fixture and the test should say so rather than pass vacuously.
        expect(textOccurrences).toBeGreaterThan(0);
        // None of them is real `import.meta` syntax — this fix's own oracle,
        // not a hand-counted assertion that drifts with typescript's text.
        expect(findRealImportMeta(src)).toHaveLength(0);
    });

    it("compiles AND RUNS the real published typescript bundled (un-externalized) into a single rolldown chunk", async () => {
        const work = temp("knext-c4b-ts-");
        const src = join(work, "src");
        mkdirSync(src, { recursive: true });
        writeFileSync(
            join(src, "index.mjs"),
            'import ts from "typescript";\n' +
                'console.log("RESULT:" + ts.ScriptTarget.ESNext + ":" + typeof ts.version);\n',
        );
        const server = join(work, ".output", "server");
        const typescriptMain = realpathSync(require.resolve("typescript"));
        const bundle = await rolldown({
            input: join(src, "index.mjs"),
            platform: "node",
            // The #3424 regression shape: typescript is NOT external, so the
            // whole compiler is inlined directly into the one output chunk.
            external: [],
            resolve: { alias: { typescript: typescriptMain } },
        });
        await bundle.write({
            dir: server,
            format: "esm",
            // nitro's bun preset + knext's vite.config.mjs template disable
            // code-splitting — everything lands in ONE chunk, the entry.
            inlineDynamicImports: true,
            entryFileNames: "index.mjs",
        });

        const bundled = readFileSync(join(server, "index.mjs"), "utf8");
        // Fixture-drift guard: the bundle really DOES carry the false positive
        // (more raw "import.meta" text than real uses `findRealImportMeta`
        // would flag), plus at least the ONE real import.meta.url rolldown's
        // own require binding needs — otherwise this test would not be
        // exercising the bug it claims to.
        const textOccurrences = (bundled.match(/import\.meta/g) ?? []).length;
        const realUses = findRealImportMeta(bundled);
        expect(textOccurrences).toBeGreaterThan(realUses.length);
        expect(realUses.some((u) => u.prop === "url")).toBe(true);

        const exe = join(work, "knext-c4b-exec");
        const build = spawnSync(
            process.execPath,
            [COMPILE, "--entry", join(server, "index.mjs"), "--outfile", exe],
            { cwd: work, encoding: "utf8" },
        );
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
        // Only the REAL import.meta.url use(s) are rewritten — the string
        // literals are correctly left alone, never counted as "survived".
        expect(build.stdout).toContain(
            `rewrote ${realUses.length} import.meta use(s) for bytecode`,
        );

        const run = spawnSync(exe, [], {
            cwd: work,
            encoding: "utf8",
            timeout: 30_000,
        });
        if (
            process.platform === "darwin" &&
            run.signal === "SIGKILL" &&
            Bun.version === "1.4.0"
        ) {
            // Bun 1.4.0's freshly-built ad-hoc-signed macOS executables are
            // SIGKILLed by the OS before running (#1227) — an environment
            // fault, not this fix's. CI (linux) always runs the behavioural
            // half.
            return;
        }
        expect(run.stdout, `${run.stdout}\n${run.stderr}`).toContain(
            "RESULT:99:string",
        );
    }, 120_000);

    it("a GENUINE bare import.meta (no .url/.filename/.dirname) also compiles and runs, rewritten to an object literal", () => {
        const work = temp("knext-c4b-bare-");
        const server = join(work, ".output", "server");
        mkdirSync(server, { recursive: true });
        writeFileSync(
            join(server, "index.mjs"),
            'const hasMeta = typeof import.meta !== "undefined";\n' +
                'console.log("RESULT:" + hasMeta + ":" + import.meta.url);\n',
        );
        const exe = join(work, "knext-c4b-bare-exec");
        const build = spawnSync(
            process.execPath,
            [COMPILE, "--entry", join(server, "index.mjs"), "--outfile", exe],
            { cwd: work, encoding: "utf8" },
        );
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
        const run = spawnSync(exe, [], {
            cwd: work,
            encoding: "utf8",
            timeout: 30_000,
        });
        if (
            process.platform === "darwin" &&
            run.signal === "SIGKILL" &&
            Bun.version === "1.4.0"
        ) {
            return;
        }
        expect(run.stdout, `${run.stdout}\n${run.stderr}`).toContain(
            `RESULT:true:${pathToFileURL(join(server, "index.mjs")).href}`,
        );
    }, 60_000);
});
