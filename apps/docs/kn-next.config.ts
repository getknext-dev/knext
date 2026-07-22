import type { KnativeNextConfig } from '@knext/core';

/**
 * kn-next deploy config for the knext docs site (dogfood target, issue #55).
 *
 * Minimal-valid per packages/kn-next/src/cli/validate.ts:
 *   required: name, registry, storage.provider, storage.bucket
 *   storage.provider MUST be one of: "gcs" | "s3" | "minio" | "azure"
 *     (each shells out to that cloud's CLI: gsutil | aws | mc | az)
 *   scaling.minScale >= 0  → set to 0 here for true scale-to-zero.
 *
 * No `cache` block: the docs site is static and needs neither Redis nor an ISR
 * data cache, so it does not enable the Redis cache handler or the bytecode-cache
 * PVC. (Bytecode caching can still be enabled later via the operator if desired.)
 */
const config: KnativeNextConfig = {
  name: 'knext-docs',
  registry: 'registry.example.com/knext-docs',
  storage: {
    provider: 'gcs',
    bucket: 'knext-docs-assets',
    publicUrl: 'https://storage.googleapis.com/knext-docs-assets',
  },
  scaling: {
    minScale: 0, // scale to zero when idle
    maxScale: 5,
  },
};

export default config;
