#!/usr/bin/env node
/**
 * soak-1304-readiness — the ONE-COMMAND check for #1304 ([v1.0 T13] soak)
 * once the founder cuts an RC tag: are every WIRED credential cell's 3 most
 * recent nights all green FIRST ATTEMPT, on the CURRENT rcTag, with
 * bytecode caching proven live?
 *
 * WHY THIS IS NOT DISPATCHED YET (deliberate — standing task, not a bug)
 * ------------------------------------------------------------------------
 * Per the assigned task: the credentialed Next.js version may still move
 * from `v16.2.0` to the shipped `>=16.3.5` pin (a founder decision pending
 * on #1376 and #1307), and soaking on the wrong version wastes CI capacity
 * that would have to be re-spent once the version moves. Separately,
 * `.github/compat-credential-ref.json`'s `rcTag` is `null` today — no RC has
 * been cut, and credential nights REFUSE rather than run against `main`
 * (ADR-0056 D1). So there is nothing to soak yet, by construction, on BOTH
 * counts. This script is the tooling, ready to run the moment both are
 * resolved — no code changes needed then, just:
 *
 *     node scripts/soak-1304-readiness.mjs
 *
 * WHAT IT DOES (rev-1396 review rewrote this to source from
 * `scripts/compat-window-audit.mjs`, not raw `gh run list`)
 * ------------------------------------------------------------------------
 * 1. Reads `.github/compat-credential-ref.json`. If `rcTag` is `null`,
 *    reports NOT READY (no RC cut) and exits 1 — never silently "ready".
 * 2. Fetches every scheduled `test-e2e-deploy.yml` night's ledger via
 *    `compat-window-audit.mjs`'s `fetchLedgers` — the SAME fetch+artifact
 *    reconciliation every other credential-window consumer in this repo
 *    already relies on (rule 5: no run silently vanishes from the count).
 * 3. For every WIRED cell in `CREDENTIAL_CELLS` (today: node, bun,
 *    node-webpack, bun-webpack — the v1.0-scoped 4-cell matrix per
 *    ADR-0058/#1295 option C; an unwired cell such as bun-vinext is
 *    skipped, not silently counted as ready), grades its nights with
 *    `auditWindow({ scope: 'credential' })` — which is where the actual
 *    filtering rev-1396 found missing now lives: rule 6 requires
 *    `credential === true`/`compatMode === 'credential'` AND a real
 *    RC-tag-shaped `knextRef` (never an early-warning `main` dispatch),
 *    `lane` scoping restricts to the cell's own runtime×builder, and rule 7
 *    requires bytecode caching PROVEN LIVE on every shard for the cell's
 *    runtime — "bytecode LIVE" is checked, not assumed.
 * 4. `deriveCellRunsFromWindow` adds the ONE thing `auditWindow` does not
 *    itself enforce: that every night's `knextRef` matches the CURRENT
 *    `rcTag` specifically (`isRcRef` only checks the SHAPE, so a stale
 *    night from a PRIOR rc.N would otherwise still count after a bump).
 * 5. Evaluates the trailing 3-night streak via `scripts/lib/soak-readiness.mjs`
 *    and prints the evidence-table markdown #1304 asks be posted on the
 *    issue, exiting 0 only when EVERY wired cell is ready.
 *
 * FAIL CLOSED
 * -----------
 * An unreachable `gh`, an unparseable run/ledger, or zero cells found are
 * all failures — a readiness checker that goes green on missing data is
 * worse than none. `fetchLedgers` itself already fails closed on a night
 * whose ledger cannot be obtained (an `unresolvedNight`, graded ineligible).
 *
 * TESTABILITY
 * -----------
 * The streak/readiness comparison and the `auditWindow` -> `CredentialRun[]`
 * mapping both live in `scripts/lib/soak-readiness.mjs`, unit-tested against
 * fixtures in `tests/soak-1304-readiness.test.ts`. `auditWindow`/
 * `fetchLedgers` themselves are `scripts/compat-window-audit.mjs`'s own,
 * already-tested exports — this file does not reimplement any of their
 * grading logic. This file is the thin CLI wrapper: real filesystem read,
 * real `gh` calls (via `fetchLedgers`'s own default transport), real
 * process exit code.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auditWindow,
  CREDENTIAL_CELLS,
  DEFAULT_FETCH_LIMIT,
  fetchLedgers,
} from './compat-window-audit.mjs';
import {
  deriveCellRunsFromWindow,
  evaluateSoakReadiness,
  SOAK_REQUIRED_STREAK,
} from './lib/soak-readiness.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CREDENTIAL_REF_PIN = resolve(REPO_ROOT, '.github/compat-credential-ref.json');
const CREDENTIALED_NEXT_VERSION_PIN = resolve(
  REPO_ROOT,
  '.github/compat-credentialed-next-version.json',
);

function loadRcTag() {
  const pin = JSON.parse(readFileSync(CREDENTIAL_REF_PIN, 'utf8'));
  return pin.rcTag ?? null;
}

/** The ONE Next.js ref every credential night must have tested against
 * (#1396 round 2 finding 2) — same manifest `compat-vinext-ledger.mjs`'s
 * `DEFAULT_NEXTJS_REF` already reads, so this never drifts independently. */
function loadCredentialedNextjsRef() {
  const manifest = JSON.parse(readFileSync(CREDENTIALED_NEXT_VERSION_PIN, 'utf8'));
  return manifest.credentialedNextRef ?? null;
}

async function main() {
  const rcTag = loadRcTag();
  if (!rcTag) {
    console.error(
      '::notice::NOT READY — no RC tag cut yet (.github/compat-credential-ref.json rcTag is null). ' +
        'Credential nights refuse rather than run against main (ADR-0056 D1); there is nothing to soak.',
    );
    process.exit(1);
  }
  const expectedKnextRef = `refs/tags/${rcTag}`;

  const expectedNextjsRef = loadCredentialedNextjsRef();
  if (!expectedNextjsRef) {
    console.error(
      '::error::no credentialedNextRef found in .github/compat-credentialed-next-version.json — ' +
        'cannot verify which Next.js ref each night must have tested against.',
    );
    process.exit(1);
  }

  const wiredCells = CREDENTIAL_CELLS.filter((c) => c.wired);
  if (wiredCells.length === 0) {
    console.error('::error::no wired credential cells found — CREDENTIAL_CELLS is misconfigured.');
    process.exit(1);
  }

  console.log(
    `RC tag: ${rcTag}. Fetching ledgers and checking ${wiredCells.length} wired cell(s)...`,
  );

  const limit = Number(process.env.SOAK_FETCH_LIMIT ?? DEFAULT_FETCH_LIMIT);
  const ledgers = fetchLedgers(limit);

  const runsByCell = {};
  for (const cell of wiredCells) {
    const windowResult = auditWindow(ledgers, {
      lane: cell.lane,
      scope: 'credential',
      requiredNights: SOAK_REQUIRED_STREAK,
    });
    runsByCell[cell.lane] = deriveCellRunsFromWindow(
      windowResult,
      expectedKnextRef,
      expectedNextjsRef,
    );
  }

  const result = evaluateSoakReadiness(runsByCell, SOAK_REQUIRED_STREAK);
  console.log(result.evidenceTableMarkdown);
  console.log(
    '\n(bytecode-live and credential-mode/RC-tag-shape are verified for every night above via ' +
      'compat-window-audit.mjs rules 6/7 — a night failing either shows as red, not as READY.)',
  );

  if (!result.overallReady) {
    console.error('\nNOT READY — see the table above for which cell(s) are missing their streak.');
    process.exit(1);
  }
  console.log(
    '\nREADY — every wired cell has 3 consecutive green first-attempt nights on the current RC tag.',
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${message}`);
  process.exit(1);
});
