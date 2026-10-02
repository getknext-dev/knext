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

declareMutations(20);

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

// M9: aliased-fetch detection (#1787) — reverting `INTERPRETER_FETCH`'s bare
// `fetch` boundary back to the old call-only `fetch\(` spelling must red the
// `const f = fetch; f(url)` alias fixtures (both the followed-script and the
// inline `node -e` shapes).
prove(
  'M9 aliased fetch (bare, non-call) detection (#1787)',
  "    '(?<![\\\\w-])fetch(?![\\\\w-])',",
  "    'fetch\\\\(', // MUTATION: disabled (reverted to call-only form)",
);

// M10: the computed-global-access gate in `classifyJsScript` (#1787) —
// disabling it must red `globalThis["fe" + "tch"](url)`, which never spells
// the literal substring "fetch" for `INTERPRETER_FETCH` to catch on its own.
prove(
  'M10 classifyJsScript computed-global-access gate (#1787)',
  'if (!INTERPRETER_FETCH.test(src) && !hasComputedGlobalAccess(src)) return null;',
  'if (!INTERPRETER_FETCH.test(src)) return null;',
);

// M11: `isSinglePlainLiteral`'s early-close rejection (#1787) — this is what
// makes `hasComputedGlobalAccess` itself work at all; disabling it collapses
// the function to "never computed", redding every computed-access fixture
// AND the two direct unit tests.
prove(
  'M11 hasComputedGlobalAccess single-literal check (#1787)',
  'function isSinglePlainLiteral(s) {',
  'function isSinglePlainLiteral(s) {\n  return true; // MUTATION: disabled',
);

// M12: the needs:+artifact/outputs component link (#1780) — disabling it
// must red both cross-job fixtures (the outputs hand-off and the artifact
// hand-off), which rely on the dependent job's apply opening the gate for
// the fetching job it `needs:`.
prove(
  'M12 needs:+artifact/outputs component linking (#1780)',
  'if (jobsLinkedByArtifactOrOutputs(depJob, depId, job)) union(jobId, depId);',
  'if (false) union(jobId, depId); // MUTATION: disabled',
);

// M13: the `uses:`-only surface check (#1780) — disabling it must red every
// LOCAL composite-action, LOCAL reusable-workflow, and REMOTE
// reusable-workflow fixture (all three rely on `jobUsesSurfaceMightApply`
// to see an apply this scanner otherwise never reads).
prove(
  'M13 uses:-only surface might-apply detection (#1780)',
  'function jobUsesSurfaceMightApply(job, resolveSource, visited) {',
  'function jobUsesSurfaceMightApply(job, resolveSource, visited) {\n  return false; // MUTATION: disabled',
);

// M14: the KNOWN_NON_APPLYING_ACTIONS exemption (#1780) — disabling it
// (treating every remote action as "might apply") must red the GREEN
// control that a uses:-only job calling a known-safe remote action (e.g.
// `aquasecurity/trivy-action`) stays clean.
prove(
  'M14 KNOWN_NON_APPLYING_ACTIONS exemption (#1780)',
  'return !KNOWN_NON_APPLYING_ACTIONS.has(base);',
  'return true; // MUTATION: disabled',
);

// M15 (#1801 round 3, fix 1): the uses: surface is now checked WHETHER OR
// NOT the job also has run: steps — disabling that (reverting to "only a
// job with uses: steps and NO run: steps is checked") must red the mixed
// run:+uses: fixture.
prove(
  'M15 uses: surface checked on jobs that ALSO have run: steps (#1801 fix 1)',
  `function jobUsesSurfaceMightApply(job, resolveSource, visited) {
  if (typeof job?.uses === 'string') {`,
  `function jobUsesSurfaceMightApply(job, resolveSource, visited) {
  if ((job?.steps ?? []).some((s) => typeof s?.run === 'string')) return false; // MUTATION: disabled
  if (typeof job?.uses === 'string') {`,
);

// M16 (#1801 round 3, fix 2): docker:// steps fail CLOSED unconditionally —
// disabling that (reverting to "docker:// is always non-applying") must red
// the no-args docker:// fixture.
prove(
  'M16 docker:// steps fail closed unconditionally (#1801 fix 2)',
  "if (uses.startsWith('docker://')) return dockerStepMightApply(s);",
  "if (uses.startsWith('docker://')) return false; // MUTATION: disabled",
);

// M17 (#1801 round 3, fix 3): a LOCAL uses: target is followed RECURSIVELY
// — disabling the recursive call (treating every local target as if it
// never itself calls anything) must red the two-hop composite-wrapping
// fixture.
prove(
  'M17 local uses: followed recursively (#1801 fix 3)',
  "if (typeof s?.uses === 'string' && usesStepMightApply(s, resolveSource, visited)) return true;",
  'if (false) return true; // MUTATION: disabled',
);

// M18 (#1801 round 3, fix 3): an unresolvable local uses: target fails
// CLOSED — disabling that (reverting to fail OPEN) must red the
// unresolvable-path fixture.
prove(
  'M18 unresolvable local uses: fails closed (#1801 fix 3)',
  'if (!doc) return true; // unresolvable — fail closed',
  'if (!doc) return false; // MUTATION: disabled',
);

// M19 (#1801 round 3, fix 4): the Reflect.get(globalThis, computedKey)
// shape — disabling the whole reflectRe loop must red the Reflect.get
// fixture while leaving the bracket-access fixtures (a separate loop)
// unaffected.
prove(
  'M19 Reflect.get(globalThis, computedKey) detection (#1801 fix 4)',
  'for (const m of text.matchAll(reflectRe)) {',
  'for (const m of []) {',
);

// M20 (#1801 round 3, fix 5): changesets/action's with: script inputs are
// scanned (instead of the action being a blanket allowlist exemption) —
// disabling the dynamic-expression fail-closed check must red the dynamic
// publish-script fixture.
prove(
  'M20 changesets/action with: script fail-closed on dynamic expression (#1801 fix 5)',
  'if (/\\$\\{\\{/.test(v)) return true; // a dynamic expression — cannot verify, fail closed',
  'if (false) return true; // MUTATION: disabled',
);

const declared = 20;
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
