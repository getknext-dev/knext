#!/usr/bin/env node
/**
 * Mutation proof for the tech-debt closures on `scripts/lib/apply-safety-scan.mjs`
 * (#1466, #1512): heredoc -> file -> apply, an `envsubst` pipeline, `kubectl
 * patch -p`/`--patch`/`--patch-file`, `kubectl set env`, and following a
 * `node <file>.mjs` / `bun <file>.mjs` invocation to classify the fetches it
 * moved out of shell text. `eval` was already covered (round-4 `execString`)
 * and is not re-proven here.
 *
 * Each mutation removes ONE rule `tests/apply-safety-scan-tech-debt.test.ts`
 * claims to enforce and requires that spec to go RED; the file is then
 * restored byte-identically to its GREEN baseline. Verdicts come from the
 * spec's exit code only — never from grepping its output.
 *
 * Usage: node scripts/mutation-prove-apply-safety-tech-debt.mjs
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
const SPEC = 'tests/apply-safety-scan-tech-debt.test.ts';

declareMutations(6);

readFileSync(SCANNER, 'utf8'); // FATAL if missing, before anything is mutated

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

function prove(name, anchor, replacement) {
  const snap = snapshot(SCANNER);
  try {
    mutate(snap, anchor, replacement);
    const red = !specPasses();
    if (red) {
      caught++;
      console.log(`   [caught] ${name}`);
    } else {
      decorative++;
      console.log(`   [DECORATIVE] ${name}: spec stayed green with this rule removed`);
    }
    recordMutation();
  } finally {
    restore(snap);
  }
}

if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green at baseline — fix it before mutating`);
  process.exit(1);
}

// M1: heredoc -> file -> apply (#1466.1) — disable the heredoc-network check
// in the write loop's readsNetwork computation.
prove(
  'M1 heredoc-network write taint (#1466.1)',
  'const heredocNetwork = ws.some((w) => {',
  'const heredocNetwork = false && ws.some((w) => {',
);

// M2: envsubst pipeline (#1466.2) — disable the envsubst-substitutes-exported-
// content rule.
prove(
  'M2 envsubst substitutes exported network content (#1466.2)',
  "if (envsubstBase === 'envsubst') {",
  "if (false && envsubstBase === 'envsubst') {",
);

// M3: kubectl patch -p / --patch (#1466.3) — disable the patch-body check.
prove(
  'M3 kubectl patch body taint (#1466.3)',
  "if (w === '-p' || w === '--patch') {",
  "if (false && (w === '-p' || w === '--patch')) {",
);

// M4: kubectl set env (#1466.3) — disable the set-env value check.
prove(
  'M4 kubectl set env value taint (#1466.3)',
  "const setIdx = u.findIndex((w, i) => w === 'set' && u[i + 1] === 'env');",
  'const setIdx = -1; // MUTATION: disabled',
);

// M5: node/bun <file>.mjs following, non-loopback host (#1512) — disable
// host-literal checking so a non-loopback host is silently accepted.
prove(
  'M5 non-loopback host literal detection (#1512)',
  "if (!isLoopbackHost(m[2])) return `${path}: fetch to non-loopback host '${m[2]}'`;",
  "if (false) return `${path}: fetch to non-loopback host '${m[2]}'`;",
);

// M6: node/bun <file>.mjs following, fail-closed on unresolvable script
// (#1512) — disable the unresolved-script report.
prove(
  'M6 fail-closed on an unresolved node/bun script (#1512)',
  'if (rawSrc === null || rawSrc === undefined)\n    return `node/bun script ${path} could not be resolved to classify its fetches`;',
  'if (false) return `unreachable`; // MUTATION: disabled',
);

const declared = 6;
console.log(`\n${caught}/${declared} mutations caught, ${decorative} decorative.`);
if (decorative > 0 || caught !== declared) {
  console.error('Mutation proof FAILED: at least one rule is decorative or missing.');
  process.exit(1);
}
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green after restore — a mutation was not fully undone`);
  process.exit(1);
}
console.log('All tech-debt apply-safety mutations proven; spec is green at baseline.');
