#!/usr/bin/env node
/**
 * Mutation proof for the operator's per-app Redis key prefix (issue #2171), Go half.
 *
 * A Redis-cached NextApp without `spec.cache.keyPrefix` used to get no
 * REDIS_KEY_PREFIX, so every such app on one Redis shared the runtime fallback
 * `kn-next`, and one app's outage collapse deleted the others' caches. The
 * operator now renders a default derived from namespace/name, yields it to a
 * REDIS_KEY_PREFIX the user sets in spec.env or spec.secrets.envMap, and reaps
 * that derived keyspace on delete, but never the shared fallback `kn-next`, even
 * when `spec.cache.keyPrefix` names it. An empty spec.env REDIS_KEY_PREFIX counts
 * as unset, so the derived default replaces it. The finalizer also refuses any
 * prefix nested under `kn-next` (`kn-next:cache`), and the cleaner glob-escapes
 * the prefix so `kn-*` / `kn-nex?` / `kn-nex[t]` / `kn-nex\t` reap only their
 * literal keyspace (graded against an in-memory Redis that implements SCAN MATCH's
 * glob). Graded by the `go test` targets in
 * `packages/kn-next-operator/internal/controller`: `redis_key_prefix_test.go`,
 * the reserved-env parity test (whose exclusion of the yielding default must stay
 * narrow), and the finalizer tests.
 *
 * The TS half (runtime refusal, doctor row, docs guard) is
 * `mutation-prove-2171-redis-prefix-isolation.mjs`.
 *
 * Spawns only `go`, run in `packages/kn-next-operator`. Exit 0 = every row went
 * red; 1 = a row survived; 2 = the prover itself could not run (anchor drift, red
 * baseline, missing tool). Never parses output.
 *
 * Usage:
 *   node scripts/mutation-prove-2171-go-redis-key-prefix.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the command's cwd), not a mutation subject.
const OPERATOR_MODULE = `${REPO_ROOT}/packages/kn-next-operator`;
// biome-ignore format: one-line resolve() for the anchor-drift scan
const PREFIX = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/redis_key_prefix.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const CONTROLLER = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/nextapp_controller.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const CLEANER = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/external_cleaner.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const PARITY = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/reserved_env_names_parity_test.go');

// -count=1: never trust a cached verdict for a mutated tree.
const GO_TEST = [
  'go',
  'test',
  '-count=1',
  '-run',
  'TestRedisKeyPrefix|TestReservedEnvNamesParity|TestCleanupExternalState',
  './internal/controller/',
];

const MUTATIONS = [
  {
    id: 'G01',
    claim: 'the derived default is not rendered (back to the shared fallback)',
    subject: 'controller',
    anchor:
      '\tif ev, ok := defaultRedisKeyPrefixEnv(nextApp); ok {\n\t\tenvVars = append(envVars, ev)\n\t}',
    replacement: '',
  },
  {
    id: 'G02',
    claim: 'the default ignores the namespace (same name in two namespaces collides)',
    subject: 'prefix',
    anchor: '\treturn "kn-" + cdnTagPrefix(app)',
    replacement: '\treturn "kn-" + app.Name',
  },
  {
    id: 'G03',
    claim: 'the default overrides a REDIS_KEY_PREFIX the user set',
    subject: 'prefix',
    anchor:
      '\treturn cacheIsRedis(app) && app.Spec.Cache.KeyPrefix == "" && !userSetsRedisKeyPrefix(app)',
    replacement: '\treturn cacheIsRedis(app) && app.Spec.Cache.KeyPrefix == ""',
  },
  {
    id: 'G04',
    claim: 'an envMap REDIS_KEY_PREFIX is not seen (a duplicate entry is rendered)',
    subject: 'prefix',
    anchor:
      '\t\tif _, ok := app.Spec.Secrets.EnvMap[redisKeyPrefixEnvName]; ok {\n\t\t\treturn true\n\t\t}',
    replacement: '',
  },
  {
    id: 'G05',
    claim: 'the default is rendered for a non-Redis cache',
    subject: 'prefix',
    anchor: '\treturn app.Spec.Cache != nil && app.Spec.Cache.Provider == "redis"',
    replacement: '\treturn app.Spec.Cache != nil',
  },
  {
    id: 'G06',
    claim: 'the finalizer leaves the derived keyspace behind',
    subject: 'prefix',
    anchor: '\tif rendersDefaultRedisKeyPrefix(app) {\n\t\treturn defaultRedisKeyPrefix(app)\n\t}',
    replacement: '',
  },
  {
    id: 'G07',
    claim: 'the finalizer reaps a derived keyspace the app never used (user-set env prefix)',
    subject: 'prefix',
    anchor: '\tif rendersDefaultRedisKeyPrefix(app) {\n\t\treturn defaultRedisKeyPrefix(app)\n\t}',
    replacement: '\tif cacheIsRedis(app) {\n\t\treturn defaultRedisKeyPrefix(app)\n\t}',
  },
  {
    id: 'G08',
    claim: 'the finalizer stops reaping an explicit keyPrefix',
    subject: 'prefix',
    anchor: '\tif app.Spec.Cache.KeyPrefix != "" {\n\t\treturn app.Spec.Cache.KeyPrefix\n\t}',
    replacement: '',
  },
  {
    id: 'G09',
    claim:
      'the parity test excludes REDIS_KEY_PREFIX even when it is a claimed name (explicit keyPrefix)',
    subject: 'parity',
    anchor: '\t\tif ev.Name == redisKeyPrefixEnvName && rendersDefaultRedisKeyPrefix(app) {',
    replacement: '\t\tif ev.Name == redisKeyPrefixEnvName {',
  },
  {
    id: 'G10',
    claim:
      'the finalizer reaps an explicit keyPrefix of kn-next (every legacy app on the shared fallback)',
    subject: 'prefix',
    anchor: '\tif isSharedRedisKeyspace(app.Spec.Cache.KeyPrefix) {\n\t\treturn ""\n\t}',
    replacement: '',
  },
  {
    id: 'G11',
    claim: 'an empty spec.env REDIS_KEY_PREFIX counts as user-set (runtime falls back to kn-next)',
    subject: 'prefix',
    anchor: '\tif v, ok := app.Spec.Env[redisKeyPrefixEnvName]; ok && v != "" {',
    replacement: '\tif _, ok := app.Spec.Env[redisKeyPrefixEnvName]; ok {',
  },
  {
    id: 'G12',
    claim: 'an empty spec.env REDIS_KEY_PREFIX is rendered beside the derived default (duplicate)',
    subject: 'controller',
    anchor: '\t\t\tif dropsEmptyUserRedisKeyPrefix(nextApp, name) {',
    replacement: '\t\t\tif false {',
  },
  {
    id: 'G13',
    claim:
      'the finalizer reaps a keyPrefix nested under kn-next (kn-next:cache: every legacy ISR entry)',
    subject: 'prefix',
    anchor:
      '\treturn prefix == legacySharedRedisKeyPrefix || strings.HasPrefix(prefix, legacySharedRedisKeyPrefix+":")',
    replacement: '\treturn prefix == legacySharedRedisKeyPrefix',
  },
  {
    id: 'G14',
    claim: 'the cleaner itself no longer refuses the shared fallback keyspace',
    subject: 'cleaner',
    anchor: '\tif isSharedRedisKeyspace(t.KeyPrefix) {',
    replacement: '\tif false {',
  },
  {
    id: 'G15',
    claim: 'the cleanup pattern is not glob-escaped (kn-* reaps every app)',
    subject: 'cleaner',
    anchor: '\tmatch := escapeRedisGlob(t.KeyPrefix) + ":*"',
    replacement: '\tmatch := t.KeyPrefix + ":*"',
  },
  {
    id: 'G16',
    claim: 'the escape drops the backslash (kn-nex\\t reaps kn-next:*)',
    subject: 'cleaner',
    anchor: 'strings.NewReplacer(`\\`, `\\\\`, ',
    replacement: 'strings.NewReplacer(',
  },
  {
    id: 'G17',
    claim: 'the escape drops * (kn-* reaps every derived app)',
    subject: 'cleaner',
    anchor: '`*`, `\\*`, ',
    replacement: '',
  },
  {
    id: 'G18',
    claim: 'the escape drops ? (kn-nex? reaps kn-next:*)',
    subject: 'cleaner',
    anchor: '`?`, `\\?`, ',
    replacement: '',
  },
  {
    id: 'G19',
    claim: 'the escape drops [ and ] (kn-nex[t] reaps kn-next:*)',
    subject: 'cleaner',
    anchor: ', `[`, `\\[`, `]`, `\\]`)',
    replacement: ')',
  },
];

const PROVER = {
  subjects: { prefix: PREFIX, controller: CONTROLLER, cleaner: CLEANER, parity: PARITY },
};

function goTestExit() {
  const [bin, ...args] = GO_TEST;
  const r = spawnSync(bin, args, {
    cwd: OPERATOR_MODULE,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 600_000,
  });
  if (r.error || r.status === null) {
    console.error(
      `mutation-prove-2171-go-redis-key-prefix: cannot run ${bin}: ${r.error?.message ?? r.signal}`,
    );
    process.exit(2);
  }
  return r.status;
}

declareMutations(MUTATIONS.length);
console.log(`mutation-prove-2171-go-redis-key-prefix: ${MUTATIONS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of MUTATIONS) {
  const path = PROVER.subjects[m.subject];
  if (path === undefined) {
    console.error(`mutation-prove-2171-go-redis-key-prefix: ${m.id} names no subject ${m.subject}`);
    process.exit(2);
  }
  const count = snapshot(path).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `mutation-prove-2171-go-redis-key-prefix: ${m.id}'s anchor occurs ${count} times in ${path}; aborting`,
    );
    process.exit(2);
  }
}

// Green baseline on a clean tree, else every verdict below is noise.
assertTreeClean(REPO_ROOT, 'baseline');
const base = goTestExit();
if (base !== 0) {
  console.error(
    `mutation-prove-2171-go-redis-key-prefix: baseline RED (exit ${base}); fix the tree first`,
  );
  process.exit(2);
}
console.log('mutation-prove-2171-go-redis-key-prefix: baseline green');

let failed = 0;
for (const m of MUTATIONS) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(PROVER.subjects[m.subject]);
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

console.log(
  `mutation-prove-2171-go-redis-key-prefix: ${MUTATIONS.length - failed}/${MUTATIONS.length} went red as required`,
);
process.exit(failed === 0 ? 0 : 1);
