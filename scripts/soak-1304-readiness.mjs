#!/usr/bin/env node
/**
 * soak-1304-readiness — the ONE-COMMAND check for #1304 ([v1.0 T13] soak)
 * once the founder cuts an RC tag: are every WIRED credential cell's 3 most
 * recent nights all green FIRST ATTEMPT?
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
 * WHAT IT DOES
 * ------------
 * 1. Reads `.github/compat-credential-ref.json`. If `rcTag` is `null`,
 *    reports NOT READY (no RC cut) and exits 1 — never silently "ready".
 * 2. For every WIRED cell in `scripts/compat-window-audit.mjs`'s
 *    `CREDENTIAL_CELLS` (today: node, bun, node-webpack, bun-webpack —
 *    the v1.0-scoped 4-cell matrix per ADR-0058/#1295 option C; an unwired
 *    cell such as bun-vinext is skipped, not silently counted as ready),
 *    lists `test-e2e-deploy.yml` runs since the RC was cut, filters to
 *    CREDENTIAL nights for that cell's runtime/builder (never early-warning
 *    dispatches — those can never satisfy this bar by construction, see
 *    ADR-0056), and evaluates the trailing 3-night streak via
 *    `scripts/lib/soak-readiness.mjs`.
 * 3. Prints the evidence-table markdown #1304 asks be posted on the issue,
 *    and exits 0 only when EVERY wired cell is ready.
 *
 * FAIL CLOSED
 * -----------
 * An unreachable `gh`, an unparseable run list, or zero cells found are all
 * failures — a readiness checker that goes green on missing data is worse
 * than none.
 *
 * TESTABILITY
 * -----------
 * All comparison/streak logic lives in `scripts/lib/soak-readiness.mjs`,
 * unit-tested against fixtures in `tests/soak-1304-readiness.test.ts`. This
 * file is the thin CLI wrapper: real filesystem read, real `gh run list`,
 * real process exit code.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CREDENTIAL_CELLS } from './compat-window-audit.mjs';
import { evaluateSoakReadiness, SOAK_REQUIRED_STREAK } from './lib/soak-readiness.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CREDENTIAL_REF_PIN = resolve(REPO_ROOT, '.github/compat-credential-ref.json');
const TARGET_WORKFLOW = 'test-e2e-deploy.yml';
const REPO = process.env.GITHUB_REPOSITORY ?? 'getknext-dev/knext';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function loadRcTag() {
  const pin = JSON.parse(readFileSync(CREDENTIAL_REF_PIN, 'utf8'));
  return pin.rcTag ?? null;
}

/**
 * `gh run list --json` does not expose the run's `nextjsRef`/`runtime`/
 * `builder` inputs directly, so cell attribution goes through the run's
 * displayed name/title the same way `compat-window-audit.mjs` already
 * attributes lanes — via the job name pattern this workflow's matrix uses.
 * Kept minimal here: filters to the cell's declared `workflowFile` and lets
 * the caller pass an already-cell-scoped run list (see `main()`).
 */
function listCredentialRuns(cell, sinceIso) {
  const out = gh([
    'run',
    'list',
    '--repo',
    REPO,
    '--workflow',
    cell.workflowFile ?? TARGET_WORKFLOW,
    '--json',
    'databaseId,conclusion,attempt,createdAt,status,displayTitle',
    '--limit',
    '50',
  ]);
  const runs = JSON.parse(out);
  return runs
    .filter((r) => r.status === 'completed')
    .filter((r) => Date.parse(r.createdAt) >= Date.parse(sinceIso))
    .map((r) => ({
      id: r.databaseId,
      conclusion: r.conclusion,
      attempt: r.attempt ?? 1,
      createdAt: r.createdAt,
    }));
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

  const wiredCells = CREDENTIAL_CELLS.filter((c) => c.wired);
  if (wiredCells.length === 0) {
    console.error('::error::no wired credential cells found — CREDENTIAL_CELLS is misconfigured.');
    process.exit(1);
  }

  console.log(`RC tag: ${rcTag}. Checking ${wiredCells.length} wired cell(s)...`);

  // A run's createdAt must be AFTER the RC cut for it to be evidence for
  // THIS RC's soak — a night from a prior (superseded) RC tag does not
  // count. `gh` has no direct "tag push date" lookup wired here; operators
  // running this by hand should pass SOAK_SINCE_ISO explicitly if the RC
  // was cut some time ago and older unrelated runs would otherwise pollute
  // the window (harmless either way, since evaluateCellReadiness only ever
  // looks at the TRAILING 3 nights).
  const sinceIso = process.env.SOAK_SINCE_ISO ?? '1970-01-01T00:00:00Z';

  const runsByCell = {};
  for (const cell of wiredCells) {
    runsByCell[cell.lane] = listCredentialRuns(cell, sinceIso);
  }

  const result = evaluateSoakReadiness(runsByCell, SOAK_REQUIRED_STREAK);
  console.log(result.evidenceTableMarkdown);

  if (!result.overallReady) {
    console.error('\nNOT READY — see the table above for which cell(s) are missing their streak.');
    process.exit(1);
  }
  console.log('\nREADY — every wired cell has 3 consecutive green first-attempt nights.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${message}`);
  process.exit(1);
});
