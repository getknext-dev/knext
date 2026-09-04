import type { NextConfig } from 'next';

// The CONTROL arm's config. `output: 'standalone'` is what makes the node arm a
// self-contained server directory, mirroring what the bun arm gets from
// `--compile`: one shippable artifact, no `next start` wrapper.
const config: NextConfig = {
  // Pin BUILD_ID to the deploy tag (ADR-0011 skew protection). `kn-next deploy`
  // exports NEXT_DEPLOYMENT_ID before the build; without this the build id is a
  // random one, so the uploaded `_next/static/<id>/` prefix does not match the
  // tag the retention GC prunes by. `deploy` now refuses rather than shipping
  // that mismatch, so this line is what keeps the example deployable. `|| null`
  // (not `??`) so an empty NEXT_DEPLOYMENT_ID falls back to Next's own id
  // instead of becoming the build id `''`.
  generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null,
  output: 'standalone',
};
export default config;
