/**
 * PK5 (#116) — Public application API surface contract for @knext/core and
 * @knext/lib.
 *
 * PK1 made the published surface *resolvable* (every `exports` subpath points
 * at compiled `dist/` JS + `.d.ts`). PK5 makes it *intentional*: it draws the
 * line between the SUPPORTED public application surface and INTERNAL
 * framework-wiring subpaths, and documents that line in a user-facing Public
 * API reference with a stability policy.
 *
 * v5-P1 (#286) closes the drift hole PK5 left open: "what is public" was
 * registered in THREE independent places that nothing cross-checked —
 *   1. the `exports` map (minus the `./internal/*` prefix),
 *   2. the `knext.publicApi.public` array in package.json, and
 *   3. the subpaths documented in `docs/PUBLIC_API.md`.
 * PR #285 promoting `@knext/core/validate` shipped with `publicApi.public`
 * missing `./validate` while the other two had it (caught only in human
 * review). This file now derives the public set from the authoritative
 * `knext.publicApi.public` field and asserts all three sources AGREE on it —
 * there is no hand-maintained duplicate of the list any more.
 *
 * These tests are the executable form of that contract. They assert:
 *  - the three registries of the public subpath set agree exactly (the 3-way
 *    contract), naming any drifting entry;
 *  - each public subpath resolves to real JS (+ `.d.ts`, where typed) in dist;
 *  - internal subpaths are clearly separated under an `./internal/*` prefix
 *    (the discoverable convention), never mixed into the public namespace;
 *  - no in-repo app/runtime regressed onto a removed bare subpath.
 *
 * They are a real gate: if someone adds a new top-level export without adding
 * it to all three sources (exports map, publicApi.public, PUBLIC_API.md) — or
 * marking it internal under ./internal/* — this fails.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corePkgDir = resolve(__dirname, "../..");
const repoRoot = resolve(corePkgDir, "../..");
const libPkgDir = resolve(repoRoot, "packages/lib");

// biome-ignore lint/suspicious/noExplicitAny: reading arbitrary package.json shape
const corePkg: any = require(resolve(corePkgDir, "package.json"));
// biome-ignore lint/suspicious/noExplicitAny: reading arbitrary package.json shape
const libPkg: any = require(resolve(libPkgDir, "package.json"));

const PUBLIC_API_DOC = resolve(repoRoot, "docs/PUBLIC_API.md");
const DOC = readFileSync(PUBLIC_API_DOC, "utf8");

/**
 * The authoritative public subpath set for a package is its
 * `knext.publicApi.public` array in package.json — NOT a hardcoded list.
 * Everything below is derived from (or cross-checked against) it.
 */
// biome-ignore lint/suspicious/noExplicitAny: reading arbitrary package.json shape
function publicApiOf(pkg: any): {
    public: string[];
    internalPrefix: string | null;
} {
    const p = pkg?.knext?.publicApi;
    return {
        public: Array.isArray(p?.public) ? [...p.public] : [],
        internalPrefix:
            typeof p?.internalPrefix === "string" ? p.internalPrefix : null,
    };
}

const CORE_API = publicApiOf(corePkg);
const LIB_API = publicApiOf(libPkg);

/** Public subpaths declared by the `exports` map (minus the internal prefix). */
function exportsPublicSubpaths(
    pkg: { exports: Record<string, unknown> },
    internalPrefix: string | null,
): string[] {
    return Object.keys(pkg.exports).filter(
        (k) => !(internalPrefix && k.startsWith(internalPrefix)),
    );
}

/**
 * Subpaths that `docs/PUBLIC_API.md` documents as public for a package, derived
 * from its `### \`<importPath>\`` section headings. `@knext/<pkg>` → `.`,
 * `@knext/<pkg>/foo` → `./foo`. Internal (`/internal/`) headings are excluded —
 * those live in the "NOT supported" table, not as `###` sections.
 */
function docPublicSubpaths(pkgName: string): string[] {
    const subpaths = new Set<string>();
    const headingRe = /^###\s+`([^`]+)`/gm;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = headingRe.exec(DOC)) !== null) {
        const importPath = m[1];
        if (importPath === pkgName) {
            subpaths.add(".");
        } else if (importPath.startsWith(`${pkgName}/`)) {
            const rest = importPath.slice(pkgName.length + 1);
            if (rest.startsWith("internal/")) continue;
            subpaths.add(`./${rest}`);
        }
    }
    return [...subpaths];
}

function sorted(xs: string[]): string[] {
    return [...xs].sort();
}

function jsTargetOf(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
        const v = value as Record<string, string>;
        return v.import ?? v.default;
    }
    return undefined;
}

function dtsTargetOf(value: unknown): string | undefined {
    if (value && typeof value === "object") {
        return (value as Record<string, string>).types;
    }
    return undefined;
}

/**
 * `@knext/core/adapters/cache-handler` is PUBLIC but plain (untyped) JS — apps
 * reference it from next.config `cacheHandler` via a thin local re-export. It
 * resolves to a bare `.js` with no `.d.ts`, so its dist target is verified
 * separately from the typed subpaths. The list of *which* subpaths are untyped
 * is derived from the exports map itself (string-valued entries), not hardcoded
 * as a second public registry.
 */
function isTypedSubpath(entry: unknown): boolean {
    return dtsTargetOf(entry) !== undefined;
}

describe("v5-P1 (#286): @knext/core public API is a 3-way contract", () => {
    const authoritative = sorted(CORE_API.public);

    it("has a non-empty authoritative knext.publicApi.public set", () => {
        expect(
            CORE_API.public.length,
            "core knext.publicApi.public must list the public subpaths",
        ).toBeGreaterThan(0);
        expect(CORE_API.internalPrefix).toBe("./internal/");
    });

    it("the exports map (minus ./internal/*) equals the authoritative public set", () => {
        const fromExports = sorted(
            exportsPublicSubpaths(corePkg, CORE_API.internalPrefix),
        );
        // Set-equality; a mismatch names the drifting entry via the diff.
        expect(
            fromExports,
            "exports map public subpaths must match knext.publicApi.public",
        ).toEqual(authoritative);
    });

    it("PUBLIC_API.md documents exactly the authoritative public set", () => {
        const fromDoc = sorted(docPublicSubpaths("@knext/core"));
        expect(
            fromDoc,
            "docs/PUBLIC_API.md sections must match knext.publicApi.public",
        ).toEqual(authoritative);
    });
});

describe("v5-P1 (#286): @knext/lib public API is a 3-way contract", () => {
    const authoritative = sorted(LIB_API.public);

    it("has a non-empty authoritative knext.publicApi.public set", () => {
        expect(
            LIB_API.public.length,
            "lib knext.publicApi.public must list the public subpaths",
        ).toBeGreaterThan(0);
    });

    it("the exports map (minus internal prefix) equals the authoritative public set", () => {
        const fromExports = sorted(
            exportsPublicSubpaths(libPkg, LIB_API.internalPrefix),
        );
        expect(
            fromExports,
            "lib exports map public subpaths must match knext.publicApi.public",
        ).toEqual(authoritative);
    });

    it("PUBLIC_API.md documents exactly the authoritative public set", () => {
        const fromDoc = sorted(docPublicSubpaths("@knext/lib"));
        expect(
            fromDoc,
            "docs/PUBLIC_API.md sections must match lib knext.publicApi.public",
        ).toEqual(authoritative);
    });
});

describe("PK5: @knext/core public API surface", () => {
    it("declares every public subpath in the exports map", () => {
        for (const sub of CORE_API.public) {
            expect(
                corePkg.exports,
                `core must publicly export ${sub}`,
            ).toHaveProperty(sub);
        }
    });

    it("resolves each typed public subpath to real JS + .d.ts in dist", () => {
        for (const sub of CORE_API.public) {
            const entry = corePkg.exports[sub];
            if (!isTypedSubpath(entry)) continue; // untyped ones verified below
            const js = jsTargetOf(entry);
            const dts = dtsTargetOf(entry);
            expect(js, `${sub} must declare a JS target`).toBeDefined();
            expect(
                existsSync(resolve(corePkgDir, js as string)),
                `missing built JS for ${sub}: ${js}`,
            ).toBe(true);
            expect(dts, `${sub} must declare a .d.ts target`).toBeDefined();
            expect(dts).toMatch(/\.d\.ts$/);
            expect(
                existsSync(resolve(corePkgDir, dts as string)),
                `missing types for ${sub}: ${dts}`,
            ).toBe(true);
        }
    });

    it("resolves each untyped public subpath (e.g. cache-handler) to real JS in dist", () => {
        const untyped = CORE_API.public.filter(
            (sub) => !isTypedSubpath(corePkg.exports[sub]),
        );
        // There is at least the cache-handler wiring point in this category.
        expect(untyped.length).toBeGreaterThan(0);
        for (const sub of untyped) {
            const js = jsTargetOf(corePkg.exports[sub]);
            expect(js, `${sub} must declare a JS target`).toBeDefined();
            expect(
                existsSync(resolve(corePkgDir, js as string)),
                `missing built JS for ${sub}: ${js}`,
            ).toBe(true);
        }
    });

    it("keeps internal framework-wiring subpaths under ./internal/*", () => {
        // These are framework wiring used by the runtime / CLI / operator —
        // not a stable application import. PK5 segregates them so the boundary
        // is visible in the exports map itself, not just in prose. (cache-handler
        // is NOT here — it is a public app wiring point, in publicApi.public.)
        const internalConcepts = [
            "next-adapter",
            "node-server",
            "loader",
            "cli-shared",
            "cli-validate",
            "logger",
        ];
        const internalKeys = Object.keys(corePkg.exports).filter((k) =>
            k.startsWith("./internal/"),
        );
        expect(
            internalKeys.length,
            "internal subpaths must be exposed under ./internal/*",
        ).toBeGreaterThanOrEqual(internalConcepts.length);
    });

    it("does not expose framework internals in the public namespace", () => {
        // No bare (non-./internal) export may target a known-internal module.
        // NB: cache-handler is intentionally NOT forbidden — it is the public
        // ISR cache wiring an app references from next.config `cacheHandler`.
        const forbidden = [
            "node-server",
            "cli/shared.js",
            "cli/validate.js",
            "loader.js",
        ];
        for (const [key, value] of Object.entries(corePkg.exports)) {
            if (key.startsWith("./internal/")) continue;
            const js = jsTargetOf(value) ?? "";
            for (const f of forbidden) {
                expect(
                    js.includes(f),
                    `public export ${key} must not target internal module ${f}`,
                ).toBe(false);
            }
        }
    });

    it("every non-internal export is named public in the doc", () => {
        for (const key of Object.keys(corePkg.exports)) {
            if (key.startsWith("./internal/")) continue;
            const importPath =
                key === "." ? "@knext/core" : `@knext/core${key.slice(1)}`;
            expect(
                DOC.includes(importPath),
                `public core export ${key} must be documented as @knext/core${key === "." ? "" : key.slice(1)}`,
            ).toBe(true);
        }
    });
});

describe("PK5: @knext/lib public API surface", () => {
    it("declares every public subpath in the exports map", () => {
        for (const sub of LIB_API.public) {
            expect(
                libPkg.exports,
                `lib must publicly export ${sub}`,
            ).toHaveProperty(sub);
        }
    });

    it("resolves each public subpath to real JS + .d.ts in dist", () => {
        for (const sub of LIB_API.public) {
            const entry = libPkg.exports[sub];
            const js = jsTargetOf(entry);
            const dts = dtsTargetOf(entry);
            expect(js, `${sub} must declare a JS target`).toBeDefined();
            expect(
                existsSync(resolve(libPkgDir, js as string)),
                `missing built JS for ${sub}: ${js}`,
            ).toBe(true);
            expect(dts, `${sub} must declare a .d.ts target`).toBeDefined();
            expect(dts).toMatch(/\.d\.ts$/);
            expect(
                existsSync(resolve(libPkgDir, dts as string)),
                `missing types for ${sub}: ${dts}`,
            ).toBe(true);
        }
    });
});

describe("PK5: Public API reference doc accuracy", () => {
    it("the doc exists and is user-facing (no internal jargon)", () => {
        expect(
            existsSync(PUBLIC_API_DOC),
            "docs/PUBLIC_API.md must exist",
        ).toBe(true);
        // user-facing: must not leak ADR numbers, PK/issue jargon, or strategy terms
        expect(DOC).not.toMatch(/ADR-\d{4}/);
        expect(DOC).not.toMatch(/\bPK\d\b/);
        expect(DOC).not.toMatch(/#\d{2,}/);
    });

    it("documents the public surface for both packages", () => {
        for (const sub of CORE_API.public) {
            const p =
                sub === "." ? "@knext/core" : `@knext/core${sub.slice(1)}`;
            expect(DOC.includes(p), `doc must list ${p}`).toBe(true);
        }
        for (const sub of LIB_API.public) {
            const p = sub === "." ? "@knext/lib" : `@knext/lib${sub.slice(1)}`;
            expect(DOC.includes(p), `doc must list ${p}`).toBe(true);
        }
    });

    it("names the internal (unsupported) subpaths explicitly", () => {
        expect(DOC.toLowerCase()).toContain("internal");
        expect(DOC).toContain("@knext/core/internal/");
    });

    it("states a stability / semver policy", () => {
        const lower = DOC.toLowerCase();
        expect(lower).toContain("semver");
        expect(lower).toContain("deprecat");
        expect(lower).toMatch(/stability|stable/);
    });
});
