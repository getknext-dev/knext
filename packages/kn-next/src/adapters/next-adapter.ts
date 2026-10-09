/**
 * knext NextAdapter — the official Next.js Deployment Adapter for knext.
 *
 * Extracted from apps/file-manager/next-adapter.ts (#89) so the adapter is a
 * REUSABLE, package-shipped artifact. The official compatibility harness builds
 * arbitrary fixture apps and needs an adapter it can point at via NEXT_ADAPTER_PATH
 * — that requires the adapter to live in @getknext/core, not in one app.
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
 * Upload uses getMinioClient() from @getknext/lib/clients.
 * Files are uploaded under: <buildId>/<pathname> in the configured bucket.
 *
 * Out of scope: request routing, bun --compile, operator changes.
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { NextAdapter } from "next";
// AdapterOutputs is not re-exported from the 'next' public barrel; import directly.
import type { AdapterOutputs } from "next/dist/build/adapter/build-complete";
import { KNEXT_RUNTIME_ENV } from "./runtime-env";
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

/** The module specifier every knext scaffold's `cache-handler.js` re-exports. */
const KNEXT_CACHE_HANDLER_SPECIFIER = "@getknext/core/adapters/cache-handler";

/**
 * Whether `cacheHandlerPath` is knext's own cache handler: the module itself
 * (a path inside the published package or this source tree), or an app file
 * that re-exports it — the one-liner every scaffold generates. Unreadable =
 * not knext's: the caller then leaves Next's default alone.
 */
function isKnextCacheHandler(cacheHandlerPath: string): boolean {
    const p = cacheHandlerPath.replaceAll("\\", "/");
    if (
        /\/@getknext\/core\/.*\/cache-handler(-node|-bun)?\.[cm]?js$/.test(p) ||
        /\/kn-next\/(src|dist)\/adapters\/cache-handler(-node|-bun)?\.js$/.test(
            p,
        )
    ) {
        return true;
    }
    try {
        // A re-export file is a few lines; never read a whole bundle.
        const head = readFileSync(cacheHandlerPath, "utf-8").slice(0, 4096);
        return head.includes(KNEXT_CACHE_HANDLER_SPECIFIER);
    } catch {
        return false;
    }
}

/** The per-runtime cache handler entries, by runtime id (#1843). */
const RUNTIME_CACHE_HANDLERS: Record<string, string> = {
    node: "@getknext/core/internal/cache-handler-node",
    bun: "@getknext/core/internal/cache-handler-bun",
};

/**
 * Point a knext `cacheHandler` at the entry for the configured runtime (#1843).
 *
 * The generic handler picks its Redis client at runtime, and on Node it loads
 * ioredis through a computed specifier that Next's standalone tracing cannot
 * follow — so the node image shipped with no Redis client and the cache ran
 * from memory in silence. The per-runtime entries pick statically: the node
 * one imports ioredis LITERALLY (traced into `.next/standalone`), the bun one
 * uses Bun's native client and imports no ioredis at all.
 *
 * Applied only when the CLI exported a known runtime and the app's handler is
 * knext's; `next dev`, a plain `next build` and a user's own handler are left
 * alone. Next records the chosen path relative to `distDir` and traces it as a
 * root, so it lands in the standalone tree like any other handler.
 */
function runtimeCacheHandler(
    config: Parameters<NonNullable<NextAdapter["modifyConfig"]>>[0],
): { cacheHandler?: string } {
    const runtime = process.env[KNEXT_RUNTIME_ENV];
    const specifier =
        runtime !== undefined && Object.hasOwn(RUNTIME_CACHE_HANDLERS, runtime)
            ? RUNTIME_CACHE_HANDLERS[runtime]
            : undefined;
    if (specifier === undefined) return {};
    const handler = config.cacheHandler;
    if (typeof handler !== "string" || !isKnextCacheHandler(handler)) return {};
    // Self-reference by package name: resolves through `exports` to this
    // package's own dist, wherever the app's package manager put it.
    return {
        cacheHandler: createRequire(import.meta.url).resolve(specifier),
    };
}

/**
 * Write-free runtime: route Next's optimized-image cache through the knext
 * cache handler instead of `.next/cache/images` on local disk.
 *
 * Next 16.2+ stores image-optimizer variants through `cacheHandler` when
 * `images.customCacheHandler` is true (the official option); otherwise it
 * writes them to the build's `.next/cache/images`, which on a read-only root
 * filesystem needs a writable volume — and every such volume costs
 * pod-sandbox setup time on each cold wake. knext's handler stores the
 * variant's bytes in Redis (shared across pods and wakes) or a byte-bounded
 * in-process map, so with it the app needs no writable path for images.
 *
 * Applied only when:
 *  - the app's `cacheHandler` is knext's (a user handler may not round-trip
 *    the entry's raw Buffer, and a broken entry serves a broken image);
 *  - this Next has the option at all — `modifyConfig` sees the RESOLVED
 *    config, so a supporting Next always carries it as a boolean;
 *  - `KNEXT_IMAGE_CACHE_HANDLER` is not `0` at build time (opt-out: keep
 *    Next's disk cache, and give the app a writable volume yourself).
 *
 * `knext deploy` reads the built `required-server-files.json` back to decide
 * whether the image is write-free (`spec.security.writeFree`).
 */
function imageCacheThroughHandler(
    config: Parameters<NonNullable<NextAdapter["modifyConfig"]>>[0],
): { images?: typeof config.images } {
    const images = config.images as
        | (typeof config.images & { customCacheHandler?: unknown })
        | undefined;
    if (!images || typeof images.customCacheHandler !== "boolean") return {};
    if (images.customCacheHandler) return {};
    if (process.env.KNEXT_IMAGE_CACHE_HANDLER === "0") return {};
    const handler = config.cacheHandler;
    if (typeof handler !== "string" || !isKnextCacheHandler(handler)) {
        return {};
    }
    return { images: { ...images, customCacheHandler: true } };
}

const adapter: NextAdapter = {
    name: "knext-adapter",

    modifyConfig(config, { phase }) {
        const isProductionBuild = phase === "phase-production-build";

        console.log(`[knext-adapter] modifyConfig fired for ${phase}`);

        // Ensure standalone output is set (already set in next.config.ts but we
        // enforce it here so the adapter is self-contained in later phases).
        // `output` stays PRODUCTION-BUILD-ONLY: `next dev` must not be told to
        // emit a standalone tree.
        //
        // #356 / ADR-0031 — the edge `IgnorePlugin` fence is PLATFORM-OWNED.
        // #342/#344: Next compiles `instrumentation.ts` for BOTH the nodejs and
        // edge runtimes (any app with `middleware.ts` forces an edge build).
        // The edge-clean entry guards EXECUTION behind `NEXT_RUNTIME ===
        // 'nodejs'`, but webpack still STATICALLY traces the dynamic
        // `import('./instrumentation-node')` into the edge bundle — pulling in
        // `@getknext/lib/clients` → `@cerbos/grpc`/`pg`/`minio` and failing the
        // build with `Module not found`. For the EDGE compile ONLY we replace
        // `instrumentation-node` with an empty module via `IgnorePlugin`, so its
        // Node-only subtree never enters the edge bundle; the nodejs compile is
        // untouched and keeps the real wiring (the knext runtime runs the app on
        // Node — the standalone server). Apps used to hand-write this hook in
        // their own next.config.ts; a NEW app that didn't know to do so silently
        // re-broke the build. Every app wired through `adapterPath` now gets the
        // fence by construction, composed AFTER any webpack hook the app still
        // owns (guarded by adapter-edge-ignore-plugin.test.ts).
        //
        // #408 item 1 — the fence ships in EVERY phase, not only
        // `phase-production-build`. MEASURED on next 16.2.11 against
        // `src/__tests__/fixtures/dev-edge-fence` (a middleware app with guarded
        // instrumentation): `next dev --webpack` fails the EDGE compile of
        // `instrumentation-node` with `Module build failed: UnhandledSchemeError:
        // Reading from "node:fs" is not handled by plugins` — the same class the
        // production build hit before #356 — while plain `next dev` (Turbopack,
        // the 16.2 default) is unaffected because Turbopack never consults
        // `config.webpack`. The app's hand-written hook this replaced covered dev,
        // so gating on the production build silently regressed `pnpm dev` for any
        // app on the webpack bundler. Pinned by `adapter-dev-edge-fence.test.ts`
        // (real dev server) and `adapter-edge-ignore-plugin.test.ts` (unit).
        const appWebpack = config.webpack;
        // #1843: the runtime's own cache handler first, so the image routing
        // below judges the handler that will actually run.
        const withRuntimeHandler = {
            ...config,
            ...runtimeCacheHandler(config),
        };
        return {
            ...withRuntimeHandler,
            ...(isProductionBuild ? { output: "standalone" as const } : {}),
            ...imageCacheThroughHandler(withRuntimeHandler),
            webpack(webpackConfig, ctx) {
                const cfg = appWebpack
                    ? appWebpack(webpackConfig, ctx)
                    : webpackConfig;
                // A webpack hook that mutates and forgets to `return config` is a
                // common authoring slip. Without this, the fence below dereferences
                // `undefined` and throws a bare TypeError from inside knext —
                // during `next dev --webpack` too, since #408 — which reads as a
                // knext bug rather than the app's missing return. Name it.
                if (cfg == null) {
                    throw new Error(
                        "[knext-adapter] the app's own `webpack(...)` hook in next.config " +
                            "returned undefined — it must RETURN the (possibly modified) " +
                            "webpack config. The adapter composes that return value before " +
                            "appending the edge instrumentation-node fence.",
                    );
                }
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
        const { getMinioClient } = await import("@getknext/lib/clients");
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
