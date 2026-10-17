#!/usr/bin/env node
/**
 * Mutation prover for the bun fresh-release quarantine guard.
 *
 * The guard is `tests/bun-release-age.test.ts`. Each row plants one regression
 * and requires the guard to go RED, by exit code:
 *
 *   Q1  `minimumReleaseAge` is removed (the quarantine silently stops).
 *   Q2  it is lowered to one hour, below the takedown-latency floor.
 *   Q3  it is raised to two weeks, above the ceiling.
 *   Q4  a third-party package is added to `minimumReleaseAgeExcludes`.
 *   Q5  a first-party package is dropped from the excludes.
 *   Q6  the documented one-off escape hatch is deleted from bunfig.toml.
 *   Q7  a CI install step passes `--minimum-release-age 0`.
 *   Q8  a CI install step passes a one-hour age.
 *   N1  negative control: the age moves to four days, inside the band.
 *   N2  negative control: the exclude list is reordered.
 *
 * bunfig.toml and the workflow are TOML/YAML: the YAML subject is checked to
 * still PARSE before it is graded.
 *
 * Runs on the shared driver (`lib/guard-prover.mjs`): exit codes only, anchors
 * exactly once (preflight), green baseline, a canary red first, tree checked
 * clean between rows, partial run = failure.
 *
 *   node scripts/mutation-prove-bun-release-age.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/bun-release-age.test.ts';

const parsesYaml = (text) => {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `not valid YAML: ${err.message}`;
  }
};

const AGE = 'minimumReleaseAge = 259200';
const EXCLUDES =
  'minimumReleaseAgeExcludes = ["@getknext/core", "@getknext/lib", "@getknext/db", "kn-next"]';
const INSTALL = '        run: bun install --frozen-lockfile';

const MUTATIONS = [
  {
    id: 'Q1',
    claim: 'minimumReleaseAge is removed',
    subject: 'bunfig',
    anchor: AGE,
    replacement: '# minimumReleaseAge removed',
  },
  {
    id: 'Q2',
    claim: 'minimumReleaseAge is lowered to one hour',
    subject: 'bunfig',
    anchor: AGE,
    replacement: 'minimumReleaseAge = 3600',
  },
  {
    id: 'Q3',
    claim: 'minimumReleaseAge is raised to two weeks',
    subject: 'bunfig',
    anchor: AGE,
    replacement: 'minimumReleaseAge = 1209600',
  },
  {
    id: 'Q4',
    claim: 'a third-party package is excluded from the quarantine',
    subject: 'bunfig',
    anchor: EXCLUDES,
    replacement:
      'minimumReleaseAgeExcludes = ["@getknext/core", "@getknext/lib", "@getknext/db", "kn-next", "left-pad"]',
  },
  {
    id: 'Q5',
    claim: 'a first-party package is dropped from the excludes',
    subject: 'bunfig',
    anchor: EXCLUDES,
    replacement: 'minimumReleaseAgeExcludes = ["@getknext/core", "@getknext/lib", "kn-next"]',
  },
  {
    id: 'Q6',
    claim: 'the documented one-off escape hatch is deleted',
    subject: 'bunfig',
    anchor: '`bun add <pkg>@<version> --minimum-release-age 0`',
    replacement: '`bun add <pkg>@<version>`',
  },
  {
    id: 'Q7',
    claim: 'a CI install step passes --minimum-release-age 0',
    subject: 'wf',
    anchor: INSTALL,
    replacement: `${INSTALL} --minimum-release-age 0`,
    validate: parsesYaml,
  },
  {
    id: 'Q8',
    claim: 'a CI install step passes a one-hour age',
    subject: 'wf',
    anchor: INSTALL,
    replacement: `${INSTALL} --minimum-release-age 3600`,
    validate: parsesYaml,
  },
  {
    id: 'N1',
    expect: 'green',
    claim: 'the age moves to four days, inside the band',
    subject: 'bunfig',
    anchor: AGE,
    replacement: 'minimumReleaseAge = 345600',
  },
  {
    id: 'N2',
    expect: 'green',
    claim: 'the exclude list is reordered',
    subject: 'bunfig',
    anchor: EXCLUDES,
    replacement:
      'minimumReleaseAgeExcludes = ["kn-next", "@getknext/db", "@getknext/lib", "@getknext/core"]',
  },
].map((m) => ({ expect: 'red', validate: undefined, ...m }));

const CANARY = {
  subject: 'bunfig',
  anchor: AGE,
  replacement: 'minimumReleaseAge = 60',
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { bunfig: 'bunfig.toml', wf: '.github/workflows/mutation-prover-nightly.yml' },
});

console.log('=== mutation proof: bun fresh-release quarantine ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
