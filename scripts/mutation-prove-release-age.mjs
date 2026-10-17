#!/usr/bin/env node
/**
 * Mutation prover for the lockfile release-age gate.
 *
 * The guard is `tests/release-age-gate.test.ts` over `scripts/lib/release-age.mjs`
 * and `.github/workflows/release-age.yml`. Each row plants one regression and
 * requires the guard to go RED, by exit code:
 *
 *   A1  the boundary moves: an entry exactly as old as the quarantine fails.
 *   A2  the quarantine is not enforced (any age passes).
 *   A3  a registry failure is swallowed instead of failing the check (fail OPEN).
 *   A4  a lookup that returns a non-time is accepted.
 *   A5  first-party exclusions stop applying.
 *   A6  an exception stops being scoped to its version.
 *   A7  the added-or-changed key forgets the lockfile.
 *   A8  an exception may outlive its 14-day cap.
 *   A9  exceptions accept a wildcard package.
 *   A10 the crates.io publish time is read from the wrong field.
 *   A11 Go module paths are not case-escaped for the proxy.
 *   A12 go.mod require blocks are ignored.
 *   A13 Cargo.lock path and git sources are treated as registry crates.
 *   A14 npm aliases are not resolved to the real package.
 *   W1  the workflow gets a soft-fail flag.
 *   W2  the workflow's token gains a write scope.
 *   W3  the workflow stops fetching full history.
 *   W4  the pull_request trigger is removed.
 *   N1  negative control: the failure hint's wording changes.
 *   N2  negative control: the concurrency policy flips.
 *
 * Mutated JS is checked to still PARSE (the shared parse-validity hook) and mutated
 * YAML/JSON to still parse, so each red is a red for the reason its row claims.
 * Mid-line anchors embed the residue marker as a block comment, because the
 * harness's own line-comment marker would swallow the rest of the line.
 *
 *   node scripts/mutation-prove-release-age.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/release-age-gate.test.ts';
const M = MUTATION_MARKER;

const parsesYaml = (text) => {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `not valid YAML: ${err.message}`;
  }
};

const MUTATIONS = [
  {
    id: 'A1',
    claim: 'an entry exactly as old as the quarantine fails',
    subject: 'lib',
    anchor: 'if (ageSeconds >= minSeconds) continue;',
    replacement: 'if (ageSeconds > minSeconds) continue;',
  },
  {
    id: 'A2',
    claim: 'the quarantine is not enforced',
    subject: 'lib',
    anchor: 'if (ageSeconds >= minSeconds) continue;',
    replacement: 'if (ageSeconds >= 0) continue;',
  },
  {
    id: 'A3',
    claim: 'a registry failure is swallowed (fail open)',
    subject: 'lib',
    anchor: 'errors.push({ ...e, error: err instanceof Error ? err.message : String(err) });',
    replacement: 'void err;',
  },
  {
    id: 'A4',
    claim: 'a lookup that returns a non-time is accepted',
    subject: 'lib',
    anchor: "if (!Number.isFinite(published)) throw new Error('lookup returned a non-time');",
    replacement: 'void 0;',
  },
  {
    id: 'A5',
    claim: 'first-party exclusions stop applying',
    subject: 'lib',
    anchor: "return entry.ecosystem === 'npm' && excludes.includes(entry.name);",
    replacement: 'return false;',
  },
  {
    id: 'A6',
    claim: 'an exception stops being scoped to its version',
    subject: 'lib',
    anchor:
      '(x) => x.ecosystem === e.ecosystem && x.package === e.name && x.version === e.version,',
    replacement: '(x) => x.ecosystem === e.ecosystem && x.package === e.name,',
  },
  {
    id: 'A7',
    claim: 'the added-or-changed key forgets the lockfile',
    subject: 'lib',
    anchor: 'const keyOf = (e) => `${e.lockfile}|${e.ecosystem}|${e.name}|${e.version}`;',
    replacement: 'const keyOf = (e) => `${e.ecosystem}|${e.name}|${e.version}`;',
  },
  {
    id: 'A8',
    claim: 'an exception may outlive its 14-day cap',
    subject: 'lib',
    anchor: 'if (span > MAX_EXCEPTION_DAYS) {',
    replacement: 'if (false) {',
  },
  {
    id: 'A9',
    claim: 'exceptions accept a wildcard package',
    subject: 'lib',
    anchor: ' || /[*?\\s]/.test(e.package)',
    replacement: ` /* ${M} */`,
  },
  {
    id: 'A10',
    claim: 'the crates.io publish time is read from the wrong field',
    subject: 'lib',
    anchor: 'json?.version?.created_at',
    replacement: `json?.version?.updated_at /* ${M} */`,
  },
  {
    id: 'A11',
    claim: 'Go module paths are not case-escaped for the proxy',
    subject: 'lib',
    anchor: 'const escaped = e.name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);',
    replacement: 'const escaped = e.name;',
  },
  {
    id: 'A12',
    claim: 'go.mod require blocks are ignored',
    subject: 'lib',
    anchor: "if (block === 'require') {",
    replacement: 'if (false) {',
  },
  {
    id: 'A13',
    claim: 'Cargo.lock path and git sources are treated as registry crates',
    subject: 'lib',
    anchor:
      "if (name && version && source?.startsWith('registry+') && source.includes('crates.io')) {",
    replacement: 'if (name && version) {',
  },
  {
    id: 'A14',
    claim: 'npm aliases are not resolved to the real package',
    subject: 'lib',
    anchor: "const target = id.includes('@npm:') ? id.slice(id.indexOf('@npm:') + 5) : id;",
    replacement: 'const target = id;',
  },
  {
    id: 'W1',
    claim: 'the workflow gets a soft-fail flag',
    subject: 'wf',
    anchor: '      - name: Release-age gate\n        env:',
    replacement: '      - name: Release-age gate\n        continue-on-error: true\n        env:',
  },
  {
    id: 'W2',
    claim: "the workflow's token gains a write scope",
    subject: 'wf',
    anchor: 'permissions:\n  contents: read\n\nconcurrency:',
    replacement: 'permissions:\n  contents: read\n  pull-requests: write\n\nconcurrency:',
  },
  {
    id: 'W3',
    claim: 'the workflow stops fetching full history',
    subject: 'wf',
    anchor: '          fetch-depth: 0\n          persist-credentials: false',
    replacement: '          persist-credentials: false',
  },
  {
    id: 'W4',
    claim: 'the pull_request trigger is removed',
    subject: 'wf',
    anchor: '  pull_request:\n  push:',
    replacement: '  push:',
  },
  {
    id: 'N1',
    expect: 'green',
    claim: "the failure hint's wording changes",
    subject: 'lib',
    anchor: "'Wait, or record a short-lived entry in security/release-age-exceptions.json.',",
    replacement:
      "'Wait for it to age, or record a short-lived entry in security/release-age-exceptions.json.',",
  },
  {
    id: 'N2',
    expect: 'green',
    claim: "the workflow's concurrency policy flips",
    subject: 'wf',
    anchor: '  cancel-in-progress: true',
    replacement: '  cancel-in-progress: false',
  },
].map((m) => ({
  expect: 'red',
  validate: m.subject === 'lib' ? jsStillParses : parsesYaml,
  ...m,
}));

const CANARY = {
  subject: 'lib',
  anchor: 'export const MAX_EXCEPTION_DAYS = 14;',
  replacement: 'export const MAX_EXCEPTION_DAYS = 3650;',
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    lib: 'scripts/lib/release-age.mjs',
    wf: '.github/workflows/release-age.yml',
  },
});

console.log('=== mutation proof: lockfile release-age gate ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
