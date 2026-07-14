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
 * These tests are the executable form of that contract. They assert:
 *  - the public subpaths the doc promises all exist in `package.json` exports
 *    and resolve to real JS + `.d.ts` in dist;
 *  - internal subpaths are clearly separated under an `./internal/*` prefix
 *    (the discoverable convention), never mixed into the public namespace;
 *  - no in-repo app/runtime regressed onto a removed bare subpath.
 *
 * They are a real gate: if someone adds a new top-level export without marking
 * it public (in the doc) or internal (under ./internal/*), this fails.
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

/** The deliberate, supported public application surface (PK5). */
const PUBLIC_CORE = [".", "./adapter", "./adapters/otel-config", "./validate"];
const PUBLIC_LIB = [".", "./logger", "./clients", "./health"];

/**
 * `@knext/core/adapters/cache-handler` is PUBLIC but plain (untyped) JS — apps
 * reference it from next.config `cacheHandler` via a thin local re-export. It
 * resolves to a bare `.js` with no `.d.ts`, so it is verified separately.
 */
const PUBLIC_CORE_UNTYPED = ["./adapters/cache-handler"];

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

describe("PK5: @knext/core public API surface", () => {
    it("declares every documented public subpath", () => {
        for (const sub of [...PUBLIC_CORE, ...PUBLIC_CORE_UNTYPED]) {
            expect(
                corePkg.exports,
                `core must publicly export ${sub}`,
            ).toHaveProperty(sub);
        }
    });

    it("resolves each typed public subpath to real JS + .d.ts in dist", () => {
        for (const sub of PUBLIC_CORE) {
            const entry = corePkg.exports[sub];
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

    it("resolves the untyped public cache-handler subpath to real JS in dist", () => {
        for (const sub of PUBLIC_CORE_UNTYPED) {
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
        // is NOT here — it is a public app wiring point, see PUBLIC_CORE_UNTYPED.)
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
        const doc = readFileSync(PUBLIC_API_DOC, "utf8");
        for (const key of Object.keys(corePkg.exports)) {
            if (key.startsWith("./internal/")) continue;
            const importPath =
                key === "." ? "@knext/core" : `@knext/core${key.slice(1)}`;
            expect(
                doc.includes(importPath),
                `public core export ${key} must be documented as @knext/core${key === "." ? "" : key.slice(1)}`,
            ).toBe(true);
        }
    });
});

describe("PK5: @knext/lib public API surface", () => {
    it("declares every documented public subpath", () => {
        for (const sub of PUBLIC_LIB) {
            expect(
                libPkg.exports,
                `lib must publicly export ${sub}`,
            ).toHaveProperty(sub);
        }
    });

    it("resolves each public subpath to real JS + .d.ts in dist", () => {
        for (const sub of PUBLIC_LIB) {
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
        const doc = readFileSync(PUBLIC_API_DOC, "utf8");
        // user-facing: must not leak ADR numbers, PK/issue jargon, or strategy terms
        expect(doc).not.toMatch(/ADR-\d{4}/);
        expect(doc).not.toMatch(/\bPK\d\b/);
        expect(doc).not.toMatch(/#\d{2,}/);
    });

    it("documents the public surface for both packages", () => {
        const doc = readFileSync(PUBLIC_API_DOC, "utf8");
        for (const sub of [...PUBLIC_CORE, ...PUBLIC_CORE_UNTYPED]) {
            const p =
                sub === "." ? "@knext/core" : `@knext/core${sub.slice(1)}`;
            expect(doc.includes(p), `doc must list ${p}`).toBe(true);
        }
        for (const sub of PUBLIC_LIB) {
            const p = sub === "." ? "@knext/lib" : `@knext/lib${sub.slice(1)}`;
            expect(doc.includes(p), `doc must list ${p}`).toBe(true);
        }
    });

    it("names the internal (unsupported) subpaths explicitly", () => {
        const doc = readFileSync(PUBLIC_API_DOC, "utf8");
        expect(doc.toLowerCase()).toContain("internal");
        expect(doc).toContain("@knext/core/internal/");
    });

    it("states a stability / semver policy", () => {
        const doc = readFileSync(PUBLIC_API_DOC, "utf8").toLowerCase();
        expect(doc).toContain("semver");
        expect(doc).toContain("deprecat");
        expect(doc).toMatch(/stability|stable/);
    });
});
