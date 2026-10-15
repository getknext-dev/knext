#!/usr/bin/env node
/**
 * Mutation proof for Redis key-prefix isolation between apps (issue #2171), TS half.
 *
 * Apps on one Redis are separated by key prefix only, and both outage-collapse
 * sweeps (ISR `<prefix>:cache:*`, `'use cache'` `<prefix>:uc:*`) delete by that
 * prefix. Apps without one used to share the fallback `kn-next`, so one app's
 * collapse deleted the others' caches. Three specs grade the fix:
 *
 *  - COLLAPSE rows grade `redis-prefix-collapse-isolation.test.ts`: two app
 *    processes on one Redis; app A's collapse under the shared fallback must
 *    leave app B's keys, refuse loudly, and count the refusal, while on distinct
 *    prefixes the collapse must still run. Runs on the fake RESP server always and
 *    also on a real Redis when KNEXT_REDIS_LIVE_URL is set.
 *  - DOCTOR rows grade `doctor-redis-prefix.test.ts`: the `knext doctor` row that
 *    flags shared, nested and fallback prefixes, and its derivation vector.
 *  - HYGIENE rows grade `apps/docs/content-hygiene.test.ts`: the docs guard was
 *    narrowed to tolerate the Redis key form `kn-next:<key>` and the value of a
 *    `REDIS_KEY_PREFIX` assignment; it must still catch the bare CLI word,
 *    including `kn-next: command not found`.
 *  - WORKFLOW row grades `tests/use-cache-lua-live-workflow.test.ts`: the
 *    `use-cache-lua-live-redis` CI job must keep running the collapse spec, the
 *    only lane where it meets a real Redis.
 *
 * The operator half (the derived default, its yielding, and the finalizer) is
 * `mutation-prove-2171-go-redis-key-prefix.mjs`.
 *
 * Verdicts are by EXIT CODE only (`scripts/lib/guard-prover.mjs`), every anchor
 * must occur exactly once (preflight first), each baseline must be green, a
 * canary must go red before any green is trusted, and every restore is
 * content-verified.
 *
 * Usage:
 *   node scripts/mutation-prove-2171-redis-prefix-isolation.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COLLAPSE_SPEC = 'packages/kn-next/src/__tests__/redis-prefix-collapse-isolation.test.ts';
const DOCTOR_SPEC = 'packages/kn-next/src/__tests__/doctor-redis-prefix.test.ts';
const HYGIENE_SPEC = 'apps/docs/content-hygiene.test.ts';
const WORKFLOW_SPEC = 'tests/use-cache-lua-live-workflow.test.ts';

const COLLAPSE = [
  {
    id: 'C01',
    subject: 'isr',
    claim: 'the ISR collapse sweeps under the shared fallback (refusal removed)',
    anchor: '  if (!collapseSweepAllowed(KEY_PREFIX)) {',
    replacement: '  if (false) {',
  },
  {
    id: 'C02',
    subject: 'uc',
    claim: "the 'use cache' collapse sweeps under the shared fallback (refusal removed)",
    anchor: '  if (!collapseSweepAllowed(prefix)) {',
    replacement: '  if (false) {',
  },
  {
    id: 'C03',
    subject: 'uc',
    claim: 'the shared fallback counts as a sweepable prefix',
    anchor:
      "  return typeof prefix === 'string' && prefix !== '' && prefix !== LEGACY_SHARED_KEY_PREFIX;",
    replacement: "  return typeof prefix === 'string' && prefix !== '';",
  },
  {
    id: 'C04',
    subject: 'uc',
    claim: 'the refusal refuses every prefix (a unique prefix is never collapsed)',
    anchor:
      "  return typeof prefix === 'string' && prefix !== '' && prefix !== LEGACY_SHARED_KEY_PREFIX;",
    replacement: '  return false;',
  },
  {
    id: 'C05',
    subject: 'uc',
    claim: "a refused 'use cache' collapse is not counted",
    anchor: "    count('tagsCollapseRefused');",
    replacement: '',
  },
  {
    id: 'C06',
    subject: 'uc',
    claim: "a refused 'use cache' collapse is silent",
    anchor: '    console.error(collapseRefusedMessage("\'use cache\' entry", prefix));',
    replacement: '',
  },
  {
    id: 'C07',
    subject: 'isr',
    claim: 'a refused ISR collapse is silent',
    anchor: "    console.error(collapseRefusedMessage('ISR entry', KEY_PREFIX));",
    replacement: '',
  },
  {
    id: 'C08',
    subject: 'isr',
    claim: 'the ISR fallback prefix drifts from the one the refusal knows',
    anchor: 'let KEY_PREFIX = process.env.REDIS_KEY_PREFIX || LEGACY_SHARED_KEY_PREFIX;',
    replacement: "let KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'kn-next-drift';",
  },
];

const DOCTOR = [
  {
    id: 'D01',
    subject: 'orchestrator',
    claim: 'the check is not wired into runDoctor',
    anchor:
      '    checks.push(...redisPrefixCheck(ctx)); // no row unless a NextApp uses a Redis cache',
    replacement: '',
  },
  {
    id: 'D02',
    subject: 'check',
    claim: 'two apps on one prefix are not flagged',
    anchor: '        if (apps.length > 1) {',
    replacement: '        if (apps.length > 99) {',
  },
  {
    id: 'D03',
    subject: 'check',
    claim: 'an app on the shared fallback is not flagged',
    anchor: '        if (prefix === LEGACY_SHARED_KEY_PREFIX) {',
    replacement: '        if (false) {',
  },
  {
    id: 'D04',
    subject: 'check',
    claim: "a prefix nested in another's sweep pattern is not flagged",
    anchor: '            if (inner !== outer && inner.startsWith(`${outer}:`)) {',
    replacement: '            if (false) {',
  },
  {
    id: 'D05',
    subject: 'check',
    claim: "the derived default drifts from the operator's (name/namespace swapped)",
    anchor: '        .update(`${namespace}/${name}`)',
    replacement: '        .update(`${name}/${namespace}`)',
  },
  {
    id: 'D06',
    subject: 'check',
    claim: "a REDIS_KEY_PREFIX in spec.env is not taken as the app's prefix",
    anchor: '        else if (fromEnv) prefix = fromEnv;',
    replacement: '',
  },
  {
    id: 'D07',
    subject: 'check',
    claim: 'a Secret-sourced prefix is guessed as the derived default instead of named unverified',
    anchor: '            unverified.push(app);\n            continue;',
    replacement: '            prefix = defaultRedisKeyPrefix(namespace, name);',
  },
  {
    id: 'D08',
    subject: 'check',
    claim:
      "an empty spec.env REDIS_KEY_PREFIX counts as a prefix of '' (the operator renders the derived default)",
    anchor: '        else if (fromEnv) prefix = fromEnv;',
    replacement: '        else if (fromEnv !== undefined) prefix = fromEnv;',
  },
];

const HYGIENE = [
  {
    id: 'H01',
    subject: 'guard',
    claim: 'the docs guard tolerates any `kn-next:` (including `kn-next: command not found`)',
    anchor: 'kn-next(?![\\w.\\-/]|:[^\\s`])/;',
    replacement: 'kn-next(?![\\w.\\-/:])/;',
  },
  {
    id: 'H02',
    subject: 'guard',
    claim:
      'the docs guard flags the REDIS_KEY_PREFIX value the caching page pins (tolerance removed)',
    anchor: '(?<!REDIS_KEY_PREFIX[\'"]?\\s*[:=]\\s*[\'"]?)',
    replacement: '',
  },
];

const WORKFLOW = [
  {
    id: 'W01',
    subject: 'ci',
    claim: 'the use-cache-lua-live-redis job stops running the collapse spec on its real Redis',
    anchor: '          packages/kn-next/src/__tests__/redis-prefix-collapse-isolation.test.ts\n',
    replacement: '',
  },
];

const collapse = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: COLLAPSE_SPEC,
  subjects: {
    isr: 'packages/kn-next/src/adapters/cache-handler.js',
    uc: 'packages/kn-next/src/adapters/use-cache-handler.js',
  },
});
const doctor = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: DOCTOR_SPEC,
  subjects: {
    check: 'packages/kn-next/src/cli/doctor/checks/redis-prefix.ts',
    orchestrator: 'packages/kn-next/src/cli/doctor.ts',
  },
});
const hygiene = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: HYGIENE_SPEC,
  subjects: { guard: 'apps/docs/content-hygiene.test.ts' },
});
const workflow = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: WORKFLOW_SPEC,
  subjects: { ci: '.github/workflows/ci.yml' },
});

console.log('=== mutation proof: Redis key-prefix isolation (#2171), TS half ===');
collapse.preflight(COLLAPSE);
doctor.preflight(DOCTOR);
hygiene.preflight(HYGIENE);
workflow.preflight(WORKFLOW);
declareMutations(COLLAPSE.length + DOCTOR.length + HYGIENE.length + WORKFLOW.length);

console.log(`\n=== collapse rows: ${COLLAPSE_SPEC} ===`);
collapse.baseline();
collapse.proveCanSeeRed({
  subject: 'uc',
  anchor: "export const LEGACY_SHARED_KEY_PREFIX = 'kn-next';",
  replacement: "export const LEGACY_SHARED_KEY_PREFIX = 'kn-nexx';",
});
for (const m of COLLAPSE) {
  collapse.run({ ...m, expect: 'red' });
  recordMutation();
}
collapse.finish(COLLAPSE.length);

console.log(`\n=== doctor rows: ${DOCTOR_SPEC} ===`);
doctor.baseline();
doctor.proveCanSeeRed({
  subject: 'check',
  anchor: '    return `kn-${hex.slice(0, 12)}`;',
  replacement: '    return `kn-${hex.slice(0, 11)}`;',
});
for (const m of DOCTOR) {
  doctor.run({ ...m, expect: 'red' });
  recordMutation();
}
doctor.finish(DOCTOR.length);

console.log(`\n=== hygiene rows: ${HYGIENE_SPEC} ===`);
hygiene.baseline();
hygiene.proveCanSeeRed({
  subject: 'guard',
  anchor: "  const REMOVAL_PAGES = ['upgrading.mdx', 'versioning.mdx'];",
  replacement: "  const REMOVAL_PAGES = ['upgrading.mdx'];",
});
for (const m of HYGIENE) {
  hygiene.run({ ...m, expect: 'red' });
  recordMutation();
}
hygiene.finish(HYGIENE.length);

console.log(`\n=== workflow row: ${WORKFLOW_SPEC} ===`);
workflow.baseline();
workflow.proveCanSeeRed({
  subject: 'ci',
  anchor:
    '          node scripts/bun-test.mjs --no-skip\n          packages/kn-next/src/__tests__/use-cache-replay-script-live-redis.test.ts',
  replacement:
    '          node scripts/bun-test.mjs\n          packages/kn-next/src/__tests__/use-cache-replay-script-live-redis.test.ts',
});
for (const m of WORKFLOW) {
  workflow.run({ ...m, expect: 'red' });
  recordMutation();
}
workflow.finish(WORKFLOW.length);
