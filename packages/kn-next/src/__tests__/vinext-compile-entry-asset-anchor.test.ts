/**
 * `vinext-compile.mjs` runs its asset-anchor rewrite (entry-asset-anchor.mjs,
 * cluster C4) on the ENTRY file too, not only on the chunks/externals branch
 * `vinext-compile-og-exec.test.ts` exercises through a real `@vercel/og`
 * build. No realistic nitro entry happens to contain its own `new URL(<lit>,
 * import.meta.url)` sibling read — so this is the dedicated, independent
 * mutation-proof for that second call site: revert it alone (leaving the
 * non-entry branch intact) and ONLY this test goes red, never
 * vinext-compile-og-exec.test.ts.
 *
 * The entry is hand-built, like vinext-compile-chunk-requires.test.ts's
 * fixtures: a minimal ESM module with ONE `new URL("./sibling.txt",
 * import.meta.url)` + `fs.readFileSync`, no server, no nitro. Compiled for
 * real with `bun build --compile --bytecode` through the SHIPPED script, then
 * run as a one-shot process from a FRESH directory with the build dir gone —
 * the same portability proof as the OG e2e, at the entry's own call site.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

function hostTarget(): string {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return process.platform === "darwin"
        ? `bun-darwin-${arch}`
        : `bun-linux-${arch}`;
}

describe("#C4 the ENTRY's own asset anchors survive the compiled exec too", () => {
    it("reads its sibling file by its embedded content, not a build-time path, from a moved binary", () => {
        const buildDir = temp("knext-entry-asset-anchor-build-");
        const serverDir = join(buildDir, ".output", "server");
        mkdirSync(serverDir, { recursive: true });

        const MARKER = "KNEXT_C4_ENTRY_SIBLING_c91a7f";
        writeFileSync(join(serverDir, "sibling.txt"), MARKER);
        writeFileSync(
            join(serverDir, "index.mjs"),
            [
                'import { readFileSync } from "node:fs";',
                'import { fileURLToPath } from "node:url";',
                'const p = fileURLToPath(new URL("./sibling.txt", import.meta.url));',
                "console.log(readFileSync(p, 'utf8'));",
            ].join("\n"),
        );

        const outFile = join(buildDir, "entry-anchor-exec");
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
            { encoding: "utf-8", timeout: 60_000 },
        );
        expect(compile.status, compile.stdout + compile.stderr).toBe(0);
        expect(existsSync(outFile)).toBe(true);

        // Move to a FRESH directory, build dir gone — the portability proof.
        const shipDir = temp("knext-entry-asset-anchor-ship-");
        const shippedBinary = join(shipDir, "entry-anchor-exec");
        cpSync(outFile, shippedBinary);
        rmSync(buildDir, { recursive: true, force: true });

        const run = spawnSync(shippedBinary, [], {
            cwd: shipDir,
            encoding: "utf-8",
            timeout: 10_000,
        });
        expect(run.status, run.stdout + run.stderr).toBe(0);
        expect(run.stdout.trim()).toBe(MARKER);
    }, 60_000);
});
