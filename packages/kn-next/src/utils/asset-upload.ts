import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { runCapture, runQuiet, runQuietAllowFail } from "../cli/exec";
import type { KnativeNextConfig } from "../config";
import { DEFAULT_RETAIN, selectBuildsToDelete } from "./asset-gc";
import { createLogger } from "./logger";

/**
 * Lists the top-level entries inside a directory as absolute paths. Used to
 * emulate a former shell glob (`dir/*`) without invoking a shell — each entry
 * is passed as a discrete argv element (no shell expansion, no injection).
 */
function topLevelEntries(dir: string): string[] {
    return readdirSync(dir).map((name) => join(dir, name));
}

const log = createLogger({ module: "asset-upload" });

/**
 * The app-scoped object-store key namespace, `<name>/` (#74).
 *
 * Every asset this app uploads lives under this prefix inside the (possibly
 * shared) bucket: `<bucket>/<name>/_next/static/...`. Two reasons:
 *
 *   1. **Real teardown.** The operator's deletion finalizer deletes objects
 *      under `app.Name + "/"` (`appStoragePrefix()` in the operator). If uploads
 *      went to the bucket ROOT, that prefix would match nothing and storage
 *      cleanup would be a silent no-op. Namespacing here makes #74's storage
 *      cleanup actually delete this app's objects.
 *   2. **Per-app isolation / data sovereignty.** Multiple zones can share one
 *      bucket without colliding or reading each other's keys.
 *
 * The app name is a DNS-1123 label (k8s-validated), so it is safe as a single
 * path segment. MUST stay in lock-step with the operator's `appStoragePrefix`.
 */
export function appKeyPrefix(config: KnativeNextConfig): string {
    return `${config.name}/`;
}

/**
 * Returns the asset prefix URL used as Next.js `assetPrefix` so browsers load
 * static assets (`_next/static/*`) from the user's object storage.
 *
 * Cloud-agnostic — the user declares `publicUrl`; we append the app namespace
 * (`/<name>`) so the served location matches the app-namespaced UPLOAD location
 * (`<bucket>/<name>/...`, see {@link appKeyPrefix}). Without this, browsers would
 * fetch from `<publicUrl>/_next/...` while assets actually live under
 * `<publicUrl>/<name>/_next/...` → 404. Any trailing slash on `publicUrl` is
 * normalised; Next appends its own `/` before `_next`.
 */
export function getAssetPrefix(config: KnativeNextConfig): string {
    const base = config.storage.publicUrl.replace(/\/+$/, "");
    return `${base}/${config.name}`;
}

/**
 * Recursively collects all file paths under a directory.
 */
function collectFiles(dir: string, baseDir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(fullPath, baseDir));
        } else {
            files.push(relative(baseDir, fullPath));
        }
    }
    return files;
}

/**
 * Per-provider data-plane operations used by {@link verifyAndRetry}. Each
 * provider supplies the bulk upload, a remote listing parsed into the same
 * relative-key space as the local file set, and a single-file re-upload for the
 * verify-and-retry pass. All argv is passed as discrete array tokens through the
 * `exec` helpers (`shell: false`) — never a shell string (CLI-58 injection
 * safety): a key containing shell metacharacters arrives as one opaque token.
 */
interface ProviderOps {
    /** Provider CLI binary name (e.g. `gsutil`), for diagnostics. */
    readonly cli: string;
    /** Bulk-upload the whole assets dir. Throws on non-zero exit. */
    bulkUpload(): void;
    /**
     * List remote objects under the bucket/prefix and return the set of keys,
     * normalised to the SAME relative paths as {@link collectFiles} (i.e. with
     * the provider scheme + bucket prefix stripped).
     */
    listRemote(): Set<string>;
    /** Re-upload a single local file to its remote key. Throws on failure. */
    reupload(key: string): void;
}

/**
 * Shared verify-and-retry pass used by ALL providers (#75): list the remote
 * prefix, diff against the local file set, re-upload any missing objects, then
 * re-list and FAIL THE DEPLOY LOUDLY (throw → non-zero exit) naming any keys
 * that are still missing. Per-file re-upload failures are logged with the
 * object key + the underlying error before the deploy is failed.
 */
function verifyAndRetry(
    ops: ProviderOps,
    localFiles: readonly string[],
    bucket: string,
): void {
    const remote = ops.listRemote();
    let missing = localFiles.filter((f) => !remote.has(f));

    if (missing.length === 0) {
        log.info(
            { provider: ops.cli, count: localFiles.length },
            "All assets verified present after upload",
        );
        return;
    }

    log.warn(
        { provider: ops.cli, count: missing.length },
        "Files missing after bulk upload, retrying individually",
    );

    const reuploadFailures: string[] = [];
    for (const key of missing) {
        try {
            ops.reupload(key);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Per-file error reporting: key + underlying error, not a count.
            log.error(
                { provider: ops.cli, key, error: message },
                "Failed to re-upload missing asset",
            );
            reuploadFailures.push(key);
        }
    }

    // Re-list and recompute what is STILL missing after the retry pass.
    const remoteAfter = ops.listRemote();
    missing = localFiles.filter((f) => !remoteAfter.has(f));

    if (missing.length > 0) {
        for (const key of missing) {
            log.error(
                { provider: ops.cli, key, bucket },
                "Asset still missing after retry — upload incomplete",
            );
        }
        throw new Error(
            `Asset upload to ${ops.cli} bucket "${bucket}" incomplete: ` +
                `${missing.length} object(s) still missing after retry: ` +
                missing.join(", "),
        );
    }

    log.info(
        { provider: ops.cli, count: reuploadFailures.length },
        "Missing files uploaded successfully on retry",
    );
}

/** Strips a leading scheme/bucket prefix from a remote listing line. */
function stripPrefix(line: string, prefix: string): string | null {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith(prefix)) {
        return null;
    }
    return trimmed.slice(prefix.length);
}

/** Builds the {@link ProviderOps} for the configured storage provider. */
function providerOps(
    config: KnativeNextConfig,
    assetsDir: string,
): ProviderOps {
    const { provider, bucket } = config.storage;
    const cacheControl = "public, max-age=31536000, immutable";
    // App-scoped key namespace, e.g. "shop/" (#74). ALL object keys live under
    // this prefix so the operator's `<app>/` deletion finalizer actually matches
    // them (no more silent no-op) and zones sharing a bucket stay isolated. The
    // listing-strip below uses the SAME prefix so the verify pass sees keys in
    // the local relative-path space (`_next/static/...`, not `shop/_next/...`).
    const appPrefix = appKeyPrefix(config); // "<name>/"

    switch (provider) {
        case "gcs":
            return {
                cli: "gsutil",
                bulkUpload() {
                    runQuiet([
                        "gsutil",
                        "-m",
                        "-h",
                        `Cache-Control:${cacheControl}`,
                        "cp",
                        "-r",
                        ...topLevelEntries(assetsDir),
                        `gs://${bucket}/${appPrefix}`,
                    ]);
                    // Ensure bucket has public read access for browser fetches.
                    runQuiet([
                        "gsutil",
                        "iam",
                        "ch",
                        "allUsers:objectViewer",
                        `gs://${bucket}`,
                    ]);
                },
                listRemote() {
                    const out = runCapture([
                        "gsutil",
                        "ls",
                        "-r",
                        `gs://${bucket}/${appPrefix}`,
                    ]);
                    const prefix = `gs://${bucket}/${appPrefix}`;
                    const keys = new Set<string>();
                    for (const line of out.split("\n")) {
                        const key = stripPrefix(line, prefix);
                        if (key) keys.add(key);
                    }
                    return keys;
                },
                reupload(key) {
                    runQuiet([
                        "gsutil",
                        "-h",
                        `Cache-Control:${cacheControl}`,
                        "cp",
                        join(assetsDir, key),
                        `gs://${bucket}/${appPrefix}${key}`,
                    ]);
                },
            };

        case "s3":
            return {
                cli: "aws",
                bulkUpload() {
                    runQuiet([
                        "aws",
                        "s3",
                        "sync",
                        assetsDir,
                        `s3://${bucket}/${appPrefix}`,
                        "--cache-control",
                        cacheControl,
                    ]);
                },
                listRemote() {
                    // List ONLY this app's prefix so the parsed key set is in the
                    // local relative-path space and the verify diff is accurate.
                    const out = runCapture([
                        "aws",
                        "s3api",
                        "list-objects-v2",
                        "--bucket",
                        bucket,
                        "--prefix",
                        appPrefix,
                        "--query",
                        "Contents[].Key",
                        "--output",
                        "text",
                    ]);
                    const keys = new Set<string>();
                    // `--output text` is whitespace-separated; split on any. Keys
                    // come back as `<app>/<key>` → strip the app prefix.
                    for (const tok of out.split(/\s+/)) {
                        const trimmed = tok.trim();
                        if (!trimmed || trimmed === "None") continue;
                        const key = stripPrefix(trimmed, appPrefix) ?? trimmed;
                        keys.add(key);
                    }
                    return keys;
                },
                reupload(key) {
                    runQuiet([
                        "aws",
                        "s3",
                        "cp",
                        join(assetsDir, key),
                        `s3://${bucket}/${appPrefix}${key}`,
                        "--cache-control",
                        cacheControl,
                    ]);
                },
            };

        case "minio":
            return {
                cli: "mc",
                bulkUpload() {
                    runQuiet([
                        "mc",
                        "cp",
                        "--recursive",
                        ...topLevelEntries(assetsDir),
                        `minio/${bucket}/${appPrefix}`,
                    ]);
                },
                listRemote() {
                    const out = runCapture([
                        "mc",
                        "ls",
                        "--recursive",
                        `minio/${bucket}/${appPrefix}`,
                    ]);
                    const prefix = `minio/${bucket}/${appPrefix}`;
                    const keys = new Set<string>();
                    for (const line of out.split("\n")) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        // `mc ls --recursive` may print metadata columns then the
                        // key; the key is the `minio/<bucket>/<app>/<key>` token
                        // if present, else the last whitespace-delimited field.
                        const token =
                            trimmed
                                .split(/\s+/)
                                .find((t) => t.startsWith(prefix)) ??
                            trimmed.split(/\s+/).pop();
                        const key = token
                            ? (stripPrefix(token, prefix) ?? token)
                            : null;
                        if (key) keys.add(key);
                    }
                    return keys;
                },
                reupload(key) {
                    runQuiet([
                        "mc",
                        "cp",
                        join(assetsDir, key),
                        `minio/${bucket}/${appPrefix}${key}`,
                    ]);
                },
            };

        case "azure":
            return {
                cli: "az",
                bulkUpload() {
                    runQuiet([
                        "az",
                        "storage",
                        "blob",
                        "upload-batch",
                        "-d",
                        bucket,
                        "-s",
                        assetsDir,
                        // Blob "directory" prefix — objects land under <app>/.
                        "--destination-path",
                        appPrefix,
                    ]);
                },
                listRemote() {
                    const out = runCapture([
                        "az",
                        "storage",
                        "blob",
                        "list",
                        "-c",
                        bucket,
                        "--prefix",
                        appPrefix,
                        "--query",
                        "[].name",
                        "-o",
                        "json",
                    ]);
                    const keys = new Set<string>();
                    try {
                        const parsed = JSON.parse(out || "[]");
                        if (Array.isArray(parsed)) {
                            for (const name of parsed) {
                                if (typeof name === "string" && name) {
                                    keys.add(
                                        stripPrefix(name, appPrefix) ?? name,
                                    );
                                }
                            }
                        }
                    } catch {
                        // Tolerate non-JSON (empty container) — leaves keys empty
                        // so verification reports the assets as missing.
                    }
                    return keys;
                },
                reupload(key) {
                    runQuiet([
                        "az",
                        "storage",
                        "blob",
                        "upload",
                        "-c",
                        bucket,
                        "-f",
                        join(assetsDir, key),
                        "-n",
                        `${appPrefix}${key}`,
                    ]);
                },
            };

        default:
            throw new Error(`Unsupported storage provider: ${provider}`);
    }
}

/**
 * Uploads static assets to the configured storage provider, then runs a
 * provider-agnostic verification pass (#75): every provider (GCS, S3, MinIO,
 * Azure) lists the remote prefix, diffs it against the local `_next/static` +
 * public file set, re-uploads any missing objects, and fails the deploy loudly
 * (throws → non-zero exit) naming any keys still missing after retry. A partial
 * or failed upload therefore produces a deploy-time signal instead of an app
 * that 404s its own JS/CSS/images.
 */
/**
 * Stages the standalone-build asset sources into a single upload directory and
 * returns it.
 *
 * `next build` with `output: 'standalone'` produces `.next/static/**` (hashed
 * chunks/CSS, nested under the BUILD_ID) and leaves the app's `public/` dir in
 * place — it creates NO `.output/public` (that layout was the pre-migration
 * Nitro output and nothing writes it anymore). uploadAssets used to read
 * `.output/public` directly, so every real `kn-next deploy` without
 * `--skip-upload` crashed with ENOENT at the upload step.
 *
 * Staging (rather than teaching every provider two source roots) keeps the
 * provider shell-outs, the verify-and-retry key diff, the retention GC's
 * `_next/static/<buildId>/` namespace, and the operator's `<app>/` teardown
 * prefix all keyed off ONE local dir whose relative paths ARE the object keys:
 *
 *   .next/static/**  →  <staging>/_next/static/**   (served via assetPrefix
 *                        `<publicUrl>/<name>/_next/static/...`)
 *   public/**        →  <staging>/**                (bucket key-space root)
 *
 * The staging dir is cleared first so a previous build's files never enter this
 * build's upload/verify set. Uploads to the BUCKET stay additive — old builds'
 * remote objects are untouched; only the local staging area is rebuilt.
 *
 * @throws when `.next/static` is missing — the user has not run `next build`.
 */
export function stageStandaloneAssets(cwd: string = process.cwd()): string {
    const nextStaticDir = join(cwd, ".next", "static");
    const publicDir = join(cwd, "public");
    const stagingDir = join(cwd, ".output", "public");

    if (!existsSync(nextStaticDir)) {
        throw new Error(
            `No .next/static directory found in ${cwd} — run \`next build\` ` +
                "(with output: 'standalone') before deploying, or pass " +
                "--skip-upload to skip the asset upload.",
        );
    }

    // Rebuild the staging area from scratch: stale files from a previous
    // build must not enter this build's upload/verify set.
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });

    cpSync(nextStaticDir, join(stagingDir, "_next", "static"), {
        recursive: true,
    });

    // public/ is optional — not every app has one.
    if (existsSync(publicDir)) {
        cpSync(publicDir, stagingDir, { recursive: true });
    }

    return stagingDir;
}

export async function uploadAssets(config: KnativeNextConfig): Promise<void> {
    const assetsDir = stageStandaloneAssets(process.cwd());

    log.info(
        { provider: config.storage.provider, bucket: config.storage.bucket },
        "Syncing assets to storage",
    );

    const ops = providerOps(config, assetsDir);
    const localFiles = collectFiles(assetsDir, assetsDir);

    ops.bulkUpload();
    verifyAndRetry(ops, localFiles, config.storage.bucket);
}

/**
 * The object-store path holding per-build static chunks, RELATIVE to the
 * app-scoped key prefix: `_next/static/<buildId>/...`. The retention GC operates
 * ONLY under this sub-namespace; the bare `<app>/` prefix is teardown-only
 * (ADR-0008) and is never a prune target.
 */
const STATIC_NS = "_next/static/";

/**
 * First-level directories under `.next/static/` that `next build` emits but
 * that are NOT build-id prefixes: content-hashed `chunks/`, `css/`, `media/`
 * shared by the pages of EVERY build (plus dev-mode `webpack/` and
 * `development/`). They MUST be excluded from the prune-candidate set — a
 * naive first-segment listing classifies them as "build-ids", and once they
 * fall outside the retain window the GC would reap them, 404ing the CURRENT
 * build's own JS/CSS (over-delete; found while building the e2e_gc suite).
 * Never add a real build-id shape here: deploy tags are user-chosen.
 */
const RESERVED_STATIC_DIRS: ReadonlySet<string> = new Set([
    "chunks",
    "css",
    "media",
    "webpack",
    "development",
]);

/**
 * Lists the build-id "directories" present under `<app>/_next/static/` in the
 * object store, returning buildId → the recursive-delete URI scoped to exactly
 * `<app>/_next/static/<buildId>/`. Provider-specific because each CLI renders a
 * listing differently. The build-id is the first path segment AFTER `_next/static/`,
 * excluding {@link RESERVED_STATIC_DIRS} (never prunable build-id candidates).
 */
function listRemoteBuildIds(config: KnativeNextConfig): Map<string, string> {
    const { provider, bucket } = config.storage;
    const appPrefix = appKeyPrefix(config); // "<name>/"
    const out = new Map<string, string>();

    /** Extracts the build-id segment that follows `_next/static/` in a key. */
    const buildIdFrom = (relKey: string): string | null => {
        const idx = relKey.indexOf(STATIC_NS);
        if (idx < 0) return null;
        const seg = relKey.slice(idx + STATIC_NS.length).split("/")[0];
        if (!seg || RESERVED_STATIC_DIRS.has(seg)) return null;
        return seg;
    };

    switch (provider) {
        case "gcs": {
            const base = `gs://${bucket}/${appPrefix}${STATIC_NS}`;
            const listed = runCapture(["gsutil", "ls", base]);
            for (const line of listed.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed.startsWith(base)) continue;
                const id = trimmed.slice(base.length).replace(/\/.*/, "");
                if (id && !RESERVED_STATIC_DIRS.has(id))
                    out.set(id, `${base}${id}/`);
            }
            return out;
        }
        case "s3": {
            const listed = runCapture([
                "aws",
                "s3api",
                "list-objects-v2",
                "--bucket",
                bucket,
                "--prefix",
                `${appPrefix}${STATIC_NS}`,
                "--query",
                "Contents[].Key",
                "--output",
                "text",
            ]);
            for (const tok of listed.split(/\s+/)) {
                const key = tok.trim();
                if (!key || key === "None") continue;
                const id = buildIdFrom(key);
                if (id)
                    out.set(
                        id,
                        `s3://${bucket}/${appPrefix}${STATIC_NS}${id}/`,
                    );
            }
            return out;
        }
        case "minio": {
            const base = `minio/${bucket}/${appPrefix}${STATIC_NS}`;
            const listed = runCapture(["mc", "ls", base]);
            for (const line of listed.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const last = trimmed.split(/\s+/).pop() ?? "";
                const id = last.replace(/\/.*$/, "");
                if (id && !RESERVED_STATIC_DIRS.has(id))
                    out.set(id, `${base}${id}/`);
            }
            return out;
        }
        case "azure": {
            const listed = runCapture([
                "az",
                "storage",
                "blob",
                "list",
                "-c",
                bucket,
                "--prefix",
                `${appPrefix}${STATIC_NS}`,
                "--query",
                "[].name",
                "-o",
                "json",
            ]);
            try {
                const parsed = JSON.parse(listed || "[]");
                if (Array.isArray(parsed)) {
                    for (const name of parsed) {
                        if (typeof name !== "string") continue;
                        const id = buildIdFrom(name);
                        if (id) out.set(id, `${appPrefix}${STATIC_NS}${id}/`);
                    }
                }
            } catch {
                // Empty / non-JSON container → no build-ids to prune.
            }
            return out;
        }
        default:
            throw new Error(`Unsupported storage provider: ${provider}`);
    }
}

/** Issues a best-effort recursive delete of one build-id prefix. */
function deleteBuildPrefix(
    config: KnativeNextConfig,
    buildId: string,
    deleteUri: string,
): void {
    const { provider, bucket } = config.storage;
    // Hard guard: the delete URI MUST be scoped to the static build-id namespace.
    // This makes a bare `<app>/` (teardown-only, ADR-0008) prune impossible even
    // if a listing parser regressed.
    if (!deleteUri.includes(`${STATIC_NS}${buildId}/`)) {
        log.warn(
            { buildId, deleteUri },
            "Refusing prune: delete URI not scoped to _next/static/<buildId>/",
        );
        return;
    }
    switch (provider) {
        case "gcs":
            runQuietAllowFail(["gsutil", "-m", "rm", "-r", deleteUri]);
            return;
        case "s3":
            runQuietAllowFail(["aws", "s3", "rm", "--recursive", deleteUri]);
            return;
        case "minio":
            runQuietAllowFail([
                "mc",
                "rm",
                "--recursive",
                "--force",
                deleteUri,
            ]);
            return;
        case "azure":
            runQuietAllowFail([
                "az",
                "storage",
                "blob",
                "delete-batch",
                "-s",
                bucket,
                "--pattern",
                `${deleteUri}*`,
            ]);
            return;
        default:
            throw new Error(`Unsupported storage provider: ${provider}`);
    }
}

/**
 * Deploy-time retention GC (#93, ADR-0011). After uploading build `newBuildId`,
 * reap the static-asset prefixes of builds that are BOTH outside the retain
 * window AND not in `liveBuildIds` (the live traffic set, sourced READ-ONLY from
 * `NextApp.Status.CurrentTraffic`, #92). This is the ONLY build-id-pruning
 * authority; it deletes strictly under `<app>/_next/static/<id>/`, never the
 * bare `<app>/` prefix.
 *
 * Ordering: the remote listing has no reliable per-build timestamp, so we treat
 * the just-deployed `newBuildId` as the unambiguous newest and order the rest by
 * their listing position (stable, oldest-first). The window + live set are the
 * safety properties; the exact age of two equally-old builds does not matter.
 *
 * Best-effort: individual deletes tolerate failure (a stuck delete must never
 * fail a deploy that has already shipped).
 */
export function pruneOldBuilds(
    config: KnativeNextConfig,
    liveBuildIds: readonly string[],
    newBuildId: string,
): void {
    const retain = config.storage.assetRetention ?? DEFAULT_RETAIN;

    let remote: Map<string, string>;
    try {
        remote = listRemoteBuildIds(config);
    } catch (err) {
        // A listing failure must never break a successful deploy — just skip GC.
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
            { provider: config.storage.provider, error: message },
            "Skipping asset GC: could not list remote build-ids",
        );
        return;
    }

    const remoteIds = [...remote.keys()];
    if (remoteIds.length === 0) return;

    // Monotonic ordering: listing order + force `newBuildId` to the newest slot.
    const timestamps: Record<string, number> = {};
    remoteIds.forEach((id, i) => {
        timestamps[id] = i;
    });
    if (newBuildId) timestamps[newBuildId] = remoteIds.length + 1;

    const toDelete = selectBuildsToDelete({
        remoteBuildIds: remoteIds,
        timestamps,
        liveBuildIds,
        retain,
    });

    if (toDelete.length === 0) {
        log.info(
            { retain, remote: remoteIds.length },
            "Asset GC: nothing to reap (all builds within window or live)",
        );
        return;
    }

    log.info(
        { reaping: toDelete, retain, live: liveBuildIds },
        "Asset GC: reaping old build prefixes (skew-protection retention)",
    );
    for (const id of toDelete) {
        const uri = remote.get(id);
        if (uri) deleteBuildPrefix(config, id, uri);
    }
}
