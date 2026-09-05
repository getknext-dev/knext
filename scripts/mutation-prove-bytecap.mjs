#!/usr/bin/env node
/**
 * Mutation proof for the ADR-0044 Option C request byte cap.
 *
 * The control is four lines of wiring, which is exactly the shape that ships
 * green and unenforced. Every way it could be decoration is planted here:
 *
 *   1. the app serve site loses `maxRequestBodySize` — the cap itself;
 *   2. the `:9464` metrics serve site loses it, which is the co-resident-pod
 *      path ADR-0044's threat scope names and the half most likely to be
 *      "obviously fine";
 *   3. the metrics cap is wired to the APP's resolved value, so
 *      `KNEXT_MAX_REQUEST_BYTES=0` silently re-opens it — a mutation that leaves
 *      the option present, so a "does the word appear" check passes it;
 *   4. the env override stops being read — the knob becomes a lie;
 *   5. an INVALID value uncaps instead of falling back to the default. The
 *      security-relevant direction: a manifest typo must not remove a control;
 *   6. the Bun build floor drops below 1.4.0. MEASURED: on 1.3.5 an oversize
 *      CHUNKED body reaches the handler with a 200 while the same body with a
 *      Content-Length is 413, so below the floor the cap stops being
 *      counted-bytes and ADR-0044 Decision 4 is not met;
 *   7. DISCOVERY breaks. The failure an exit-code-only check cannot see: an
 *      audit over zero discovered serve sites reports zero findings and reads as
 *      a clean tree.
 *
 * It spawns NOTHING, for the reason `mutation-prove-entry-copy-parity.mjs`
 * gives: `tests/request-byte-cap.test.ts` is a thin wrapper over
 * `auditRequestByteCap`, so proving the audit proves the guard, and the prover
 * lane cannot launch a `bun:test` spec through the vitest resolver until #902
 * lands.
 *
 * WHAT THIS DOES NOT PROVE, stated rather than left to be assumed: the
 * behavioural half (`examples/bun-exec/test/request-byte-cap.test.ts`, which
 * sends real oversize bodies over real sockets) is not driven here. It is not
 * unguarded — the harness it boots is a DISCOVERED serve site, so mutations 1-3
 * below red the wiring audit for the harness as well as the templates — but the
 * 413 itself is proved by that spec running, not by this prover. Wire it in when
 * the lane can dispatch a bun:test spec.
 *
 * Usage:  node scripts/mutation-prove-bytecap.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';
import { auditRequestByteCap } from './lib/request-byte-cap.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = resolve(REPO_ROOT, 'scripts/lib/request-byte-cap.mjs');
const ENTRY_TEMPLATE = resolve(REPO_ROOT, 'packages/kn-next/templates/app/knext-bun-entry.mjs.hbs');
const CONTRACT_TEMPLATE = resolve(
  REPO_ROOT,
  'packages/kn-next/templates/app/runtime-contract.mjs.hbs',
);
const HARNESS = resolve(REPO_ROOT, 'examples/bun-exec/test/srvx-close-harness.mjs');
const BUN_FLOOR = resolve(REPO_ROOT, 'packages/kn-next/src/cli/vinext-build.ts');

declareMutations(7);

let pass = 0;
let fail = 0;
let bust = 0;

const audit = () => auditRequestByteCap({ repoRoot: REPO_ROOT });

/**
 * Case 7 mutates the CHECKER, and an ESM module is evaluated once — so that case
 * re-imports through a cache-busting URL. Reading the mutated file back through
 * the same module object would prove nothing.
 */
async function auditFresh() {
  bust += 1;
  const fresh = await import(`${pathToFileURL(CHECKER).href}?bust=${bust}`);
  return fresh.auditRequestByteCap({ repoRoot: REPO_ROOT });
}

/**
 * Plant a mutation and require a finding that MATCHES — never merely "some
 * finding". A guard that reds for the wrong reason will red for the wrong reason
 * in CI too.
 */
async function prove(label, file, anchor, replacement, expect, { fresh = false, ...opts } = {}) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(file);
  let findings = [];
  try {
    mutate(snap, anchor, replacement, opts);
    findings = fresh ? await auditFresh() : await audit();
  } finally {
    restore(snap);
  }
  const hit = findings.find((f) => expect.test(f));
  if (hit) {
    console.log(`   ok reported: ${hit.slice(0, 140)}…`);
    pass += 1;
  } else {
    console.log(`   x DECORATION: no finding matched ${expect}`);
    console.log(`     findings were: ${JSON.stringify(findings, null, 2)}`);
    fail += 1;
  }
  recordMutation();

  const after = await audit();
  if (after.length !== 0) {
    console.error('   FATAL: the audit is not clean again after restore');
    console.error(after);
    process.exit(1);
  }
}

console.log('Baseline: the tree must be CLEAN before anything is mutated.');
{
  const baseline = await audit();
  if (baseline.length !== 0) {
    console.error('FATAL: the byte-cap audit is already red — nothing here would prove anything');
    console.error(baseline);
    process.exit(1);
  }
}
console.log('   ok baseline clean\n');

// 1. THE CAP ITSELF, removed from the app listener in the canonical template.
await prove(
  'the app serve site loses maxRequestBodySize',
  ENTRY_TEMPLATE,
  '  maxRequestBodySize: REQUEST_CAP.bytes,\n',
  '',
  /knext-bun-entry\.mjs\.hbs: the srvx serve call .* does not set maxRequestBodySize/,
  // The anchor sits in a `.hbs` file, which the harness has no comment syntax
  // for — so the residue marker's prefix is supplied here.
  { commentPrefix: '//' },
);

// 2. The :9464 half. Its default is Bun's 128 MB, on the exact path ADR-0044
//    §Threat scope calls unbounded, so "it only answers a GET" is not a reason.
await prove(
  'the :9464 metrics serve site loses maxRequestBodySize',
  ENTRY_TEMPLATE,
  '  maxRequestBodySize: METRICS_MAX_REQUEST_BYTES,\n',
  '',
  /knext-bun-entry\.mjs\.hbs: the Bun\.serve call .* does not set maxRequestBodySize/,
  // The anchor sits in a `.hbs` file, which the harness has no comment syntax
  // for — so the residue marker's prefix is supplied here.
  { commentPrefix: '//' },
);

// 3. The subtle one: the option is STILL THERE, so any "is the word present"
//    check passes — but `KNEXT_MAX_REQUEST_BYTES=0` now uncaps metrics too.
await prove(
  'the metrics cap is wired to the app’s resolved value, so 0 re-opens it',
  ENTRY_TEMPLATE,
  '  maxRequestBodySize: METRICS_MAX_REQUEST_BYTES,\n',
  '  maxRequestBodySize: REQUEST_CAP.bytes,\n',
  /Bun\.serve \(:9464 metrics\) call sets maxRequestBodySize to .* instead of METRICS_MAX_REQUEST_BYTES/,
  // The anchor sits in a `.hbs` file, which the harness has no comment syntax
  // for — so the residue marker's prefix is supplied here.
  { commentPrefix: '//' },
);

// 4. The knob stops being read. The cap still exists, at the default, forever —
//    an operator who sets the env sees no effect and no error.
await prove(
  'resolveMaxRequestBytes stops reading the env',
  CONTRACT_TEMPLATE,
  '  const raw = env[MAX_REQUEST_BYTES_ENV];\n',
  '  const raw = undefined;\n',
  /a positive KNEXT_MAX_REQUEST_BYTES override: expected 4096/,
  // The anchor sits in a `.hbs` file, which the harness has no comment syntax
  // for — so the residue marker's prefix is supplied here.
  { commentPrefix: '//' },
);

// 5. An invalid value uncaps instead of falling back. This is the direction that
//    matters: a typo in a manifest must never remove the control silently.
await prove(
  'an invalid value uncaps instead of falling back to the default',
  CONTRACT_TEMPLATE,
  "      bytes: DEFAULT_MAX_REQUEST_BYTES,\n      metricsBytes,\n      source: 'invalid',\n",
  "      bytes: undefined,\n      metricsBytes,\n      source: 'invalid',\n",
  /KNEXT_MAX_REQUEST_BYTES="abc" must fall back to the default/,
  // The anchor sits in a `.hbs` file, which the harness has no comment syntax
  // for — so the residue marker's prefix is supplied here.
  { commentPrefix: '//' },
);

// 6. The runtime floor that makes the cap COUNTED bytes rather than a trusted
//    Content-Length. Lowering it downgrades a security control silently.
await prove(
  'the vinext Bun floor drops below 1.4.0',
  BUN_FLOOR,
  'export const MIN_BUN_MINOR = 4;',
  'export const MIN_BUN_MINOR = 3;',
  /bun floor: .* allows Bun 1\.3, below 1\.4\.0/,
);

// 7. DISCOVERY breaks — zero serve sites found means zero findings means
//    "clean". The one case an exit-code-only check cannot see.
await prove(
  'the serve-site scan discovers nothing (the vacuous-green case)',
  CHECKER,
  'const SCANNED_EXT = /\\.(mjs|js|ts|mjs\\.hbs|js\\.hbs|ts\\.hbs)$/;',
  'const SCANNED_EXT = /$^/;',
  /the scan did not discover .* discovery is broken/,
  { fresh: true },
);

// The cap's own subject must be back exactly as it was — a prover that leaves
// residue in the templates it audits would poison the next run and, worse, could
// ship an uncapped entry.
{
  const final = await audit();
  if (final.length !== 0) {
    console.error('FATAL: residue left behind — restore is broken');
    console.error(final);
    process.exit(1);
  }
  // `git status` cannot see residue inside a file the PR legitimately modifies,
  // which is how the inverse of a fix has nearly shipped here twice. So assert
  // the harness the behavioural e2e boots still carries BOTH caps by name.
  const { serveCalls } = await import('./lib/request-byte-cap.mjs');
  const { readFileSync } = await import('node:fs');
  const calls = serveCalls(readFileSync(HARNESS, 'utf8'));
  if (calls.length !== 2 || !calls.every((c) => c.hasCap)) {
    console.error('FATAL: the srvx harness lost a cap during the run');
    process.exit(1);
  }
}

console.log(`\nmutations proved: ${pass}  decoration found: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
