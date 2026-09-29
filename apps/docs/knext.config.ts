import type { KnativeNextConfig } from '@getknext/core';

/**
 * kn-next deploy config for the knext docs site — the dogfood target.
 *
 * CI (`.github/workflows/docs-deploy-oke.yml`) deploys this app to the OKE
 * cluster with `kn-next deploy` → NextApp CR → operator. Nothing else writes
 * the cluster: the operator renders the Knative Service, named after `name`
 * below, which is what `deploy/oke/domainmapping.yaml` points at. Renaming
 * the app therefore orphans the custom domains — change both together.
 *
 * No `storage` block (ADR-0047 no-storage mode): the image serves its own
 * static assets. The docs deploy also passes `--skip-upload`, so it needs no
 * cloud-storage credential at all. Add a storage block once an object-storage
 * bucket exists for OKE.
 *
 * No `cache` block: the docs site is static and needs neither Redis nor an ISR
 * data cache.
 */
const config: KnativeNextConfig = {
  name: 'knext-docs',
  // build: 'vinext' EXPLICIT — this site's build script runs `vite build`, so
  // it does not want knext's default builder (`turbopack`/`next build`). The
  // image is the app's own `Dockerfile` (vinext `.output` run under Bun).
  build: 'vinext',
  // OCIR namespace. The CLI appends the app name, so the image lands in the
  // PUBLIC `knext-docs` repository — the cluster pulls without a pull secret.
  registry: 'me-abudhabi-1.ocir.io/axfqznklsd2t',
  scaling: {
    // Scale to zero when idle — the product's default. The hand-applied
    // Knative Service this replaces pinned min-scale 1 ("keep warm"); a cold
    // docs hit now pays one cold start instead of holding a pod forever.
    minScale: 0,
    maxScale: 5,
    // Matches the hand-applied Knative Service this replaces.
    cpuRequest: '100m',
    memoryRequest: '256Mi',
    cpuLimit: '1',
    memoryLimit: '768Mi',
  },
};

export default config;
