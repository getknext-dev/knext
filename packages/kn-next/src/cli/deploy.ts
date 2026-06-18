#!/usr/bin/env bun
/**
 * kn-next CLI — Knative Next.js Deployment Automation
 *
 * Usage:
 *   npx kn-next deploy [options]
 *
 * ADR-0001: The operator is the single source of truth for cluster state.
 * This CLI's job is strictly: build → push → apply the NextApp CR.
 *
 * What was removed (A1-cli):
 * - kubectl apply of raw Knative Service manifests (was deploy.ts:176)
 * - kubectl apply of infrastructure manifests (was deploy.ts:153)
 * - generateKnativeManifest / generateInfrastructure calls
 *
 * The operator reconciles everything from the NextApp CR.
 */

import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { $ } from 'bun';
import type { KnativeNextConfig } from '../config';
import { getAssetPrefix, uploadAssets } from '../utils/asset-upload';
import { createLogger } from '../utils/logger';
import { renderNextAppCR } from './cr-builder';
import { loadConfig } from './shared';

const log = createLogger({ module: 'deploy' });

interface DeployOptions {
  registry?: string;
  bucket?: string;
  tag?: string;
  namespace: string;
  skipBuild: boolean;
  skipUpload: boolean;
  dryRun: boolean;
}

function parseCliArgs(): DeployOptions {
  const { values } = parseArgs({
    options: {
      registry: { type: 'string', short: 'r' },
      bucket: { type: 'string', short: 'b' },
      tag: { type: 'string', short: 't' },
      namespace: { type: 'string', short: 'n', default: 'default' },
      'skip-build': { type: 'boolean', default: false },
      'skip-upload': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    log.info(
      [
        'kn-next deploy — build → push → apply NextApp CR',
        '',
        'Options:',
        '  -r, --registry  Container registry (overrides config)',
        '  -b, --bucket    Storage bucket (overrides config)',
        '  -t, --tag       Image tag (default: timestamp)',
        '  -n, --namespace Kubernetes namespace (default: default)',
        '  --skip-build    Skip next build step',
        '  --skip-upload   Skip asset upload step',
        '  --dry-run       Print the NextApp CR without applying it',
        '  -h, --help      Show this help',
      ].join('\n'),
    );
    process.exit(0);
  }

  return {
    registry: values.registry || process.env.KN_REGISTRY,
    bucket: values.bucket || process.env.KN_BUCKET,
    tag: values.tag || process.env.KN_IMAGE_TAG,
    namespace: values.namespace || process.env.KN_NAMESPACE || 'default',
    skipBuild: values['skip-build'] ?? false,
    skipUpload: values['skip-upload'] ?? false,
    dryRun: values['dry-run'] ?? false,
  };
}

function applyOverrides(config: KnativeNextConfig, options: DeployOptions): KnativeNextConfig {
  const overridden = { ...config };

  if (options.registry) {
    overridden.registry = options.registry;
  }
  if (options.bucket) {
    overridden.storage = { ...overridden.storage, bucket: options.bucket };
  }

  if (process.env.KN_REDIS_URL && overridden.cache?.provider === 'redis') {
    overridden.cache = {
      ...overridden.cache,
      url: process.env.KN_REDIS_URL,
    };
  }

  return overridden;
}

async function deploy() {
  const options = parseCliArgs();

  log.info({ dryRun: options.dryRun }, 'kn-next deploy');

  // Load config with validation
  const baseConfig = await loadConfig();
  const config = applyOverrides(baseConfig, options);

  if (!options.skipBuild) {
    const assetPrefix = getAssetPrefix(config.storage);
    process.env.ASSET_PREFIX = assetPrefix;
    log.info({ assetPrefix }, 'Running next build (output:standalone)...');
    await $`npm run build`.quiet();
    log.info('Next.js build complete — standalone output in .next/standalone/');
  }

  const imageTag = options.tag || `${Date.now()}`;
  const imageName = `${config.registry}/${config.name}:${imageTag}`;

  log.info({ image: imageName }, 'Image tag resolved');

  if (!options.dryRun) {
    const tasks: Promise<void>[] = [];

    if (!options.skipUpload) {
      log.info('Running parallel tasks: asset upload + Docker build');
      tasks.push(
        (async () => {
          await uploadAssets(config);
          log.info('Assets uploaded');
        })(),
      );
    }

    log.info('Building & pushing Docker image');
    tasks.push(
      (async () => {
        const repoRoot = resolve(process.cwd(), '../..');
        await $`docker buildx build --platform linux/amd64 -f ${process.cwd()}/Dockerfile -t ${imageName} --push ${repoRoot}`;
        log.info('Docker image built and pushed');
      })(),
    );

    await Promise.all(tasks);
  }

  // Render the NextApp CR from config + resolved image.
  // The operator reconciles all cluster resources from this CR.
  const crYaml = renderNextAppCR(config, imageName, options.namespace);
  const crPath = join(process.cwd(), '.output', 'nextapp-cr.yaml');

  if (options.dryRun) {
    log.info('Dry run — NextApp CR (not applied):');
    // Print to stdout so callers can capture or display it
    process.stdout.write(crYaml);
    log.info('Dry run complete — no cluster changes made');
    return;
  }

  // Write CR to .output/ and apply it — only CR apply, operator handles the rest.
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(process.cwd(), '.output'), { recursive: true });
  writeFileSync(crPath, crYaml, 'utf-8');

  log.info({ cr: crPath }, 'Applying NextApp CR to cluster...');
  await $`kubectl apply -f ${crPath} -n ${options.namespace}`;

  // Wait briefly for the operator to begin reconciling, then read the URL.
  const result =
    await $`kubectl get nextapp ${config.name} -n ${options.namespace} -o jsonpath='{.status.url}'`.text();
  log.info({ url: result.replace(/'/g, '') }, 'Deployment submitted — operator is reconciling');
}

try {
  await deploy();
} catch (err) {
  log.fatal({ err }, 'Deployment failed');
  process.exit(1);
}
