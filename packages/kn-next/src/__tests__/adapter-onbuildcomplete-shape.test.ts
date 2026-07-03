/**
 * GUARD TEST (#147 A3-3 fix round 1 follow-up): onBuildComplete must tolerate
 * BOTH adapter-API ctx shapes.
 *
 * Ground truth (probed against real `next build` runs):
 *  - next v16.0.3 passes `ctx.routes`   { headers, redirects, rewrites:{beforeFiles,
 *    afterFiles, fallback}, dynamicRoutes }
 *  - next v16.2.0 passes `ctx.routing`  { beforeMiddleware, beforeFiles, afterFiles,
 *    dynamicRoutes, onMatch, fallback, shouldNormalizeNextData, rsc } — and
 *    `ctx.routes` is GONE.
 *
 * The adapter's routing DIAGNOSTICS read `routes.headers.length` unconditionally,
 * so on 16.2.0 every fixture build died at onBuildComplete with
 * `TypeError: Cannot read properties of undefined (reading 'headers')` — killing
 * the whole compat run right after the tarball-install fix finally let builds
 * happen. Diagnostics must NEVER crash the build: count whatever shape is present.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import adapter from "../adapters/next-adapter";

/** The ctx type the adapter declares — fixtures are deliberately cast across API revisions. */
type OnBuildCompleteCtx = Parameters<
    NonNullable<typeof adapter.onBuildComplete>
>[0];

/** Minimal outputs common to both API revisions. */
function makeOutputs() {
    return {
        pages: [{ pathname: "/", filePath: "/tmp/x" }],
        pagesApi: [],
        appPages: [],
        appRoutes: [],
        prerenders: [],
        staticFiles: [],
    };
}

function baseCtx() {
    return {
        buildId: "test-build",
        distDir: "/tmp/dist",
        nextVersion: "0.0.0-test",
        projectDir: "/tmp/app",
        repoRoot: "/tmp/app",
        config: { output: "standalone" },
        outputs: makeOutputs(),
    };
}

describe("next-adapter onBuildComplete — ctx shape tolerance (#147)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("counts the v16.2.x shape via the typed ctx.routing (ctx.routes ABSENT)", async () => {
        const logSpy = vi.spyOn(console, "log");
        const ctx = {
            ...baseCtx(),
            nextVersion: "16.2.0",
            routing: {
                beforeMiddleware: [],
                beforeFiles: [],
                afterFiles: [],
                dynamicRoutes: [],
                onMatch: [{}],
                fallback: [],
                shouldNormalizeNextData: false,
                rsc: {},
            },
        };
        // The exact crash of the first real compat builds:
        // TypeError: Cannot read properties of undefined (reading 'headers')
        await expect(
            adapter.onBuildComplete?.(ctx as unknown as OnBuildCompleteCtx),
        ).resolves.not.toThrow();
        // The counts must come from ctx.routing — and actually count it.
        const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logged).toContain("routing counts (ctx.routing)");
        expect(logged).toMatch(/onMatch\s*: 1/);
    });

    it("still counts the v16.0.x shape (legacy ctx.routes present) — peerDep >=16.0.0", async () => {
        const logSpy = vi.spyOn(console, "log");
        const ctx = {
            ...baseCtx(),
            nextVersion: "16.0.3",
            routes: {
                headers: [],
                redirects: [{}],
                rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
                dynamicRoutes: [],
            },
        };
        await expect(
            adapter.onBuildComplete?.(ctx as unknown as OnBuildCompleteCtx),
        ).resolves.not.toThrow();
        const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logged).toContain("routing counts (ctx.routes)");
        expect(logged).toMatch(/redirects\s*: 1/);
    });

    it("does not throw even when NEITHER routes nor routing is present (diagnostics never kill a build)", async () => {
        const logSpy = vi.spyOn(console, "log");
        const ctx = baseCtx();
        await expect(
            adapter.onBuildComplete?.(ctx as unknown as OnBuildCompleteCtx),
        ).resolves.not.toThrow();
        const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logged).toContain("routing counts (none present)");
    });
});
