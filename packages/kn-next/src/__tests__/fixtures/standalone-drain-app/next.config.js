/**
 * Minimal standalone fixture for standalone-drain.docker-e2e.test.ts.
 *
 * `output: 'standalone'` is the shape the ADR-0055 image supervises. The
 * type/lint bypasses keep the e2e's `next build` to a few seconds of compile
 * rather than a full project typecheck — the fixture's correctness is proved by
 * the container actually serving and draining, not by tsc.
 */
module.exports = {
  output: 'standalone',
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
