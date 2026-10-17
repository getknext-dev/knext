#!/usr/bin/env node
/**
 * Mutation prover for the OSV dependency gate.
 *
 * The guard is `tests/osv-gate.test.ts` over `scripts/lib/osv-gate.mjs` and
 * `.github/workflows/osv-scan.yml`. Each row plants one regression and requires
 * the guard to go RED, by exit code:
 *
 *   G1  the HIGH threshold moves from CVSS 7.0 to 9.0.
 *   G2  a MAL- advisory reached only through an alias is no longer malicious.
 *   G3  a malicious package the base already had stops failing.
 *   G4  a pre-existing HIGH starts failing (every unrelated PR would red).
 *   G5  a NEW HIGH stops failing.
 *   G6  the base-vs-head key forgets the version (a bump to another vulnerable
 *       version would read as pre-existing).
 *   G7  an expired allowlist entry keeps suppressing.
 *   G8  the allowlist stops requiring a real justification.
 *   G9  an advisory with no severity score starts failing.
 *   G10 lockfile discovery forgets go.mod.
 *   G11 the committed allowlist is malformed.
 *   W1  the workflow stops verifying the scanner's sha256.
 *   W2  the workflow gets a soft-fail flag on the gate step.
 *   W3  the workflow's token gains a write scope.
 *   W4  the workflow stops fetching full history (no merge base to diff against).
 *   N1  negative control: the report wording changes.
 *   N2  negative control: the workflow's concurrency policy flips.
 *
 * Every mutated YAML/JSON subject is checked to still PARSE before it is graded.
 *
 * Runs on the shared driver (`lib/guard-prover.mjs`): exit codes only, anchors
 * exactly once (preflight), green baseline, a canary red first, tree checked
 * clean between rows, partial run = failure.
 *
 *   node scripts/mutation-prove-osv-gate.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/osv-gate.test.ts';
const M = MUTATION_MARKER;

const parsesYaml = (text) => {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `not valid YAML: ${err.message}`;
  }
};
const parsesJson = (text) => {
  try {
    JSON.parse(text);
    return undefined;
  } catch (err) {
    return `not valid JSON: ${err.message}`;
  }
};

const MUTATIONS = [
  {
    id: 'G1',
    claim: 'the HIGH threshold moves from 7.0 to 9.0',
    subject: 'lib',
    anchor: 'export const HIGH_SEVERITY = 7;',
    replacement: 'export const HIGH_SEVERITY = 9;',
  },
  {
    id: 'G2',
    claim: 'a MAL- alias no longer marks a package malicious',
    subject: 'lib',
    anchor: 'return /^MAL-/.test(v.id) || (v.aliases ?? []).some((a) => /^MAL-/.test(a));',
    replacement: 'return /^MAL-/.test(v.id);',
  },
  {
    id: 'G3',
    claim: 'a malicious package the base already had stops failing',
    subject: 'lib',
    anchor: '(allowed(f) ? suppressed : failures).push(f);',
    replacement: '(allowed(f) || baseKeys.has(keyOf(f)) ? suppressed : failures).push(f);',
  },
  {
    id: 'G4',
    claim: 'a pre-existing HIGH starts failing',
    subject: 'lib',
    anchor: 'const isNew = base !== null && !baseKeys.has(keyOf(f));',
    replacement: 'const isNew = true;',
  },
  {
    id: 'G5',
    claim: 'a NEW HIGH stops failing',
    subject: 'lib',
    anchor: 'if (full || isNew) failures.push(f);',
    replacement: 'if (full) failures.push(f);',
  },
  {
    id: 'G6',
    claim: 'the base-vs-head key forgets the version',
    subject: 'lib',
    anchor: 'const keyOf = (f) => `${f.ecosystem}|${f.name}|${f.version}|${f.id}`;',
    replacement: 'const keyOf = (f) => `${f.ecosystem}|${f.name}|${f.id}`;',
  },
  {
    id: 'G7',
    claim: 'an expired allowlist entry keeps suppressing',
    subject: 'lib',
    anchor: 'if (e.expires !== undefined && e.expires < today)',
    replacement: 'if (false)',
  },
  {
    id: 'G8',
    claim: 'the allowlist stops requiring a real justification',
    subject: 'lib',
    anchor: "if (typeof e.justification !== 'string' || e.justification.trim().length < 20) {",
    replacement: "if (typeof e.justification !== 'string') {",
  },
  {
    id: 'G9',
    claim: 'an advisory with no severity score starts failing',
    subject: 'lib',
    anchor: '      unknownSeverity.push(f);\n',
    replacement: '      failures.push(f);\n',
  },
  {
    id: 'G10',
    claim: 'lockfile discovery forgets go.mod',
    subject: 'lib',
    anchor: "export const LOCKFILE_NAMES = ['bun.lock', 'Cargo.lock', 'go.mod'];",
    replacement: "export const LOCKFILE_NAMES = ['bun.lock', 'Cargo.lock'];",
  },
  {
    id: 'G11',
    claim: 'the committed allowlist is malformed',
    subject: 'allow',
    anchor: '"expires": "2026-12-15"',
    replacement: `"expires": "soon-${M}"`,
    validate: parsesJson,
  },
  {
    id: 'W1',
    claim: "the workflow stops verifying the scanner's sha256",
    subject: 'wf',
    anchor: 'echo "${OSV_SCANNER_SHA256}  ${RUNNER_TEMP}/osv-scanner" | sha256sum -c -',
    replacement: 'true',
    validate: parsesYaml,
  },
  {
    id: 'W2',
    claim: 'the gate step gets a soft-fail flag',
    subject: 'wf',
    anchor: '      - name: OSV gate\n        env:',
    replacement: '      - name: OSV gate\n        continue-on-error: true\n        env:',
    validate: parsesYaml,
  },
  {
    id: 'W3',
    claim: "the workflow's token gains a write scope",
    subject: 'wf',
    anchor: 'permissions:\n  contents: read\n\nconcurrency:',
    replacement: 'permissions:\n  contents: read\n  pull-requests: write\n\nconcurrency:',
    validate: parsesYaml,
  },
  {
    id: 'W4',
    claim: 'the workflow stops fetching full history',
    subject: 'wf',
    anchor: '          fetch-depth: 0\n          persist-credentials: false',
    replacement: '          persist-credentials: false',
    validate: parsesYaml,
  },
  {
    id: 'N1',
    expect: 'green',
    claim: 'the report wording changes',
    subject: 'lib',
    anchor: "out.push('OSV: no malicious packages and no new HIGH/CRITICAL vulnerabilities.');",
    replacement: "out.push('OSV: clean, nothing malicious and nothing new at HIGH or above.');",
  },
  {
    id: 'N2',
    expect: 'green',
    claim: "the workflow's concurrency policy flips",
    subject: 'wf',
    anchor: '  cancel-in-progress: true',
    replacement: '  cancel-in-progress: false',
    validate: parsesYaml,
  },
].map((m) => ({
  expect: 'red',
  validate: m.subject === 'lib' ? jsStillParses : undefined,
  ...m,
}));

const CANARY = {
  subject: 'lib',
  anchor: 'export const HIGH_SEVERITY = 7;',
  replacement: 'export const HIGH_SEVERITY = 11;',
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    lib: 'scripts/lib/osv-gate.mjs',
    wf: '.github/workflows/osv-scan.yml',
    allow: 'security/osv-allowlist.json',
  },
});

console.log('=== mutation proof: OSV dependency gate ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
