#!/usr/bin/env node
/**
 * Boundary gate: a figure this repo has RETRACTED may not go on being published,
 * uncorrected, on an issue the release documents cite. (#545, #710)
 *
 * Runs at RESOLUTION time, never as a committed assertion — the same division of
 * labour `security.md` records for action pins: `tests/release-action-pins.test.ts`
 * asserts form and scope at PR time, and
 * `.github/workflows/action-pin-resolution-nightly.yml` resolves against upstream
 * nightly. Here `tests/retracted-figures.test.ts` asserts the LOGIC at PR time
 * (no network), and this script resolves against the live issues.
 *
 * AN UNREACHABLE API IS A FAILURE, NEVER A PASS. A checker that goes green when
 * it cannot see its subject is worse than no checker, because it reports
 * "nothing wrong" and "I could not look" identically. Same rule, same reason, as
 * the action-pin nightly.
 *
 * Usage:  node scripts/verify-retracted-figures.mjs [--repo owner/name]
 * Exit 0 = every retracted figure is either absent or corrected on every cited
 * issue. Exit 1 = at least one still stands, or the issues could not be read.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { citedIssues, findUncorrected } from './lib/retracted-figures.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = 'docs/compat/retracted-figures.json';

/**
 * The documents whose citations define the boundary.
 *
 * These are the two that TELL the reader the issues carry the corrected
 * findings, which is what makes their citations load-bearing rather than
 * decorative. The issues themselves are scanned out of these files, never
 * listed here.
 */
const CITING_DOCS = [
  'docs/release/compat-honesty-gate.md',
  'docs/release/public-release-readiness.md',
];

function repoSlug() {
  const i = process.argv.indexOf('--repo');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.GITHUB_REPOSITORY ?? 'getknext-dev/knext';
}

/** Fetch JSON from the GitHub API. Throws — never returns a falsy "nothing". */
function api(path) {
  const out = execFileSync('gh', ['api', path, '--paginate'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  // `--paginate` concatenates pages as separate JSON arrays; stitch them.
  const chunks = out.replace(/\]\s*\[/g, ',').trim();
  return JSON.parse(chunks);
}

function main() {
  const slug = repoSlug();
  const ledger = JSON.parse(readFileSync(join(REPO_ROOT, LEDGER), 'utf8')).figures;
  if (!Array.isArray(ledger) || ledger.length === 0) {
    console.error(`FAIL: ${LEDGER} lists no figures — the gate would pass vacuously.`);
    process.exit(1);
  }

  const issues = new Set();
  for (const doc of CITING_DOCS) {
    const text = readFileSync(join(REPO_ROOT, doc), 'utf8');
    for (const n of citedIssues(text)) issues.add(n);
  }
  if (issues.size === 0) {
    console.error('FAIL: no cited issues found in the citing documents — the scan is vacuous.');
    process.exit(1);
  }

  console.log(`Ledger: ${ledger.length} retracted figure(s).`);
  console.log(`Cited issues discovered by scan: ${[...issues].sort((a, b) => a - b).join(', ')}`);

  const offences = [];
  const unreachable = [];
  for (const n of [...issues].sort((a, b) => a - b)) {
    let issue;
    let comments;
    try {
      issue = api(`repos/${slug}/issues/${n}`);
      comments = api(`repos/${slug}/issues/${n}/comments`);
    } catch (err) {
      // Not a pass. A 404 on a number that is not really an issue is still a
      // thing we could not read, and it is reported as such rather than skipped.
      unreachable.push(`#${n}: ${String(err.message ?? err).split('\n')[0]}`);
      continue;
    }
    const sources = [
      { ref: `#${n} body`, body: issue.body ?? '' },
      ...comments.map((c) => ({ ref: `#${n} comment ${c.id}`, body: c.body ?? '' })),
    ];
    const found = findUncorrected(sources, ledger);
    offences.push(...found);
    console.log(
      `  #${n}: ${sources.length} source(s), ${found.length} uncorrected retracted figure(s)`,
    );
  }

  if (unreachable.length) {
    console.error(
      '\nFAIL: could not read these cited issues. Unreachable is a FAILURE, never a pass —',
    );
    console.error(
      'a checker that goes green when it cannot see its subject reports "nothing wrong"',
    );
    console.error('and "I could not look" identically.');
    for (const u of unreachable) console.error(`  - ${u}`);
    process.exit(1);
  }

  if (offences.length) {
    console.error(`\nFAIL: ${offences.length} retracted figure(s) still published uncorrected:`);
    for (const o of offences) {
      const fig = ledger.find((f) => f.id === o.figure);
      console.error(`\n  [${o.figure}] in ${o.ref}`);
      console.error(`    still says: "${o.matched}"`);
      console.error(`    correct:    ${fig?.correct ?? '(see the ledger)'}`);
    }
    console.error(
      '\nAdd a correcting comment on that issue quoting the wrong figure and stating the right',
    );
    console.error('one. Do NOT silently edit the original, and do NOT delete the ledger entry.');
    process.exit(1);
  }

  console.log('\nOK: every retracted figure is absent or corrected on every cited issue.');
}

main();
