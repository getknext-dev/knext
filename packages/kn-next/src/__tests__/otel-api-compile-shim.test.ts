/**
 * The `@opentelemetry/api` require shim for the compiled vinext single
 * executable (#1309).
 *
 * Root cause: vinext 1.0.0-beta.11's built-in tracing resolves
 * `@opentelemetry/api` via `globalThis.require(...)` at runtime (the same
 * pattern `dist/server/client-trace-metadata.js` documents as an
 * intentional optional-peer resolution). `Bun.build` only bundles STATIC
 * import/require graphs, so that call is invisible to it — the compiled
 * binary never embeds `@opentelemetry/api`, and its `require` has no real
 * `node_modules` to fall back to, so every request touching that code path
 * throws `Cannot find module '@opentelemetry/api'` (measured: CI's "knext
 * adapter smoke (bun)" job, every route red after the beta.11 bump).
 *
 * Two properties are worth a guard, matching `bun-serve-keepalive-guard`'s
 * own two-wiring pattern:
 *  1. The shim function correctly intercepts ONLY the `@opentelemetry/api`
 *     specifier and delegates everything else to the original `require`.
 *  2. `vinext-compile.mjs` injects it as one of the entry's first imports.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installOtelApiRequireShim } from "../adapters/otel-api-compile-shim.mjs";

const ADAPTERS = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "adapters",
);
const COMPILE_SRC = resolve(ADAPTERS, "vinext-compile.mjs");

describe("installOtelApiRequireShim", () => {
    it("serves the bundled module for '@opentelemetry/api' only", () => {
        const fakeApi = { trace: {}, marker: "FAKE_OTEL_API" };
        const g: Record<PropertyKey, unknown> = {};
        installOtelApiRequireShim(g, fakeApi);
        expect(
            (g.require as (s: string) => unknown)("@opentelemetry/api"),
        ).toBe(fakeApi);
    });

    it("delegates every other specifier to the original require", () => {
        const original = (s: string) => `ORIGINAL:${s}`;
        const g: Record<PropertyKey, unknown> = { require: original };
        installOtelApiRequireShim(g, { marker: "FAKE_OTEL_API" });
        expect((g.require as (s: string) => unknown)("node:fs")).toBe(
            "ORIGINAL:node:fs",
        );
    });

    it("throws for an unknown specifier when there is no original require to fall back to", () => {
        const g: Record<PropertyKey, unknown> = {};
        installOtelApiRequireShim(g, { marker: "FAKE_OTEL_API" });
        expect(() => (g.require as (s: string) => unknown)("left-pad")).toThrow(
            /Cannot find module 'left-pad'/,
        );
    });

    it("installs at most once (idempotent — a second install does not re-wrap)", () => {
        const g: Record<PropertyKey, unknown> = {};
        installOtelApiRequireShim(g, { marker: "first" });
        const wrapped = g.require;
        installOtelApiRequireShim(g, { marker: "second" });
        expect(g.require).toBe(wrapped);
    });
});

describe("wiring — the COMPILED binary bakes the otel shim in (vinext-compile.mjs)", () => {
    const src = () => readFileSync(COMPILE_SRC, "utf8");

    it("resolves the shim beside vinext-compile (dist AND source names)", () => {
        const s = src();
        expect(s).toContain("otel-api-compile-shim.js");
        expect(s).toContain("otel-api-compile-shim.mjs");
    });

    it("injects the shim import into the preamble alongside the keep-alive guard", () => {
        const s = src();
        expect(s).toContain(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the LITERAL source substring being asserted, not a template
            'OTEL_SHIM_FILE ? `import ${JSON.stringify(OTEL_SHIM_FILE)};` : ""',
        );
    });

    it("is a WARNING, not a fail-closed abort, when the shim file is absent", () => {
        // Unlike the keep-alive guard (process.exit(1) on absence), the otel shim
        // is best-effort: a vinext dist that never reaches the guarded require
        // path should still compile.
        const s = src();
        const warnBlock = s.match(/if\s*\(!OTEL_SHIM_FILE\)\s*\{[\s\S]*?\}/);
        expect(
            warnBlock,
            "the OTEL_SHIM_FILE absence branch moved — re-anchor",
        ).not.toBeNull();
        expect((warnBlock as RegExpMatchArray)[0]).not.toContain(
            "process.exit(1)",
        );
    });
});
