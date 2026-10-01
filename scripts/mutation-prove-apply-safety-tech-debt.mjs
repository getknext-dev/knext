#!/usr/bin/env node
/**
 * Mutation proof for the tech-debt closures on `scripts/lib/apply-safety-scan.mjs`
 * (#1466, #1512, #1715): heredoc -> file -> apply, an `envsubst` pipeline,
 * `kubectl patch -p`/`--patch`/`--patch-file`, `kubectl set env`, following a
 * `node <file>.mjs` / `bun <file>.mjs` invocation to classify the fetches it
 * moved out of shell text, and (round 2) the lexical tokenizer that decides
 * which parts of a followed script are a real comment/`new URL(…)` call vs.
 * string/template data that merely looks like one, plus its independent
 * tokenizer-uncertainty fail-closed check. `eval` was already covered
 * (round-4 `execString`) and is not re-proven here.
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

declareMutations(8);

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

// M7: `stripNonFetchText` string-awareness (#1715 round 2) — disabling the
// tokenizer's own notion of "which lexical context is this character in"
// (forcing every character to be treated as plain code) reproduces the
// round-2 bug: the decoy ("/* " then a real fetch() then "*/" as three
// ordinary statements) is read as one comment and the fetch is swallowed.
prove(
  'M7 stripNonFetchText string-awareness (#1715 round 2)',
  'const ctx = top();',
  "const ctx = 'code';",
);

// M8: the tokenizer-uncertainty fail-closed check (#1715 round 2) — this is
// INDEPENDENT of M7: even with a perfectly string-aware tokenizer, a file
// that cannot be tokenized unambiguously at all (unterminated string/
// template/comment/regex) must still fail closed. Disabling just the
// `!clean` check (leaving the tokenizer itself untouched) must still red
// the "unterminated template literal" fixture, which has no visible
// INTERPRETER_FETCH shape for any other rule to catch.
prove(
  'M8 tokenizer-uncertainty fail-closed check (#1715 round 2)',
  'if (!clean)\n    return `${path}: could not tokenize unambiguously (unterminated string/template/comment/regex) — fail closed`;',
  'if (false) return `unreachable`; // MUTATION: disabled',
);

const declared = 8;
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
