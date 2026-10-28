import type { KnativeNextConfig } from '@getknext/core';

/**
 * Deploy profile for the `fm-v1-demo` file-manager on the OKE cluster
 * (namespace `fm-v1-demo`): the default standalone build (turbopack) on Bun.
 *
 * Operator-run demo config, not a user template. Copy it over
 * `apps/file-manager/knext.config.ts` in a throwaway checkout, then:
 *
 *   knext deploy --registry ghcr.io/getknext-dev --namespace fm-v1-demo --tag <tag>
 *
 * BUILD PREREQUISITE: this app's own `build` script is `vite build` (vinext) and
 * its `next.config.ts` sets no tracing root, so a turbopack deploy needs
 * `"build": "next build"` plus `outputFileTracingRoot` and `turbopack.root` set
 * to the repo root in a throwaway checkout. Verified that the standalone image
 * then builds, but on a bun-installed workspace the traced `node_modules` lacks
 * `@getknext/core/node_modules/pino` and the container exits at boot, so the
 * live `fm-v1-demo` still runs its previous image.
 *
 * It references the Secrets already in the namespace by NAME only; no secret
 * value lives here. The in-cluster Redis is the `redis` Deployment in the same
 * namespace.
 */
const config: KnativeNextConfig = {
  name: 'file-manager',
  build: 'turbopack',
  runtime: 'bun',

  registry: 'ghcr.io/getknext-dev',
  imagePullSecrets: ['ghcr-pull'],

  cache: {
    provider: 'redis',
    url: 'redis://redis.fm-v1-demo.svc.cluster.local.:6379',
    keyPrefix: 'file-manager',
  },

  database: {
    secretRef: { name: 'fm-v1-demo-db', key: 'DATABASE_URL' },
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
    envFrom: ['fm-v1-demo-credentials'],
    envMap: {
      DEMO_BASIC_AUTH: { name: 'fm-v1-demo-auth', key: 'DEMO_BASIC_AUTH' },
    },
  },
};

export default config;
