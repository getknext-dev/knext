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

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { $ } from 'bun';
import type { KnativeNextConfig } from '../config';

const CONFIG_FILE = 'kn-next.config.ts';

async function loadConfig(): Promise<KnativeNextConfig> {
  const configPath = resolve(process.cwd(), CONFIG_FILE);

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const module = await import(configPath);
  return module.default;
}

async function cleanup() {
  console.log('🧹 kn-next cleanup\n');

  // 1. Load config
  console.log('📋 Loading configuration...');
  const config = await loadConfig();
  console.log(`   App: ${config.name}`);
  console.log(`   Storage: ${config.storage.provider} (${config.storage.bucket})\n`);

  // 2. Delete Knative service
  console.log('🗑️  Deleting Knative service...');
  try {
    await $`kubectl delete ksvc ${config.name} --ignore-not-found`.quiet();
    console.log(`   ✅ Deleted ksvc/${config.name}\n`);
  } catch (err) {
    console.log('   ⚠️  Service not found or already deleted\n');
  }

  // 3. Delete infrastructure services (if configured)
  if (config.infrastructure) {
    console.log('🗑️  Deleting infrastructure services...');
    if (config.infrastructure.postgres?.enabled) {
      await $`kubectl delete statefulset ${config.name}-postgres --ignore-not-found`.quiet();
      await $`kubectl delete svc ${config.name}-postgres --ignore-not-found`.quiet();
      await $`kubectl delete pvc -l app=${config.name}-postgres --ignore-not-found`.quiet();
      console.log('   ✅ Deleted PostgreSQL');
    }
    if (config.infrastructure.redis?.enabled) {
      await $`kubectl delete deployment ${config.name}-redis --ignore-not-found`.quiet();
      await $`kubectl delete svc ${config.name}-redis --ignore-not-found`.quiet();
      console.log('   ✅ Deleted Redis');
    }
    if (config.infrastructure.minio?.enabled) {
      await $`kubectl delete statefulset ${config.name}-minio --ignore-not-found`.quiet();
      await $`kubectl delete svc ${config.name}-minio --ignore-not-found`.quiet();
      await $`kubectl delete pvc -l app=${config.name}-minio --ignore-not-found`.quiet();
      console.log('   ✅ Deleted MinIO');
    }
    console.log('');
  }

  // 4. Clear storage bucket
  console.log('🗑️  Clearing storage bucket...');
  await clearStorage(config);
  console.log(`   ✅ Cleared ${config.storage.bucket}\n`);

  console.log('✨ Cleanup complete!');
}

async function clearStorage(config: KnativeNextConfig) {
  switch (config.storage.provider) {
    case 'gcs':
      await $`gsutil -m rm -r gs://${config.storage.bucket}/** 2>/dev/null || true`.quiet();
      break;
    case 's3':
      await $`aws s3 rm s3://${config.storage.bucket} --recursive`.quiet();
      break;
    case 'minio':
      await $`mc rm --recursive --force minio/${config.storage.bucket}`.quiet();
      break;
    case 'azure':
      await $`az storage blob delete-batch -s ${config.storage.bucket}`.quiet();
      break;
  }
}

// Run
cleanup().catch((err) => {
  console.error('❌ Cleanup failed:', err.message);
  process.exit(1);
});
