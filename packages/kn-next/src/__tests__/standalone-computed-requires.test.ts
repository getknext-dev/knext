/**
 * The compiled standalone-on-Bun executable keeps the disk closure out of the
 * bundle by scanning LITERAL require/import specifiers (standalone-compile.mjs).
 * A COMPUTED specifier — `require(pagePath)`, `import(pathToFileURL(p).href)` —
 * is invisible to that scan: the bundler cannot follow it, so at runtime it
 * resolves from disk. If it ever loads a module the executable ALSO bundled,
 * the process holds two instances of it (the NoFallbackError split class).
 *
 * Those sites cannot be closed statically, so they are INVENTORIED: the compile
 * reports the ones in its bundled set, and this suite pins the reviewed set in
 * the Next.js server core. A Next upgrade that adds, moves or removes one
 * fails here, so a person re-reviews what it can load before it ships.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    computedRequireInventory,
    computedRequireSites,
    literalRequireClosure,
} from "../adapters/computed-require-scan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PINNED = JSON.parse(
    readFileSync(
        join(HERE, "fixtures/standalone-computed-requires.json"),
        "utf8",
    ),
);

const count = (src: string) => computedRequireSites(src).length;

describe("computedRequireSites — what counts as a computed specifier", () => {
    it("does not count literal specifiers", () => {
        expect(
            count(
                `require("a"); require('b'); require(\`c\`); import("d"); import('e');`,
            ),
        ).toBe(0);
        expect(count(`require( /* turbopackIgnore: true */ "a" )`)).toBe(0);
    });

    it("counts non-literal specifiers", () => {
        expect(count("require(pagePath)")).toBe(1);
        expect(count("await import((0, _url.pathToFileURL)(p).href)")).toBe(1);
        expect(count("require(`${pkg}/package.json`)")).toBe(1);
        expect(count("__non_webpack_require__(id)")).toBe(1);
        expect(count("require(/* turbopackIgnore: true */ pagePath)")).toBe(1);
        expect(count("const f = (e) => import(e).then((m) => m.default)")).toBe(
            1,
        );
        expect(count("require('a' + name)")).toBe(1);
    });

    it("ignores comments and string contents", () => {
        expect(
            count(
                "// dynamic import() support\n/* require(x) */ const s = 'require(';",
            ),
        ).toBe(0);
        expect(
            count('const t = `use import() here`; const d = "require(x)";'),
        ).toBe(0);
    });

    it("ignores other functions whose names end in require", () => {
        expect(
            count(
                "_require(x); obj.require(x); __nccwpck_require__(1); require.resolve(x); $require(x)",
            ),
        ).toBe(0);
    });

    it("tracks templates nested inside template expressions", () => {
        expect(
            count(
                "const t = `${a.map((x) => `import(${x})`).join('')}`; require(y);",
            ),
        ).toBe(1);
        expect(count("const t = `x ${require(p)} y`;")).toBe(1);
        expect(
            count(
                "const h = `typeof import(${JSON.stringify(p.replace(/\\.tsx?$/, '.js'))})`; require(q);",
            ),
        ).toBe(1);
    });

    it("is not thrown off by a regex literal containing a quote", () => {
        expect(count(`const r = /"/g; const q = /'/; require(x);`)).toBe(1);
        expect(count(`x = a / b; y = "s"; require(z);`)).toBe(1);
    });
});

describe("computedRequireSites — definitions are not calls", () => {
    it("does not count a method or function NAMED require/import", () => {
        expect(
            count(
                "class L { static require(id) { return 1; } import(data) { this.d = data; } }",
            ),
        ).toBe(0);
        expect(count("function require(id) { return id; }")).toBe(0);
    });

    it("still counts the call inside such a method", () => {
        expect(
            count(
                "class L { static require(id) { try { return require(id); } catch { return null; } } }",
            ),
        ).toBe(1);
    });
});

describe("the reviewed inventory for the Next.js server core", () => {
    // The Next this package is built and tested against.
    const req = createRequire(resolve(HERE, "../../package.json"));
    const nextDir = dirname(req.resolve("next/package.json"));
    const nextVersion = JSON.parse(
        readFileSync(join(nextDir, "package.json"), "utf8"),
    ).version;
    const roots = [
        req.resolve("next"),
        req.resolve("next/dist/server/lib/start-server"),
    ];
    const inventory = computedRequireInventory(
        literalRequireClosure(roots, nextDir),
        nextDir,
    );

    it("walks a real closure (not an empty one)", () => {
        expect(Object.keys(inventory).length).toBeGreaterThan(5);
    });

    it("equals the pinned, reviewed set — re-review any change before updating the pin", () => {
        const pinned = Object.fromEntries(
            Object.entries(
                PINNED.sites as Record<string, { count: number }>,
            ).map(([f, s]) => [f, s.count]),
        );
        expect({ next: nextVersion, sites: inventory }).toEqual({
            next: nextVersion,
            sites: pinned,
        });
    });

    it("gives every pinned site a reason", () => {
        for (const [file, site] of Object.entries(
            PINNED.sites as Record<string, { reason?: string }>,
        )) {
            expect({ file, reason: (site.reason ?? "").length > 20 }).toEqual({
                file,
                reason: true,
            });
        }
    });
});
