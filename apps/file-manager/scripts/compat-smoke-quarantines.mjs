/**
 * The compat-smoke lane's quarantine accounting + summary line (#512).
 *
 * `compat-smoke.mjs` used to print a literal `quarantined=0`. That line is the smoke lane's
 * public accounting, and a literal cannot back it: the moment the smoke lane gains a
 * quarantine the summary under-reports it silently, which is the "a quarantine never hides a
 * regression" guarantee #282/#512 exist to keep observable.
 *
 * The WHOLE summary line is therefore built here by {@link formatLaneSummary}, which derives
 * the count itself from a ledger. The runner never formats `quarantined=` — that is what makes
 * the guard behavioural rather than textual. (Round 1 of this change asserted only source text;
 * a reviewer defeated it by writing `quarantined=${0}`, which is textually an interpolation and
 * numerically a lie. Asserting the RETURNED STRING over ledgers of size 0/1/2 cannot be
 * satisfied by any constant.)
 *
 * ── WHAT THE LIVE NUMBER MEANS, HONESTLY (#512 round 2) ──────────────────────────────────
 * Today it is 0, and it is 0 STRUCTURALLY — not because a live partition happens to be empty:
 *
 *   1. The smoke runner has NO quarantine mechanism at all. Sprint-1 T4 deliberately removed
 *      skip-on-fail, so a check may only PASS or FAIL (plus the declared runtime-lane SKIP).
 *      A check whose failure is tolerated is exactly the hole T4 closed.
 *   2. The shared ledger cannot host a smoke entry. `$knextQuarantines` lives in Next's own
 *      run-tests.js manifest, and independent guards bind every entry to an OFFICIAL-SUITE
 *      test path: per-case entries must map to `manifest.suites[test].flakey` and file-level
 *      entries to `rules.exclude` (deploy-manifest.test.ts), each entry needs a `vX.Y.Z`
 *      `nextjsRef` stamp matching the workflow ref, a `family` from a closed taxonomy, a
 *      `prefetch-runtime`/`edge-sandbox` provenance shape, and the bun-lane set is pinned to
 *      exactly two files (deploy-manifest-lanes.test.ts).
 *
 * An earlier draft invented a `compat-smoke:<check name>` namespace for that ledger. It was
 * REMOVED as wrong: no entry could ever satisfy point 2 without loosening the guards that fence
 * the official suite, so it was an unreachable branch with a passing test over it. A real smoke
 * quarantine would need (a) a runner-level quarantine status — a deliberate decision that
 * re-opens T4's hole and should be escalated, not slipped in — and (b) its own ledger file, not
 * a corner of Next's manifest. Until both exist, `quarantined=0` is a structural truth.
 *
 * So the value this code adds is FALSIFIABILITY, not counting: the zero stops being a claim
 * nobody checks. Every ambiguity is a THROW, never a quiet zero:
 *
 *   - an unreadable / non-array ledger throws. An unreachable source is a failure, never a pass
 *     (the same rule the action-pin nightly follows).
 *   - an entry attributable to NEITHER the official suite NOR a known smoke check throws. The
 *     attribution SCANS; it is not an allowlist of the entries we know about today, so the day
 *     the ledger stops being purely official-suite, this runner says so instead of printing 0.
 *
 * `checkNames` is the runner's own registered check list, so the count is testable with a
 * synthetic ledger (and a future smoke ledger drops straight in) without pretending the shared
 * manifest can host one.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Path (relative to the repo root) of the manifest carrying the quarantine ledger. */
export const LEDGER_PATH = 'test/deploy-tests-manifest.knext.json';

/** Entries whose `test` is an official-suite path belong to the run-tests.js lane, not here. */
const OFFICIAL_SUITE_TEST_RE = /^test\//;

/**
 * Read `$knextQuarantines` from the shared manifest. Throws if the manifest is missing,
 * unparseable, or does not carry an array ledger — never returns an empty ledger to paper
 * over a read failure.
 */
export function loadQuarantineLedger(repoRoot) {
  const file = path.resolve(repoRoot, LEDGER_PATH);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `compat-smoke: cannot read the quarantine ledger at ${file} — ` +
        `refusing to report a quarantine count it cannot back (${err && err.message})`,
    );
  }
  const ledger = parsed.$knextQuarantines;
  if (!Array.isArray(ledger)) {
    throw new Error(
      `compat-smoke: ${file} has no array "$knextQuarantines" ledger — refusing to report ` +
        'a quarantine count it cannot back',
    );
  }
  return ledger;
}

/**
 * How many ledger entries quarantine a check of THIS smoke runner on `lane`.
 *
 * @param {{ledger: unknown, lane: string, checkNames: string[]}} input
 * @returns {number}
 */
export function smokeQuarantineCount({ ledger, lane, checkNames }) {
  if (!Array.isArray(ledger)) {
    throw new Error(
      'compat-smoke: quarantine ledger is missing or not an array — refusing to report a ' +
        'quarantine count it cannot back',
    );
  }
  const known = new Set(checkNames ?? []);
  let count = 0;
  for (const entry of ledger) {
    const name = entry && typeof entry.test === 'string' ? entry.test : '';
    if (OFFICIAL_SUITE_TEST_RE.test(name)) continue; // the official suite's lane, not ours
    if (!known.has(name)) {
      throw new Error(
        `compat-smoke: unattributable quarantine entry "${name}" — it names neither an ` +
          'official-suite test file (test/…) nor a known smoke check. An unknown entry must ' +
          'fail loudly, not be silently dropped from the per-lane quarantine count (#512)',
      );
    }
    // The ledger's lane default is "node" (see tests/compat-lane-ledger.ts).
    if ((entry.lane ?? 'node') === lane) count++;
  }
  return count;
}

/**
 * The runner's per-lane summary LINE, with the quarantine count derived from `ledger`.
 *
 * Owning the formatting here (rather than in the runner) is what makes the guard behavioural:
 * a test asserts the returned string, so a hardcoded or stale value cannot survive a ledger
 * whose size changes. Throws from {@link smokeQuarantineCount} propagate deliberately — a line
 * this runner cannot back must not be printed at all.
 *
 * @param {{lane: string, passing: number, failing: number, ledger: unknown, checkNames: string[]}} input
 * @returns {string}
 */
export function formatLaneSummary({ lane, passing, failing, ledger, checkNames }) {
  const q = smokeQuarantineCount({ ledger, lane, checkNames });
  return (
    `LANE=${lane}  passing=${passing}  quarantined=${q}  failing=${failing}  ` +
    '(per-lane; the other lane runs separately)'
  );
}
