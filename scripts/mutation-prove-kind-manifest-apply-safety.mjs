#!/usr/bin/env node
/**
 * Mutation proof for the kind-manifest apply-safety guard (#1289, #1410).
 *
 * `tests/kind-manifest-checksum-pin.test.ts` drives
 * `scripts/lib/apply-safety-scan.mjs` over every tracked script and workflow
 * and over one fixture set per reviewer bypass class, and drives
 * `scripts/kind-manifests/pin-known-images.sh` against evasive manifests.
 * Each mutation below removes ONE rule the spec claims to enforce and
 * requires the spec to go RED; the file is then restored byte-identically
 * and the spec must be GREEN again. Verdicts come from the spec's exit code
 * only — never from grepping its output.
 *
 * One mutation per bypass class the #1410 reviewer named (and per rule the
 * round-4 lexer added to close them):
 *   class 1 — fetch spellings / helpers:   M1 M2 M3
 *   class 2 — bare URLs / invokers / streams: M4 M5 M6
 *   class 3 — defeated or non-dominating checksum: M7 M8 M9 M10
 *   fail closed on the unclassifiable:      M11
 *   loopback exemption stays strict:       M12
 *   class 4 — pin-known-images evasions:    M13 M14
 *
 * Usage:  node scripts/mutation-prove-kind-manifest-apply-safety.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNER = resolve(REPO_ROOT, 'scripts/lib/apply-safety-scan.mjs');
const PIN_SCRIPT = resolve(REPO_ROOT, 'scripts/kind-manifests/pin-known-images.sh');
const SPEC = 'tests/kind-manifest-checksum-pin.test.ts';

declareMutations(14);

// Both subjects must exist before anything is mutated: a missing one is a
// FATAL throw here, never fourteen vacuous reds.
readFileSync(SCANNER, 'utf8');
readFileSync(PIN_SCRIPT, 'utf8');

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never grepped output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

let caught = 0;
let decorative = 0;

/** Applies one mutation to `file`, requires RED, restores, requires GREEN. */
function prove(label, file, anchor, replacement) {
  console.log(`── ${label}`);
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with this rule removed');
      decorative += 1;
    } else {
      console.log('   ok went RED as required');
      caught += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// class 1 — fetch spellings / helpers
prove(
  'M1 class 1: fetch output flags (-o/-fsSLo/--output=/-O/wget) no longer recorded',
  SCANNER,
  '    if (!isFetch) continue;',
  '    if (!isFetch || true) continue;',
);
prove(
  'M2 class 1: helper functions no longer inlined at their call sites',
  SCANNER,
  '  walk(substituteArgs(body, argVals), st, callCtx);',
  '  void callCtx;',
);
prove(
  'M3 class 1: files a fetch writes are no longer tainted',
  SCANNER,
  '      for (const p of writtenPaths(ws, st, isFetch)) {',
  '      for (const p of []) {',
);

// class 2 — bare URLs / invokers / streams
prove(
  'M4 class 2: apply recognised only after a literal `kubectl`',
  SCANNER,
  '    if (APPLY_VERBS.has(ws[k])) {',
  "    if (APPLY_VERBS.has(ws[k]) && ws[k - 1] === 'kubectl') {",
);
prove(
  'M5 class 2: a URL (or URL variable) apply target is no longer rejected',
  SCANNER,
  '  if (URL_RE.test(c) || varRefs(raw).some((r) => st.vars.get(r)?.url)) {',
  '  if (false) {',
);
prove(
  'M6 class 2: a stdin apply fed by network content is no longer rejected',
  SCANNER,
  '    if (why) offend(st, `stdin apply fed by network content (${why})`, clause);',
  '    void why;',
);

// class 3 — defeated or non-dominating checksum
prove(
  'M7 class 3: a checksum run without errexit (set +e / no set -e) counts',
  SCANNER,
  '      !st.errexit ||',
  '      false ||',
);
prove(
  'M8 class 3: a checksum that is not the head of its && list counts',
  SCANNER,
  "      endsChain: !['&&', '||'].includes(cl.sepAfter) && ci === chainStart,",
  "      endsChain: !['&&', '||'].includes(cl.sepAfter),",
);
prove(
  'M9 class 3: a checksum of ANY file clears every fetched file',
  SCANNER,
  '  if (hits.length > 0) {',
  '  if (hits.length > 0 && st.verified.size === 0) {',
);
prove(
  'M10 class 3: a checksum inside a control block covers applies outside it',
  SCANNER,
  "  return v.block === '' || here === v.block || here.startsWith(`${v.block}/`);",
  '  return true;',
);

// fail closed
prove(
  'M11 fail closed: a stdin apply with no producer passes',
  SCANNER,
  "      offend(st, 'unclassifiable stdin apply (no producer in this source)', clause);",
  '      void clause;',
);

// loopback exemption strictness
prove(
  'M12 loopback: a URL nested inside a loopback URL is treated as loopback',
  SCANNER,
  "  return LOOPBACK_URL.test(u) && u.split('://').length === 2 && !/\\$/.test(u.split('/')[2]);",
  "  return LOOPBACK_URL.test(u) && !/\\$/.test(u.split('/')[2]);",
);

// class 4 — pin-known-images evasions
prove(
  'M13 class 4: only the FIRST image key on a line is judged',
  PIN_SCRIPT,
  '  while [[ "$rest" =~ $image_key_re ]]; do',
  '  for _once in 1; do [[ "$rest" =~ $image_key_re ]] || break',
);
prove(
  'M14 class 4: any value merely containing "@sha256:" counts as pinned',
  PIN_SCRIPT,
  'digest_pinned() { [[ "$1" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; }',
  'digest_pinned() { [[ "$1" == *@sha256:* ]]; }',
);

console.log(`\n${caught} caught, ${decorative} undetected.`);
if (decorative > 0) {
  console.error(
    'At least one apply-safety rule is decoration — the spec does not notice it removed.',
  );
  process.exit(1);
}
