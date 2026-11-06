/**
 * SHARED compat-quarantine bound (v6-P1, ADR-0007 §g).
 *
 * Historically the number 15 lived as TWO independent literals that ADR-0007 §g
 * only PROSE-promised to keep in sync:
 *   - the per-mechanism-family SOFT BOUND in tests/deploy-manifest-lanes.test.ts
 *   - the file-level ≤15 family cap in tests/deploy-manifest.test.ts
 *
 * They are now BOUND to this single constant so they cannot silently diverge.
 * If you change the value, you change BOTH consumers at once — that is the point.
 * Do NOT reintroduce a bare `15` literal in either consumer; import this instead.
 */
export const FAMILY_QUARANTINE_CAP = 15;

/**
 * The two consumers that MUST reference {@link FAMILY_QUARANTINE_CAP}. Named here
 * so the binding assertion's failure message can point a future diverger at BOTH
 * call-sites at once.
 */
export const QUARANTINE_CAP_CALLSITES = [
  'tests/deploy-manifest-lanes.test.ts (PER_FAMILY_SOFT_BOUND — per-mechanism-family soft bound)',
  'tests/deploy-manifest.test.ts (the ≤15 file-level family cap)',
] as const;

/** The message emitted if either consumer drifts off the shared constant. */
export function capBindingMessage(): string {
  return (
    `the per-family soft bound and the file-level family cap MUST share the single ` +
    `constant FAMILY_QUARANTINE_CAP (= ${FAMILY_QUARANTINE_CAP}) in ` +
    `tests/compat-quarantine-bounds.ts. Both call-sites must reference it — do NOT ` +
    `hardcode a bare literal: ${QUARANTINE_CAP_CALLSITES.join(' AND ')}. ` +
    `Diverging them silently is exactly the ADR-0007 §g failure this binding prevents.`
  );
}

/**
 * The suites entries that are a VERBATIM mirror of upstream's own deploy manifest (re-mirrored on a
 * ref bump). Everything else in `suites` is knext's: flakey quarantines, or ref-pinned per-case
 * `failed` entries (ADR-0007 amendment 2026-11-04). Shared by tests/deploy-manifest.test.ts and
 * tests/compat-ref-pinned-cases.test.ts so the two guards cannot disagree about which is which.
 */
export const UPSTREAM_MIRROR_SUITES: ReadonlySet<string> = new Set([
  'test/e2e/app-dir/app-client-cache/client-cache.defaults.test.ts',
  'test/e2e/app-dir/app-client-cache/client-cache.experimental.test.ts',
  'test/e2e/app-dir/segment-cache/prefetch-runtime/prefetch-runtime.test.ts',
  'test/e2e/app-dir/actions/app-action.test.ts',
  'test/e2e/app-dir/actions/app-action-node-middleware.test.ts',
  'test/e2e/app-dir/app-static/app-static.test.ts',
  'test/e2e/app-dir/metadata/metadata.test.ts',
  'test/e2e/app-dir/searchparams-reuse-loading/searchparams-reuse-loading.test.ts',
  // test/e2e/middleware-rewrites/test/index.test.ts is excluded at file level
  // by the §h vercel-infra-coupled family (#1633), which subsumes upstream's
  // mirrored `failed` entry. Restore both here and in the manifest when that
  // entry retires.
]);
