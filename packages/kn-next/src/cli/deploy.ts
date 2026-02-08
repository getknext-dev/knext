#!/usr/bin/env bun
/**
 * kn-next CLI - Knative Next.js Deployment Automation
 *
 * Usage:
 *   npx kn-next deploy [options]
 *
 * Options:
 *   --registry <url>     Override container registry
 *   --bucket <name>      Override storage bucket
 *   --tag <tag>          Override image tag (default: timestamp)
 *   --namespace <ns>     Kubernetes namespace (default: default)
 *   --skip-build         Skip Next.js and OpenNext build
 *   --skip-upload        Skip asset upload to storage
 *   --skip-infra         Skip infrastructure deployment
 *   --dry-run            Generate manifests without deploying
 *   --help               Show help
 *
 * Environment Variables (for CI/CD):
 *   KN_REGISTRY          Container registry URL
 *   KN_BUCKET            Storage bucket name
 *   KN_IMAGE_TAG         Docker image tag
 *   KN_NAMESPACE         Kubernetes namespace
 *   KN_REDIS_URL         Redis connection URL (overrides config)
 *   KN_DATABASE_URL      Database connection URL (overrides config)
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { $ } from 'bun';
import type { KnativeNextConfig } from '../config';
import { generateInfrastructure } from '../generators/infrastructure';
import { generateEntrypoint, generateKnativeManifest } from '../generators/knative-manifest';
import { uploadAssets } from '../utils/asset-upload';

const CONFIG_FILE = 'kn-next.config.ts';

interface DeployOptions {
  registry?: string;
  bucket?: string;
  tag?: string;
  namespace: string;
  skipBuild: boolean;
  skipUpload: boolean;
  skipInfra: boolean;
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
      'skip-infra': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
kn-next deploy - Deploy Next.js to Knative

USAGE:
  npx kn-next deploy [options]

OPTIONS:
  -r, --registry <url>   Override container registry
  -b, --bucket <name>    Override storage bucket  
  -t, --tag <tag>        Image tag (default: timestamp)
  -n, --namespace <ns>   Kubernetes namespace (default: default)
  --skip-build           Skip Next.js/OpenNext build
  --skip-upload          Skip asset upload
  --skip-infra           Skip infrastructure deployment
  --dry-run              Generate manifests only

ENVIRONMENT VARIABLES:
  KN_REGISTRY            Container registry URL
  KN_BUCKET              Storage bucket name
  KN_IMAGE_TAG           Docker image tag
  KN_NAMESPACE           Kubernetes namespace
  KN_REDIS_URL           Redis connection URL
  KN_DATABASE_URL        Database connection URL

EXAMPLES:
  # Deploy with defaults from config
  npx kn-next deploy

  # Deploy to production with specific tag
  npx kn-next deploy --tag v1.2.3 --namespace production

  # CI/CD: Use environment variables
  KN_REGISTRY=gcr.io/prod KN_IMAGE_TAG=\${CI_COMMIT_SHA} npx kn-next deploy

  # Preview manifest without deploying
  npx kn-next deploy --dry-run
`);
    process.exit(0);
  }

  return {
    registry: values.registry || process.env.KN_REGISTRY,
    bucket: values.bucket || process.env.KN_BUCKET,
    tag: values.tag || process.env.KN_IMAGE_TAG,
    namespace: values.namespace || process.env.KN_NAMESPACE || 'default',
    skipBuild: values['skip-build'] ?? false,
    skipUpload: values['skip-upload'] ?? false,
    skipInfra: values['skip-infra'] ?? false,
    dryRun: values['dry-run'] ?? false,
  };
}

async function loadConfig(): Promise<KnativeNextConfig> {
  const configPath = resolve(process.cwd(), CONFIG_FILE);

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const module = await import(configPath);
  return module.default;
}

function applyOverrides(
  config: KnativeNextConfig,
  options: DeployOptions
): KnativeNextConfig {
  const overridden = { ...config };

  // Apply CLI/env overrides
  if (options.registry) {
    overridden.registry = options.registry;
  }
  if (options.bucket) {
    overridden.storage = { ...overridden.storage, bucket: options.bucket };
  }

  // Apply Redis URL override from environment
  if (process.env.KN_REDIS_URL && overridden.cache?.provider === 'redis') {
    overridden.cache = { ...overridden.cache, url: process.env.KN_REDIS_URL };
  }

  return overridden;
}

async function deploy() {
  const options = parseCliArgs();

  console.log('🚀 kn-next deploy\n');

  if (options.dryRun) {
    console.log('⚠️  DRY RUN MODE - No actual deployment\n');
  }

  // 1. Load and merge config
  console.log('📋 Loading configuration...');
  const baseConfig = await loadConfig();
  const config = applyOverrides(baseConfig, options);

  console.log(`   App: ${config.name}`);
  console.log(`   Storage: ${config.storage.provider} (${config.storage.bucket})`);
  console.log(`   Registry: ${config.registry}`);
  console.log(`   Namespace: ${options.namespace}`);
  if (options.skipBuild) console.log('   ⏭️  Skipping build');
  if (options.skipUpload) console.log('   ⏭️  Skipping upload');
  if (options.skipInfra) console.log('   ⏭️  Skipping infrastructure');
  console.log('');

  // 2. Build Next.js (unless skipped)
  if (!options.skipBuild) {
    console.log('📦 Building Next.js...');
    await $`npm run build`.quiet();
    console.log('   ✅ Next.js build complete\n');

    // 3. Build OpenNext
    console.log('⚡ Building OpenNext...');
    await $`npx open-next build`.quiet();
    console.log('   ✅ OpenNext build complete\n');
  }

  // 4. PARALLEL: Asset upload + Docker build/push
  const imageTag = options.tag || `${Date.now()}`;
  const imageName = `${config.registry}/${config.name}:${imageTag}`;

  console.log(`📌 Image: ${imageName}\n`);

  // Generate entrypoint.sh for bytecode cache PVC permissions fix
  if (config.bytecodeCache?.enabled) {
    const outputDir = join(process.cwd(), '.open-next', 'server-functions', 'default');
    generateEntrypoint({ config, outputDir });
  }

  if (!options.dryRun) {
    const tasks: Promise<void>[] = [];

    // Asset upload (unless skipped)
    if (!options.skipUpload) {
      console.log('🔀 Running in parallel:');
      console.log(`   - Uploading assets to ${config.storage.provider}`);
      tasks.push(
        (async () => {
          await uploadAssets(config);
          console.log('   ✅ Assets uploaded');
        })()
      );
    }

    // Docker build + push
    console.log('   - Building & pushing Docker image\n');
    tasks.push(
      (async () => {
        const repoRoot = resolve(process.cwd(), '../..');
        await $`docker buildx build --platform linux/amd64 -f ${process.cwd()}/Dockerfile -t ${imageName} --push ${repoRoot}`.quiet();
        console.log('   ✅ Docker image built and pushed');
      })()
    );

    await Promise.all(tasks);
    console.log('');
  }

  // 5. Deploy infrastructure & observability (unless skipped)
  let infraEnvVars: Record<string, string> = {};
  const hasInfra = config.infrastructure || config.observability?.enabled;
  if (hasInfra && !options.skipInfra && !options.dryRun) {
    console.log('🏗️  Deploying infrastructure services...');
    const outputDir = join(process.cwd(), '.open-next');
    const { manifests, envVars } = generateInfrastructure(config, outputDir);
    infraEnvVars = envVars;

    for (const manifest of manifests) {
      await $`kubectl apply -f ${manifest} -n ${options.namespace}`;
    }

    if (config.observability?.enabled) {
      console.log('   📊 Observability: ServiceMonitor + Grafana dashboard deployed');
    }
    console.log('   ✅ Infrastructure deployed\n');

    // Wait for services to be ready
    if (config.infrastructure?.postgres?.enabled) {
      console.log('   Waiting for PostgreSQL...');
      await $`kubectl wait --for=condition=ready pod -l app=${config.name}-postgres -n ${options.namespace} --timeout=120s`.quiet();
    }
    if (config.infrastructure?.redis?.enabled) {
      console.log('   Waiting for Redis...');
      await $`kubectl wait --for=condition=ready pod -l app=${config.name}-redis -n ${options.namespace} --timeout=60s`.quiet();
    }
    if (config.infrastructure?.minio?.enabled) {
      console.log('   Waiting for MinIO...');
      await $`kubectl wait --for=condition=ready pod -l app=${config.name}-minio -n ${options.namespace} --timeout=120s`.quiet();
    }
    console.log('   ✅ Infrastructure ready\n');
  }

  // Inject DATABASE_URL from environment if provided
  if (process.env.KN_DATABASE_URL) {
    infraEnvVars.DATABASE_URL = process.env.KN_DATABASE_URL;
  }

  // 6. Generate and deploy Knative manifest
  console.log('🌐 Generating Knative manifest...');
  const outputDir = join(process.cwd(), '.open-next');
  generateKnativeManifest({
    config,
    outputDir,
    imageTag,
    namespace: options.namespace,
    additionalEnvVars: infraEnvVars,
  });
  const manifestPath = join(outputDir, 'knative-service.yaml');
  console.log(`   📄 Manifest: ${manifestPath}`);

  if (!options.dryRun) {
    console.log('   Applying to cluster...');
    await $`kubectl apply -f ${manifestPath} -n ${options.namespace}`;

    // Get service URL
    const result =
      await $`kubectl get ksvc ${config.name} -n ${options.namespace} -o jsonpath='{.status.url}'`.text();

    console.log('\n✨ Deployment complete!');
    console.log(`🔗 URL: ${result.replace(/'/g, '')}`);
  } else {
    console.log('\n✅ Dry run complete - manifest generated');
    console.log(`   View: cat ${manifestPath}`);
  }
}

// Run
deploy().catch((err) => {
  console.error('❌ Deployment failed:', err.message);
  process.exit(1);
});
