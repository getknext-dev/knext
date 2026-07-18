/**
 * #356 / ADR-0031 — the knext app template (the `turbo gen zone` scaffolding,
 * `turbo/generators/templates/zone/`) must emit the guarded-instrumentation
 * pair BY DEFAULT so a generated app inherits the two invariants that three
 * shipped observability features silently violated (#342 edge-safety,
 * #352/ADR-0027 seam-alive):
 *
 *   1. EDGE-SAFETY (#342): `src/instrumentation.ts` is edge-clean (no top-level
 *      static import of a Node-only module), guards the Node-only body behind
 *      `NEXT_RUNTIME === 'nodejs'`, and loads it via a dynamic
 *      `await import('./instrumentation-node')`. The load-bearing edge
 *      exclusion (webpack `IgnorePlugin`) is PLATFORM-OWNED — injected by the
 *      knext adapter's `modifyConfig` (guarded by
 *      `adapter-edge-ignore-plugin.test.ts`) — so the generated
 *      `next.config.ts` wires `adapterPath` and must NOT hand-write the hook.
 *
 *   2. SEAM-ALIVE (#352/ADR-0027): the generated `instrumentation-node.ts`
 *      wires the `@knext/lib` collaborator seams (`setPoolInstrumentor`,
 *      `setTraceIdProvider`, `setCorrelationIdProvider`) whose state is
 *      anchored on `globalThis` via `Symbol.for('knext.lib.*')`, and the
 *      generated `next.config.ts` never externalizes `@knext/lib`.
 *
 *   3. GRADUATED GUARDS: file-manager's per-app static guards
 *      (`instrumentation-edge-safe.test.ts`, `standalone-seam-alive.test.ts`,
 *      #344) ship as template files so EVERY generated app carries the gate.
 *
 * Written RED-first: none of the instrumentation template files existed before
 * #356, so every existence assertion failed.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// packages/kn-next/src/__tests__ → repo root
const REPO_ROOT = resolve(here, "../../../..");
const ZONE_TEMPLATE = join(REPO_ROOT, "turbo", "generators", "templates", "zone");
const LIB_SRC = join(REPO_ROOT, "packages", "lib", "src");

function readTemplate(rel: string): string | null {
    const p = join(ZONE_TEMPLATE, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/**
 * Modules that are Node-only and must never be reached from a top-level static
 * import in the generated `instrumentation.ts` (edge-compiled). Mirrors the
 * list in `apps/file-manager/instrumentation-edge-safe.test.ts`.
 */
const NODE_ONLY_MODULES = ["@knext/lib/clients", "pg", "@cerbos/grpc", "minio"];

/** Top-level *static* import specifiers (dynamic `await import()` excluded). */
function topLevelStaticImportSpecifiers(source: string): string[] {
    const specs: string[] = [];
    const staticImportRe = /^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm;
    const sideEffectImportRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
    for (const re of [staticImportRe, sideEffectImportRe]) {
        for (const match of source.matchAll(re)) {
            specs.push(match[1]);
        }
    }
    return specs;
}

describe("app template — edge-clean instrumentation.ts (#342/#356)", () => {
    const instrumentation = readTemplate("src/instrumentation.ts.hbs");

    it("the template emits src/instrumentation.ts", () => {
        expect(instrumentation, "src/instrumentation.ts.hbs missing from the zone template").not.toBeNull();
    });

    it("guards the Node-only body behind NEXT_RUNTIME === 'nodejs'", () => {
        expect(instrumentation).toMatch(/process\.env\.NEXT_RUNTIME\s*[!=]==?\s*['"]nodejs['"]/);
    });

    it("loads the Node-only body via a dynamic import of ./instrumentation-node", () => {
        expect(instrumentation).toMatch(/await\s+import\s*\(\s*['"]\.\/instrumentation-node['"]\s*\)/);
    });

    it.each(NODE_ONLY_MODULES)(
        "never top-level static-imports the Node-only module %s",
        (mod) => {
            expect(topLevelStaticImportSpecifiers(instrumentation ?? "")).not.toContain(mod);
        },
    );
});

describe("app template — seam-alive instrumentation-node.ts (#352/ADR-0027/#356)", () => {
    const instrumentationNode = readTemplate("src/instrumentation-node.ts.hbs");

    it("the template emits src/instrumentation-node.ts", () => {
        expect(
            instrumentationNode,
            "src/instrumentation-node.ts.hbs missing from the zone template",
        ).not.toBeNull();
    });

    it("exports the Node-only registerNode body", () => {
        expect(instrumentationNode).toMatch(/export\s+function\s+registerNode\s*\(/);
    });

    it.each([
        { mod: "@knext/lib/clients", fn: "setPoolInstrumentor" },
        { mod: "@knext/lib/context", fn: "setTraceIdProvider" },
        { mod: "@knext/lib/context", fn: "setCorrelationIdProvider" },
    ])("wires the globalThis-anchored seam $fn from $mod", ({ mod, fn }) => {
        const escaped = mod.replace(/\//g, "\\/");
        expect(instrumentationNode).toMatch(new RegExp(`from\\s*['"]${escaped}['"]`));
        expect(instrumentationNode).toContain(fn);
    });

    it("keeps tracing default-off via the core-owned resolveOtelOptions gate", () => {
        expect(instrumentationNode).toContain("resolveOtelOptions");
    });

    it("has NO app-relative imports (the generated body must be app-agnostic)", () => {
        const specs = topLevelStaticImportSpecifiers(instrumentationNode ?? "");
        for (const spec of specs) {
            expect(spec.startsWith(".")).toBe(false);
        }
    });

    it.each([
        {
            libFile: join(LIB_SRC, "clients.ts"),
            symbol: "knext.lib.clients.poolInstrumentor",
        },
        {
            libFile: join(LIB_SRC, "context", "index.ts"),
            symbol: "knext.lib.context.state",
        },
    ])(
        "the seam it wires stays anchored on globalThis in @knext/lib ($symbol)",
        ({ libFile, symbol }) => {
            // The anchor itself is owned (and unit-guarded) by @knext/lib; this
            // pins that the seams the template wires are the anchored ones.
            const src = readFileSync(libFile, "utf8");
            expect(src).toContain(`Symbol.for('${symbol}')`);
        },
    );
});

describe("app template — next.config wires the platform fence, never hand-writes it (#356)", () => {
    const nextConfig = readTemplate("next.config.ts.hbs");

    it("wires the knext adapter via adapterPath (the modifyConfig fence carrier)", () => {
        expect(nextConfig).toMatch(/adapterPath\s*:/);
    });

    it("keeps output:'standalone'", () => {
        expect(nextConfig).toMatch(/output:\s*['"]standalone['"]/);
    });

    it("does NOT hand-write the IgnorePlugin webpack hook (the adapter injects it)", () => {
        expect(nextConfig).not.toMatch(/IgnorePlugin/);
    });

    it("never externalizes @knext/lib (ADR-0027: would re-split the seam state)", () => {
        const externals = nextConfig?.match(/serverExternalPackages:\s*\[([^\]]*)\]/s)?.[1] ?? "";
        expect(externals).not.toMatch(/@knext\/lib/);
    });

    it("ships the thin app adapter re-exporting @knext/core/adapter", () => {
        const appAdapter = readTemplate("next-adapter.ts.hbs");
        expect(appAdapter, "next-adapter.ts.hbs missing from the zone template").not.toBeNull();
        expect(appAdapter).toMatch(/from\s*['"]@knext\/core\/adapter['"]/);
    });
});

describe("app template — graduated per-app guards ship with every generated app (#344/#356)", () => {
    it("ships instrumentation-edge-safe.test.ts (the static #342 fence)", () => {
        const guard = readTemplate("instrumentation-edge-safe.test.ts.hbs");
        expect(
            guard,
            "instrumentation-edge-safe.test.ts.hbs missing from the zone template",
        ).not.toBeNull();
        // The generated guard must carry BOTH halves of the edge-safety check…
        expect(guard).toContain("NEXT_RUNTIME");
        expect(guard).toContain("@knext/lib/clients");
        // …and assert the fence is adapter-owned (adapterPath wired, no
        // hand-written IgnorePlugin in the app's next.config).
        expect(guard).toContain("adapterPath");
        expect(guard).toContain("IgnorePlugin");
    });

    it("ships standalone-seam-alive.test.ts (the build-artifact #352 gate, parameterized)", () => {
        const guard = readTemplate("standalone-seam-alive.test.ts.hbs");
        expect(
            guard,
            "standalone-seam-alive.test.ts.hbs missing from the zone template",
        ).not.toBeNull();
        // Both globalThis seam keys must be asserted in the real standalone output.
        expect(guard).toContain("knext.lib.clients.poolInstrumentor");
        expect(guard).toContain("knext.lib.context.state");
        // CI hard-fail semantics are preserved for generated apps.
        expect(guard).toContain("KNEXT_REQUIRE_STANDALONE");
        // The standalone path is parameterized for the generated app name.
        expect(guard).toContain("apps/{{ name }}");
    });
});

describe("app template — package.json carries the instrumentation contract (#356)", () => {
    const pkg = readTemplate("package.json.hbs");

    it("builds with `next build --webpack` (the platform-proven path the fence applies to)", () => {
        expect(pkg).toMatch(/"build":\s*"next build --webpack"/);
    });

    it.each(["@vercel/otel", "prom-client"])(
        "declares the runtime dependency the generated instrumentation needs: %s",
        (dep) => {
            expect(pkg).toContain(`"${dep}"`);
        },
    );

    it("declares @knext/core (the adapter + core-owned instrumentation adapters)", () => {
        expect(pkg).toContain('"@knext/core"');
    });
});
