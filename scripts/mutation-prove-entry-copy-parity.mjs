#!/usr/bin/env node
/**
 * Mutation proof for the #911 runtime-entry copy pin.
 *
 * A guard that stays green when the drift it exists to catch is reintroduced is
 * decoration, and this one is exposed to FOUR distinct ways of being decoration
 * — not just "a copy drifted". Each is planted here and each must be reported:
 *
 *   1. a checked-in copy drifts from the template (the #911 defect itself);
 *   2. the RECORDED divergence (`examples/bun-exec`) drifts one line further —
 *      an exemption without a byte pin is a hole that widens quietly;
 *   3. the canonical template loses the generated-by header the strip is
 *      anchored on, which would turn the strip into a silent no-op;
 *   4. DISCOVERY breaks. This is the one an exit-code-only check would miss
 *      entirely: an audit over zero discovered files reports zero findings and
 *      reads as a clean tree. So the walker is neutered and the guard must
 *      report that it is broken, rather than pass vacuously.
 *
 * It spawns NOTHING. The `tests/runtime-entry-copy-parity.test.ts` assertions
 * are a thin wrapper over `auditRuntimeEntryCopies`, so proving the audit is
 * proving the guard — and delegating instead of spawning keeps this prover
 * clean under the lane's runner-resolution audit (`scripts/lib/prover-lane.mjs`)
 * without pretending a `bun:test` spec can be launched through the vitest
 * resolver (#902).
 *
 * Usage:  node scripts/mutation-prove-entry-copy-parity.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';
import { auditRuntimeEntryCopies } from './lib/runtime-entry-copies.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = resolve(REPO_ROOT, 'scripts/lib/runtime-entry-copies.mjs');

declareMutations(4);

let pass = 0;
let fail = 0;
let bust = 0;

const audit = () => auditRuntimeEntryCopies({ repoRoot: REPO_ROOT });

/**
 * The checker is mutated in case 4, and an ESM module is evaluated once — so
 * that case re-imports through a cache-busting URL. Reading the mutated file
 * back through the SAME module object would prove nothing.
 */
async function auditFresh() {
  bust += 1;
  const fresh = await import(`${pathToFileURL(CHECKER).href}?bust=${bust}`);
  return fresh.auditRuntimeEntryCopies({ repoRoot: REPO_ROOT });
}

/**
 * Plant a mutation and require the audit to report a finding that MATCHES —
 * not merely "some finding". A guard that reds for the wrong reason is a guard
 * that will red for the wrong reason in CI too.
 */
async function prove(label, file, anchor, replacement, expect, { fresh = false, ...opts } = {}) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(file);
  let findings = [];
  try {
    mutate(snap, anchor, replacement, opts);
    findings = fresh ? await auditFresh() : audit();
  } finally {
    restore(snap);
  }
  if (findings.some((f) => expect.test(f))) {
    console.log(`   ok reported: ${findings.find((f) => expect.test(f)).slice(0, 120)}…`);
    pass += 1;
  } else {
    console.log(`   x DECORATION: no finding matched ${expect}`);
    console.log(`     findings were: ${JSON.stringify(findings, null, 2)}`);
    fail += 1;
  }
  recordMutation();

  const after = audit();
  if (after.length !== 0) {
    console.error('   FATAL: the audit is not clean again after restore');
    console.error(after);
    process.exit(1);
  }
}

console.log('Baseline: the tree must be CLEAN before anything is mutated.');
{
  const baseline = audit();
  if (baseline.length !== 0) {
    console.error('FATAL: the copy pin is already red — nothing here would prove anything');
    console.error(baseline);
    process.exit(1);
  }
}
console.log('   ok baseline clean\n');

// 1. THE DEFECT ITSELF: a checked-in copy gains a line the template does not
//    have. This is exactly the shape the image intercept had for months.
await prove(
  'a checked-in copy drifts from the template',
  resolve(REPO_ROOT, 'apps/file-manager/knext-bun-entry.mjs'),
  'const PORT = Number(process.env.PORT ?? 3000);',
  'const PORT = Number(process.env.PORT ?? 3001);',
  /apps\/file-manager\/knext-bun-entry\.mjs differs from/,
);

// 2. The RECORDED divergence drifts further. Without the byte pin, an exemption
//    means "this file is no longer compared to anything", which is how a
//    documented exception becomes an unguarded one.
await prove(
  'the recorded divergence drifts one line further',
  resolve(REPO_ROOT, 'examples/bun-exec/knext-bun-entry.mjs'),
  'const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);',
  'const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9092);',
  /examples\/bun-exec\/knext-bun-entry\.mjs is a RECORDED divergence whose bytes changed/,
);

// 3. The header the strip is anchored on disappears from the canonical
//    template. The comparison would still "work" — it would just start
//    comparing a header against nothing and report every copy, or (worse, if
//    the strip were loosened to compensate) silently allow a real divergence.
await prove(
  'the canonical template loses the generated-by header',
  resolve(REPO_ROOT, 'packages/kn-next/templates/app/knext-bun-entry.mjs.hbs'),
  ' * GENERATED BY the knext app scaffolder — `turbo gen zone` (in this repo) or',
  ' * Emitted by the scaffolder.',
  /no longer carries the generated-by header/,
  // The anchor sits inside a JSDoc block in a `.hbs` file, which the harness has
  // no comment syntax for — so the residue marker's prefix is supplied here.
  { commentPrefix: ' *' },
);

// 4. DISCOVERY breaks. The failure an exit-code-only check cannot see: zero
//    files discovered means zero findings means "clean".
await prove(
  'the scan discovers nothing (the vacuous-green case)',
  CHECKER,
  "export const COPY_BASENAMES = ['knext-bun-entry.mjs', 'runtime-contract.mjs'];",
  'export const COPY_BASENAMES = [];',
  /the scan did not discover .* discovery is broken/,
  { fresh: true },
);

// The pin's own subject must be back exactly as it was — a prover that leaves
// residue in the very files it compares would poison the next run.
{
  const final = audit();
  if (final.length !== 0) {
    console.error('FATAL: residue left behind — restore is broken');
    console.error(final);
    process.exit(1);
  }
  if (
    !readFileSync(join(REPO_ROOT, 'apps/file-manager/knext-bun-entry.mjs'), 'utf8').includes(
      'import sharp from',
    )
  ) {
    console.error('FATAL: the image direct-pass did not survive the restore');
    process.exit(1);
  }
}

console.log(`\nmutations proved: ${pass}  decoration found: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
