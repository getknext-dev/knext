#!/usr/bin/env node
/**
 * Mutation proof for the #645 guards — and a dogfood of the harness they ship.
 *
 * A guard that stays green when the behaviour it protects is removed is
 * decoration, so this deletes each protected behaviour in turn and requires the
 * corresponding test to go RED. It restores from a BYTE SNAPSHOT using the very
 * helper it is proving (scripts/lib/mutation-harness.mjs), which is the honest
 * way to demonstrate the helper: if the snapshot restore were wrong, this script
 * would leave residue and the scan it just proved would catch it.
 *
 * Step 3 is the point of the whole issue: it plants residue in a file that is
 * ALSO legitimately modified, shows `git status --porcelain` reporting exactly the
 * same thing as for the honest edit alone, and shows the scan going red anyway.
 *
 * Usage:  node scripts/mutation-prove-residue-scan.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { scanForResidue } from './scan-mutation-residue.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNER = resolve(REPO_ROOT, 'scripts/scan-mutation-residue.mjs');
const HARNESS = resolve(REPO_ROOT, 'scripts/lib/mutation-harness.mjs');

let pass = 0;
let fail = 0;

function vitest(spec) {
  const r = spawnSync('pnpm', ['exec', 'vitest', 'run', spec], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

/** The test must be RED while the behaviour is removed, and GREEN once restored. */
function prove(label, file, anchor, replacement, spec) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement);
    if (vitest(spec)) {
      console.log('   x DECORATION: the test stayed GREEN with the behaviour removed');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
  } finally {
    restore(snap);
  }
  if (!vitest(spec)) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log('Baseline: both guards must be GREEN before anything is mutated.');
for (const spec of ['tests/mutation-residue-scan.test.ts', 'tests/mutation-harness.test.ts']) {
  if (!vitest(spec)) {
    console.error(`FATAL: ${spec} is not green to begin with`);
    process.exit(1);
  }
}
console.log('   ok baseline green\n');

// 1. Delete the scan's actual matching. If it stops looking for the marker it can
//    never fire, which is the decoration case for proposal A.
prove(
  'scan: stop matching the marker',
  SCANNER,
  '    const idx = text.indexOf(MUTATION_MARKER);',
  '    const idx = -1;',
  'tests/mutation-residue-scan.test.ts',
);

// 2. Delete the snapshot restore. Without it the harness cannot put the bytes
//    back, which is precisely incident 2's failure mode (proposal B).
prove(
  'harness: never write the snapshotted bytes back',
  HARNESS,
  '  writeFileSync(snap.path, snap.bytes);',
  '  /* restore removed */',
  'tests/mutation-harness.test.ts',
);

// 3. Delete the anchor-count refusal. A harness that mutates on a 0- or N-match
//    anchor produces a green run that proves nothing.
// The anchor spans the whole refusal INCLUDING its message, because the two-line
// head of it also appears in assertAnchorOnce — the harness refused a shorter
// anchor here for occurring twice, which is the refusal doing its job.
prove(
  'harness: mutate without asserting the anchor occurs exactly once',
  HARNESS,
  [
    '  const n = countOccurrences(src, anchor);',
    '  if (n !== 1) {',
    '    throw new MutationHarnessError(',
    '      `anchor occurs ${n} times in ${snap.path} (expected exactly 1): ${JSON.stringify(anchor)}`,',
    '    );',
    '  }',
  ].join('\n'),
  [
    '  const n = 1;',
    '  if (n !== 1) {',
    '    throw new MutationHarnessError("unreachable");',
    '  }',
  ].join('\n'),
  'tests/mutation-harness.test.ts',
);

// 4. THE ISSUE ITSELF: residue inside a legitimately-modified file.
console.log('── git-status blindness: residue inside a legitimately modified file');
const subject = resolve(REPO_ROOT, 'CONTRIBUTING.md');
const relSubject = 'CONTRIBUTING.md';
const snap = snapshot(subject);
try {
  const statusOf = () =>
    execFileSync('git', ['status', '--porcelain', '--', relSubject], { cwd: REPO_ROOT })
      .toString()
      .trim();

  const before = statusOf();

  // An honest edit of the kind a PR makes.
  appendFileSync(subject, '\n<!-- an honest edit this PR intends -->\n');
  const honest = statusOf();
  console.log(`   git status after the honest edit:   ${JSON.stringify(honest)}`);

  // Now residue hiding inside it.
  mutate(snap, '## Mutation-proving a guard', '## Mutation-proving a guard');
  const withResidue = statusOf();
  console.log(`   git status with residue added:      ${JSON.stringify(withResidue)}`);

  void before;
  if (honest !== withResidue) {
    console.log('   x git status DID distinguish the two — the premise of #645 does not hold here');
    fail += 1;
  } else {
    console.log('   ok git status is BLIND: identical report either way');
    pass += 1;
  }

  const offenders = scanForResidue({ cwd: REPO_ROOT });
  const hit = offenders.find((o) => o.path === relSubject);
  if (hit) {
    console.log(`   ok scan RED where git status was blind: ${hit.path}:${hit.line}`);
    pass += 1;
  } else {
    console.log('   x DECORATION: the scan did not fire on planted residue');
    fail += 1;
  }
} finally {
  restore(snap);
}

const after = scanForResidue({ cwd: REPO_ROOT });
if (after.length !== 0) {
  console.error('FATAL: this proof left residue behind — restore is broken');
  console.error(after);
  process.exit(1);
}
if (readFileSync(subject, 'utf8').includes('an honest edit this PR intends')) {
  console.error('FATAL: the honest edit was not rolled back');
  process.exit(1);
}
console.log('   ok tree clean after restore\n');

console.log(`mutations proved: ${pass}  decoration found: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
