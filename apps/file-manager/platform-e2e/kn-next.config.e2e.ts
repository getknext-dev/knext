import type { KnativeNextConfig } from '@getknext/core';

/**
 * The file-manager config PROFILE for the nightly platform e2e (#1282).
 *
 * The nightly copies this over `apps/file-manager/kn-next.config.ts` inside the
 * runner's throwaway checkout, then runs the real `kn-next deploy`. The
 * committed config names a GCS bucket and a GCP registry, and neither exists
 * on an ephemeral kind cluster.
 *
 * It differs from the real config in EXACTLY these keys, and
 * `platform-e2e.test.ts` fails if any other key drifts from it:
 *   - `storage`   — dropped. This is image-served static mode (ADR-0047), which
 *                   is what the image actually serves today. The storage-mode
 *                   asset prefix is tracked separately (#1283).
 *   - `registry`  — the in-cluster registry the kind node pulls from.
 *   - `cache.url` — the in-cluster Redis.
 *   - `database`  — binds the in-cluster Postgres through a K8s Secret (the
 *                   app's `/`, `/users`, `/audit` and `/dashboard` read it).
 */
const config: KnativeNextConfig = {
  name: 'file-manager',

  cache: {
    provider: 'redis',
    url: process.env.KN_REDIS_URL || 'redis://redis.fm-e2e.svc.cluster.local:6379',
    keyPrefix: 'file-manager',
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
