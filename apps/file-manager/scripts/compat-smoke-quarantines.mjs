/**
 * The compat-smoke lane's quarantine accounting (#512, third acceptance criterion).
 *
 * `compat-smoke.mjs` used to print a literal `quarantined=0` in its per-lane summary. That
 * line is the smoke lane's public accounting, and a literal cannot back it: the moment the
 * smoke lane gains a quarantine the summary under-reports it silently, which is exactly the
 * "a quarantine never hides a regression" guarantee #282/#512 exist to keep observable.
 *
 * So the count is DERIVED from `$knextQuarantines` in `test/deploy-tests-manifest.knext.json`
 * — the one quarantine ledger this repo has — and every ambiguity is a THROW, never a quiet
 * zero:
 *
 *   - an unreadable / non-array ledger throws. An unreachable source is a failure, never a
 *     pass (the same rule the action-pin nightly follows).
 *   - an entry attributable to NEITHER the official suite NOR a known smoke check throws.
 *     Attribution SCANS the ledger; it is not an enumerated allowlist of the entries we
 *     happen to know about today, so an unparseable entry fails instead of being skipped.
 *
 * Attribution rule:
 *   - `test` starting with `test/` → an OFFICIAL-SUITE (run-tests.js) quarantine. The smoke
 *     runner does not run those files, so they are not its to report.
 *   - `test` equal to a smoke check name, or `compat-smoke:<check name>` → this runner's.
 *   - anything else → unattributable, throw.
 *
 * Kept in a plain `.mjs` module so both the runner and `tests/compat-smoke-quarantine-count.test.ts`
 * exercise the SAME code — the guard tests behaviour, not a copy of it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Path (relative to the repo root) of the manifest carrying the quarantine ledger. */
export const LEDGER_PATH = 'test/deploy-tests-manifest.knext.json';

/** The namespace prefix a smoke-lane quarantine entry uses in the shared ledger. */
export const SMOKE_PREFIX = 'compat-smoke:';

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
    const test = entry && typeof entry.test === 'string' ? entry.test : '';
    if (OFFICIAL_SUITE_TEST_RE.test(test)) continue; // the official suite's lane, not ours
    const name = test.startsWith(SMOKE_PREFIX) ? test.slice(SMOKE_PREFIX.length) : test;
    if (!known.has(name)) {
      throw new Error(
        `compat-smoke: unattributable quarantine entry "${test}" — it names neither an ` +
          `official-suite test file (test/…) nor a known smoke check. An unknown entry must ` +
          'fail loudly, not be silently dropped from the per-lane quarantine count (#512)',
      );
    }
    // The ledger's lane default is "node" (see tests/compat-lane-ledger.ts).
    if ((entry.lane ?? 'node') === lane) count++;
  }
  return count;
}
