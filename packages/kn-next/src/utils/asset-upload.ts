import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { runCapture, runQuiet } from "../cli/exec";
import type { KnativeNextConfig, StorageConfig } from "../config";
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
 * Returns the asset prefix URL from the storage configuration.
 * This is cloud-agnostic — the user declares `publicUrl` in their config.
 *
 * Used as Next.js `assetPrefix` so browsers load static assets
 * (_next/static/*) from the user's object storage bucket.
 */
export function getAssetPrefix(storage: StorageConfig): string {
    return storage.publicUrl;
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
 * Uploads static assets to configured storage provider.
 * Assets include _next/static/* and public files.
 *
 * For GCS: also sets public read access, cache-control headers,
 * and verifies all files were uploaded successfully.
 */
export async function uploadAssets(config: KnativeNextConfig): Promise<void> {
    const assetsDir = join(process.cwd(), ".output", "public");

    log.info(
        { provider: config.storage.provider, bucket: config.storage.bucket },
        "Syncing assets to storage",
    );

    switch (config.storage.provider) {
        case "gcs": {
            // Upload with cache-control headers for immutable _next/static assets.
            // The former shell glob `${assetsDir}/*` is expanded in Node (no shell)
            // and each top-level entry passed as a discrete argv source.
            runQuiet([
                "gsutil",
                "-m",
                "-h",
                "Cache-Control:public, max-age=31536000, immutable",
                "cp",
                "-r",
                ...topLevelEntries(assetsDir),
                `gs://${config.storage.bucket}/`,
            ]);
            // Ensure bucket has public read access for browser fetches
            runQuiet([
                "gsutil",
                "iam",
                "ch",
                "allUsers:objectViewer",
                `gs://${config.storage.bucket}`,
            ]);

            // Post-upload verification: ensure all local files exist in GCS
            const localFiles = collectFiles(assetsDir, assetsDir);
            const gcsListResult = runCapture([
                "gsutil",
                "ls",
                "-r",
                `gs://${config.storage.bucket}/`,
            ]);
            const gcsFiles = new Set(
                gcsListResult
                    .split("\n")
                    .filter((line) => line.startsWith("gs://"))
                    .map((line) =>
                        line.replace(`gs://${config.storage.bucket}/`, ""),
                    ),
            );

            const missing = localFiles.filter((f) => !gcsFiles.has(f));

            if (missing.length > 0) {
                log.warn(
                    { count: missing.length },
                    "Files missing after bulk upload, retrying individually",
                );
                for (const file of missing) {
                    const localPath = join(assetsDir, file);
                    const gcsPath = `gs://${config.storage.bucket}/${file}`;
                    runQuiet([
                        "gsutil",
                        "-h",
                        "Cache-Control:public, max-age=31536000, immutable",
                        "cp",
                        localPath,
                        gcsPath,
                    ]);
                }
                log.info(
                    { count: missing.length },
                    "Missing files uploaded successfully",
                );
            }
            break;
        }
        case "s3":
            runQuiet([
                "aws",
                "s3",
                "sync",
                assetsDir,
                `s3://${config.storage.bucket}`,
                "--cache-control",
                "public, max-age=31536000, immutable",
            ]);
            break;
        case "minio":
            // MinIO uses S3-compatible CLI. Former shell glob `${assetsDir}/*`
            // expanded in Node so each top-level entry is a discrete argv source.
            runQuiet([
                "mc",
                "cp",
                "--recursive",
                ...topLevelEntries(assetsDir),
                `minio/${config.storage.bucket}/`,
            ]);
            break;
        case "azure":
            runQuiet([
                "az",
                "storage",
                "blob",
                "upload-batch",
                "-d",
                config.storage.bucket,
                "-s",
                assetsDir,
            ]);
            break;
        default:
            throw new Error(
                `Unsupported storage provider: ${config.storage.provider}`,
            );
    }
}
