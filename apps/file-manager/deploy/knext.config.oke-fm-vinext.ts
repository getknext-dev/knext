import type { KnativeNextConfig } from '@getknext/core';

/**
 * Deploy profile for the `fm-vinext` file-manager on the OKE cluster
 * (namespace `fm-vinext`): the vinext single-executable build.
 *
 * Operator-run demo config, not a user template. Copy it over
 * `apps/file-manager/knext.config.ts` in a throwaway checkout, then:
 *
 *   knext deploy --registry ghcr.io/getknext-dev --namespace fm-vinext --tag <tag>
 *
 * It references the Secrets already in the namespace by NAME only; no secret
 * value lives here. The in-cluster Redis is the `redis` Deployment in the same
 * namespace.
 */
const config: KnativeNextConfig = {
  name: 'file-manager',
  build: 'vinext',

  registry: 'ghcr.io/getknext-dev',
  imagePullSecrets: ['ghcr-bench'],

  cache: {
    provider: 'redis',
    url: 'redis://redis.fm-vinext.svc.cluster.local.:6379',
    keyPrefix: 'file-manager',
  },

  database: {
    secretRef: { name: 'fm-e2e-db', key: 'DATABASE_URL' },
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
