import {
    cpSync,
    type Dirent,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_BUILDER_ID } from "../adapters/artifact-contract";
import { runCapture, runQuiet, runQuietAllowFail } from "../cli/exec";
import type { KnativeNextConfig, StorageConfig } from "../config";
import { classifyBuilds, DEFAULT_RETAIN } from "./asset-gc";
import { createLogger } from "./logger";
import { RESERVED_STATIC_DIRS } from "./reserved-static-dirs";

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
 * A config whose `storage` block is PRESENT — the shape every function in
 * this module that talks to a bucket requires. `storage` itself is optional
 * on {@link KnativeNextConfig} (ADR-0047: absence is the announced
 * image-served static mode), so narrowing through {@link hasStorage} is what
 * turns an un-guarded `config.storage` dereference into a COMPILE error
 * rather than a runtime crash. The type-level scan is the primary guard here
 * — deliberately not an enumerated call-site list, which is how the second
 * site gets missed.
 */
export type StorageBackedConfig = KnativeNextConfig & {
    storage: StorageConfig;
};

/** Type guard: does this config carry a storage block? */
export function hasStorage(
    config: KnativeNextConfig,
): config is StorageBackedConfig {
    return config.storage !== undefined;
}

/** The user-facing growth path for the no-storage mode (docs site). */
export const NO_STORAGE_DOCS_URL =
    "https://knext.dev/docs/multi-cloud#starting-without-object-storage";

/**
 * ADR-0047 condition 1: the ANNOUNCED mode. Printed at info by every deploy
 * and build that runs without a `storage` block, so a dropped or mistyped
 * block never looks identical to a deliberate choice. Honest about the trade
 * (ADR-0011): navigations stay skew-protected via ?dpl= (NEXT_DEPLOYMENT_ID
 * is storage-independent), but a chunk fetch already in flight when the old
 * revision scales away has no bucket to fall back to.
 */
export const NO_STORAGE_MODE_NOTICE =
    "no object storage configured — static assets will be served from the " +
    "image (next start semantics): no CDN offload, no cross-deploy asset " +
    "retention, and the in-flight skew window is unprotected (a browser " +
    "still holding the previous build can 404 on its chunks once that " +
    "revision scales away). Add a `storage` block when you need the offload " +
    `path: ${NO_STORAGE_DOCS_URL}`;

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
export function getAssetPrefix(config: StorageBackedConfig): string {
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
    config: StorageBackedConfig,
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
                        // #481: az defaults to NO-overwrite, so a second deploy of
                        // an unhashed asset (e.g. favicon.ico) under the same key
                        // would ERROR. Overwrite makes re-deploy idempotent, at
                        // parity with the gcs/s3/minio paths.
                        "--overwrite",
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
                        // #481: `az storage blob list` caps at 5000 results by
                        // default; a >5000-object prefix would yield a false
                        // "missing" verdict → redundant re-uploads. `*` lists all
                        // (az paginates internally via the continuation marker).
                        "--num-results",
                        "*",
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
                        // #481: a re-upload always replaces an existing blob; az
                        // defaults to no-overwrite and would error without this.
                        "--overwrite",
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
 * ## The `.knext-build` marker requires the deploy id (#924, mirroring #892)
 *
 * This function used to READ `.next/BUILD_ID` off disk and mark whatever it
 * found. That is the exact over-delete #892 fixed on the vinext leg, un-fixed
 * here: under `kn-next build` (turbopack) no `NEXT_DEPLOYMENT_ID` is exported
 * and no revision is created, so `.next/BUILD_ID` holds Next's own generated id
 * — a value no `apps.kn-next.dev/build-id` revision label can ever carry. A
 * marker keyed on it makes the prefix a prune CANDIDATE that is permanently
 * unprotectable: reapable, never protectable. ADR-0011 forbids that direction.
 *
 * So the marker is keyed on the caller's `buildId`, not on disk state — the
 * same contract {@link stageNitroPublicAssets} enforces on the vinext leg:
 *  - **no `buildId` ⇒ no marker** (over-kept forever, the safe direction, with
 *    a warning). This is `kn-next build`, which creates no revision.
 *  - a `buildId` is given ⇒ the write site ASSERTS `.next/BUILD_ID === buildId`
 *    rather than trusting the caller (marker key ≡ protection key ≡ image tag ≡
 *    CR `spec.buildId` by construction), and REFUSES a reserved segment. A
 *    disagreement throws — never a marker written beside the real prefix.
 *
 * @throws when `.next/static` is missing — the user has not run `next build`.
 * @throws when `buildId` is a reserved static directory name.
 * @throws when `buildId` is given but `.next/BUILD_ID` does not equal it.
 */
export function stageStandaloneAssets(
    cwd: string = process.cwd(),
    buildId?: string,
): string {
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

    // EVERY refusal happens BEFORE the copy — same discipline as
    // stageNitroPublicAssets. The write site enforces the equality rather than
    // trusting the caller to have enforced it.
    if (buildId) {
        // A reserved segment can never be a build-id (deny-list as
        // defense-in-depth): marking it would scope the GC to a directory every
        // build shares — the max-blast-radius over-delete.
        if (RESERVED_STATIC_DIRS.has(buildId)) {
            throw new Error(
                `Refusing to stage a .knext-build marker for "${buildId}": ` +
                    "that name is a shared static directory (" +
                    `${[...RESERVED_STATIC_DIRS].sort().join(", ")}), not a ` +
                    "build prefix. Marking it would let the GC reap assets " +
                    "every build shares. Use a different deploy tag.",
            );
        }
        // The write site enforces marker key ≡ protection key rather than
        // trusting the caller. `.next/BUILD_ID` IS the standalone build prefix;
        // if the deploy id the caller states does not equal it, a marker would
        // name a phantom build the GC could reap while the chunks it protects
        // stay unmarked.
        const buildIdFile = join(cwd, ".next", "BUILD_ID");
        const onDisk = existsSync(buildIdFile)
            ? readFileSync(buildIdFile, "utf8").trim()
            : "";
        if (onDisk !== buildId) {
            throw new Error(
                `Refusing to stage a .knext-build marker for "${buildId}": ` +
                    `.next/BUILD_ID is ${
                        onDisk ? `"${onDisk}"` : "absent"
                    }, not the stated deploy id. A marker whose key disagrees ` +
                    "with the built prefix names a build the GC could reap " +
                    "while the chunks it protects stay unmarked.",
            );
        }
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

    // #264 marker inversion (ADR-0011): stage the `.knext-build` marker object
    // into this build's `_next/static/<buildId>/` prefix. It rides the normal
    // provider bulk upload AND the #75 verify-and-retry pass (it is part of the
    // staged file set), so every provider both writes it and PROVES it landed
    // remotely — a build whose marker is missing fails the deploy loudly. The
    // pruner deletes ONLY marker-carrying prefixes; a build uploaded without a
    // marker is permanently over-kept (documented transition/reclaim story).
    //
    // #924: keyed on the caller's `buildId` (already asserted == .next/BUILD_ID
    // above), NOT on disk state. No `buildId` ⇒ no marker ⇒ over-kept, the safe
    // direction — this is `kn-next build`, which creates no revision.
    if (buildId) {
        const markerDir = join(stagingDir, "_next", "static", buildId);
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, BUILD_MARKER_FILENAME), `${buildId}\n`);
    } else {
        log.warn(
            "No deploy build id for this upload — no .knext-build marker " +
                "staged, so these objects will be over-kept (never reaped) by " +
                "`kn-next gc`. Expected for `kn-next build`, which creates no " +
                "revision: nothing could ever protect the prefix, so marking " +
                "it would make it reapable but never protectable.",
        );
    }

    return stagingDir;
}

/**
 * Stages the vinext (nitro `.output`) build's served assets for upload and
 * returns the staging dir.
 *
 * The nitro shape needs its own staging for two reasons, both learned the
 * hard way in the PR #890 design gate:
 *
 * 1. **The source moved.** vinext serves everything from `.output/public`
 *    (`_next/static/**` and the app's public files, already merged into the
 *    exact key-space the bucket expects) — `.next/static` does not exist, so
 *    `stageStandaloneAssets` would throw advice naming a builder the config
 *    cannot even select.
 * 2. **The standalone staging dir IS this shape's artifact.** Staging into
 *    `.output/public` (chosen back when nothing else wrote `.output`) would
 *    `rmSync` the vinext build's real static root — concurrently with the
 *    docker build that COPYs it, in `deploy`'s parallel task set. So this
 *    stages into a fresh temp dir outside the repo, and treats the artifact
 *    as READ-ONLY.
 *
 * The `.knext-build` marker IS staged here (#892), which it deliberately was
 * not before: the templates now set
 * `generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null`, so the
 * vinext static prefix IS the deploy tag, and marker key ≡ protection key ≡
 * image tag ≡ CR `spec.buildId`. The over-delete that justified staying silent
 * — marking a UUID the GC's revision-label protection could never match —
 * cannot be expressed once those keys are the same value by construction.
 *
 * **`buildId` is what makes that true, so this function requires it rather than
 * discovering it.** The write site enforces the equality; it does not trust the
 * caller to have enforced it. Two failures made that non-negotiable:
 *
 *  - `kn-next build` (`build.ts`) uploads assets while exporting NO deploy id
 *    and creating NO revision. A discovered id there is whatever vinext minted
 *    — a UUID no `apps.kn-next.dev/build-id` label can ever carry — so the
 *    marker would make the prefix a prune CANDIDATE that is permanently
 *    unprotectable. That is the over-delete direction ADR-0011 forbids, on the
 *    path least likely to be noticed.
 *  - Discovery itself is unsound: vinext emits `_vinext_fonts/` beside the
 *    build prefix for any app using `next/font`, so "the single non-reserved
 *    directory" is not a rule that survives contact with the tree.
 *
 * So: **no `buildId` ⇒ no marker** (over-kept forever, the safe direction, with
 * a warning), and a `buildId` whose prefix is absent ⇒ **throw**, never a
 * marker written beside the real prefix.
 *
 * @throws when `.output/public` is missing — the app's build has not run.
 * @throws when `buildId` is given but `_next/static/<buildId>/` is not there.
 */
export function stageNitroPublicAssets(
    cwd: string = process.cwd(),
    buildId?: string,
): string {
    const sourceDir = join(cwd, ".output", "public");

    if (!existsSync(sourceDir)) {
        throw new Error(
            `No .output/public directory found in ${cwd} — run the app's build ` +
                "(`vite build`, or `kn-next build`) before deploying, or pass " +
                "--skip-upload to skip the asset upload.",
        );
    }

    // EVERY refusal happens BEFORE the copy. `mkdtempSync` + `cpSync` duplicate
    // the whole static tree, and this function's `finally`-based cleanup in
    // `uploadAssets` keys off the returned staging dir — which a throw never
    // returns, so a temp dir leaked per failed deploy. That is the exact leak
    // class the fresh-per-run design fixed for the success path; validating
    // first means there is nothing to clean up because nothing was created.
    if (buildId) {
        // A reserved segment can never be a build-id. The standalone write site
        // has always refused this; without the same refusal here `--tag chunks`
        // would write a marker INTO a shared, cross-build prefix and hand the
        // pruner a licence to reap it — the max-blast-radius over-delete.
        if (RESERVED_STATIC_DIRS.has(buildId)) {
            throw new Error(
                `Refusing to stage a .knext-build marker for "${buildId}": ` +
                    "that name is a shared static directory (" +
                    `${[...RESERVED_STATIC_DIRS].sort().join(", ")}), not a ` +
                    "build prefix. Marking it would let the GC reap assets " +
                    "every build shares. Use a different deploy tag.",
            );
        }
        const check = verifyVinextStaticPrefix(cwd, buildId);
        if (!check.ok) {
            throw new Error(
                `Refusing to stage a .knext-build marker for "${buildId}": ` +
                    `.output/public/_next/static/${buildId}/ does not exist ` +
                    `(${check.reason}${
                        check.siblings.length
                            ? `; found ${check.siblings.join(", ")}`
                            : ""
                    }). A marker written beside the real prefix names a build ` +
                    "whose assets are not under it — the GC could reap that " +
                    "name while the chunks it protects stay unmarked.",
            );
        }
    }

    // A FRESH temp dir per staging run, OUTSIDE the repo and the docker build
    // context by construction (re-gate residual on PR #890): an in-repo
    // staging dir sits inside deploy's build context, where buildx's context
    // walk races the concurrent re-staging (intermittent `no such file`
    // during context transfer) and an unignored copy of every asset wedges
    // `git status`. Fresh-per-run also makes staleness impossible — no clear
    // step, so there is nothing to mis-aim at the artifact.
    const stagingDir = mkdtempSync(join(tmpdir(), "knext-upload-"));
    cpSync(sourceDir, stagingDir, { recursive: true });

    // #892 marker, written into the STAGING copy only — the artifact stays
    // read-only (the concurrent docker build is COPYing it). Already validated
    // above, before anything was created.
    if (buildId) {
        writeFileSync(
            join(stagingDir, "_next", "static", buildId, BUILD_MARKER_FILENAME),
            `${buildId}\n`,
        );
    } else {
        log.warn(
            "No deploy build id for this upload — no .knext-build marker " +
                "staged, so these objects will be over-kept (never reaped) by " +
                "`kn-next gc`. Expected for `kn-next build`, which creates no " +
                "revision: nothing could ever protect the prefix, so marking " +
                "it would make it reapable but never protectable.",
        );
    }

    return stagingDir;
}

/**
 * Does `.output/public/_next/static/<expectedId>/` exist? (#892, round 2.)
 *
 * The ONE check the deploy lock-step guard and {@link stageNitroPublicAssets}'
 * marker both call, which is what makes "marker key ≡ protection key" true by
 * construction rather than by two call sites agreeing today.
 *
 * **It verifies a KNOWN id; it does not discover one.** Round 1 discovered "the
 * single non-reserved first-level directory", and that rule is unsound: vinext
 * copies fonts into `<assetsDir>/_vinext_fonts/` (`createGoogleFontsPlugin`'s
 * `writeBundle` hook, `assetsDir` = `_next/static`), so every `next/font` app
 * has a second candidate and would have been called ambiguous — no marker, and
 * an aborted deploy, for a naming detail.
 *
 * The repo's "prefer scanning to enumerating" rule is why the fix is not simply
 * `_vinext_fonts` added to the deny-list. Any classify-the-siblings rule needs
 * an exhaustive list of what vinext may emit beside the build prefix, and
 * `_vinext_fonts` is the proof that such a list is one someone will be short an
 * entry on — the next namespace breaks it exactly as this one did. Asking
 * "is the prefix I built at the id I claim?" has nothing to enumerate, so a
 * sibling nobody here has seen cannot break it.
 *
 * `siblings` is reported for the ERROR MESSAGE only: "expected `t1`, found a
 * UUID" is a diagnosis, "not found" is not. Nothing branches on it.
 */
export type VinextPrefixCheck =
    | { ok: true }
    | {
          ok: false;
          /** `no-static-root` = no `_next/static` at all. */
          reason: "no-static-root" | "prefix-missing";
          /** First-level directories actually present, sorted. Diagnostic only. */
          siblings: string[];
      };

/**
 * The shared question both {@link verifyVinextStaticPrefix} (the HOST
 * `.output`) and {@link verifyBuiltImageLockstep} (the pushed IMAGE, #1283)
 * ask: does `<staticDir>/<expectedId>/` exist? Extracted so the two checks
 * can never drift into asking it two different ways.
 */
function checkStaticPrefixDir(
    staticDir: string,
    expectedId: string,
): VinextPrefixCheck {
    if (!existsSync(staticDir)) {
        return { ok: false, reason: "no-static-root", siblings: [] };
    }
    const siblings = readdirSync(staticDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    // An empty id would scope to the static ROOT — never a valid prefix, and
    // `siblings.includes("")` is false anyway; this is the explicit form.
    if (expectedId && siblings.includes(expectedId)) return { ok: true };
    return { ok: false, reason: "prefix-missing", siblings };
}

export function verifyVinextStaticPrefix(
    cwd: string,
    expectedId: string,
): VinextPrefixCheck {
    const staticDir = join(cwd, ".output", "public", "_next", "static");
    return checkStaticPrefixDir(staticDir, expectedId);
}

/**
 * The two encodings a `bun build --compile` bundle stores its embedded module
 * SOURCE in — the same fact `bytecode-exec-verify.mjs` documents and checks
 * for the compile-marker literal: Bun stores a module Latin-1 when it can,
 * and UTF-16LE for the WHOLE module the moment it contains any non-Latin-1
 * character (a real Next/vinext bundle routinely does — emoji in generated
 * comments, non-ASCII route segments, etc.). An ASCII literal's Latin-1 bytes
 * are byte-identical to its UTF-8 bytes, so `"utf-8"` covers the Latin-1 case
 * without a third encoding; `"utf16le"` is the one round 2 missed.
 */
const LITERAL_SEARCH_ENCODINGS = ["utf-8", "utf16le"] as const;

/**
 * True when `file`'s BYTES contain `needle` (e.g. a configured URL) as a
 * substring, in EITHER encoding {@link LITERAL_SEARCH_ENCODINGS} lists.
 * Buffer-based, not a UTF-8 string decode: the compiled vinext SERVER binary
 * this now reads (see {@link verifyBuiltImageLockstep}) is a
 * `bun build --compile` executable — mostly non-text bytes — and comparing
 * raw bytes avoids relying on a lossy decode of the surrounding binary data.
 * Returns `false` (never throws) on a read failure — an unreadable/missing
 * candidate is not a match.
 */
function fileContainsLiteral(file: string, needle: string): boolean {
    let buf: Buffer;
    try {
        buf = readFileSync(file);
    } catch {
        return false;
    }
    return LITERAL_SEARCH_ENCODINGS.some((enc) =>
        buf.includes(Buffer.from(needle, enc)),
    );
}

/**
 * True when ANY file under `dir` (recursively) contains `needle` — see
 * {@link fileContainsLiteral}. Used for the vinext×node shape's ENTIRE
 * `.output/server` tree (#1283 round 3): `index.mjs` is a thin nitro entry
 * that re-exports from split chunks, and `assetPrefix` lands in whichever
 * chunk the RSC/SSR renderer compiles into (`_ssr/rsc.mjs` on a real vinext
 * build — see the doc comment below) — NOT necessarily `index.mjs` itself.
 * Scanning only the entry (round 2's defect) would fail closed on every real
 * vinext×node storage deploy. Missing/unreadable `dir` is not a match, never
 * a throw — the same fail-safe contract as `fileContainsLiteral`.
 */
function treeContainsLiteral(dir: string, needle: string): boolean {
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return false;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (treeContainsLiteral(full, needle)) return true;
        } else if (fileContainsLiteral(full, needle)) {
            return true;
        }
    }
    return false;
}

export type ImageLockstepCheck =
    | { ok: true }
    | {
          ok: false;
          reason:
              | "no-static-root"
              | "prefix-missing"
              | "image-extract-failed"
              | "asset-prefix-not-embedded";
          siblings: string[];
      };

/**
 * Proves the ADR-0011 build-id/asset-prefix lock-step against the ACTUAL
 * pushed image, not the Dockerfile's source text (#1283). A text-only check
 * ("does the Dockerfile declare `ARG ASSET_PREFIX`?") is satisfiable while
 * still wrong — the ARG can be declared and never passed into the build
 * step's env, set in the wrong stage, or clobbered.
 *
 * **Where each value actually lands, and why the check reads two different
 * artifacts for the two halves (round 2, #1283 review).** Round 1 grepped
 * `.output/public` for the configured `assetPrefix` and would have FAILED
 * EVERY real vinext deploy, storage-mode or not: reading vinext
 * 1.0.0-beta.8's own compiled server-entry source
 * (`vinext/dist/entries/app-rsc-entry.js`) shows `assetPrefix` baked as
 * `export const __assetPrefix = ${JSON.stringify(assetPrefix)}` into the
 * SERVER entry, then embedded whole into the `bun build --compile` binary —
 * never into the client-served `.output/public` tree the round-1 check
 * inspected. The build-id/static-prefix half is UNAFFECTED by this —
 * `_next/static/<id>/` is real static output the build tool writes under
 * `.output/public`, not something the server embeds, so it stays checked
 * there, matching the HOST leg (`verifyVinextStaticPrefix`) exactly.
 *
 * **Round 2 fixed WHERE to look but not HOW MUCH of it (round 3, #1283
 * review).** `.output/server/index.mjs` is a thin nitro entry that
 * re-exports from split chunks — on a REAL vinext build (`examples/bun-exec`
 * with `ASSET_PREFIX`/`NEXT_DEPLOYMENT_ID` set) the literal lands in
 * `.output/server/_ssr/{ssr,rsc}.mjs`, NOT `index.mjs` itself (0 matches
 * there). Checking only `index.mjs` — round 2's fixture happened to plant the
 * literal there, so its own test missed this — would fail EVERY real
 * vinext×node storage deploy. So the vinext×node leg scans the WHOLE
 * `.output/server` tree ({@link treeContainsLiteral}), not one file. Also
 * searched in BOTH the ASCII/UTF-8 encoding AND UTF-16LE
 * ({@link LITERAL_SEARCH_ENCODINGS}) — the same two encodings
 * `bytecode-exec-verify.mjs` checks for its own embedded-marker search, for
 * the same reason: Bun stores an embedded module UTF-16LE, not Latin-1/UTF-8,
 * the moment the module contains any non-Latin-1 character, which a real
 * Next/vinext bundle routinely does.
 *
 * So: `docker create --platform linux/amd64` (OKE is amd64; without the
 * platform flag this fails outright on an arm64 Docker host — "no matching
 * manifest for linux/arm64/v8") + `docker cp` extracts the whole `/app` tree
 * once, then:
 *
 *   1. `_next/static/<expectedId>/` must exist under `app/.output/public` —
 *      proves `NEXT_DEPLOYMENT_ID` reached the in-image build;
 *   2. when `assetPrefix` is configured (storage mode), a SERVER artifact
 *      must contain it literally (either encoding) — `app/server` (the
 *      compiled single-executable, the vinext×bun `app-dockerfile` shape) if
 *      present, else ANY file under `app/.output/server` (the vinext×node
 *      shape, run uncompiled by `node`) — proving `ASSET_PREFIX` was baked
 *      in, not silently dropped. Neither present is
 *      `asset-prefix-not-embedded`, the SAME reason a present-but-wrong
 *      value is: an unrecognised server layout is exactly the case
 *      `--skip-image-lockstep-check` (deploy.ts) exists for, and that flag
 *      (not a different failure reason here) is how a user routes around it.
 *
 * Runs AFTER the `docker buildx build --push`, BEFORE the CR apply — a
 * failure here aborts the deploy exactly where `verifyVinextStaticPrefix`
 * aborts it for the host leg, never after the cluster write (ADR-0001).
 *
 * SCOPE (deploy.ts): only called for a Dockerfile that is NOT
 * byte-identical to a shipped template (`isKnownGoodTemplateDockerfile`,
 * runtime-image.ts) — the scaffolded `Dockerfile`/`Dockerfile.vinext-node`
 * `COPY` host-built artifacts, so the host build already had both env vars
 * before either compiled or was copied; there is nothing for this check to
 * catch there, and paying a `docker cp` on every such deploy is pure
 * overhead this function itself has no way to avoid — the caller must skip
 * it.
 */
export function verifyBuiltImageLockstep(opts: {
    taggedRef: string;
    expectedId: string;
    assetPrefix?: string;
}): ImageLockstepCheck {
    const workDir = mkdtempSync(join(tmpdir(), "knext-image-lockstep-"));
    let containerId: string | undefined;
    try {
        try {
            containerId = runCapture([
                "docker",
                "create",
                "--platform",
                "linux/amd64",
                opts.taggedRef,
            ]);
        } catch {
            return { ok: false, reason: "image-extract-failed", siblings: [] };
        }
        const appDir = join(workDir, "app");
        try {
            runQuiet(["docker", "cp", `${containerId}:/app`, appDir]);
        } catch {
            return { ok: false, reason: "image-extract-failed", siblings: [] };
        }
        const staticCheck = checkStaticPrefixDir(
            join(appDir, ".output", "public", "_next", "static"),
            opts.expectedId,
        );
        if (!staticCheck.ok) return staticCheck;
        if (opts.assetPrefix) {
            // vinext×bun: the compiled single executable (one file). vinext×
            // node: the uncompiled `.output/server` tree — SCAN it whole
            // (#1283 round 3), not just `index.mjs`; see the doc comment
            // above for why a single-file check there is wrong on a real
            // build. Try the binary first (cheap, one file); fall back to the
            // tree scan.
            const found =
                fileContainsLiteral(join(appDir, "server"), opts.assetPrefix) ||
                treeContainsLiteral(
                    join(appDir, ".output", "server"),
                    opts.assetPrefix,
                );
            if (!found) {
                return {
                    ok: false,
                    reason: "asset-prefix-not-embedded",
                    siblings: [],
                };
            }
        }
        return { ok: true };
    } finally {
        if (containerId) {
            runQuietAllowFail(["docker", "rm", "-f", containerId]);
        }
        rmSync(workDir, { recursive: true, force: true });
    }
}

export type ChunkReferenceCheck =
    | { ok: true; referenced: number }
    | {
          ok: false;
          reason:
              | "server-artifact-missing"
              | "no-chunk-references"
              | "chunk-missing";
          /** Chunk files the server references that the asset set lacks. */
          missing: string[];
      };

/** `chunks/<hashed-file>` as the vinext server output spells a client chunk. */
const CHUNK_REFERENCE = /\bchunks\/([A-Za-z0-9_.~-]+\.(?:js|mjs|css))/g;

/**
 * The one-build-one-artifact guard (#1447). `appDir` is a `/app` tree (an image
 * extraction). Asserts EVERY client chunk the image's SERVER output references
 * exists in the asset set that will be uploaded (`.output/public/_next/static/
 * chunks`). A mismatch is exactly the shape of the bug it guards: HTML that
 * names `chunks/vinext-A.js` while the bucket holds `vinext-B.js` is a 404 for
 * the app's main chunk, discovered by a user instead of by the deploy.
 *
 * Fail-closed on both blind spots: no server artifact, and a server artifact
 * that references no chunk at all (an unrecognised layout — the guard cannot
 * observe, which is not the same as passing). Searched in both encodings a
 * `bun build --compile` bundle stores modules in (see LITERAL_SEARCH_ENCODINGS).
 */
export function verifyAssetsCoverServerReferences(
    appDir: string,
): ChunkReferenceCheck {
    const chunkDir = join(
        appDir,
        ".output",
        "public",
        "_next",
        "static",
        "chunks",
    );
    const files: string[] = [];
    const collect = (p: string): void => {
        let entries: Dirent[];
        try {
            entries = readdirSync(p, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = join(p, e.name);
            if (e.isDirectory()) collect(full);
            else files.push(full);
        }
    };
    const compiled = join(appDir, "server");
    if (existsSync(compiled)) files.push(compiled);
    collect(join(appDir, ".output", "server"));
    if (files.length === 0) {
        return { ok: false, reason: "server-artifact-missing", missing: [] };
    }
    const referenced = new Set<string>();
    for (const f of files) {
        let buf: Buffer;
        try {
            buf = readFileSync(f);
        } catch {
            continue;
        }
        for (const text of [buf.toString("latin1"), buf.toString("utf16le")]) {
            for (const m of text.matchAll(CHUNK_REFERENCE))
                referenced.add(m[1]);
        }
        // utf16le at an odd byte offset — the second alignment.
        const odd = buf.subarray(1).toString("utf16le");
        for (const m of odd.matchAll(CHUNK_REFERENCE)) referenced.add(m[1]);
    }
    if (referenced.size === 0) {
        return { ok: false, reason: "no-chunk-references", missing: [] };
    }
    const uploaded = new Set(
        existsSync(chunkDir)
            ? readdirSync(chunkDir, { withFileTypes: true })
                  .filter((e) => e.isFile())
                  .map((e) => e.name)
            : [],
    );
    const missing = [...referenced].filter((n) => !uploaded.has(n)).sort();
    if (missing.length > 0)
        return { ok: false, reason: "chunk-missing", missing };
    return { ok: true, referenced: referenced.size };
}

/**
 * Upload the static assets the IMAGE serves (#1447), not the ones a separate
 * host build produced. The image is the source of truth: it was built once,
 * and its `/app/.output/public` is byte-for-byte what its server references.
 * Extracts `/app` from `imageRef`, proves the extracted assets cover every
 * chunk the image's server output references, then uploads that tree.
 *
 * @throws when the image cannot be extracted or the guard finds a mismatch —
 *   the deploy aborts before the CR apply (ADR-0001).
 */
export async function uploadAssetsFromImage(
    config: StorageBackedConfig,
    buildId: string,
    imageRef: string,
    opts: {
        verify?: boolean;
        /** Test seam: the actual provider upload. */
        upload?: typeof uploadAssets;
    } = {},
): Promise<void> {
    const verify = opts.verify ?? true;
    const workDir = mkdtempSync(join(tmpdir(), "knext-image-assets-"));
    let containerId: string | undefined;
    try {
        try {
            containerId = runCapture([
                "docker",
                "create",
                "--platform",
                "linux/amd64",
                imageRef,
            ]);
            runQuiet([
                "docker",
                "cp",
                `${containerId}:/app`,
                join(workDir, "app"),
            ]);
        } catch {
            throw new Error(
                `could not extract /app from image ${imageRef} (docker create/cp ` +
                    "failed) — the assets to upload are read from the image the " +
                    "deploy is about to serve, so the deploy cannot proceed.",
            );
        }
        const appDir = join(workDir, "app");
        // `verify: false` is the documented `--skip-image-lockstep-check` opt-out
        // for a non-standard server layout. The upload is STILL sourced from the
        // image, so it stays correct by construction; only the cross-check goes.
        const check: ChunkReferenceCheck = verify
            ? verifyAssetsCoverServerReferences(appDir)
            : { ok: true, referenced: 0 };
        if (!check.ok) {
            throw new Error(
                "Asset/image mismatch: " +
                    (check.reason === "chunk-missing"
                        ? `the image's server references client chunks absent from ` +
                          `its own asset tree: ${check.missing.join(", ")}`
                        : check.reason === "no-chunk-references"
                          ? "the image's server output references no client chunks, " +
                            "so the asset set cannot be verified against it"
                          : "the image has no recognisable server artifact " +
                            "(/app/server or /app/.output/server)") +
                    ". Refusing to upload assets the image does not serve.",
            );
        }
        if (check.ok && verify) {
            log.info(
                { referencedChunks: check.referenced },
                "Image assets cover every chunk the server references",
            );
        }
        await (opts.upload ?? uploadAssets)(config, buildId, { cwd: appDir });
    } finally {
        if (containerId) runQuietAllowFail(["docker", "rm", "-f", containerId]);
        rmSync(workDir, { recursive: true, force: true });
    }
}

/**
 * @param buildId this deploy's id. Threaded from the caller rather than read
 *   back off disk — see {@link stageNitroPublicAssets}. Omitted by
 *   `kn-next build`, which creates no revision, so its upload is over-kept.
 */
export async function uploadAssets(
    config: StorageBackedConfig,
    buildId?: string,
    opts: { cwd?: string } = {},
): Promise<void> {
    const cwd = opts.cwd ?? process.cwd();
    // Shape dispatch — the builder decides where served assets live, so the
    // staging step must ask (the resolved default, not the raw field: an
    // absent `build` means vinext, ADR-0048).
    const nitroShape = (config.build ?? DEFAULT_BUILDER_ID) === "vinext";
    const assetsDir = nitroShape
        ? stageNitroPublicAssets(cwd, buildId)
        : stageStandaloneAssets(cwd, buildId);

    try {
        log.info(
            {
                provider: config.storage.provider,
                bucket: config.storage.bucket,
            },
            "Syncing assets to storage",
        );

        const ops = providerOps(config, assetsDir);
        const localFiles = collectFiles(assetsDir, assetsDir);

        ops.bulkUpload();
        verifyAndRetry(ops, localFiles, config.storage.bucket);
    } finally {
        // The nitro staging is a fresh mkdtemp per run — without this, every
        // deploy on a long-lived build machine leaks a full copy of the
        // app's static assets into the OS temp dir (sprint-close finding: the
        // temp-dir guard asserts LOCATION, never lifetime). finally, not
        // success-only: a failed upload's staging is equally dead weight.
        // The standalone shape stages into .output/public, which is NOT ours
        // to delete (it is the artifact on that shape) — never remove it.
        if (nitroShape) rmSync(assetsDir, { recursive: true, force: true });
    }
}

/**
 * The object-store path holding per-build static chunks, RELATIVE to the
 * app-scoped key prefix: `_next/static/<buildId>/...`. The retention GC operates
 * ONLY under this sub-namespace; the bare `<app>/` prefix is teardown-only
 * (ADR-0008) and is never a prune target.
 */
const STATIC_NS = "_next/static/";

// RESERVED_STATIC_DIRS (first-level `_next/static/` siblings that are never a
// build-id prefix — `chunks/`, `css/`, `media/`, `webpack/`, `development/`,
// `_vinext_fonts/`) now lives in `./reserved-static-dirs` (its own tsup entry,
// so a plain-`node` script outside this build can import it too — see that
// module's doc comment for what the list is and is not, and why it is
// enumerated at all despite "prefer scanning to enumerating").

/**
 * The marker OBJECT every knext upload writes at
 * `<app>/_next/static/<buildId>/.knext-build` (#264, ADR-0011). The pruner
 * deletes ONLY prefixes that carry this marker — proof the prefix was uploaded
 * by knext as a build. Everything else (a FUTURE Next shared dir, a pre-marker
 * upload, anything a human placed there) defaults to KEEP. This inverts the
 * old deny-list-only direction, whose failure mode on a Next upgrade was
 * DELETION of a new shared dir; {@link RESERVED_STATIC_DIRS} stays permanently
 * as defense-in-depth on top (reaping `chunks/` is the max-blast-radius
 * failure and must stay impossible even if a marker appears inside it).
 */
export const BUILD_MARKER_FILENAME = ".knext-build";

/** One first-level prefix under `<app>/_next/static/` observed remotely. */
interface RemoteStaticPrefix {
    /** Recursive-delete URI scoped to exactly `<app>/_next/static/<id>/`. */
    deleteUri: string;
    /** true ⇒ `<id>/.knext-build` exists — the prefix is a knext build. */
    hasMarker: boolean;
}

/** What one remote listing observed under `<app>/_next/static/` (#264). */
interface RemoteStaticListing {
    /** Candidate id → { delete URI, marker presence }. */
    prefixes: Map<string, RemoteStaticPrefix>;
    /**
     * {@link RESERVED_STATIC_DIRS} segments actually PRESENT remotely, sorted.
     * Never candidates (marker or not) — surfaced so the `--dry-run` plan can
     * name what the deny-list excluded (#264 part 2).
     */
    reservedExcluded: string[];
}

/**
 * Lists the first-level "directories" present under `<app>/_next/static/` in
 * the object store, returning id → { delete URI, marker presence } (#264).
 * Provider-specific because each CLI renders a listing differently; every
 * provider lists RECURSIVELY so the `.knext-build` marker objects are visible.
 * The id is the first path segment AFTER `_next/static/`, excluding
 * {@link RESERVED_STATIC_DIRS} (never prunable candidates, marker or not —
 * reported separately in `reservedExcluded`).
 */
function listRemoteBuildIds(config: StorageBackedConfig): RemoteStaticListing {
    const { provider, bucket } = config.storage;
    const appPrefix = appKeyPrefix(config); // "<name>/"
    const out = new Map<string, RemoteStaticPrefix>();
    const reservedSeen = new Set<string>();
    const listing = (): RemoteStaticListing => ({
        prefixes: out,
        reservedExcluded: [...reservedSeen].sort(),
    });

    /**
     * Folds one key path RELATIVE to `_next/static/` (e.g.
     * `bid-1/.knext-build`, `bid-1/_buildManifest.js`, `bid-1/:` for a gsutil
     * directory-header line) into the result map.
     */
    const record = (
        relAfterStatic: string,
        deleteUriFor: (id: string) => string,
    ): void => {
        const segs = relAfterStatic.split("/");
        const id = segs[0];
        if (!id) return;
        if (RESERVED_STATIC_DIRS.has(id)) {
            reservedSeen.add(id);
            return;
        }
        const entry = out.get(id) ?? {
            deleteUri: deleteUriFor(id),
            hasMarker: false,
        };
        // The marker is the DIRECT child `<id>/.knext-build` — never deeper.
        if (segs.length === 2 && segs[1] === BUILD_MARKER_FILENAME) {
            entry.hasMarker = true;
        }
        out.set(id, entry);
    };

    /** Extracts the path RELATIVE to `_next/static/` from a full key, if any. */
    const relFrom = (key: string): string | null => {
        const idx = key.indexOf(STATIC_NS);
        if (idx < 0) return null;
        return key.slice(idx + STATIC_NS.length);
    };

    switch (provider) {
        case "gcs": {
            const base = `gs://${bucket}/${appPrefix}${STATIC_NS}`;
            // Recursive: object URIs (and `<dir>/:` header lines) — the marker
            // objects are visible, unlike the old single-level `gsutil ls`.
            const listed = runCapture(["gsutil", "ls", "-r", base]);
            for (const line of listed.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed.startsWith(base)) continue;
                const rel = trimmed.slice(base.length);
                // `gsutil ls -r` prints a header for the listed dir ITSELF
                // (`<base>:` → rel ":") — not a prefix; folding it in would
                // report a phantom unmarked prefix ":" on every clean run.
                // Per-id headers (`<id>/:`) are handled fine by `record`.
                if (rel === ":") continue;
                record(rel, (id) => `${base}${id}/`);
            }
            return listing();
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
                const rel = relFrom(key);
                if (rel !== null)
                    record(
                        rel,
                        (id) => `s3://${bucket}/${appPrefix}${STATIC_NS}${id}/`,
                    );
            }
            return listing();
        }
        case "minio": {
            const base = `minio/${bucket}/${appPrefix}${STATIC_NS}`;
            // Recursive so the per-build `.knext-build` objects are listed.
            const listed = runCapture(["mc", "ls", "--recursive", base]);
            for (const line of listed.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // `mc ls --recursive` prints metadata columns then the key —
                // either the full `minio/<bucket>/...` token or a path
                // RELATIVE to the listed prefix as the last field.
                const token =
                    trimmed.split(/\s+/).find((t) => t.startsWith(base)) ??
                    trimmed.split(/\s+/).pop();
                if (!token) continue;
                const rel = stripPrefix(token, base) ?? token;
                record(rel, (id) => `${base}${id}/`);
            }
            return listing();
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
                        const rel = relFrom(name);
                        if (rel !== null)
                            record(
                                rel,
                                (id) => `${appPrefix}${STATIC_NS}${id}/`,
                            );
                    }
                }
            } catch {
                // Empty / non-JSON container → no build-ids to prune.
            }
            return listing();
        }
        default:
            throw new Error(`Unsupported storage provider: ${provider}`);
    }
}

/** Issues a best-effort recursive delete of one build-id prefix. */
function deleteBuildPrefix(
    config: StorageBackedConfig,
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
 * Builds the recursive-delete URI scoped to EXACTLY `<app>/_next/static/<id>/`
 * for one build-id — the SAME per-provider shape the listing's `deleteUriFor`
 * closures produce, factored out so {@link reclaimBuildPrefix} can target a
 * single known prefix WITHOUT a remote listing (no full-remote-set enumeration).
 */
function staticBuildDeleteUri(
    config: StorageBackedConfig,
    buildId: string,
): string {
    const { provider, bucket } = config.storage;
    const appPrefix = appKeyPrefix(config); // "<name>/"
    switch (provider) {
        case "gcs":
            return `gs://${bucket}/${appPrefix}${STATIC_NS}${buildId}/`;
        case "s3":
            return `s3://${bucket}/${appPrefix}${STATIC_NS}${buildId}/`;
        case "minio":
            return `minio/${bucket}/${appPrefix}${STATIC_NS}${buildId}/`;
        case "azure":
            return `${appPrefix}${STATIC_NS}${buildId}/`;
        default:
            throw new Error(`Unsupported storage provider: ${provider}`);
    }
}

/**
 * FAILURE-PATH orphan reclaim (v6-P2, ADR-0011). Deletes EXACTLY this run's
 * own `<app>/_next/static/<buildId>/` prefix and NOTHING else — a single,
 * idempotent, scoped delete of one known prefix.
 *
 * Called by `kn-next deploy` on the confirmed upload-succeeded-then-push-failed
 * leg: the assets were already uploaded, but the deploy is aborting before
 * `kubectl apply`, so those assets would otherwise be orphaned forever (the
 * post-apply {@link pruneOldBuilds} never runs on the failure path, and it
 * prunes by CURRENT traffic — a never-applied build-id is never in traffic, so
 * nothing would ever reclaim it).
 *
 * SAFETY INVARIANT (why a targeted delete is safe here, ADR-0011): `buildId` is
 * this run's UNIQUE build-id — `.next/BUILD_ID` == `NEXT_DEPLOYMENT_ID` == the
 * deploy tag, enforced unique-per-run by the deploy skew guard (ADR-0011 §2
 * lock-step). Because this deploy is aborting before apply, this build-id can
 * NEVER appear in the operator's `status.currentTraffic` nor in a
 * `spec.traffic.revisionName` pin, and a CONCURRENT deploy's build-id is a
 * DIFFERENT value. Deleting only this build-id's own prefix therefore cannot
 * touch a live/pinned build or a concurrently-deploying build's not-yet-live
 * assets. That uniqueness is the ONLY reason a targeted delete is safe — this
 * MUST NOT call {@link pruneOldBuilds} / the retention GC, which enumerate ALL
 * remote builds and could reap a concurrent deploy's prefix (an ADR-0011
 * over-keep-never-over-delete violation on a path with no traffic to consult).
 *
 * Routes through {@link deleteBuildPrefix}, whose hard `_next/static/<id>/`
 * scope assertion makes a bare `<app>/` (teardown-only, ADR-0008) delete
 * impossible. Best-effort delete (`runQuietAllowFail`): the caller rethrows the
 * original push error regardless, so a stuck cleanup never masks the failure.
 *
 * OUT OF SCOPE (documented): the symmetric leg — upload REJECTS while the push
 * SUCCEEDS — leaves an orphaned image TAG in the registry. Reclaiming that is a
 * SEPARATE authority (registry GC), not this asset-store reclaim.
 */
export function reclaimBuildPrefix(
    config: StorageBackedConfig,
    buildId: string,
): void {
    if (!buildId) return; // never scope to the static root
    const deleteUri = staticBuildDeleteUri(config, buildId);
    log.warn(
        { buildId, deleteUri, provider: config.storage.provider },
        "Reclaiming orphaned asset prefix from a failed deploy (upload " +
            "succeeded, push failed) — scoped single-prefix delete of THIS " +
            "run's own _next/static/<buildId>/ (ADR-0011; NOT the retention GC)",
    );
    deleteBuildPrefix(config, buildId, deleteUri);
}

/**
 * What one {@link pruneOldBuilds} run did — returned so callers (`kn-next gc`)
 * can report it SYNCHRONOUSLY on stdout (a command that deletes objects must
 * always say what it did, and what it refused to touch).
 */
export interface PruneSummary {
    /**
     * Build-ids whose prefixes were reaped (delete issued), oldest-first.
     * Under `dryRun` these are the candidates that WOULD be reaped — no
     * delete was issued (`dryRun: true` makes the distinction unambiguous).
     * `reaped` records the ATTEMPTED delete set, not the confirmed outcome:
     * deletes are best-effort (`runQuietAllowFail`), so a silently-failed
     * provider delete is still listed here.
     */
    reaped: string[];
    /**
     * First-level prefixes KEPT because they carry no `.knext-build` marker
     * (#264): pre-marker uploads or unknown/future shared dirs. Over-keep by
     * design — named loudly so a human can reclaim them manually (ADR-0011).
     */
    keptUnmarked: string[];
    /** Build-ids kept by the retain window (newest-first), #264 part 2. */
    keptWindow: string[];
    /** Build-ids kept ONLY by the live-set rule (outside the window). */
    keptLive: string[];
    /** Reserved shared dirs (chunks/css/…) observed remotely — never candidates. */
    reservedExcluded: string[];
    /** true ⇒ this was a `--dry-run`: the plan above was computed, nothing deleted. */
    dryRun: boolean;
}

/**
 * Deploy-time retention GC (#93, ADR-0011). After uploading build `newBuildId`,
 * reap the static-asset prefixes of builds that are outside the retain window
 * AND not in `liveBuildIds` (the live traffic set, sourced READ-ONLY from
 * `NextApp.Status.CurrentTraffic`, #92) AND carry the `.knext-build` marker
 * object (#264 — only prefixes knext itself uploaded are ever candidates;
 * unmarked prefixes are kept and named loudly). This is the ONLY
 * build-id-pruning authority; it deletes strictly under
 * `<app>/_next/static/<id>/`, never the bare `<app>/` prefix.
 *
 * Ordering: the remote listing has no reliable per-build timestamp, so we treat
 * the just-deployed `newBuildId` as the unambiguous newest and order the rest by
 * their listing position (stable, oldest-first). The window + live set + marker
 * are the safety properties; the exact age of two equally-old builds does not
 * matter.
 *
 * Best-effort: individual deletes tolerate failure (a stuck delete must never
 * fail a deploy that has already shipped).
 *
 * `--dry-run` (#264 part 2): with `opts.dryRun` the ENTIRE plan is computed
 * through the same listing + marker filter + {@link classifyBuilds} path a wet
 * run takes (no parallel implementation to drift), but no delete is ever
 * issued — `summary.reaped` holds the would-reap candidates and
 * `summary.dryRun` is true.
 */
export function pruneOldBuilds(
    config: StorageBackedConfig,
    liveBuildIds: readonly string[],
    newBuildId: string,
    opts: { dryRun?: boolean } = {},
): PruneSummary {
    const dryRun = opts.dryRun === true;
    const retain = config.storage.assetRetention ?? DEFAULT_RETAIN;
    const summary: PruneSummary = {
        reaped: [],
        keptUnmarked: [],
        keptWindow: [],
        keptLive: [],
        reservedExcluded: [],
        dryRun,
    };

    let remote: Map<string, RemoteStaticPrefix>;
    try {
        const listed = listRemoteBuildIds(config);
        remote = listed.prefixes;
        summary.reservedExcluded = listed.reservedExcluded;
    } catch (err) {
        // A listing failure must never break a successful deploy — just skip GC.
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
            { provider: config.storage.provider, error: message },
            "Skipping asset GC: could not list remote build-ids",
        );
        return summary;
    }

    // #264 marker inversion: ONLY marker-carrying prefixes are candidates.
    // Everything else defaults to KEEP and is skipped LOUDLY, by name.
    const markedIds: string[] = [];
    for (const [id, entry] of remote) {
        if (entry.hasMarker) markedIds.push(id);
        else summary.keptUnmarked.push(id);
    }
    if (summary.keptUnmarked.length > 0) {
        log.warn(
            { kept: summary.keptUnmarked, marker: BUILD_MARKER_FILENAME },
            "Asset GC: keeping unmarked _next/static/ prefixes (no " +
                ".knext-build marker — pre-marker upload or unknown dir; " +
                "over-keep, never over-delete)",
        );
    }
    if (markedIds.length === 0) return summary;

    // Monotonic ordering: listing order + force `newBuildId` to the newest slot.
    const timestamps: Record<string, number> = {};
    markedIds.forEach((id, i) => {
        timestamps[id] = i;
    });
    if (newBuildId) timestamps[newBuildId] = markedIds.length + 1;

    const plan = classifyBuilds({
        remoteBuildIds: markedIds,
        timestamps,
        liveBuildIds,
        retain,
    });
    summary.keptWindow = plan.keptWindow;
    summary.keptLive = plan.keptLive;
    const toDelete = plan.reap;

    if (dryRun) {
        // #264 part 2: the identical plan, ZERO deletes issued. `reaped`
        // carries the would-reap candidates; the caller prints the full plan.
        summary.reaped = [...toDelete];
        log.info(
            {
                wouldReap: toDelete,
                keptWindow: plan.keptWindow,
                keptLive: plan.keptLive,
                keptUnmarked: summary.keptUnmarked,
                reservedExcluded: summary.reservedExcluded,
                retain,
            },
            "Asset GC DRY-RUN: plan computed, nothing deleted",
        );
        return summary;
    }

    if (toDelete.length === 0) {
        log.info(
            { retain, remote: markedIds.length },
            "Asset GC: nothing to reap (all builds within window or live)",
        );
        return summary;
    }

    log.info(
        { reaping: toDelete, retain, live: liveBuildIds },
        "Asset GC: reaping old build prefixes (skew-protection retention)",
    );
    for (const id of toDelete) {
        const entry = remote.get(id);
        if (entry) {
            deleteBuildPrefix(config, id, entry.deleteUri);
            summary.reaped.push(id);
        }
    }
    return summary;
}
