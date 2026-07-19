/**
 * knext NextAdapter — the official Next.js Deployment Adapter for knext.
 *
 * Extracted from apps/file-manager/next-adapter.ts (#89) so the adapter is a
 * REUSABLE, package-shipped artifact. The official compatibility harness builds
 * arbitrary fixture apps and needs an adapter it can point at via NEXT_ADAPTER_PATH
 * — that requires the adapter to live in @knext/core, not in one app.
 *
 * Hooks:
 *  - modifyConfig: force output:'standalone' on phase-production-build, and
 *    inject the edge-scoped webpack IgnorePlugin that excludes
 *    `instrumentation-node` from the EDGE bundle (#342/#356, ADR-0031) — the
 *    platform-owned half of the guarded-instrumentation fence, composed after
 *    any webpack hook the app still owns
 *  - onBuildComplete:
 *      1. Log output counts + routing counts
 *      2. Best-effort upload staticFiles + prerenders to MinIO/S3 keyed by buildId
 *         (guarded by STORAGE_BUCKET env var; skips cleanly if not set)
 *
 * Upload uses getMinioClient() from @knext/lib/clients.
 * Files are uploaded under: <buildId>/<pathname> in the configured bucket.
 *
 * Out of scope: request routing, bun --compile, operator changes.
 */
import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { NextAdapter } from "next";
// AdapterOutputs is not re-exported from the 'next' public barrel; import directly.
import type { AdapterOutputs } from "next/dist/build/adapter/build-complete";
import { healBunExportTargets } from "./standalone-bun-exports";

/** The onBuildComplete ctx as typed by the installed next (16.2.x): carries `routing`. */
type OnBuildCompleteCtx = Parameters<
    NonNullable<NextAdapter["onBuildComplete"]>
>[0];

/**
 * LEGACY 16.0.x ctx shape (#171 follow-up). peerDependencies.next is >=16.0.0,
 * so a 16.0.x consumer hands us a ctx with `routes` and NO `routing`. The 16.2
 * types dropped `routes`, so this documents the legacy field for the runtime
 * tolerance below. Types-only modernization: the runtime must keep counting
 * whichever shape is present (guarded by adapter-onbuildcomplete-shape.test.ts).
 */
type Legacy160RoutesCtx = {
    routes?: {
        headers?: unknown;
        redirects?: unknown;
        rewrites?: {
            beforeFiles?: unknown;
            afterFiles?: unknown;
            fallback?: unknown;
        };
        dynamicRoutes?: unknown;
    };
};

const adapter: NextAdapter = {
    name: "knext-adapter",

    modifyConfig(config, { phase }) {
        if (phase !== "phase-production-build") {
            return config;
        }

        console.log(
            "[knext-adapter] modifyConfig fired for phase-production-build",
        );

        // Ensure standalone output is set (already set in next.config.ts but we
        // enforce it here so the adapter is self-contained in later phases).
        //
        // #356 / ADR-0031 — the edge `IgnorePlugin` fence is PLATFORM-OWNED.
        // #342/#344: Next compiles `instrumentation.ts` for BOTH the nodejs and
        // edge runtimes (any app with `middleware.ts` forces an edge build).
        // The edge-clean entry guards EXECUTION behind `NEXT_RUNTIME ===
        // 'nodejs'`, but webpack still STATICALLY traces the dynamic
        // `import('./instrumentation-node')` into the edge bundle — pulling in
        // `@knext/lib/clients` → `@cerbos/grpc`/`pg`/`minio` and failing the
        // build with `Module not found`. For the EDGE compile ONLY we replace
        // `instrumentation-node` with an empty module via `IgnorePlugin`, so its
        // Node-only subtree never enters the edge bundle; the nodejs compile is
        // untouched and keeps the real wiring (the knext runtime runs the app on
        // Node — the standalone server). Apps used to hand-write this hook in
        // their own next.config.ts; a NEW app that didn't know to do so silently
        // re-broke the build. Every app wired through `adapterPath` now gets the
        // fence by construction, composed AFTER any webpack hook the app still
        // owns (guarded by adapter-edge-ignore-plugin.test.ts).
        const appWebpack = config.webpack;
        return {
            ...config,
            output: "standalone",
            webpack(webpackConfig, ctx) {
                const cfg = appWebpack
                    ? appWebpack(webpackConfig, ctx)
                    : webpackConfig;
                if (ctx.nextRuntime === "edge") {
                    cfg.plugins = cfg.plugins || [];
                    cfg.plugins.push(
                        new ctx.webpack.IgnorePlugin({
                            resourceRegExp:
                                /instrumentation-node(\.[cm]?[jt]s)?$/,
                        }),
                    );
                }
                return cfg;
            },
        };
    },

    async onBuildComplete(ctx) {
        const { buildId, distDir, nextVersion, outputs } = ctx;

        const counts = {
            pages: outputs.pages.length,
            appPages: outputs.appPages.length,
            appRoutes: outputs.appRoutes.length,
            pagesApi: outputs.pagesApi.length,
            prerenders: outputs.prerenders.length,
            staticFiles: outputs.staticFiles.length,
            middleware: outputs.middleware ? 1 : 0,
        };

        // Routing DIAGNOSTICS — tolerate both adapter-API ctx shapes (#147 fix
        // round 1 follow-up; typed ctx.routing since the 16.2.x devDep bump).
        // Ground truth, probed against real `next build`s:
        //   v16.0.3: ctx.routes  { headers, redirects, rewrites:{beforeFiles,
        //            afterFiles, fallback}, dynamicRoutes }
        //   v16.2.x: ctx.routing { beforeMiddleware, beforeFiles, afterFiles,
        //            dynamicRoutes, onMatch, fallback, ... } — ctx.routes is GONE
        //            (and is now the OFFICIAL typed shape on NextAdapter).
        // The old unconditional `routes.headers.length` crashed EVERY fixture
        // build at 16.2.0 (`TypeError: ... reading 'headers'`), killing the
        // whole compat run. Diagnostics must never kill a build: count whatever
        // shape is present, defensively.
        const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
        // Legacy runtime field — see Legacy160RoutesCtx. The types say `routing`
        // is always there; on a 16.0.x consumer it isn't, so both reads stay guarded.
        const legacyRoutes = (ctx as OnBuildCompleteCtx & Legacy160RoutesCtx)
            .routes;
        const routing: OnBuildCompleteCtx["routing"] | undefined = ctx.routing;
        const routingCounts: Record<string, number> = {};
        if (legacyRoutes) {
            routingCounts.headers = len(legacyRoutes.headers);
            routingCounts.redirects = len(legacyRoutes.redirects);
            routingCounts.rewritesBeforeFiles = len(
                legacyRoutes.rewrites?.beforeFiles,
            );
            routingCounts.rewritesAfterFiles = len(
                legacyRoutes.rewrites?.afterFiles,
            );
            routingCounts.rewritesFallback = len(
                legacyRoutes.rewrites?.fallback,
            );
            routingCounts.dynamicRoutes = len(legacyRoutes.dynamicRoutes);
        } else if (routing) {
            routingCounts.beforeMiddleware = len(routing.beforeMiddleware);
            routingCounts.beforeFiles = len(routing.beforeFiles);
            routingCounts.afterFiles = len(routing.afterFiles);
            routingCounts.dynamicRoutes = len(routing.dynamicRoutes);
            routingCounts.onMatch = len(routing.onMatch);
            routingCounts.fallback = len(routing.fallback);
        }

        console.log("[knext-adapter] onBuildComplete fired");
        console.log(`  buildId      : ${buildId}`);
        console.log(`  distDir      : ${distDir}`);
        console.log(`  nextVersion  : ${nextVersion}`);
        console.log(`  output.output: ${ctx.config.output ?? "not set"}`);
        console.log(
            `  cacheHandler : ${String(ctx.config.cacheHandler ?? "not set")}`,
        );
        console.log("  output counts:");
        for (const [key, count] of Object.entries(counts)) {
            console.log(`    ${key.padEnd(22)}: ${count}`);
        }
        console.log(
            `  routing counts (${legacyRoutes ? "ctx.routes" : routing ? "ctx.routing" : "none present"}):`,
        );
        for (const [key, count] of Object.entries(routingCounts)) {
            console.log(`    ${key.padEnd(22)}: ${count}`);
        }

        // ── Best-effort artifact upload ─────────────────────────────────────────
        // Upload staticFiles + prerenders to object storage keyed by buildId.
        // Guarded by STORAGE_BUCKET env var — skips cleanly when not configured.
        // This allows local/CI builds to succeed without storage credentials.
        await uploadBuildArtifacts({ buildId, outputs });

        // ── Bun-condition export heal (#188 round 2) ────────────────────────────
        // nft traces under Node, so exports targets behind a "bun" condition
        // (react-dom/server → server.bun.js) are absent from the standalone tree
        // while the exports map still points at them — Bun then fails the whole
        // specifier and every pages-router SSR/API render 500s. Copy the missing
        // targets (byte-identical, version-checked) from the app's node_modules.
        // Purely additive: Node resolution never touches these files.
        const standaloneDir = join(distDir, "standalone");
        if (existsSync(standaloneDir)) {
            const healed = healBunExportTargets({
                projectDir: dirname(distDir),
                standaloneDir,
                log: (message) => console.log(message),
            });
            console.log(
                `[knext-adapter] bun-exports heal: ${healed.copied.length} copied, ${healed.skipped.length} skipped`,
            );
        } else {
            // #188 round 3 (run 28616072395): at next@16.2.0 onBuildComplete
            // fires BEFORE the standalone tree is emitted, so this branch is
            // the NORMAL path — say so loudly. The reliable heal happens
            // post-build in scripts/e2e-deploy.sh (and any deploy pipeline
            // that assembles the standalone output).
            console.log(
                `[knext-adapter] bun-exports heal skipped: no standalone dir at ${standaloneDir} yet (onBuildComplete precedes standalone emit at next 16.2) — heal must run post-build`,
            );
        }
    },
};

async function uploadBuildArtifacts({
    buildId,
    outputs,
}: {
    buildId: string;
    outputs: AdapterOutputs;
}): Promise<void> {
    const bucket = process.env.STORAGE_BUCKET;

    if (!bucket) {
        console.log(
            "[knext-adapter] upload skipped: STORAGE_BUCKET not set — set STORAGE_BUCKET to enable artifact upload",
        );
        return;
    }

    console.log(
        `[knext-adapter] starting artifact upload to storage bucket="${bucket}" buildId="${buildId}"`,
    );

    // Dynamically import the minio client to avoid loading it in non-upload builds.
    let putObject: (
        bucket: string,
        key: string,
        stream: Readable,
    ) => Promise<unknown>;
    try {
        const { getMinioClient } = await import("@knext/lib/clients");
        const client = getMinioClient();
        putObject = (b, k, s) => client.putObject(b, k, s);
    } catch (err) {
        console.log(
            `[knext-adapter] upload skipped: could not load storage client — ${String(err)}`,
        );
        return;
    }

    // PRERENDER type in Next 16.0.3 doesn't have a top-level filePath;
    // the fallback HTML path is nested under fallback.filePath (optional).
    type StaticFile = AdapterOutputs["staticFiles"][number];
    type Prerender = AdapterOutputs["prerenders"][number];
    const artifacts = [
        ...outputs.staticFiles.map((f: StaticFile) => ({
            filePath: f.filePath,
            key: `${buildId}${f.pathname}`,
        })),
        ...outputs.prerenders
            .filter((f: Prerender) => f.fallback?.filePath)
            .map((f: Prerender) => ({
                filePath: f.fallback!.filePath!,
                key: `${buildId}/${f.id}`,
            })),
    ];

    let uploaded = 0;
    let skipped = 0;

    for (const { filePath, key } of artifacts) {
        if (!filePath || !existsSync(filePath)) {
            skipped++;
            continue;
        }
        try {
            // createReadStream returns fs.ReadStream which extends node:stream Readable
            const stream = createReadStream(filePath) as unknown as Readable;
            await putObject(bucket, key, stream);
            uploaded++;
        } catch (err) {
            console.log(
                `[knext-adapter] upload warning: failed to upload "${key}" — ${String(err)}`,
            );
            skipped++;
        }
    }

    console.log(
        `[knext-adapter] artifact upload complete: uploaded=${uploaded} skipped=${skipped} total=${artifacts.length}`,
    );
}

export default adapter;
