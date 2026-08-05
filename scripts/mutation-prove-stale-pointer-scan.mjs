#!/usr/bin/env node
/**
 * Standing mutation proof for the stale-pointer scan (#672 item 2 / #661 item 3).
 *
 * The scan in `tests/bun-exec-alpine-image-ci.test.ts` resolves a BARE test-file
 * reference through a repo-wide index. #661 recorded the hole: a bare reference
 * to a renamed file can be satisfied by a same-named file elsewhere, so the
 * pointer reads as live when it is stale. The fix is to fail closed on an
 * ambiguous basename rather than resolve it.
 *
 * "Fails closed" is a claim about behaviour that does not exist on the clean
 * tree — there is no ambiguous reference to see it fire on — so it is exactly
 * the kind of guard that can be written, merged, and be decoration. This script
 * plants the three references that must be rejected and requires the scan to
 * red on each.
 *
 * The ambiguous basename is DISCOVERED from `git ls-files`, never hardcoded: a
 * hardcoded one becomes a lie the moment the duplicate is renamed away, and the
 * proof would then pass by planting a reference that is no longer ambiguous.
 *
 * Mutations land in `.github/workflows/ci.yml` (a file the scan reads) through
 * the byte-snapshot harness, so restoration is content-addressed and every
 * mutation carries the residue marker.
 *
 * Usage:  node scripts/mutation-prove-stale-pointer-scan.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const SPEC = 'tests/bun-exec-alpine-image-ci.test.ts';
const TEST_NAME = 'a comment or doc names actually exists';

/** The job key the planted comment is anchored above — any scanned line would do. */
const ANCHOR = '  compile-cache-bun-probe:\n';

/** SGR colour codes in vitest's output — see the sibling proof for why not `\x1b`. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

let pass = 0;
let fail = 0;

/** A basename shared by more than one tracked test file, or `null` if none is. */
function anAmbiguousBasename() {
  const index = new Map();
  for (const path of execFileSync('git', ['ls-files', '-z', '*.test.ts'], { cwd: REPO_ROOT })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)) {
    const base = path.split('/').pop();
    index.set(base, (index.get(base) ?? 0) + 1);
  }
  for (const [base, n] of index) if (n > 1) return base;
  return null;
}

function runScan() {
  const res = spawnSync('pnpm', ['exec', 'vitest', 'run', SPEC, '-t', TEST_NAME], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.replace(ANSI, '');
  const passed = Number(out.match(/Tests\s+(\d+) passed/)?.[1] ?? 0);
  const failed = Number(out.match(/Tests\s+.*?(\d+) failed/)?.[1] ?? 0);
  return { ok: res.status === 0, ran: passed + failed };
}

function prove(label, reference) {
  console.log(`── planting: ${label} (${reference})`);
  const snap = snapshot(CI_YML);
  try {
    mutate(snap, ANCHOR, `  # ${reference}\n${ANCHOR}`);
    const { ok, ran } = runScan();
    if (ran === 0) {
      console.error(`   FATAL: no test matching ${JSON.stringify(TEST_NAME)} ran in ${SPEC}`);
      restore(snap);
      process.exit(1);
    }
    if (ok) {
      console.log('   x DECORATION: the scan ACCEPTED a reference it must reject');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
  } finally {
    restore(snap);
  }
  if (!runScan().ok) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

const ambiguous = anAmbiguousBasename();
if (!ambiguous) {
  // Not "skip": the guard's own non-vacuity assertion covers this case and would
  // already be red. Exiting 1 keeps the two from disagreeing.
  console.error('FATAL: no duplicated test basename exists, so the ambiguity cannot be planted');
  process.exit(1);
}

console.log(`Baseline: ${SPEC} must be GREEN before anything is planted.`);
const baseline = runScan();
if (baseline.ran === 0 || !baseline.ok) {
  console.error(`FATAL: ${SPEC} is not green to begin with (ran ${baseline.ran})`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// 1. THE #661 HOLE. A bare reference whose basename exists more than once. Under
//    the old Set-membership index this was accepted, because "something with
//    this name exists" was the only question asked.
prove('an AMBIGUOUS bare reference', ambiguous);

// 2. Regression: the check the ambiguity fix must not have traded away — a bare
//    reference to a file that exists nowhere.
prove('a bare reference to a file that does not exist', 'no-such-file-anywhere.test.ts');

// 3. Regression: a path-qualified reference that does not resolve.
prove('a path-qualified reference that does not resolve', 'tests/no-such-file.test.ts');

console.log(`\n${pass} planted reference(s) were rejected as required, ${fail} were accepted.`);
process.exit(fail === 0 ? 0 : 1);
