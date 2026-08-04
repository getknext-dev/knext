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
 *      wires the `@getknext/lib` collaborator seams (`setPoolInstrumentor`,
 *      `setTraceIdProvider`, `setCorrelationIdProvider`) whose state is
 *      anchored on `globalThis` via `Symbol.for('knext.lib.*')`, and the
 *      generated `next.config.ts` never externalizes `@getknext/lib`.
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
const ZONE_TEMPLATE = join(
    REPO_ROOT,
    "turbo",
    "generators",
    "templates",
    "zone",
);
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
const NODE_ONLY_MODULES = [
    "@getknext/lib/clients",
    "pg",
    "@cerbos/grpc",
    "minio",
];

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
        expect(
            instrumentation,
            "src/instrumentation.ts.hbs missing from the zone template",
        ).not.toBeNull();
    });

    it("guards the Node-only body behind NEXT_RUNTIME === 'nodejs'", () => {
        expect(instrumentation).toMatch(
            /process\.env\.NEXT_RUNTIME\s*[!=]==?\s*['"]nodejs['"]/,
        );
    });

    it("loads the Node-only body via a dynamic import of ./instrumentation-node", () => {
        expect(instrumentation).toMatch(
            /await\s+import\s*\(\s*['"]\.\/instrumentation-node['"]\s*\)/,
        );
    });

    it.each(
        NODE_ONLY_MODULES,
    )("never top-level static-imports the Node-only module %s", (mod) => {
        expect(
            topLevelStaticImportSpecifiers(instrumentation ?? ""),
        ).not.toContain(mod);
    });
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
        expect(instrumentationNode).toMatch(
            /export\s+function\s+registerNode\s*\(/,
        );
    });

    it.each([
        { mod: "@getknext/lib/clients", fn: "setPoolInstrumentor" },
        { mod: "@getknext/lib/context", fn: "setTraceIdProvider" },
        { mod: "@getknext/lib/context", fn: "setCorrelationIdProvider" },
    ])("wires the globalThis-anchored seam $fn from $mod", ({ mod, fn }) => {
        const escaped = mod.replace(/\//g, "\\/");
        expect(instrumentationNode).toMatch(
            new RegExp(`from\\s*['"]${escaped}['"]`),
        );
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
    ])("the seam it wires stays anchored on globalThis in @getknext/lib ($symbol)", ({
        libFile,
        symbol,
    }) => {
        // The anchor itself is owned (and unit-guarded) by @getknext/lib; this
        // pins that the seams the template wires are the anchored ones.
        const src = readFileSync(libFile, "utf8");
        expect(src).toContain(`Symbol.for('${symbol}')`);
    });
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
        // A hand-written hook would construct the plugin or define a webpack
        // config key; comments may legitimately NAME the injected fence.
        expect(nextConfig).not.toMatch(/new\s+webpack\.IgnorePlugin\s*\(/);
        expect(nextConfig).not.toMatch(/^\s*webpack\s*[:(]/m);
    });

    it("never externalizes @getknext/lib (ADR-0027: would re-split the seam state)", () => {
        const externals =
            nextConfig?.match(/serverExternalPackages:\s*\[([^\]]*)\]/s)?.[1] ??
            "";
        expect(externals).not.toMatch(/@getknext\/lib/);
    });

    it("ships the thin app adapter re-exporting @getknext/core/adapter", () => {
        const appAdapter = readTemplate("next-adapter.ts.hbs");
        expect(
            appAdapter,
            "next-adapter.ts.hbs missing from the zone template",
        ).not.toBeNull();
        expect(appAdapter).toMatch(/from\s*['"]@getknext\/core\/adapter['"]/);
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
        expect(guard).toContain("@getknext/lib/clients");
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

    it.each([
        "@vercel/otel",
        "prom-client",
    ])("declares the runtime dependency the generated instrumentation needs: %s", (dep) => {
        expect(pkg).toContain(`"${dep}"`);
    });

    it("declares @getknext/core (the adapter + core-owned instrumentation adapters)", () => {
        expect(pkg).toContain('"@getknext/core"');
    });

    /**
     * #408 item 2 — the generated app must be able to run its seam-alive guard
     * for REAL, not green-by-skip. The guard hard-fails only under
     * KNEXT_REQUIRE_STANDALONE=1 AND with a standalone build present; a generated
     * app whose CI just runs `vitest` gets neither, so the guard silently passes
     * while the seam it protects can be dead. The template therefore ships ONE
     * script that does both halves, so the app's CI has something to call.
     */
    it("ships a `test:seam` script that BUILDS and then hard-fails (no green-by-skip)", () => {
        const seamScript = JSON.parse(pkg ?? "{}").scripts?.["test:seam"] as
            | string
            | undefined;
        expect(
            seamScript,
            "package.json.hbs is missing the `test:seam` script — without it a " +
                "generated app's seam guard can only ever run build-less and skip",
        ).toBeDefined();
        const script = seamScript as string;
        // It must build the standalone output the guard reads…
        expect(script).toContain("next build --webpack");
        // …and force the hard-fail mode, so a missing build FAILS instead of skipping.
        expect(script).toContain("KNEXT_REQUIRE_STANDALONE=1");
        expect(script).toContain("standalone-seam-alive.test.ts");
    });

    it("declares every binary `test:seam` invokes (it must work OUTSIDE this monorepo)", () => {
        // The script knext hands users is prescribed for "an app generated into
        // your own repo — wire it into your CI". Inside this workspace a missing
        // binary resolves by root hoisting, so the gap is invisible here and only
        // shows up as command-not-found in the exact scenario the docs describe.
        // SCAN the script for the binaries it runs rather than checking a known
        // name — a future `test:seam` that adds a tool is covered automatically.
        const manifest = JSON.parse(pkg ?? "{}") as {
            scripts?: Record<string, string>;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const script = manifest.scripts?.["test:seam"] ?? "";
        const declared = {
            ...manifest.dependencies,
            ...manifest.devDependencies,
        };
        const binaries = script
            // Every shell separator, not just `&&` — splitting on `&&` alone hides
            // every command after a `;`, `||` or `|`, which is the one way an
            // undeclared binary could still slip through this scan. (`||` is listed
            // before `|` so the alternation matches the two-char form first.)
            .split(/&&|\|\||;|\|/)
            .map((segment) =>
                segment
                    .trim()
                    .split(/\s+/)
                    // Drop leading `VAR=value` env assignments (KNEXT_REQUIRE_STANDALONE=1).
                    .find((token) => !/^[A-Z_][A-Z0-9_]*=/.test(token)),
            )
            .filter((bin): bin is string => Boolean(bin));
        expect(
            binaries.length,
            `no binary parsed out of test:seam: "${script}"`,
        ).toBeGreaterThan(0);
        for (const bin of binaries) {
            expect(
                Object.hasOwn(declared, bin),
                `test:seam runs \`${bin}\` but the template never declares it — the ` +
                    "script resolves by root hoisting inside this monorepo and dies with " +
                    "command-not-found in a generated app's own repo",
            ).toBe(true);
        }
    });
});
