#!/usr/bin/env node
/**
 * Mutation prover for the bun install-script allowlist guard.
 *
 * The guard is `tests/bun-install-scripts.test.ts`. Each row plants one
 * regression and requires the guard to go RED, by exit code:
 *
 *   I1  a reviewed package is dropped from the root `trustedDependencies`.
 *   I2  an unreviewed package is added to the root `trustedDependencies`.
 *   I3  an allowlist entry is renamed (a stale name, and the real one now
 *       reaches bun's default list unreviewed).
 *   I4  an allowlist entry's date is malformed.
 *   I5  the lockfile's mirror of the trusted list loses an entry.
 *   I6  a CI install step starts passing `--trust`.
 *   I7  a workspace member declares its own `trustedDependencies` (bun reads
 *       only the root's, so it would be a no-op that reads as protection).
 *   I8  a package that bun's default list trusts (puppeteer) enters the lockfile
 *       with no review.
 *   N1  negative control: an allowlist justification is reworded.
 *   N2  negative control: a package that is NOT on bun's default list enters the
 *       lockfile. Only default-trusted names need review.
 *
 * The residue marker cannot be a comment inside JSON, so JSON subjects embed it
 * as a value or a trailing key and are checked to still PARSE before grading.
 *
 * Runs on the shared driver (`lib/guard-prover.mjs`): exit codes only, anchors
 * exactly once (preflight), green baseline, a canary red first, tree checked
 * clean between rows, partial run = failure.
 *
 *   node scripts/mutation-prove-bun-install-scripts.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/bun-install-scripts.test.ts';

const parsesJson = (text) => {
  try {
    JSON.parse(text);
    return undefined;
  } catch (err) {
    return `not valid JSON: ${err.message}`;
  }
};
const parsesYaml = (text) => {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `not valid YAML: ${err.message}`;
  }
};

const TRUSTED_TAIL = '    "esbuild",\n    "sharp"\n  ],';
const LOCK_TRUSTED = '    "sharp",\n    "@bufbuild/buf",\n  ],';
const FIRST_ADDED = '"added": "2026-10-17"\n    },\n    {\n      "name": "esbuild"';
const INSTALL = '        run: bun install --frozen-lockfile';
const LOCK_PACKAGES = '  "packages": {\n';
const M = MUTATION_MARKER;

const MUTATIONS = [
  {
    id: 'I1',
    claim: 'a reviewed package is dropped from the root trustedDependencies',
    subject: 'root',
    anchor: TRUSTED_TAIL,
    replacement: `    "esbuild"\n  ],\n  "x-${M}": 0,`,
    validate: parsesJson,
  },
  {
    id: 'I2',
    claim: 'an unreviewed package is added to the root trustedDependencies',
    subject: 'root',
    anchor: TRUSTED_TAIL,
    replacement: `    "esbuild",\n    "sharp",\n    "left-pad-${M}"\n  ],`,
    validate: parsesJson,
  },
  {
    id: 'I3',
    claim: 'an allowlist entry is renamed',
    subject: 'allow',
    anchor: '"name": "sharp"',
    replacement: `"name": "sharp-renamed-${M}"`,
    validate: parsesJson,
  },
  {
    id: 'I4',
    claim: "an allowlist entry's date is malformed",
    subject: 'allow',
    anchor: FIRST_ADDED,
    replacement: `"added": "yesterday-${M}"\n    },\n    {\n      "name": "esbuild"`,
    validate: parsesJson,
  },
  {
    id: 'I5',
    claim: "the lockfile's mirror of the trusted list loses an entry",
    subject: 'lock',
    anchor: LOCK_TRUSTED,
    replacement: '    "sharp",\n  ],',
  },
  {
    id: 'I6',
    claim: 'a CI install step starts passing --trust',
    subject: 'wf',
    anchor: INSTALL,
    replacement: `${INSTALL} --trust`,
    validate: parsesYaml,
  },
  {
    id: 'I7',
    claim: 'a workspace member declares its own trustedDependencies',
    subject: 'member',
    anchor: '"name": "@getknext/lib",',
    replacement: `"name": "@getknext/lib", "trustedDependencies": ["${M}"],`,
    validate: parsesJson,
  },
  {
    id: 'I8',
    claim: "a package on bun's default-trusted list (puppeteer) enters the lockfile unreviewed",
    subject: 'lock',
    anchor: LOCK_PACKAGES,
    replacement: `${LOCK_PACKAGES}    "puppeteer": ["puppeteer@1.0.0", "", {}, "sha512-aaaa"], // ${M}\n`,
  },
  {
    id: 'N1',
    expect: 'green',
    claim: 'an allowlist justification is reworded',
    subject: 'allow',
    anchor: 'Dev tooling only: it is a devDependency of the workspace',
    replacement: `Dev tooling only; (${M}) it is a devDependency of the workspace`,
    validate: parsesJson,
  },
  {
    id: 'N2',
    expect: 'green',
    claim: "a package NOT on bun's default list enters the lockfile",
    subject: 'lock',
    anchor: LOCK_PACKAGES,
    replacement: `${LOCK_PACKAGES}    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-aaaa"], // ${M}\n`,
  },
].map((m) => ({ expect: 'red', validate: undefined, ...m }));

const CANARY = {
  subject: 'root',
  anchor: TRUSTED_TAIL,
  replacement: `    "sharp"\n  ],\n  "x-${M}": 0,`,
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    root: 'package.json',
    allow: 'security/bun-install-scripts.json',
    lock: 'bun.lock',
    wf: '.github/workflows/mutation-prover-nightly.yml',
    member: 'packages/lib/package.json',
  },
});

console.log('=== mutation proof: bun install-script allowlist ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
