import type { KnativeNextConfig } from '@kn-next/config';

const config: KnativeNextConfig = {
  name: 'file-manager',

  // Object storage for static assets
  storage: {
    provider: 'gcs',
    bucket: 'knative-next-assets-banna',
    region: 'us-east-1',
    publicUrl: 'https://storage.googleapis.com/knative-next-assets-banna',
  },

  // Cache adapter for data cache & ISR
  cache: {
    provider: 'redis',
    url: process.env.REDIS_URL || 'redis://redis.default.svc.cluster.local:6379',
    keyPrefix: 'file-manager',
  },

  // Container registry
  registry: 'us-central1-docker.pkg.dev/gsw-mcp/knative-next-repo',

  // Infrastructure services (deployed by CLI)
  infrastructure: {
    postgres: { enabled: true },
  },

  // Knative autoscaling
  scaling: {
    minScale: 0, // changed to test bytecode cache
    maxScale: 2, // Scale up to 2 pods max
  },

  // V8 bytecode caching for faster cold starts
  bytecodeCache: {
    enabled: true,
  },

  // Observability (Prometheus metrics + Grafana dashboards)
  observability: {
    enabled: true,
  },
};

export default config;
