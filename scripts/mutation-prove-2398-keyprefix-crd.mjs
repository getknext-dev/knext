#!/usr/bin/env node
/**
 * Mutation proof for the NextApp `spec.cache.keyPrefix` admission rules (issue
 * #2398), Go half.
 *
 * The generated CRD refuses, at admission, a keyPrefix that is longer than 63
 * characters, contains ASCII whitespace or a Redis glob character (* ? [ ] \),
 * or is the shared fallback keyspace kn-next / kn-next:* (a CEL rule). The empty
 * string stays valid (unset). Every row weakens ONE of those rules in the CRD
 * YAML the apiserver actually validates against, and must turn the envtest
 * admission suite (`keyprefix_admission_test.go`, focused on "keyPrefix") red.
 *
 * The CRD is the mutation subject, not the Go markers: envtest loads the
 * generated YAML, and `operator-codegen-check` in CI holds the YAML to what
 * `controller-gen` produces from the markers.
 *
 * The TS half (the CLI copy of the rule, doctor, and the guard's narrowing
 * waivers) is `mutation-prove-2398-keyprefix-cli-waivers.mjs`.
 *
 * Spawns only `go`, run in `packages/kn-next-operator`. Envtest binaries:
 * KUBEBUILDER_ASSETS, or packages/kn-next-operator/bin/k8s (`make
 * setup-envtest`). Exit 0 = every row went red; 1 = a row survived; 2 = the
 * prover could not run (anchor drift, red baseline, missing tool). Never parses
 * output.
 *
 * Usage:
 *   node scripts/mutation-prove-2398-keyprefix-crd.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const NAME = 'mutation-prove-2398-keyprefix-crd';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the command's cwd), not a mutation subject.
const OPERATOR_MODULE = `${REPO_ROOT}/packages/kn-next-operator`;
// biome-ignore format: one-line resolve() for the anchor-drift scan
const CRD = resolve(REPO_ROOT, 'packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml');

// -count=1: never trust a cached verdict for a mutated tree.
const GO_TEST = [
  'go',
  'test',
  '-count=1',
  '-run',
  'TestControllers',
  './internal/controller/',
  '-ginkgo.focus=spec.cache.keyPrefix admission',
];

const PATTERN_LINE = '                    pattern: ^[^*?\\[\\]\\\\ \\t\\n\\r\\f\\v]*$\n';
const CEL_BLOCK =
  "                    x-kubernetes-validations:\n                    - message: keyPrefix 'kn-next' and prefixes under 'kn-next:' are\n                        reserved for the shared fallback keyspace\n                      rule: self != 'kn-next' && !self.startsWith('kn-next:')\n";

const MUTATIONS = [
  {
    id: 'K01',
    claim: 'no pattern at all (glob characters and whitespace admitted)',
    anchor: PATTERN_LINE,
    replacement: '',
  },
  {
    id: 'K02',
    claim: 'the pattern admits * (kn-* admitted)',
    anchor: 'pattern: ^[^*?',
    replacement: 'pattern: ^[^?',
  },
  {
    id: 'K03',
    claim: 'the pattern admits ? (kn-nex? admitted)',
    anchor: 'pattern: ^[^*?\\[',
    replacement: 'pattern: ^[^*\\[',
  },
  {
    id: 'K04',
    claim: 'the pattern admits [ (kn-[a admitted)',
    anchor: '?\\[\\]\\\\',
    replacement: '?\\]\\\\',
  },
  {
    id: 'K05',
    claim: 'the pattern admits ] (kn-a] admitted)',
    anchor: '\\[\\]\\\\ ',
    replacement: '\\[\\\\ ',
  },
  {
    id: 'K06',
    claim: 'the pattern admits the backslash (kn-a\\b admitted)',
    anchor: '\\]\\\\ \\t',
    replacement: '\\] \\t',
  },
  {
    id: 'K07',
    claim: 'the pattern admits a space',
    anchor: '\\\\ \\t\\n',
    replacement: '\\\\\\t\\n',
  },
  {
    id: 'K08',
    claim: 'the pattern admits a tab',
    anchor: ' \\t\\n\\r',
    replacement: ' \\n\\r',
  },
  {
    id: 'K09',
    claim: 'the pattern admits a newline',
    anchor: '\\t\\n\\r',
    replacement: '\\t\\r',
  },
  {
    id: 'K10',
    claim: 'the pattern admits a carriage return',
    anchor: '\\n\\r\\f',
    replacement: '\\n\\f',
  },
  {
    id: 'K11',
    claim: 'the pattern admits a form feed',
    anchor: '\\r\\f\\v',
    replacement: '\\r\\v',
  },
  {
    id: 'K12',
    claim: 'the pattern admits a vertical tab',
    anchor: '\\f\\v]',
    replacement: '\\f]',
  },
  {
    id: 'K13',
    claim: 'the pattern refuses the empty string (unset can no longer be written)',
    anchor: '\\v]*$',
    replacement: '\\v]+$',
  },
  {
    id: 'K14',
    claim: 'no maxLength (a 64-character prefix admitted)',
    anchor: '                    maxLength: 63\n                    pattern: ^[^*?',
    replacement: '                    pattern: ^[^*?',
  },
  {
    id: 'K15',
    claim: 'maxLength off by one (64 admitted)',
    anchor: 'maxLength: 63\n                    pattern: ^[^*?',
    replacement: 'maxLength: 64\n                    pattern: ^[^*?',
  },
  {
    id: 'K16',
    claim: 'maxLength off by one the other way (a 63-character prefix refused)',
    anchor: 'maxLength: 63\n                    pattern: ^[^*?',
    replacement: 'maxLength: 62\n                    pattern: ^[^*?',
  },
  {
    id: 'K17',
    claim: 'no CEL rule (kn-next and kn-next:cache admitted)',
    anchor: CEL_BLOCK,
    replacement: '',
  },
  {
    id: 'K18',
    claim: 'the CEL rule forgets the nested keyspace (kn-next:cache admitted)',
    anchor: "rule: self != 'kn-next' && !self.startsWith('kn-next:')",
    replacement: "rule: self != 'kn-next'",
  },
  {
    id: 'K19',
    claim: 'the CEL rule forgets kn-next itself',
    anchor: "rule: self != 'kn-next' && !self.startsWith('kn-next:')",
    replacement: 'rule: "!self.startsWith(\'kn-next:\')"',
  },
  {
    id: 'K20',
    claim: "the CEL rule over-reaches (kn-nextapp, kn-next-v2 refused: startsWith without ':')",
    anchor: "rule: self != 'kn-next' && !self.startsWith('kn-next:')",
    replacement: 'rule: "!self.startsWith(\'kn-next\')"',
  },
];

function envtestAssetsPresent() {
  if (process.env.KUBEBUILDER_ASSETS) return true;
  const dir = `${OPERATOR_MODULE}/bin/k8s`;
  return existsSync(dir) && readdirSync(dir).length > 0;
}

function goTestExit() {
  const [bin, ...args] = GO_TEST;
  const r = spawnSync(bin, args, {
    cwd: OPERATOR_MODULE,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 900_000,
  });
  if (r.error || r.status === null) {
    console.error(`${NAME}: cannot run ${bin}: ${r.error?.message ?? r.signal}`);
    process.exit(2);
  }
  return r.status;
}

declareMutations(MUTATIONS.length);
console.log(`${NAME}: ${MUTATIONS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of MUTATIONS) {
  const count = snapshot(CRD).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(`${NAME}: ${m.id}'s anchor occurs ${count} times in ${CRD}; aborting`);
    process.exit(2);
  }
}
if (!envtestAssetsPresent()) {
  console.error(
    `${NAME}: no envtest binaries (set KUBEBUILDER_ASSETS or run \`make setup-envtest\` in packages/kn-next-operator)`,
  );
  process.exit(2);
}

// Green baseline on a clean tree, else every verdict below is noise.
assertTreeClean(REPO_ROOT, 'baseline');
const base = goTestExit();
if (base !== 0) {
  console.error(`${NAME}: baseline RED (exit ${base}); fix the tree first`);
  process.exit(2);
}
console.log(`${NAME}: baseline green`);

let failed = 0;
for (const m of MUTATIONS) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(CRD);
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    code = goTestExit();
  } finally {
    restore(snap);
  }
  assertTreeClean(REPO_ROOT, `after ${m.id}`);
  recordMutation();
  const ok = code !== 0;
  if (!ok) failed++;
  console.log(`${ok ? 'KILLED   ' : '*** SURVIVED ***'} ${m.id} exit=${code} — ${m.claim}`);
}

console.log(`${NAME}: ${MUTATIONS.length - failed}/${MUTATIONS.length} went red as required`);
process.exit(failed === 0 ? 0 : 1);
