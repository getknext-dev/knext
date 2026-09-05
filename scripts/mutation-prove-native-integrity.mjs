#!/usr/bin/env node
/**
 * Mutation proof for #907's native-tree integrity pin (sprint 2, lane G — G3).
 *
 * WHAT #907 CLAIMED, AND WHY IT NEEDS PROVING
 * -------------------------------------------
 * sharp's addon cannot live inside the compiled binary — a Bun executable
 * resolves modules only from its own embedded graph, and the OS cannot `dlopen` a
 * library from a path inside an executable — so the `.node` ships as a REAL FILE
 * beside the binary and is opened by absolute path. That is a native-code
 * `dlopen` of a file the image copies in, which makes the whole `native/`
 * directory a supply-chain surface with no package manager in front of it.
 *
 * #907's answer is a manifest written at build time from the LOCKFILE and
 * verified at `dlopen` time. Its claims, each of which fails silently if wrong:
 *
 *   1. staged @img packages with NO lockfile is a build FAILURE, not a warning.
 *      A tree nobody can pin is the injected-dependency case exactly.
 *   2. a staged package the lockfile never resolved is a FAILURE.
 *   3. a staged VERSION that disagrees with the lockfile is a FAILURE — the
 *      store and the lockfile disagreeing is not something to ship the
 *      difference of.
 *   4. the manifest records every file's sha256, and cannot hash itself or leak
 *      a previous build's record into the new one.
 *
 * All four are refusals. A refusal that stops refusing is the quietest defect
 * there is: the build goes green, the image ships, and the only observable
 * difference is that an unverified addon now loads at native privilege. Nothing
 * in a review diff looks different either — each is one `throw` or one `continue`.
 *
 * This is a `security.md` supply-chain invariant, so prose in a PR body is not
 * the bar. #907 shipped no prover; this is it.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/native-integrity.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'staged native packages with NO lockfile stop being a build failure — knext ships an @img ' +
      'tree it cannot pin, which is the injected-dependency case it refuses by design',
    subject: 'src',
    anchor: 'if (!lockfilePath || !existsSync(lockfilePath)) {',
    replacement: 'if (false && (!lockfilePath || !existsSync(lockfilePath))) {',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'a staged package the lockfile never resolved is SKIPPED instead of refused — a package on ' +
      'disk that no install produced is exactly what an attacker leaves behind',
    subject: 'src',
    anchor: '            if (!versions) {',
    replacement:
      '            if (!versions) {\n                continue;\n            }\n            if (false) {',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'a staged VERSION disagreeing with the lockfile is tolerated — the mismatch lookup falls ' +
      'back to some pinned entry and the build ships the difference rather than stopping',
    subject: 'src',
    anchor: 'const entry = versions.find((v) => v.version === pkg.version);',
    replacement: 'const entry = versions.find((v) => v.version === pkg.version) ?? versions[0];',
  },
  {
    id: 'M7',
    expect: 'red',
    claim:
      'the lockfile map collapses back to ONE version per name — the #954 two-sharp scaffold ' +
      '(app sharp ^0.35 beside next’s 0.34 pin) false-fails again, against whichever version ' +
      'lost the collapse',
    subject: 'src',
    anchor: '        if (existing !== -1 && key !== name) continue;',
    replacement:
      '        if (existing === -1 && entries.length > 0) continue;\n        if (existing !== -1 && key !== name) continue;',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the manifest stops recording file hashes — every `dlopen` check then compares against an ' +
      'empty record, which passes for any bytes at all',
    subject: 'src',
    anchor: '        files[rel] = createHash("sha256")',
    replacement: '        if (rel) continue;\n        files[rel] = createHash("sha256")',
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      "a PREVIOUS build's manifest leaks into the new record — the file hashes itself, so the " +
      'record depends on what was already there rather than on what is being shipped',
    subject: 'src',
    anchor: '        if (rel === INTEGRITY_MANIFEST_NAME) continue;',
    replacement: '        // the self-exclusion, removed by the mutation',
  },
];

/**
 * NEGATIVE CONTROL. The refusal MESSAGES are long, specific, and entirely
 * advisory — they tell an operator which command to run. Rewording one must
 * leave the guard GREEN.
 *
 * Without this, all five reds above are equally explained by the guard asserting
 * on the file's text rather than on its behaviour, which would make it a
 * tripwire. It also pins something the repo cares about: these messages are
 * exactly the kind that get improved, and a guard that reddened on a better error
 * message would be the first thing weakened.
 */
const NEGATIVE = {
  id: 'M6',
  expect: 'green',
  claim: 'a refusal MESSAGE is reworded — the guard asserts behaviour, not prose',
  subject: 'src',
  anchor: '"The store and the lockfile disagree about what is installed. Reinstall with\\n" +',
  replacement:
    '"The store and the lockfile disagree about what is installed (reworded by the negative control). Reinstall with\\n" +',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { src: 'packages/kn-next/src/cli/native-integrity.ts' },
});

console.log(`=== mutation proof: ${SPEC} (#907 native integrity) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary changes the DIGEST ALGORITHM the manifest records against. The
// guard asserts `manifest.algorithm === "sha256"` (`:127`), so this must red —
// and it also proves the runner is pointed at the right spec.
//
// ROUND 1 USED A DIFFERENT CANARY AND IT SURVIVED, which is recorded here
// because it is a real (small) finding rather than a mistake worth hiding:
// changing the manifest's `version: 1` to `version: 99` reds NOTHING. The
// declared schema version is written and never asserted, so a bump the `dlopen`
// verifier does not understand would ship silently. Filed as issue
// #929 rather than fixed here — widening #907's guard is not this prover's job,
// and inventing the assertion in order to have a canary would be writing the
// test to fit the proof.
prover.proveCanSeeRed({
  subject: 'src',
  anchor: '        algorithm: "sha256",',
  replacement: '        algorithm: "sha1",',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
