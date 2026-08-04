/**
 * #356 / ADR-0031 — the edge-scoped `IgnorePlugin` for `instrumentation-node`
 * is PLATFORM-OWNED: the knext adapter's `modifyConfig` injects it.
 *
 * #342/#344 established the invariant: any app with a `middleware.ts` triggers
 * an EDGE compile of `instrumentation.ts`, and the Node-only body in
 * `instrumentation-node.ts` must be excluded from the edge bundle via an
 * edge-scoped webpack `IgnorePlugin` — the runtime `NEXT_RUNTIME === 'nodejs'`
 * guard stops EXECUTION on the edge, not BUNDLING (webpack statically traces
 * the dynamic `import('./instrumentation-node')` into both runtime bundles).
 * Until #356 every app hand-wrote that webpack hook in its own
 * `next.config.ts` — exactly the kind of non-obvious invariant a NEW app can
 * silently drop (unit tests pass; only the production `next build` catches it).
 *
 * The fence therefore lives in the adapter: every app wired through
 * `adapterPath` (the app template wires it by default) gets the edge exclusion
 * by construction, composed AFTER any webpack hook the app still owns so
 * app-local webpack customizations keep working.
 *
 * Written RED-first for #356: `modifyConfig` previously returned no `webpack`
 * fn, so the "returns a webpack fn" assertion failed before the implementation.
 */
import type { NextConfig } from "next";
// NextConfigComplete is not re-exported from the 'next' public barrel; import directly.
import type { NextConfigComplete } from "next/dist/server/config-shared";
import { describe, expect, it, vi } from "vitest";
import adapter from "../adapters/next-adapter";

type ModifyConfig = NonNullable<typeof adapter.modifyConfig>;
type ModifyCtx = Parameters<ModifyConfig>[1];
type WebpackFn = NonNullable<NextConfig["webpack"]>;

const PRODUCTION_BUILD = "phase-production-build" as ModifyCtx["phase"];
const DEVELOPMENT_SERVER = "phase-development-server" as ModifyCtx["phase"];
const PRODUCTION_SERVER = "phase-production-server" as ModifyCtx["phase"];

/** Stand-in for the webpack module Next hands to the config.webpack ctx. */
class FakeIgnorePlugin {
    readonly options: { resourceRegExp: RegExp };
    constructor(options: { resourceRegExp: RegExp }) {
        this.options = options;
    }
}

function modify(
    config: Partial<NextConfig>,
    phase: ModifyCtx["phase"] = PRODUCTION_BUILD,
) {
    return (adapter.modifyConfig as ModifyConfig)(
        config as NextConfigComplete,
        {
            phase,
            nextVersion: "16.2.10",
        } as ModifyCtx,
    );
}

/** Invoke the returned config.webpack hook the way `next build --webpack` would. */
function runWebpackHook(
    webpackFn: WebpackFn,
    nextRuntime: "nodejs" | "edge",
    plugins: unknown[] = [],
): { plugins: unknown[] } {
    const config = { plugins } as unknown as Parameters<WebpackFn>[0];
    const ctx = {
        nextRuntime,
        webpack: { IgnorePlugin: FakeIgnorePlugin },
    } as unknown as Parameters<WebpackFn>[1];
    return webpackFn(config, ctx) as unknown as { plugins: unknown[] };
}

describe("knext-adapter modifyConfig — platform-owned edge IgnorePlugin fence (#356/ADR-0031)", () => {
    it("returns a webpack fn on phase-production-build (the fence carrier)", async () => {
        const out = await modify({});
        expect(typeof out.webpack).toBe("function");
    });

    it("edge compile: appends an IgnorePlugin that targets instrumentation-node", async () => {
        const out = await modify({});
        const result = runWebpackHook(out.webpack as WebpackFn, "edge");
        expect(result.plugins).toHaveLength(1);
        const plugin = result.plugins[0] as FakeIgnorePlugin;
        expect(plugin).toBeInstanceOf(FakeIgnorePlugin);
        const re = plugin.options.resourceRegExp;
        expect(re.test("instrumentation-node")).toBe(true);
        expect(re.test("instrumentation-node.ts")).toBe(true);
        expect(re.test("instrumentation-node.mjs")).toBe(true);
        // The edge-clean entry itself must NOT be excluded — only the Node body.
        expect(re.test("./src/instrumentation")).toBe(false);
        expect(re.test("instrumentation-nodex")).toBe(false);
    });

    it("nodejs compile: leaves the config untouched (the real module must bundle there)", async () => {
        const out = await modify({});
        const result = runWebpackHook(out.webpack as WebpackFn, "nodejs");
        expect(result.plugins).toHaveLength(0);
    });

    it("composes the app's own webpack hook instead of replacing it", async () => {
        const appWebpack = vi.fn((config: { plugins: unknown[] }) => {
            config.plugins.push("app-owned-plugin");
            return config;
        });
        const out = await modify({
            webpack: appWebpack as unknown as NextConfig["webpack"],
        });
        const result = runWebpackHook(out.webpack as WebpackFn, "edge");
        expect(appWebpack).toHaveBeenCalledTimes(1);
        expect(result.plugins).toContain("app-owned-plugin");
        // The app plugin survived AND the platform fence was appended.
        expect(result.plugins).toHaveLength(2);
        expect(result.plugins[1]).toBeInstanceOf(FakeIgnorePlugin);
    });

    it("still forces output:'standalone' (the pre-existing modifyConfig contract)", async () => {
        const out = await modify({});
        expect(out.output).toBe("standalone");
    });

    it("does NOT force output:'standalone' outside phase-production-build", async () => {
        const out = await modify({ reactStrictMode: true }, DEVELOPMENT_SERVER);
        expect(out.output).toBeUndefined();
        expect(out.reactStrictMode).toBe(true);
    });
});

/**
 * #408 item 1 — the fence must cover `next dev` too, NOT only the production
 * build. MEASURED against next 16.2.11 with a middleware + guarded-instrumentation
 * fixture (`__tests__/fixtures/dev-edge-fence`, exercised end-to-end by
 * `adapter-dev-edge-fence.test.ts`):
 *
 *   next dev            (Turbopack, the 16.2 default) → compiles clean; `config.webpack`
 *                        is not consulted by Turbopack at all.
 *   next dev --webpack  → the EDGE compile of `instrumentation-node` FAILS exactly the
 *                        way the production build did before #356:
 *                        `Module build failed: UnhandledSchemeError: Reading from
 *                        "node:fs" is not handled by plugins`.
 *
 * So "dev is unaffected" is TRUE only for the Turbopack default and FALSE for the
 * webpack bundler — which is the bundler this repo's apps build with
 * (`next build --webpack`). The fence therefore ships in EVERY phase; only
 * `output: 'standalone'` stays production-gated.
 */
describe("knext-adapter modifyConfig — the fence covers next dev too (#408)", () => {
    it("returns a webpack fn on phase-development-server (dev carries the fence)", async () => {
        const out = await modify({}, DEVELOPMENT_SERVER);
        expect(typeof out.webpack).toBe("function");
    });

    it.each([
        ["phase-development-server", DEVELOPMENT_SERVER],
        ["phase-production-server", PRODUCTION_SERVER],
    ])("%s edge compile: appends the instrumentation-node IgnorePlugin", async (_label, phase) => {
        const out = await modify({}, phase);
        const result = runWebpackHook(out.webpack as WebpackFn, "edge");
        expect(result.plugins).toHaveLength(1);
        const plugin = result.plugins[0] as FakeIgnorePlugin;
        expect(plugin).toBeInstanceOf(FakeIgnorePlugin);
        expect(
            plugin.options.resourceRegExp.test("instrumentation-node.ts"),
        ).toBe(true);
    });

    it("dev nodejs compile: leaves the config untouched", async () => {
        const out = await modify({}, DEVELOPMENT_SERVER);
        const result = runWebpackHook(out.webpack as WebpackFn, "nodejs");
        expect(result.plugins).toHaveLength(0);
    });

    it("dev: composes the app's own webpack hook instead of replacing it", async () => {
        const appWebpack = vi.fn((config: { plugins: unknown[] }) => {
            config.plugins.push("app-owned-plugin");
            return config;
        });
        const out = await modify(
            { webpack: appWebpack as unknown as NextConfig["webpack"] },
            DEVELOPMENT_SERVER,
        );
        const result = runWebpackHook(out.webpack as WebpackFn, "edge");
        expect(appWebpack).toHaveBeenCalledTimes(1);
        expect(result.plugins).toEqual([
            "app-owned-plugin",
            expect.any(FakeIgnorePlugin),
        ]);
    });
});
