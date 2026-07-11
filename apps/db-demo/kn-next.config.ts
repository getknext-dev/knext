import type { KnativeNextConfig } from '@knext/core';

/**
 * Minimal NextApp config for db-demo. The database is NOT configured here —
 * it is bound at deploy time with `kn-next db bind` (ADR-0019), which sets
 * `spec.database.secretRef` (BYO) or `spec.database.enabled` (managed) so the
 * operator injects `DATABASE_URL` (+ optional `DATABASE_URL_RO`) into the app.
 * See README.md for the bind + migrate flow.
 */
const config: KnativeNextConfig = {
  name: 'db-demo',
  registry: 'us-central1-docker.pkg.dev/gsw-mcp/knative-next-repo',
  storage: {
    provider: 'minio',
    bucket: 'db-demo-assets',
    region: 'us-east-1',
    endpoint: 'http://minio.default.svc.cluster.local:9000',
    publicUrl: 'http://minio.default.svc.cluster.local:9000/db-demo-assets',
  },
  scaling: {
    minScale: 0, // scale-to-zero — the whole point of the demo
    maxScale: 2,
    memoryRequest: '256Mi',
    memoryLimit: '512Mi',
  },
};

export default config;
