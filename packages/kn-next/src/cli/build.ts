#!/usr/bin/env bun
/**
 * kn-next build — Prepares Next.js app for Knative deployment.
 *
 * Usage:
 *   bun run packages/kn-next/src/cli/build.ts
 *
 * Steps:
 *   1. Load kn-next.config.ts (with validation)
 *   2. Run `next build` (output:'standalone' set in the app's next.config.ts)
 *   3. Upload static assets to storage (GCS/S3/MinIO)
 *   4. Generate knative-service.yaml
 *
 * NOTE: The Vinext/Nitro build orchestration was removed in the official
 * Next.js Adapter migration. The CLI now delegates to the project's
 * `npm run build` script which runs `next build` with output:'standalone'.
 */

import { join } from 'node:path';
import { $ } from 'bun';
import { generateKnativeManifest } from '../generators/knative-manifest';
import { uploadAssets } from '../utils/asset-upload';
import { createLogger } from '../utils/logger';
import { loadConfig } from './shared';

const log = createLogger({ module: 'build' });

interface BuildOptions {
  enableKafkaQueue?: boolean;
  skipNextBuild?: boolean;
}

export async function build(options: BuildOptions = {}) {
  log.info('🔨 kn-next build (Next.js official adapter + standalone)');

  const workDir = process.cwd();
  const outputDir = join(workDir, '.output');

  // 1. Load config (validates at load time)
  log.info('Loading configuration...');
  const config = await loadConfig();
  log.info(
    {
      app: config.name,
      storage: `${config.storage.provider} (${config.storage.bucket})`,
      cache: config.cache?.provider ?? 'none',
      runtime: config.runtime ?? 'node',
    },
    'Configuration loaded',
  );

  // 2. Run `next build` via the project's build script.
  //    The app's next.config.ts must set output:'standalone'.
  if (!options.skipNextBuild) {
    log.info('Running next build (output:standalone)...');
    await $`npm run build`.quiet();
    log.info('Next.js build complete — standalone output in .next/standalone/');
  }

  // 3. Upload static assets
  log.info('Uploading static assets...');
  await uploadAssets(config);
  log.info('Assets uploaded');

  // 4. Generate Knative manifest
  log.info('Generating Knative manifest...');
  generateKnativeManifest({
    config,
    outputDir,
    enableKafkaQueue: options.enableKafkaQueue,
  });

  log.info(
    {
      output: outputDir,
      manifest: join(outputDir, 'knative-service.yaml'),
    },
    '✨ Build complete!',
  );
}

// Run if executed directly
if (import.meta.main) {
  try {
    await build({
      enableKafkaQueue: process.argv.includes('--no-kafka') ? false : undefined,
      skipNextBuild: process.argv.includes('--skip-next'),
    });
  } catch (err) {
    log.fatal({ err }, 'Build failed');
    process.exit(1);
  }
}
