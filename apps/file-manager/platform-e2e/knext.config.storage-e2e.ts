import type { KnativeNextConfig } from '@getknext/core';

/**
 * Object-storage-mode profile for the storage leg of the nightly platform e2e
 * (#1292, follow-up to #1283/#1291).
 *
 * The nightly copies this over `apps/file-manager/kn-next.config.ts` (same
 * mechanism `kn-next.config.e2e.ts` already uses) AFTER the image-served leg
 * has finished with it, then runs a SECOND real `kn-next deploy`. This
 * deploys a distinct NextApp (`file-manager-storage`) against the SAME
 * in-cluster MinIO the image-served leg's upload check already uses, with
 * `storage` configured — proving `ASSET_PREFIX`/`NEXT_DEPLOYMENT_ID`
 * build-arg threading (#1291) end to end, on a live cluster, not just against
 * a built image.
 *
 * `provider: 's3'` (not `'minio'`) deliberately: `asset-upload.ts`'s `minio`
 * provider shells out to the `mc` CLI, which is not installed (or
 * supply-chain pinned) on the runner. AWS CLI v2 IS preinstalled on
 * `ubuntu-latest` and honours `AWS_ENDPOINT_URL`, so the `s3` provider
 * reaches the SAME MinIO over its S3-compatible API with no new dependency.
 * MinIO does not care which client talks to it — the object-storage-mode
 * behaviour under test (ASSET_PREFIX wiring, build-id lock-step, served
 * content) is provider-agnostic. Exercising the `mc`-based `minio` provider
 * itself is a deferred follow-up (needs a pinned `mc` artifact).
 *
 * Differs from `kn-next.config.e2e.ts` (the image-served profile) in EXACTLY:
 *   - `name`    — a distinct NextApp so both legs' resources coexist.
 *   - `storage` — present here, dropped there (that profile documents why).
 *   - `cache.keyPrefix` — distinct, so the two apps' Redis entries never collide.
 * Everything else matches so this leg still exercises the same app.
 */
const config: KnativeNextConfig = {
  name: 'file-manager-storage',

  // build: 'vinext' EXPLICIT — shared with the real config, see its comment.
  build: 'vinext',

  storage: {
    provider: 's3',
    bucket: 'fm-e2e-storage-assets',
    region: 'us-east-1',
    // Cluster-internal DNS: what the SERVED HTML embeds. The leg re-bases
    // each extracted URL's path onto MINIO_LOCAL_ENDPOINT to reach the same
    // object from the runner — see storage-mode-e2e.mjs.
    publicUrl: `http://minio.${process.env.KN_APP_NAMESPACE ?? 'fm-e2e'}.svc.cluster.local:9000/fm-e2e-storage-assets`,
  },

  cache: {
    provider: 'redis',
    url: process.env.KN_REDIS_URL || 'redis://redis.fm-e2e.svc.cluster.local.:6379',
    keyPrefix: 'file-manager-storage',
  },

  registry: 'localhost:5001',

  database: {
    secretRef: { name: 'fm-e2e-db', key: 'DATABASE_URL' },
  },

  infrastructure: {
    postgres: { enabled: true },
    redis: { enabled: true },
  },

  scaling: {
    minScale: 0,
    maxScale: 2,
    memoryRequest: '256Mi',
    memoryLimit: '512Mi',
  },

  observability: {
    enabled: true,
  },

  secrets: {
    envFrom: ['file-manager-credentials'],
    envMap: {
      API_TOKEN: { name: 'global-tokens', key: 'file_manager_token' },
    },
  },
};

export default config;
