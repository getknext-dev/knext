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
