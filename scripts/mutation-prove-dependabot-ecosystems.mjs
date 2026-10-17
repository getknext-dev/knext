#!/usr/bin/env node
/**
 * Mutation prover for the Dependabot ecosystem-coverage guard.
 *
 * The guard is `tests/dependabot-ecosystems.test.ts`. Each row plants one
 * regression and requires the guard to go RED, by exit code:
 *
 *   E1  the bun entry becomes `npm` (which would not update bun.lock).
 *   E2  the cargo entry drops the Rust function template.
 *   E3  the gomod entry drops the Go function template.
 *   E4  the bun entry drops examples/bun-exec (a tracked bun.lock with no channel).
 *   E5  the bun entry's cooldown no longer matches bunfig's quarantine.
 *   E6  the cargo entry loses its groups.
 *   E7  the Go entry goes daily instead of weekly.
 *   E8  the bun tooling group becomes a second production group (runtime and
 *       tooling no longer split, so a tooling bump can trip "Changeset required").
 *   E9  the cargo entry loses its `dependencies` label.
 *   E10 bunfig's quarantine changes without the Dependabot cooldown following.
 *   E11 the operator's Go entry loses its cooldown.
 *   E12 the changeset check stops treating `dependencies` as consumer-visible.
 *   E13 the changeset check starts treating `devDependencies` as consumer-visible.
 *   N1  negative control: the cargo commit-message prefix is renamed.
 *   N2  negative control: the cargo PR limit is lowered.
 *
 * Every mutated YAML subject is checked to still PARSE before it is graded.
 *
 * Runs on the shared driver (`lib/guard-prover.mjs`): exit codes only, anchors
 * exactly once (preflight), green baseline, a canary red first, tree checked
 * clean between rows, partial run = failure.
 *
 *   node scripts/mutation-prove-dependabot-ecosystems.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/dependabot-ecosystems.test.ts';

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
    id: 'E1',
    claim: 'the bun entry becomes npm',
    subject: 'dep',
    anchor: "  - package-ecosystem: 'bun'\n",
    replacement: "  - package-ecosystem: 'npm'\n",
  },
  {
    id: 'E2',
    claim: 'the cargo entry drops the Rust template',
    subject: 'dep',
    anchor: "      - '/crates'\n      - '/templates/rust'\n",
    replacement: "      - '/crates'\n",
  },
  {
    id: 'E3',
    claim: 'the gomod entry drops the Go template',
    subject: 'dep',
    anchor: "      - '/templates/go'\n      - '/packages/scale-zero-pg/gateway'\n",
    replacement: "      - '/packages/scale-zero-pg/gateway'\n",
  },
  {
    id: 'E4',
    claim: 'the bun entry drops examples/bun-exec',
    subject: 'dep',
    anchor: "      - '/'\n      - '/examples/bun-exec'\n",
    replacement: "      - '/'\n",
  },
  {
    id: 'E5',
    claim: "the bun entry's cooldown no longer matches bunfig",
    subject: 'dep',
    anchor: '    cooldown:\n      default-days: 3\n    groups:\n      bun-runtime:',
    replacement: '    cooldown:\n      default-days: 1\n    groups:\n      bun-runtime:',
  },
  {
    id: 'E6',
    claim: 'the cargo entry loses its groups',
    subject: 'dep',
    anchor:
      "    groups:\n      rust-crates:\n        patterns:\n          - '*'\n        update-types:\n          - 'minor'\n          - 'patch'\n",
    replacement: '',
  },
  {
    id: 'E7',
    claim: 'the Go entry goes daily',
    subject: 'dep',
    anchor: "      - '/packages/scale-zero-pg/gateway'\n    schedule:\n      interval: 'weekly'\n",
    replacement:
      "      - '/packages/scale-zero-pg/gateway'\n    schedule:\n      interval: 'daily'\n",
  },
  {
    id: 'E8',
    claim: 'the bun tooling group becomes a second production group',
    subject: 'dep',
    anchor: "        dependency-type: 'development'\n",
    replacement: "        dependency-type: 'production'\n",
  },
  {
    id: 'E9',
    claim: 'the cargo entry loses its dependencies label',
    subject: 'dep',
    anchor: "      prefix: 'chore(rust)'\n    labels:\n      - 'dependencies'\n",
    replacement: "      prefix: 'chore(rust)'\n",
  },
  {
    id: 'E10',
    claim: "bunfig's quarantine changes without the Dependabot cooldown following",
    subject: 'bunfig',
    anchor: 'minimumReleaseAge = 259200',
    replacement: 'minimumReleaseAge = 345600',
    validate: undefined,
  },
  {
    id: 'E11',
    claim: "the operator's Go entry loses its cooldown",
    subject: 'dep',
    anchor:
      "    # Same quarantine as bunfig.toml's minimumReleaseAge; see the bun entry below.\n    cooldown:\n      default-days: 3\n",
    replacement: '',
  },
  {
    id: 'E12',
    claim: 'the changeset check stops treating dependencies as consumer-visible',
    subject: 'changeset',
    anchor: "export const CONSUMER_VISIBLE_DEPENDENCY_KEYS = [\n  'dependencies',\n",
    replacement: 'export const CONSUMER_VISIBLE_DEPENDENCY_KEYS = [\n',
    validate: undefined,
  },
  {
    id: 'E13',
    claim: 'the changeset check starts treating devDependencies as consumer-visible',
    subject: 'changeset',
    anchor: "  'optionalDependencies',\n];",
    replacement: "  'optionalDependencies',\n  'devDependencies',\n];",
    validate: undefined,
  },
  {
    id: 'N1',
    expect: 'green',
    claim: 'the cargo commit-message prefix is renamed',
    subject: 'dep',
    anchor: "      prefix: 'chore(rust)'\n",
    replacement: "      prefix: 'chore(crates)'\n",
  },
  {
    id: 'N2',
    expect: 'green',
    claim: 'the cargo PR limit is lowered',
    subject: 'dep',
    anchor:
      "          - 'patch'\n    open-pull-requests-limit: 5\n    commit-message:\n      prefix: 'chore(rust)'\n",
    replacement:
      "          - 'patch'\n    open-pull-requests-limit: 3\n    commit-message:\n      prefix: 'chore(rust)'\n",
  },
].map((m) => ({ expect: 'red', validate: parsesYaml, ...m }));

const CANARY = {
  subject: 'dep',
  anchor: "  - package-ecosystem: 'cargo'\n",
  replacement: "  - package-ecosystem: 'cargo-gone'\n",
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    dep: '.github/dependabot.yml',
    bunfig: 'bunfig.toml',
    changeset: 'scripts/check-changeset-required.mjs',
  },
});

console.log('=== mutation proof: Dependabot ecosystem coverage ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
