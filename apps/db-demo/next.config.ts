import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pin BUILD_ID to the deploy tag (ADR-0011 skew protection). `kn-next deploy`
  // exports KNEXT_BUILD_ID before the build; without this the build id is a
  // random one, so the uploaded `_next/static/<id>/` prefix does not match the
  // tag the retention GC prunes by and the "just-deployed build is protected"
  // guarantee silently fails. `deploy` now refuses rather than shipping that,
  // so this line is what keeps the app deployable. `|| null` (not `??`) so an
  // empty value falls back instead of becoming the id `''`. No `deploymentId`:
  // on Next 16.2.11+ it makes Next ignore generateBuildId.
  generateBuildId: () => process.env.KNEXT_BUILD_ID || process.env.NEXT_DEPLOYMENT_ID || null,
  // Standalone output is what `kn-next deploy` packages into the app image.
  output: 'standalone',
};

export default nextConfig;
