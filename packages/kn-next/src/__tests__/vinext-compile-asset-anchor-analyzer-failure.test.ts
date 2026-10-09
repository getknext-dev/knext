/**
 * The asset-anchor analyzer runs as its own `bun` process. If that PROCESS
 * fails (crash, kill or timeout, acorn not loadable, output that is not an
 * analysis), the compile must FAIL with an actionable `[knext compile]`
 * message rather than carry on and silently ship a binary with no embedded
 * siblings — next/og's wasm and font included, which then ENOENT on every
 * route.
 *
 * Each failure case copies the SHIPPED adapters directory to a temp dir and
 * swaps in a stub analyzer beside vinext-compile (where it resolves it), so
 * the real compile script runs against a broken analyzer. Pass/fail is
 * decided by EXIT CODE; the message assertions only check that the failure is
 * named.
 *
 * Two non-fatal cases are logged instead, and asserted on the build log: a
 * module acorn cannot parse (named, with its anchors not embedded), and an
 * anchor whose use is not recognised as a read (one line each, with why).
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

const ADAPTERS = resolve(import.meta.dir, "../adapters");

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

/** A `.output/server` tree whose one package module is `moduleSource`, with a sibling `x.wasm`. */
function buildFixture(moduleSource: string) {
    const buildDir = temp("knext-x-analyzer-build-");
    const serverDir = join(buildDir, ".output", "server");
    const distDir = join(serverDir, "node_modules", "@acme", "reader", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "x.wasm"), "XWASM");
    writeFileSync(join(distDir, "index.js"), moduleSource);
    writeFileSync(
        join(serverDir, "index.mjs"),
        [
            'import { value } from "./node_modules/@acme/reader/dist/index.js";',
            "console.log(String(value));",
        ].join("\n"),
    );
    return { buildDir, serverDir };
}

const READ_MODULE = [
    'import { readFileSync } from "node:fs";',
    'export const value = readFileSync(new URL("./x.wasm", import.meta.url), "utf8");',
].join("\n");

/** Compile with `compileScript`; returns the exit status and the whole log. */
function compile(compileScript: string, serverDir: string, buildDir: string) {
    const outFile = join(buildDir, "anchor-exec");
    const r = spawnSync(
        "bun",
        [
            "run",
            compileScript,
            "--entry",
            join(serverDir, "index.mjs"),
            "--outfile",
            outFile,
            "--target",
            hostTarget(),
        ],
        { encoding: "utf-8", timeout: 90_000 },
    );
    return { status: r.status, log: `${r.stdout}\n${r.stderr}`, outFile };
}

/** A copy of the shipped adapters dir with `asset-anchor-analyze.mjs` replaced by `stub` (or kept, when undefined). */
function adaptersWithAnalyzer(stub: string | undefined): string {
    const dir = join(temp("knext-x-analyzer-adapters-"), "adapters");
    cpSync(ADAPTERS, dir, { recursive: true });
    if (stub !== undefined)
        writeFileSync(join(dir, "asset-anchor-analyze.mjs"), stub);
    return join(dir, "vinext-compile.mjs");
}

describe("an asset-anchor analyzer PROCESS failure fails the compile (never a silent no-embed)", () => {
    it.each<[string, string | undefined, RegExp]>([
        ["it crashes", 'console.error("boom"); process.exit(3);', /exited 3/],
        [
            "it is killed (as the timeout kills it)",
            'process.kill(process.pid, "SIGTERM"); await new Promise(() => {});',
            /was killed by SIGTERM/,
        ],
        [
            "it prints garbage",
            'process.stdout.write("not json at all");',
            /printed no JSON/,
        ],
        [
            "it prints JSON that is not an analysis",
            "process.stdout.write(JSON.stringify({ anchors: [{ literal: 1 }] }));",
            /not an analysis/,
        ],
        // The REAL analyzer, copied where `acorn` is not resolvable (the temp
        // dir has no node_modules, and the spawn passes --no-install).
        ["it cannot load acorn", undefined, /exited 1/],
    ])(
        "when %s",
        (_name, stub, why) => {
            const { buildDir, serverDir } = buildFixture(READ_MODULE);
            const { status, log, outFile } = compile(
                adaptersWithAnalyzer(stub),
                serverDir,
                buildDir,
            );
            expect(status, log).not.toBe(0);
            expect(existsSync(outFile)).toBe(false);
            expect(log).toContain("[knext compile] the asset-anchor analyzer");
            expect(log).toMatch(why);
            expect(log).toContain(join("@acme", "reader", "dist", "index.js"));
        },
        120_000,
    );
});

describe("non-fatal anchors are named in the build log", () => {
    it("a module acorn cannot parse: the build succeeds and the warning names the module", () => {
        // Bun accepts JSX in a `.js` file (classic runtime via the pragma);
        // acorn does not — a real "bundles fine, does not parse" module.
        const src = [
            "/** @jsxRuntime classic */",
            "/** @jsx h */",
            "const h = (t) => t;",
            "export const tag = <div />;",
            'import { readFileSync } from "node:fs";',
            'export const value = readFileSync(new URL("./x.wasm", import.meta.url), "utf8");',
        ].join("\n");
        const { buildDir, serverDir } = buildFixture(src);
        const { status, log } = compile(
            join(ADAPTERS, "vinext-compile.mjs"),
            serverDir,
            buildDir,
        );
        expect(status, log).toBe(0);
        expect(log).toMatch(
            /\[knext compile\] could not parse \S*@acme\/reader\/dist\/index\.js .*NONE of its new URL/,
        );
    }, 120_000);

    it("an anchor whose use is not a recognised read: one line saying it was not embedded, and why", () => {
        const src = [
            'import { createReadStream, readFileSync } from "node:fs";',
            'export const stream = () => createReadStream(new URL("./x.wasm", import.meta.url));',
            'export const value = readFileSync(new URL("./x.wasm", import.meta.url), "utf8");',
        ].join("\n");
        const { buildDir, serverDir } = buildFixture(src);
        const { status, log } = compile(
            join(ADAPTERS, "vinext-compile.mjs"),
            serverDir,
            buildDir,
        );
        expect(status, log).toBe(0);
        expect(log).toMatch(
            /\[knext compile\] did not embed \.\/x\.wasm for \S*@acme\/reader\/dist\/index\.js: it is passed to createReadStream\(\)/,
        );
        expect(log).toContain("[knext compile] embedded sibling asset");
    }, 120_000);
});
