/**
 * Minimal standalone fixture for standalone-drain.docker-e2e.test.ts.
 *
 * `output: 'standalone'` is the shape the ADR-0055 image supervises. The
 * typescript bypass keeps the e2e's `next build` to a few seconds of compile
 * rather than a full project typecheck — the fixture's correctness is proved by
 * the container actually serving and draining, not by tsc. (eslint isn't
 * installed here and Next 16.3.3 no longer reads an `eslint` key from this
 * file, so there is nothing to bypass on that axis.)
 */
module.exports = {
  output: 'standalone',
  typescript: { ignoreBuildErrors: true },
};
