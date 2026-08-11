/**
 * The ONE admissible spelling of an unconditional `if:`, plus the shape tables
 * that exercise it (#703).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `.github/workflows/test-e2e-deploy.yml` turns a red compat RESULT into a red
 * compat JOB through a short tail of steps that must run even after an earlier
 * step failed — summarise, upload the ledger artifact, then fail the shard.
 * Every one of them carries `if: always()` for that reason, and every one of
 * them is disarmed by a ONE-LINE YAML edit that narrows the condition:
 *
 *     if: always() && github.event_name == 'schedule'
 *
 * MEASURED on the tree this module landed on: narrowing `Summarize shard
 * result` or `Upload summary artifact` that way left `tests/` entirely GREEN,
 * because the guard protecting them was `/if:\s*always\(\)/` — a regex a
 * conjunction SATISFIES. The same regex also went RED on `${{ always() }}`,
 * which is the identical condition in GitHub's other spelling. Too weak in one
 * direction and too strict in the other, from one pattern.
 *
 * THE INVERSION, which this repo has now written down three times: do not ban
 * spellings. A blocklist catches the form already fixed and nothing else. State
 * the permitted form and reject everything else, INCLUDING what you do not
 * recognise. `ADMISSIBLE_IF` is that allowlist-of-one, lifted here from
 * `tests/compat-shard-flake-attribution.test.ts` (#697) so the spec, the helper
 * and the mutation prover share ONE implementation rather than three that agree
 * until they do not.
 *
 * A CONSEQUENCE OF THE ALLOWLIST, stated rather than discovered: some rejected
 * shapes are harmless in isolation. `always() || false` evaluates exactly like
 * `always()`. It is still rejected, and the mutation table still exercises it,
 * because an allowlist that reasoned about SEMANTICS would have to evaluate
 * arbitrary GitHub expressions — which is the blocklist all over again, wearing
 * an interpreter. The cost is a false positive on a form nobody writes; the
 * benefit is that the form nobody thought of is rejected too.
 *
 * Plain `.mjs` because the mutation prover (`scripts/mutation-prove-*.mjs`) is
 * Node and cannot import TypeScript; the specs and `tests/helpers/*.ts` import
 * it the same way they already import `shell-command-position.mjs`.
 */

/**
 * The only `if:` values that certify a step or job as UNCONDITIONAL.
 *
 * Both spellings are the same GitHub condition — `always()` bare, and wrapped
 * in the `${{ }}` interpolation YAML also accepts. Interior whitespace is
 * tolerated because YAML does not normalise it and a guard that reddened on
 * `${{  always() }}` would be teaching people to edit the guard.
 */
export const ADMISSIBLE_IF = /^(always\(\)|\$\{\{\s*always\(\)\s*\}\})$/;

/**
 * Is `value` an admissible unconditional `if:`?
 *
 * Takes `unknown` on purpose. A YAML `if: true` parses to a BOOLEAN, not a
 * string, and a check that only handled strings would let it through as
 * "nothing to test" — which is the vacuous-pass failure this repo keeps
 * re-finding. Everything is stringified and then judged.
 */
export function isAdmissibleIf(value) {
  if (value === undefined || value === null) return false;
  return ADMISSIBLE_IF.test(String(value).trim());
}

/**
 * Every `if:` value that MUST be rejected, with what it does if it lands.
 *
 * The list is the mutation table's source: `tests/compat-suite-workflow.test.ts`
 * asserts every entry is rejected by `isAdmissibleIf`, and
 * `scripts/mutation-prove-compat-step-level-disarms.mjs` generates one disarm
 * row per entry. Adding a shape here therefore adds BOTH a verdict assertion
 * and a mutation row; a shape that gains neither is what the coverage guard in
 * the spec exists to catch.
 *
 * `yaml` is what gets written into the workflow. It differs from `value` for
 * the shapes whose YAML spelling is not their parsed value (`'true'` parses to
 * the STRING "true", `true` to the boolean).
 */
export const INADMISSIBLE_IF_SHAPES = Object.freeze([
  {
    id: 'conjunction-event',
    yaml: "always() && github.event_name == 'schedule'",
    why: 'the exact disarm #703 was filed for: `/if:\\s*always\\(\\)/` matches it, and the step stops running on every trigger that is not `schedule`',
  },
  {
    id: 'conjunction-interpolated',
    yaml: "${{ always() && github.event_name == 'schedule' }}",
    why: 'the same conjunction inside the interpolation, which a pattern anchored on the bare form does not even see',
  },
  {
    id: 'conjunction-dead-context',
    yaml: "always() && github.repository == 'nobody/nowhere'",
    why: 'a conjunct that is false on every run — the step is present, named, and never executes',
  },
  {
    id: 'disjunction-false',
    yaml: 'always() || false',
    why: 'harmless BY VALUE and still rejected: the allowlist judges the form, because judging the value means evaluating arbitrary GitHub expressions',
  },
  {
    id: 'success-or-failure',
    yaml: 'success() || failure()',
    why: 'runs after a failure but NOT after a cancellation — a cancelled shard then reports no verdict at all',
  },
  {
    id: 'implicit-success',
    yaml: 'success()',
    why: 'the default: the step is skipped the moment an earlier step in the job fails, which is precisely when the verdict matters',
  },
  {
    id: 'boolean-true',
    yaml: 'true',
    why: 'reads as unconditional and is not — GitHub implies `success() &&` for an `if:` that names no status function, so this skips after a failure',
  },
  {
    id: 'boolean-false',
    yaml: 'false',
    why: 'never runs at all — the total disarm, listed so the table covers the trivial case as well as the subtle ones',
  },
  {
    id: 'context-gated',
    yaml: "github.event_name == 'schedule'",
    why: 'the conjunction with `always()` dropped entirely — same effect, and no `always` token left for a text scan to anchor on',
  },
]);

/**
 * The spellings that MUST be accepted.
 *
 * The other half of the guard, and the half a blocklist never has: a check that
 * only ever rejects is proved by nothing when it starts rejecting everything.
 */
export const ADMISSIBLE_IF_SHAPES = Object.freeze([
  { id: 'bare', yaml: 'always()' },
  { id: 'interpolated', yaml: '${{ always() }}' },
  { id: 'interpolated-loose-spacing', yaml: '${{   always()   }}' },
]);

/**
 * Every spelling of a truthy `continue-on-error`.
 *
 * `continueOnErrorProblem` (tests/helpers/blocking-gate.ts) asks "is it
 * literally `false`?" rather than banning these, so the table is not what makes
 * the check correct — it is what PROVES the check is not a blocklist wearing a
 * different name. `${{ !false }}` and `yes` are here because neither is a form
 * anyone wrote down, which is the whole point.
 */
export const CONTINUE_ON_ERROR_SPELLINGS = Object.freeze([
  { id: 'bare-true', yaml: 'true' },
  { id: 'quoted-true', yaml: "'true'" },
  { id: 'expression-true', yaml: '${{ true }}' },
  { id: 'expression-not-false', yaml: '${{ !false }}' },
  { id: 'yaml-yes', yaml: 'yes' },
]);
