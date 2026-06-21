#!/usr/bin/env bun
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

import { $ } from "bun";
import type { KnativeNextConfig } from "../config";
import { createLogger } from "../utils/logger";
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
        await $`kubectl delete ksvc ${config.name} --ignore-not-found`.quiet();
        log.info({ service: config.name }, "Deleted Knative service");
    } catch (_err) {
        log.warn("Service not found or already deleted");
    }

    // 3. Delete infrastructure services (if configured)
    if (config.infrastructure) {
        log.info("Deleting infrastructure services...");
        if (config.infrastructure.postgres?.enabled) {
            await $`kubectl delete statefulset ${config.name}-postgres --ignore-not-found`.quiet();
            await $`kubectl delete svc ${config.name}-postgres --ignore-not-found`.quiet();
            await $`kubectl delete pvc -l app=${config.name}-postgres --ignore-not-found`.quiet();
            log.info("Deleted PostgreSQL");
        }
        if (config.infrastructure.redis?.enabled) {
            await $`kubectl delete deployment ${config.name}-redis --ignore-not-found`.quiet();
            await $`kubectl delete svc ${config.name}-redis --ignore-not-found`.quiet();
            log.info("Deleted Redis");
        }
        if (config.infrastructure.minio?.enabled) {
            await $`kubectl delete statefulset ${config.name}-minio --ignore-not-found`.quiet();
            await $`kubectl delete svc ${config.name}-minio --ignore-not-found`.quiet();
            await $`kubectl delete pvc -l app=${config.name}-minio --ignore-not-found`.quiet();
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
            await $`gsutil -m rm -r gs://${config.storage.bucket}/** 2>/dev/null || true`.quiet();
            break;
        case "s3":
            await $`aws s3 rm s3://${config.storage.bucket} --recursive`.quiet();
            break;
        case "minio":
            await $`mc rm --recursive --force minio/${config.storage.bucket}`.quiet();
            break;
        case "azure":
            await $`az storage blob delete-batch -s ${config.storage.bucket}`.quiet();
            break;
    }
}

// Run
try {
    await cleanup();
} catch (err) {
    log.fatal({ err }, "Cleanup failed");
    process.exit(1);
}
