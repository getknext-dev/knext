#!/usr/bin/env node

/**
 * kn-next cleanup - Removes Knative services and clears storage
 *
 * Usage:
 *   bun run packages/kn-next/src/cli/cleanup.ts
 *
 * Steps:
 *   1. Load kn-next.config.ts
 *   2. Delete Knative service
 *   3. Clear storage bucket
 */

import type { KnativeNextConfig } from "../config";
import { createLogger } from "../utils/logger";
import { isEntrypoint, runQuiet, runQuietAllowFail } from "./exec";
// Single source of truth for config loading — also runs validateConfig,
// which cleanup's former private copy skipped (CONFIG-LOAD-DEDUP).
import { loadConfig } from "./shared";

const log = createLogger({ module: "cleanup" });

async function cleanup() {
    log.info("🧹 kn-next cleanup");

    // 1. Load config
    log.info("Loading configuration...");
    const config = await loadConfig();
    log.info(
        {
            app: config.name,
            storage: `${config.storage.provider} (${config.storage.bucket})`,
        },
        "Configuration loaded",
    );

    // 2. Delete Knative service
    log.info("Deleting Knative service...");
    try {
        runQuiet([
            "kubectl",
            "delete",
            "ksvc",
            config.name,
            "--ignore-not-found",
        ]);
        log.info({ service: config.name }, "Deleted Knative service");
    } catch (_err) {
        log.warn("Service not found or already deleted");
    }

    // 3. Delete infrastructure services (if configured)
    if (config.infrastructure) {
        log.info("Deleting infrastructure services...");
        if (config.infrastructure.postgres?.enabled) {
            const pg = `${config.name}-postgres`;
            runQuiet([
                "kubectl",
                "delete",
                "statefulset",
                pg,
                "--ignore-not-found",
            ]);
            runQuiet(["kubectl", "delete", "svc", pg, "--ignore-not-found"]);
            runQuiet([
                "kubectl",
                "delete",
                "pvc",
                "-l",
                `app=${pg}`,
                "--ignore-not-found",
            ]);
            log.info("Deleted PostgreSQL");
        }
        if (config.infrastructure.redis?.enabled) {
            const redis = `${config.name}-redis`;
            runQuiet([
                "kubectl",
                "delete",
                "deployment",
                redis,
                "--ignore-not-found",
            ]);
            runQuiet(["kubectl", "delete", "svc", redis, "--ignore-not-found"]);
            log.info("Deleted Redis");
        }
        if (config.infrastructure.minio?.enabled) {
            const minio = `${config.name}-minio`;
            runQuiet([
                "kubectl",
                "delete",
                "statefulset",
                minio,
                "--ignore-not-found",
            ]);
            runQuiet(["kubectl", "delete", "svc", minio, "--ignore-not-found"]);
            runQuiet([
                "kubectl",
                "delete",
                "pvc",
                "-l",
                `app=${minio}`,
                "--ignore-not-found",
            ]);
            log.info("Deleted MinIO");
        }
    }

    // 4. Clear storage bucket
    log.info("Clearing storage bucket...");
    await clearStorage(config);
    log.info({ bucket: config.storage.bucket }, "Storage bucket cleared");

    log.info("✨ Cleanup complete!");
}

async function clearStorage(config: KnativeNextConfig) {
    switch (config.storage.provider) {
        case "gcs":
            // gsutil expands the `**` wildcard itself (single argv token).
            // Tolerate a non-zero exit (empty bucket) — the old `|| true` idiom.
            runQuietAllowFail([
                "gsutil",
                "-m",
                "rm",
                "-r",
                `gs://${config.storage.bucket}/**`,
            ]);
            break;
        case "s3":
            runQuiet([
                "aws",
                "s3",
                "rm",
                `s3://${config.storage.bucket}`,
                "--recursive",
            ]);
            break;
        case "minio":
            runQuiet([
                "mc",
                "rm",
                "--recursive",
                "--force",
                `minio/${config.storage.bucket}`,
            ]);
            break;
        case "azure":
            runQuiet([
                "az",
                "storage",
                "blob",
                "delete-batch",
                "-s",
                config.storage.bucket,
            ]);
            break;
    }
}

// Run only when invoked directly as the entry (not when imported, e.g. in tests).
if (isEntrypoint(import.meta.url)) {
    try {
        await cleanup();
    } catch (err) {
        log.fatal({ err }, "Cleanup failed");
        process.exit(1);
    }
}
