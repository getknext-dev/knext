/**
 * Every vinext runtime path turns on vinext's own deploy Cache-Control switch
 * (`VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1`) by calling `applyVinextDeployDefault`
 * at process start, before any request.
 *
 * SCANNED, not enumerated: the vinext runtime entries are found by walking the
 * repo for `knext-node-entry.mjs*` (vinext on Node: the entry itself must call
 * it) and by reading what `vinext-compile.mjs` injects into the compiled
 * executable (every `knext-bun-entry.mjs*` is compiled through it, so the
 * injected install module must call it). A new entry file that forgets the call
 * turns this red instead of silently serving no Cache-Control on a
 * `fallback: true` first request. Comments are stripped before matching, so an
 * explanatory comment cannot satisfy the guard.
 *
 * Also asserts nothing in the templates, scripts or workflows hard-sets the
 * variable to anything but `1` (an explicit `0` is the user's opt-out, never
 * knext's default).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "..", "..", "..", "..");
const SKIP = new Set([
    "node_modules",
    ".git",
    ".claude",
    ".next",
    ".output",
    "dist",
    "docs",
    "__tests__",
]);

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (SKIP.has(name)) continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FILES = walk(REPO);
const rel = (p: string) => relative(REPO, p);
const read = (p: string) => stripComments(readFileSync(p, "utf8"));

describe("vinext runtime paths default VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1", () => {
    const nodeEntries = FILES.filter((f) =>
        /(^|\/)knext-node-entry\.mjs(\.hbs)?$/.test(f),
    );

    it("finds the vinext-on-Node entry template(s)", () => {
        expect(nodeEntries.map(rel)).toContain(
            "packages/kn-next/templates/app/knext-node-entry.mjs.hbs",
        );
    });

    for (const f of nodeEntries) {
        it(`${rel(f)} calls applyVinextDeployDefault(process.env)`, () => {
            expect(read(f)).toMatch(/^applyVinextDeployDefault\(process\.env\);$/m);
        });
    }

    it("the compiled executable injects an install module that calls applyVinextDeployDefault", () => {
        const compile = read(
            join(REPO, "packages/kn-next/src/adapters/vinext-compile.mjs"),
        );
        // Every `import ${JSON.stringify(X_FILE)}` the compile prepends to the
        // entry; resolve each X_FILE to the module name it looks up.
        const injected = [
            ...compile.matchAll(/`import \$\{JSON\.stringify\((\w+)\)\};\\n`/g),
        ].map((m) => m[1]);
        expect(injected.length).toBeGreaterThan(0);
        const modules = injected.map((id) => {
            const decl = compile.match(
                new RegExp(`const ${id} = \\[([\\s\\S]*?)\\]`),
            );
            const name = decl?.[1].match(/"([\w-]+)\.(?:m?js)"/)?.[1];
            expect(name, `${id} resolves to a module`).toBeTruthy();
            return `${name}.mjs`;
        });
        const covered = modules.filter((m) => {
            const p = join(REPO, "packages/kn-next/src/adapters", m);
            return /applyVinextDeployDefault\(/.test(read(p));
        });
        expect(covered.length).toBeGreaterThan(0);
    });

    it("no template, script or workflow sets the variable to anything but 1", () => {
        const scanned = FILES.filter(
            (f) =>
                /\.(hbs|sh|ya?ml|mjs|cjs|ts|json)$/.test(f) &&
                /(templates|scripts|\.github|adapters)/.test(rel(f)),
        );
        const bad: string[] = [];
        for (const f of scanned) {
            const src = readFileSync(f, "utf8");
            for (const m of src.matchAll(
                /VINEXT_NEXT_DEPLOY_CACHE_CONTROL\s*[=:]\s*["']?([^\s"',;)`]*)/g,
            )) {
                if (m[1] !== "1" && m[1] !== "") bad.push(`${rel(f)}: ${m[0]}`);
            }
        }
        expect(bad).toEqual([]);
    });
});
