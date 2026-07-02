/**
 * PK1 (#114) — Publish-surface packaging correctness for @knext/core.
 *
 * The package historically advertised its ENTIRE library surface as raw
 * TypeScript (`main`/`types` = ./src/config.ts, every `exports` subpath →
 * ./src/*.ts), while `tsup` only built the CLI entries. On plain Node an app
 * importing `@knext/core/adapter` (or the `KnativeNextConfig` type) resolved to
 * a `.ts` file Node cannot load.
 *
 * These tests encode the acceptance criteria:
 *  - No `main`/`types`/`exports` entry references `./src/*.ts`; all point at dist.
 *  - Every `exports` subpath target exists in the built `dist/` output.
 *  - The CLI bin still points at ./dist/cli/kn-next.js.
 *
 * The dist-existence assertions require a prior `tsup` build. They are written
 * RED-first: with only the CLI entries built, the library targets are missing.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, "../..");

// biome-ignore lint/suspicious/noExplicitAny: reading arbitrary package.json shape
const pkg: any = require(resolve(pkgDir, "package.json"));

/** Collect every file path referenced by main/types/exports. */
function exportTargets(): string[] {
    const targets: string[] = [];
    if (typeof pkg.main === "string") targets.push(pkg.main);
    if (typeof pkg.types === "string") targets.push(pkg.types);
    if (typeof pkg.module === "string") targets.push(pkg.module);
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
        if (key === "//") continue; // documentation marker, not a file target
        if (typeof value === "string") {
            targets.push(value);
        } else if (value && typeof value === "object") {
            // conditional exports ({ import, require, types, default })
            for (const cond of Object.values(
                value as Record<string, unknown>,
            )) {
                if (typeof cond === "string") targets.push(cond);
            }
        }
    }
    return targets;
}

describe("PK1: @knext/core publish surface", () => {
    it("main and types point at compiled dist, never raw src/*.ts", () => {
        expect(pkg.main).toMatch(/^\.\/dist\//);
        expect(pkg.types).toMatch(/^\.\/dist\//);
        expect(pkg.main).not.toMatch(/\.ts$/);
        expect(pkg.types).toMatch(/\.d\.ts$/);
    });

    it("no main/types/exports entry references ./src/*.ts", () => {
        for (const target of exportTargets()) {
            expect(
                target,
                `${target} must not be a raw src/*.ts file`,
            ).not.toMatch(/^\.\/src\/.*\.ts$/);
            expect(target, `${target} must resolve under ./dist/`).toMatch(
                /^\.\/dist\//,
            );
        }
    });

    it("declares every library subpath the example app and CLI import", () => {
        const exp = pkg.exports ?? {};
        // PK5 (#116) split these into a PUBLIC application surface and
        // INTERNAL framework-wiring subpaths under ./internal/*. Every dist
        // target the example app and runtime resolve must still be declared.
        for (const subpath of [
            // public application surface (cache-handler is the app's ISR
            // cacheHandler wiring point — a local re-export targets this path)
            ".",
            "./adapter",
            "./adapters/otel-config",
            "./adapters/cache-handler",
            // internal framework wiring (runtime / CLI / operator)
            "./internal/next-adapter",
            "./internal/node-server",
            "./internal/loader",
            "./internal/logger",
            "./internal/cli-validate",
            "./internal/cli-shared",
            // #188 — Bun ≤1.3.x keep-alive mitigation preload (bun lane only)
            "./internal/bun-keepalive-guard",
        ]) {
            expect(exp, `exports must declare ${subpath}`).toHaveProperty(
                subpath,
            );
        }
    });

    it("ships dist (not src) in the published files list", () => {
        expect(pkg.files).toContain("dist");
        expect(pkg.files).not.toContain("src");
    });

    it("keeps the CLI bin pointed at the bundled dist entry", () => {
        expect(pkg.bin["kn-next"]).toBe("./dist/cli/kn-next.js");
    });

    // --- Build-output resolution (requires `tsup` to have run) -------------
    it("every exports subpath resolves to a file present in dist", () => {
        for (const target of exportTargets()) {
            const abs = resolve(pkgDir, target);
            expect(existsSync(abs), `missing built output: ${target}`).toBe(
                true,
            );
        }
    });

    it("emits a .d.ts for each TypeScript-typed subpath", () => {
        const typed = Object.entries(pkg.exports ?? {})
            .filter(([sub]) => sub !== "./adapters/cache-handler")
            .map(([, value]) =>
                typeof value === "string"
                    ? value
                    : (value as Record<string, string>).types,
            )
            .filter((v): v is string => typeof v === "string");
        // At minimum the root export must carry types as a .d.ts in dist.
        const rootTypes =
            typeof pkg.exports?.["."] === "string"
                ? pkg.types
                : (pkg.exports?.["."] as Record<string, string>)?.types;
        expect(rootTypes ?? pkg.types).toMatch(/\.d\.ts$/);
        for (const dts of typed) {
            if (dts.endsWith(".d.ts")) {
                expect(
                    existsSync(resolve(pkgDir, dts)),
                    `missing types output: ${dts}`,
                ).toBe(true);
            }
        }
    });
});
