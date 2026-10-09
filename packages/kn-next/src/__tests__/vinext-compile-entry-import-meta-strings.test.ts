/**
 * A server entry that merely MENTIONS `import.meta.url` in a string must
 * compile, and the string must survive byte-for-byte. The docs app is the
 * real case: an MDX page's code sample, `readFileSync(new URL('./data.wasm',
 * import.meta.url))`, compiles to a JSX text child, which is a plain string
 * literal in nitro's bundled entry. The compile's entry `import.meta` rewrite
 * used to be a textual `replaceAll`, spliced `require("node:url")` into that
 * string, and the build failed with `Expected "}" but found "node"`.
 *
 * The entry here carries such strings (double- and single-quoted JSX text, a
 * template literal, a comment) next to a REAL `import.meta.url` use. It is
 * compiled through the shipped script, and the binary is moved away from its
 * build dir and run. The binary exits 0 only when every string reads back
 * exactly as written and the real use still resolves to the entry's path.
 * Exit codes only.
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

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});
function temp(prefix: string): string {
    const r = mkdtempSync(join(tmpdir(), prefix));
    tempRoots.push(r);
    return realpathSync(r);
}

function hostTarget(): string {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return process.platform === "darwin"
        ? `bun-darwin-${arch}`
        : `bun-linux-${arch}`;
}

const SAMPLE = "readFileSync(new URL('./data.wasm', import.meta.url))";

describe("the entry's import.meta rewrite leaves strings that mention import.meta alone", () => {
    it("compiles, and the moved binary reads every string back unchanged", () => {
        const buildDir = temp("knext-x-meta-build-");
        const serverDir = join(buildDir, ".output", "server");
        mkdirSync(serverDir, { recursive: true });
        writeFileSync(
            join(serverDir, "index.mjs"),
            [
                "const _jsx = (tag, props) => props.children;",
                // MDX JSX text children, as the docs bundle holds them.
                `const dq = _jsx("code", { children: "${SAMPLE}" });`,
                `const sq = _jsx("span", { children: 'new URL("./x", import.meta.url) or import.meta.dirname' });`,
                "const tl = `template: import.meta.filename`;",
                "// a comment: import.meta.url",
                "const real = import.meta.url;",
                `const want = [${JSON.stringify(SAMPLE)}, 'new URL("./x", import.meta.url) or import.meta.dirname', "template: import.meta.filename"];`,
                "const got = [dq, sq, tl];",
                "if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(JSON.stringify(got)); process.exit(3); }",
                'if (!real.endsWith("/.output/server/index.mjs")) { console.error(real); process.exit(4); }',
                "process.exit(0);",
            ].join("\n"),
        );
        const outFile = join(buildDir, "meta-exec");
        const compile = spawnSync(
            "bun",
            [
                "run",
                COMPILE,
                "--entry",
                join(serverDir, "index.mjs"),
                "--outfile",
                outFile,
                "--target",
                hostTarget(),
            ],
            { encoding: "utf-8", timeout: 90_000 },
        );
        expect(compile.status, compile.stdout + compile.stderr).toBe(0);

        const shipDir = temp("knext-x-meta-ship-");
        cpSync(outFile, join(shipDir, "meta-exec"));
        rmSync(buildDir, { recursive: true, force: true });
        const run = spawnSync(join(shipDir, "meta-exec"), [], {
            cwd: shipDir,
            encoding: "utf-8",
            timeout: 30_000,
        });
        expect(run.status, run.stdout + run.stderr).toBe(0);
    }, 120_000);
});
