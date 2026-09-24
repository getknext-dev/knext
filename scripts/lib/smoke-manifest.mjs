// #1301 — the branch 16-shard smoke manifest.
//
// The smoke manifest is DERIVED from the real credential manifest
// (test/deploy-tests-manifest.knext.json), never hand-maintained: it copies
// `suites` / `rules.exclude` / `$knextQuarantines` / `$knextExclusions`
// byte-for-byte and narrows ONLY `rules.include`, so a branch smoke dispatch
// still honors every known quarantine and architectural exclusion the
// credential lane does — it just selects far fewer files. `test/e2e/app-dir/`
// is the narrowing target: it is next.js's own largest e2e corpus directory
// (referenced elsewhere in test-e2e-deploy.yml's symlink tripwire, so it is
// known to exist in the checked-out fixture tree) and is NOT itself excluded
// by any entry in the credential manifest's `rules.exclude`.
//
// `scripts/generate-smoke-manifest.mjs` writes the committed file from this
// function; `tests/ci-capacity-budget.test.ts` re-derives it from the LIVE
// main manifest and diffs against the committed copy, so the smoke manifest
// cannot silently drift out of sync with the credential manifest's
// exclude/suites ledger.

/** The narrowing glob(s) applied for the branch smoke selection (#1301). */
export const SMOKE_INCLUDE = ['test/e2e/app-dir/**/*.test.{t,j}s{,x}'];

/**
 * Derive the smoke manifest from the real (credential) manifest object.
 * Deep-clones via JSON round-trip (the manifest is plain JSON data) so the
 * caller's object is never mutated.
 */
export function deriveSmokeManifest(mainManifest) {
  const clone = JSON.parse(JSON.stringify(mainManifest));
  if (!clone.rules || !Array.isArray(clone.rules.exclude)) {
    throw new Error(
      'deriveSmokeManifest: main manifest is missing rules.exclude — cannot derive a smoke manifest from it',
    );
  }
  clone.$comment = [
    'DERIVED, not hand-maintained — see scripts/lib/smoke-manifest.mjs.',
    '#1301 branch smoke mode: this file is test/deploy-tests-manifest.knext.json',
    'with rules.include narrowed to a small representative corpus subset',
    '(test/e2e/app-dir/**). suites / rules.exclude / $knextQuarantines /',
    '$knextExclusions are copied VERBATIM from the credential manifest, so a',
    'smoke dispatch honors every known quarantine and architectural exclusion',
    'the credential lane does. Regenerate with',
    '`node scripts/generate-smoke-manifest.mjs` after any edit to',
    'test/deploy-tests-manifest.knext.json — tests/ci-capacity-budget.test.ts',
    'reds on drift. Dispatch-only (workflow_dispatch smoke=true); NEVER used on',
    'a credential or early-warning schedule night — those always read the main',
    'manifest (test-e2e-deploy.yml KNEXT_DEPLOY_MANIFEST env).',
  ];
  clone.rules = {
    include: [...SMOKE_INCLUDE],
    exclude: clone.rules.exclude,
  };
  return clone;
}
