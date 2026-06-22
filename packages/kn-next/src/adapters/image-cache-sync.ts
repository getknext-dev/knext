/**
 * Object-store sync for Next.js optimized-image variants — survives scale-to-zero.
 *
 * ── Why this exists (ADR-0006, item 2) ───────────────────────────────────────
 * `next/image` runtime optimization (the `/_next/image` endpoint) writes optimized
 * variants (resized + format-negotiated WebP/AVIF) to a POD-LOCAL directory:
 *   `<distDir>/cache/images/<cacheKey>/<maxAge>.<expireAt>.<etag>.<upstreamEtag>.<ext>`
 * where, in Next.js, `cacheKey = hash([CACHE_VERSION, href, width, quality, mimeType])`
 * (see next/dist/server/image-optimizer.js → `ImageOptimizerCache.getCacheKey`).
 * That hash IS the `(src, w, q, accept)` key ADR-0006 requires: href=src, width=w,
 * quality=q, mimeType=the negotiated Accept format. So the on-disk directory name is
 * already the content-addressed variant key — we do not need to recompute it.
 *
 * Under Knative scale-to-zero, every cold pod starts with an empty local cache dir,
 * so it re-optimizes images another pod already produced — wasting the cold-start
 * CPU budget. This module persists the per-variant directories in the object store
 * (GCS/S3/MinIO — knext's data plane) so a variant computed by one pod is reused by
 * every later pod.
 *
 * ── Why a sync (and not a pluggable cache handler) ───────────────────────────
 * Next.js exposes a pluggable ISR/data cache via `next.config.cacheHandler`, but in
 * the pinned runtime (Next 16.0.3) the IMAGE optimizer cache is NOT pluggable: the
 * server hardcodes `new ImageOptimizerCache(...)` writing to `<distDir>/cache/images`
 * and does not route IMAGE-kind entries through `cacheHandler`. (Next 16.2+ DID make
 * the image disk cache overridable via the same `cacheHandler` option — see
 * ADR-0006 "Correction" note. When knext upgrades, this sync can be replaced by an
 * object-store cacheHandler that handles `CachedRouteKind.IMAGE`.)
 *
 * So on the pinned version we use the only real, non-interception integration point:
 * sync the directory Next already writes. On startup we RESTORE existing variants
 * from the store into the local dir (warm the cache); while running we WATCH the dir
 * and PUSH newly-written variants up. Both directions are keyed by the per-variant
 * cacheKey directory name = `(src,w,q,accept)`.
 *
 * Guarded by `STORAGE_BUCKET` (same guard as the adapter's build-artifact upload):
 * when unset, this is a no-op and Next falls back to pod-local caching.
 */

import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Minimal object-store surface this module needs. Mirrors the MinIO client used by
 * `next-adapter.ts` (`getMinioClient()`), but is narrowed to an interface so unit
 * tests can inject a fake without a live store / network.
 */
export interface ImageVariantStore {
    /** List object keys under a prefix. */
    list(bucket: string, prefix: string): Promise<string[]>;
    /** Download an object to a local file path. */
    download(bucket: string, key: string, destPath: string): Promise<void>;
    /** Upload a local file to an object key. */
    upload(bucket: string, key: string, srcPath: string): Promise<void>;
}

export interface ImageCacheSyncOptions {
    /** Object-store bucket. From STORAGE_BUCKET. */
    bucket: string;
    /**
     * Local optimized-image cache dir Next writes to. Default mirrors Next:
     * `<cwd>/.next/cache/images`. Standalone output keeps the same relative layout.
     */
    cacheDir?: string;
    /**
     * Key prefix in the bucket. Namespaces image variants away from build artifacts
     * + ISR keys. Default `image-cache`. (The deploy path sets per-app buckets, so a
     * static prefix is safe; callers may override per app if sharing a bucket.)
     */
    prefix?: string;
    /** Injected store. Defaults to the MinIO-backed adapter at runtime. */
    store?: ImageVariantStore;
    /** Logger (defaults to console). `console` and the pino runtime logger both satisfy it. */
    log?: SyncLogger;
}

/**
 * Minimal logger surface satisfied by both `console` and the kn-next pino logger
 * (which exposes `info`/`warn` but not `log`). Single-string calls only.
 */
export interface SyncLogger {
    info(msg: string): void;
    warn(msg: string): void;
}

const DEFAULT_PREFIX = "image-cache";

function defaultCacheDir(): string {
    return join(process.cwd(), ".next", "cache", "images");
}

/** Build the object key for a local cache file: `<prefix>/<cacheKey>/<file>`. */
function objectKey(prefix: string, cacheKey: string, file: string): string {
    return `${prefix}/${cacheKey}/${file}`;
}

/**
 * Lazily build a MinIO-backed {@link ImageVariantStore} from `@knext/lib`'s client,
 * matching how `next-adapter.ts` resolves its uploader. Imported dynamically so the
 * dependency never loads when STORAGE_BUCKET is unset (or in tests that inject a fake).
 */
async function defaultStore(): Promise<ImageVariantStore | null> {
    try {
        const { getMinioClient } = await import("@knext/lib/clients");
        const client = getMinioClient();
        return {
            async list(bucket, prefix) {
                const keys: string[] = [];
                const stream = client.listObjectsV2(bucket, prefix, true);
                await new Promise<void>((resolvePromise, reject) => {
                    stream.on("data", (obj: { name?: string }) => {
                        if (obj.name) keys.push(obj.name);
                    });
                    stream.on("end", () => resolvePromise());
                    stream.on("error", reject);
                });
                return keys;
            },
            async download(bucket, key, destPath) {
                await fs.mkdir(dirname(destPath), { recursive: true });
                await client.fGetObject(bucket, key, destPath);
            },
            async upload(bucket, key, srcPath) {
                await client.fPutObject(bucket, key, srcPath, {});
            },
        };
    } catch {
        return null;
    }
}

/**
 * RESTORE: download every persisted variant from the store into the local cache dir,
 * skipping files that already exist locally. Best-effort — failures are logged, never
 * thrown, so a store outage degrades to local-only optimization rather than a crash.
 *
 * @returns number of variant files restored.
 */
export async function restoreImageCache(
    opts: ImageCacheSyncOptions,
): Promise<number> {
    const log = opts.log ?? console;
    const prefix = opts.prefix ?? DEFAULT_PREFIX;
    const cacheDir = opts.cacheDir ?? defaultCacheDir();
    const store = opts.store ?? (await defaultStore());

    if (!store) {
        log.warn(
            "[image-cache-sync] restore skipped: object store client unavailable",
        );
        return 0;
    }

    let restored = 0;
    try {
        const keys = await store.list(opts.bucket, `${prefix}/`);
        for (const key of keys) {
            // key = `<prefix>/<cacheKey>/<file>` → local `<cacheDir>/<cacheKey>/<file>`
            const rel = key.slice(prefix.length + 1); // strip `<prefix>/`
            if (!rel) continue;
            const destPath = join(cacheDir, rel);
            if (existsSync(destPath)) continue;
            try {
                await store.download(opts.bucket, key, destPath);
                restored++;
            } catch (err) {
                log.warn(
                    `[image-cache-sync] restore warning: failed "${key}" — ${String(err)}`,
                );
            }
        }
    } catch (err) {
        log.warn(
            `[image-cache-sync] restore skipped: could not list store — ${String(err)}`,
        );
        return restored;
    }

    log.info(
        `[image-cache-sync] restore complete: ${restored} variant file(s) warmed into ${cacheDir}`,
    );
    return restored;
}

/**
 * PUSH a single variant directory (one cacheKey = one `(src,w,q,accept)` variant) to
 * the store. Uploads every file in the directory under `<prefix>/<cacheKey>/<file>`.
 * Idempotent: re-uploading an identical variant overwrites with the same bytes.
 */
export async function pushVariant(
    cacheKey: string,
    opts: ImageCacheSyncOptions & { store: ImageVariantStore },
): Promise<number> {
    const log = opts.log ?? console;
    const prefix = opts.prefix ?? DEFAULT_PREFIX;
    const cacheDir = opts.cacheDir ?? defaultCacheDir();
    const variantDir = join(cacheDir, cacheKey);

    let files: string[];
    try {
        files = await fs.readdir(variantDir);
    } catch {
        return 0; // directory vanished (e.g. LRU eviction) — nothing to push
    }

    let uploaded = 0;
    for (const file of files) {
        try {
            await opts.store.upload(
                opts.bucket,
                objectKey(prefix, cacheKey, file),
                join(variantDir, file),
            );
            uploaded++;
        } catch (err) {
            log.warn(
                `[image-cache-sync] push warning: failed "${cacheKey}/${file}" — ${String(err)}`,
            );
        }
    }
    if (uploaded > 0) {
        log.info(
            `[image-cache-sync] pushed variant ${cacheKey} (${uploaded} file(s)) to store`,
        );
    }
    return uploaded;
}

/**
 * WATCH the local image cache dir; when Next writes a new variant directory, push it
 * to the store. Returns a stop() handle. Uses `fs.watch` (recursive) — best-effort and
 * debounced so the multi-file write of one variant becomes one upload pass.
 *
 * Note: `fs.watch({recursive:true})` is supported on Linux (Node ≥ 20) and macOS,
 * which covers the distroless runtime and local dev. If watching is unavailable the
 * caller still benefits from the startup restore; we log and return a no-op stop.
 */
export async function watchAndPushImageCache(
    opts: ImageCacheSyncOptions,
): Promise<{ stop: () => void }> {
    const log = opts.log ?? console;
    const cacheDir = opts.cacheDir ?? defaultCacheDir();
    const store = opts.store ?? (await defaultStore());
    const noop = { stop: () => {} };

    if (!store) {
        log.warn(
            "[image-cache-sync] watch skipped: object store client unavailable",
        );
        return noop;
    }

    await fs.mkdir(cacheDir, { recursive: true });

    const pending = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    const FLUSH_MS = 500;

    const flush = () => {
        timer = null;
        const keys = [...pending];
        pending.clear();
        for (const cacheKey of keys) {
            void pushVariant(cacheKey, { ...opts, store });
        }
    };

    let watcher: import("node:fs").FSWatcher;
    try {
        const { watch } = await import("node:fs");
        watcher = watch(cacheDir, { recursive: true }, (_event, filename) => {
            if (!filename) return;
            // filename is `<cacheKey>/<file>` (or just `<cacheKey>`); take the first segment.
            const cacheKey = String(filename).split(/[/\\]/)[0];
            if (!cacheKey) return;
            pending.add(cacheKey);
            if (!timer) timer = setTimeout(flush, FLUSH_MS);
        });
    } catch (err) {
        log.warn(
            `[image-cache-sync] watch unavailable (restore-only mode) — ${String(err)}`,
        );
        return noop;
    }

    log.info(
        `[image-cache-sync] watching ${cacheDir} for new optimized variants`,
    );
    return {
        stop: () => {
            if (timer) clearTimeout(timer);
            watcher.close();
        },
    };
}

/**
 * Top-level entry: restore-then-watch. Guarded by STORAGE_BUCKET. Returns a stop()
 * handle (no-op when disabled). Call once from the runtime entry, before/around the
 * Next standalone server starts.
 */
export async function startImageCacheSync(
    env: NodeJS.ProcessEnv = process.env,
    deps: {
        log?: SyncLogger;
        store?: ImageVariantStore;
    } = {},
): Promise<{ stop: () => void }> {
    const log = deps.log ?? console;
    const bucket = env.STORAGE_BUCKET;
    if (!bucket) {
        log.info(
            "[image-cache-sync] disabled: STORAGE_BUCKET not set — image variants stay pod-local",
        );
        return { stop: () => {} };
    }

    const opts: ImageCacheSyncOptions = {
        bucket,
        prefix: env.IMAGE_CACHE_PREFIX || DEFAULT_PREFIX,
        cacheDir: env.IMAGE_CACHE_DIR || undefined,
        store: deps.store,
        log,
    };

    await restoreImageCache(opts);
    return watchAndPushImageCache(opts);
}
