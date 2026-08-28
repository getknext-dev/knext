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

    it("does NOT wire adapterPath — vinext never calls the adapter hooks", () => {
        // Inverted by ADR-0048. `adapterPath`/`modifyConfig` are a
        // webpack/turbopack mechanism; on a Vite/rolldown build they are dead
        // config that still READS as an active fence to the next person.
        expect(nextConfig).not.toMatch(/adapterPath\s*:/);
    });

    it("does NOT set output:'standalone' — there is no standalone server", () => {
        // Comments stripped first. The template's docblock NAMES
        // `output: 'standalone'` in order to explain why it is absent, so a raw
        // match fails on the very prose that documents the removal — the same
        // trap create-scaffold.test.ts already fell into once.
        const code = (nextConfig ?? "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
        expect(code).not.toMatch(/output:\s*['"]standalone['"]/);
    });

    it("still carries assetPrefix — knext's own wiring, not turbopack residue", () => {
        // The one thing that must NOT be swept up in the cleanup: without it a
        // no-storage pod 404s every chunk (optional-storage.test.ts).
        expect(nextConfig).toMatch(/assetPrefix:\s*process\.env\.ASSET_PREFIX/);
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

    it("ships NO app adapter — the file is retired, not merely unused", () => {
        // Scaffolding a dead adapter into every new app is how a migration
        // leaves rubble that later reads as intentional.
        expect(
            readTemplate("next-adapter.ts.hbs"),
            "next-adapter.ts.hbs is retired and must not ship",
        ).toBeNull();
    });

    it("ships the vinext build config instead (the real carrier now)", () => {
        // Both halves: the old carrier is gone AND a new one is present.
        // Asserting only the removal would pass on a template that scaffolds
        // an app with no build configuration at all.
        const viteConfig = readTemplate("vite.config.ts.hbs");
        expect(viteConfig, "vite.config.ts.hbs missing").not.toBeNull();
        expect(viteConfig).toMatch(/vinext\(/);
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
        // …and assert it pins the POST-webpack shape. The guard used to
        // require `adapterPath` to be wired; under vinext it requires the
        // opposite, so a template that kept the old assertions would ship a
        // test that fails in every generated app.
        expect(guard).toContain("adapterPath");
        expect(guard).toContain("IgnorePlugin");
        expect(guard).toMatch(/not\.toMatch\(\/adapterPath/);
    });

    it("does NOT ship standalone-seam-alive.test.ts — its subject no longer exists", () => {
        // #352/ADR-0027 was a WEBPACK problem: Next duplicated `@getknext/lib`
        // across webpack layers in the standalone bundle, giving each copy its
        // own module state. vinext has no webpack layers and emits no
        // standalone tree, so the guard has nothing to inspect — it would fail
        // on a missing directory, which reads as a regression rather than as a
        // retired check.
        //
        // The invariant it protected is NOT dropped: the seam state is still
        // anchored on `globalThis` via `Symbol.for('knext.lib.*')`, which the
        // instrumentation-node assertions above pin.
        expect(
            readTemplate("standalone-seam-alive.test.ts.hbs"),
            "standalone-seam-alive.test.ts.hbs is retired and must not ship",
        ).toBeNull();
    });
});

describe("app template — package.json carries the instrumentation contract (#356)", () => {
    it("is valid JSON once the handlebars placeholders are substituted", () => {
        // A trailing comma shipped here for real: removing the `test:seam`
        // script during the vinext migration left its comma behind, so EVERY
        // generated zone got a package.json that no package manager could
        // parse. Nothing caught it, because every other assertion in this file
        // greps the text rather than parsing it — and the two tests that did
        // parse reported it as a confusing SyntaxError about position 201.
        const probe = (pkg ?? "").replace(/{{[^}]*}}/g, "x");
        expect(() => JSON.parse(probe)).not.toThrow();
    });

    const pkg = readTemplate("package.json.hbs");

    it("builds with `next build --webpack` (the platform-proven path the fence applies to)", () => {
        // ADR-0048: vinext through vite, not `next build --webpack`. The
        // webpack build was the end-to-end tripwire for the edge fence; that
        // tripwire is gone with it (see the guard template's own note).
        expect(pkg).toMatch(/"build":\s*"vite build"/);
        expect(pkg).not.toMatch(/next build/);
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
    it("ships NO `test:seam` script — the guard it ran is retired", () => {
        // `test:seam` existed to run standalone-seam-alive.test.ts, which
        // inspected a `.next/standalone` build for the duplicated-module-state
        // bug webpack layering caused. vinext produces no standalone tree and
        // has no webpack layers, so the script would build nothing and assert
        // against a directory that never appears.
        //
        // Retiring the script is the honest move; leaving it would hand every
        // generated app a CI step that passes by finding nothing.
        const scripts = (JSON.parse(pkg ?? "{}").scripts ?? {}) as Record<
            string,
            string
        >;
        expect(scripts["test:seam"]).toBeUndefined();
    });

    it("declares every binary ANY script invokes (they must work OUTSIDE this monorepo)", () => {
        // Generalized from the `test:seam`-only version. The prescription is
        // "an app generated into your own repo — wire it into your CI", and
        // inside this workspace a missing binary resolves by root hoisting, so
        // the gap is invisible here and only shows up as command-not-found in
        // exactly the scenario the docs describe.
        //
        // Scanning EVERY script rather than one named script is strictly
        // stronger, and it is what kept this check alive when its original
        // subject was retired: the migration swapped the scripts to vinext and
        // vite, and a guard pinned to `test:seam` would simply have vanished
        // with it, taking the protection along.
        const manifest = JSON.parse(pkg ?? "{}") as {
            scripts?: Record<string, string>;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const declared = {
            ...manifest.dependencies,
            ...manifest.devDependencies,
        };

        // Runtimes, not packages. `bun` and `node` are the process that RUNS
        // the app; requiring them as dependencies would be wrong, and the
        // template documents the bun floor separately.
        const RUNTIMES = new Set(["bun", "node", "npm", "npx", "pnpm"]);

        const scripts = Object.entries(manifest.scripts ?? {});
        expect(
            scripts.length,
            "template declares no scripts at all",
        ).toBeGreaterThan(0);

        for (const [name, script] of scripts) {
            const binaries = script
                // Every shell separator, not just `&&` — splitting on `&&`
                // alone hides every command after a `;`, `||` or `|`, which is
                // the one way an undeclared binary could still slip through.
                // (`||` is listed before `|` so the two-char form matches first.)
                .split(/&&|\|\||;|\|/)
                .map((segment) =>
                    segment
                        .trim()
                        .split(/\s+/)
                        // Drop leading `VAR=value` env assignments.
                        .find((token) => !/^[A-Z_][A-Z0-9_]*=/.test(token)),
                )
                .filter((bin): bin is string => Boolean(bin))
                .filter((bin) => !RUNTIMES.has(bin));

            for (const bin of binaries) {
                expect(
                    Object.hasOwn(declared, bin),
                    `script \`${name}\` runs \`${bin}\` but the template never declares it — ` +
                        "it resolves by root hoisting inside this monorepo and dies with " +
                        "command-not-found in a generated app's own repo",
                ).toBe(true);
            }
        }
    });
});
