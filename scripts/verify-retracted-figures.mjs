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
import { assembleSources, citedIssues, findUncorrected } from './lib/retracted-figures.mjs';

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

/**
 * Fetch JSON from the GitHub API. Throws — never returns a falsy "nothing".
 *
 * `--slurp` rather than raw `--paginate`. An earlier version stitched
 * concatenated pages with `out.replace(/\]\s*\[/g, ',')`, which is a **textual**
 * edit over the whole payload including the inside of JSON string values: an
 * issue body reading `see refs [a] [b] and note 9 restarts` was silently parsed
 * as `see refs [a,b] and note 9 restarts`. Still valid JSON, quietly altered —
 * which can break a pattern match (false green) or a correction's quote (false
 * red). `--slurp` returns a real array of pages, so nothing is rewritten.
 */
function api(path) {
  const out = execFileSync('gh', ['api', path, '--paginate', '--slurp'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const pages = JSON.parse(out);
  if (!Array.isArray(pages)) throw new Error(`unexpected --slurp payload for ${path}`);
  // A single-object endpoint slurps to `[obj]`; a list endpoint to `[[...], …]`.
  return pages.every((p) => Array.isArray(p)) ? pages.flat() : pages[0];
}

/**
 * Read every comment surface of one citation.
 *
 * A cited **pull request** carries two surfaces `issues/N/comments` does not:
 * review bodies (`pulls/N/reviews`) and inline review comments
 * (`pulls/N/comments`). #846 — the PR this very work posted a correction on — is
 * exactly that shape, so a retracted figure in a review body on a cited PR would
 * have gone unseen. Both are now read; `issue.pull_request` is what distinguishes
 * a PR from an issue in the REST payload.
 */
function readSources(slug, ref) {
  const n = ref.number;
  const label = ref.owner ? `${ref.owner}/${ref.repo}#${n}` : `#${n}`;
  const issue = api(`repos/${slug}/issues/${n}`);
  const comments = api(`repos/${slug}/issues/${n}/comments`);
  if (!issue || typeof issue !== 'object' || !Array.isArray(comments)) {
    // A subprocess that SUCCEEDS while returning nothing usable is how a checker
    // goes green without seeing its subject. Classed as unreadable, not empty.
    throw new Error('API returned an unusable payload (no issue object or no comment array)');
  }
  let reviews = [];
  let reviewComments = [];
  if (issue.pull_request) {
    reviews = api(`repos/${slug}/pulls/${n}/reviews`);
    reviewComments = api(`repos/${slug}/pulls/${n}/comments`);
    if (!Array.isArray(reviews) || !Array.isArray(reviewComments)) {
      throw new Error('API returned an unusable payload for the PR review surfaces');
    }
  }
  // WHICH surfaces count is a decision, and it lives in the pure core so it can
  // be unit-tested and mutated offline. This function only fetches.
  return assembleSources(label, issue, comments, reviews, reviewComments);
}

function main() {
  const slug = repoSlug();
  const ledger = JSON.parse(readFileSync(join(REPO_ROOT, LEDGER), 'utf8')).figures;
  if (!Array.isArray(ledger) || ledger.length === 0) {
    console.error(`FAIL: ${LEDGER} lists no figures — the gate would pass vacuously.`);
    process.exit(1);
  }

  const byKey = new Map();
  for (const doc of CITING_DOCS) {
    const text = readFileSync(join(REPO_ROOT, doc), 'utf8');
    for (const ref of citedIssues(text)) {
      byKey.set(`${ref.owner ?? ''}/${ref.repo ?? ''}#${ref.number}`, ref);
    }
  }
  const refs = [...byKey.values()];
  if (refs.length === 0) {
    console.error('FAIL: no cited issues found in the citing documents — the scan is vacuous.');
    process.exit(1);
  }

  console.log(`Ledger: ${ledger.length} retracted figure(s).`);
  console.log(
    `Cited issues discovered by scan: ${refs
      .map((r) => (r.owner ? `${r.owner}/${r.repo}#${r.number}` : `#${r.number}`))
      .join(', ')}`,
  );

  const offences = [];
  const unreachable = [];
  for (const ref of refs) {
    // Each citation is resolved against the repository it NAMES, not against the
    // default one. Discarding the owner/repo meant a cross-repo citation was
    // checked against an unrelated same-repo issue that happened to share a
    // number — a confident verdict about the wrong subject.
    const targetSlug = ref.owner ? `${ref.owner}/${ref.repo}` : slug;
    const label = ref.owner ? `${ref.owner}/${ref.repo}#${ref.number}` : `#${ref.number}`;
    let sources;
    try {
      sources = readSources(targetSlug, ref);
    } catch (err) {
      // Not a pass. A 404 on a number that is not really an issue is still a
      // thing we could not read, and it is reported as such rather than skipped.
      unreachable.push(`${label}: ${String(err.message ?? err).split('\n')[0]}`);
      continue;
    }
    const found = findUncorrected(sources, ledger);
    offences.push(...found);
    console.log(
      `  ${label}: ${sources.length} source(s), ${found.length} uncorrected retracted figure(s)`,
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
