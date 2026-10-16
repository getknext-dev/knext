#!/usr/bin/env node
/**
 * Mutation proof for the `spec.cache.keyPrefix` admission work (issue #2398),
 * TS half.
 *
 * Two guards, each with its own spec:
 *   - `redis-key-prefix-rule.test.ts` — the CLI copy of the CRD rule
 *     (`cli/redis-key-prefix.ts`), held in lockstep with the GENERATED CRD; the
 *     early `knext deploy` check in `validateConfig`; and the `knext doctor`
 *     finding that names stored apps whose prefix the cluster now refuses.
 *   - `crd-schema-diff-waivers.test.ts` — the narrowing waivers of the CRD
 *     additive-only guard (ADR-0017 Amendment 3): exact match, single use (a
 *     stale entry fails), only ratchetable value narrowings, a well-formed
 *     entry; the guard's new "bound added where none existed" class; and the
 *     committed waiver file against the committed CRD: a second, unlisted
 *     narrowing goes red, and so does an edit to a waived rule's text.
 *
 * The CRD admission rules themselves (the apiserver half) are proved by
 * `mutation-prove-2398-keyprefix-crd.mjs`.
 *
 * Exit 0 = every row went red; non-zero otherwise (see guard-prover.mjs).
 *
 * Usage:
 *   node scripts/mutation-prove-2398-keyprefix-cli-waivers.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RULE_SPEC = 'packages/kn-next/src/__tests__/redis-key-prefix-rule.test.ts';
const WAIVER_SPEC = 'tests/crd-schema-diff-waivers.test.ts';

const RULE = [
  {
    id: 'R01',
    subject: 'rule',
    claim: 'the CLI pattern admits * (drifts from the CRD)',
    anchor: 'export const KEY_PREFIX_PATTERN = "^[^*?',
    replacement: 'export const KEY_PREFIX_PATTERN = "^[^?',
  },
  {
    id: 'R02',
    subject: 'rule',
    claim: 'the CLI pattern admits whitespace',
    anchor: '\\\\\\\\ \\\\t\\\\n\\\\r\\\\f\\\\v]*$";',
    replacement: '\\\\\\\\]*$";',
  },
  {
    id: 'R03',
    subject: 'rule',
    claim: 'the CLI max length is off by one (drifts from the CRD)',
    anchor: 'export const KEY_PREFIX_MAX_LENGTH = 63;',
    replacement: 'export const KEY_PREFIX_MAX_LENGTH = 64;',
  },
  {
    id: 'R04',
    subject: 'rule',
    claim: 'the CLI length check is gone',
    anchor: '    if (length > KEY_PREFIX_MAX_LENGTH) {',
    replacement: '    if (false) {',
  },
  {
    id: 'R05',
    subject: 'rule',
    claim: 'the CLI forgets the nested reserved keyspace (kn-next:cache accepted)',
    anchor:
      '        prefix === LEGACY_SHARED_KEY_PREFIX ||\n        prefix.startsWith(`${LEGACY_SHARED_KEY_PREFIX}:`)',
    replacement: '        prefix === LEGACY_SHARED_KEY_PREFIX',
  },
  {
    id: 'R06',
    subject: 'rule',
    claim: 'the CLI forgets the reserved prefix itself (kn-next accepted)',
    anchor: '        prefix === LEGACY_SHARED_KEY_PREFIX ||\n',
    replacement: '',
  },
  {
    id: 'R07',
    subject: 'rule',
    claim: "the CLI's CEL mirror drifts from the CRD rule text",
    anchor: `    "self != 'kn-next' && !self.startsWith('kn-next:')";`,
    replacement: `    "self != 'kn-next'";`,
  },
  {
    id: 'V01',
    subject: 'validate',
    claim: 'knext deploy stops checking cache.keyPrefix before the build',
    anchor: '            const problem = keyPrefixProblem(keyPrefix);\n            if (problem) {',
    replacement:
      '            const problem = keyPrefixProblem(keyPrefix);\n            if (false) {',
  },
  {
    id: 'D01',
    subject: 'doctor',
    claim: 'doctor stops naming apps whose stored prefix is refused',
    anchor: '            if (problem)\n                invalid.push(',
    replacement: '            if (false)\n                invalid.push(',
  },
  {
    id: 'D02',
    subject: 'doctor',
    claim: 'doctor checks stored prefixes only on Redis apps (admission checks every app)',
    anchor: '    if (redisApps === 0 && invalid.length === 0) return [];',
    replacement: '    if (redisApps === 0) return [];',
  },
  {
    id: 'D03',
    subject: 'doctor',
    claim: 'doctor finds refused prefixes but never reports them',
    anchor: '    const problems: string[] = [...invalid];',
    replacement: '    const problems: string[] = [];',
  },
];

const WAIVERS = [
  {
    id: 'W01',
    subject: 'lib',
    claim: 'an unlisted violation is waived too (a second narrowing slips through)',
    anchor: '    remaining: violations.filter((v) => !listed.has(v)),',
    replacement: '    remaining: [],',
  },
  {
    id: 'W02',
    subject: 'lib',
    claim: 'stale entries are never reported (a waiver can be reused)',
    anchor: '    stale: waivers.filter((w) => !present.has(w.violation)),',
    replacement: '    stale: [],',
  },
  {
    id: 'W03',
    subject: 'script',
    claim: 'the guard reports a stale entry but still passes',
    anchor: '  if (stale.length > 0) {\n    failed = true;',
    replacement: '  if (stale.length > 0) {\n    failed = false;',
  },
  {
    id: 'W04',
    subject: 'script',
    claim: 'the guard honours a malformed entry',
    anchor: '    for (const problem of validateWaiverEntry(entry, fileExistsFn)) {',
    replacement: '    for (const problem of []) {',
  },
  {
    id: 'W05',
    subject: 'lib',
    claim: 'a structural change (removed field, type change) becomes waivable',
    anchor: '  if (!WAIVABLE.some((re) => re.test(entry.violation))) {',
    replacement: '  if (false) {',
  },
  {
    id: 'W06',
    subject: 'lib',
    claim: 'a CEL transition rule (oldSelf), which ratcheting does not cover, becomes waivable',
    anchor: '/\\boldSelf\\b/.test(entry.rule)',
    replacement: 'false',
  },
  {
    id: 'W07',
    subject: 'lib',
    claim: 'an entry need not name its own field (not exact: field path)',
    anchor: '  if (!entry.violation.includes(`$.${entry.field}.`)) {',
    replacement: '  if (false) {',
  },
  {
    id: 'W08',
    subject: 'lib',
    claim: 'an entry need not carry its rule text (not exact: rule text)',
    anchor: '!entry.violation.includes(JSON.stringify(entry.rule)) &&',
    replacement: 'false &&',
  },
  {
    id: 'W09',
    subject: 'lib',
    claim: 'a token justification is accepted',
    anchor: '  if (entry.justification.trim().length < MIN_JUSTIFICATION) {',
    replacement: '  if (false) {',
  },
  {
    id: 'W10',
    subject: 'lib',
    claim: 'an undated entry is accepted',
    anchor:
      '  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(entry.added) || Number.isNaN(Date.parse(entry.added))) {',
    replacement: '  if (false) {',
  },
  {
    id: 'W11',
    subject: 'lib',
    claim: 'an entry may point at any ADR, not the ADR-0017 amendment',
    anchor: '/^docs\\/adr\\/0017-[^/]+\\.md$/',
    replacement: '/^docs\\/adr\\/[^/]+\\.md$/',
  },
  {
    id: 'W12',
    subject: 'lib',
    claim: 'an entry may point at an ADR file that does not exist',
    anchor: '  } else if (!fileExists(adrPath)) {',
    replacement: '  } else if (false) {',
  },
  {
    id: 'W13',
    subject: 'lib',
    claim: 'a bound added where none existed is not a violation (the guard blind spot returns)',
    anchor: '      if (!(COUNT_MINIMUMS.has(key) && newVal <= 0)) {',
    replacement: '      if (false) {',
  },
  {
    id: 'W14',
    subject: 'lib',
    claim: 'a no-op minLength: 0 is flagged as a narrowing',
    anchor: '      if (!(COUNT_MINIMUMS.has(key) && newVal <= 0)) {',
    replacement: '      if (true) {',
  },
  {
    id: 'X01',
    subject: 'crd',
    claim: 'a second, unlisted narrowing on keyPrefix (minLength: 1) passes',
    anchor: '                    maxLength: 63\n                    pattern: ^[^*?',
    replacement:
      '                    maxLength: 63\n                    minLength: 1\n                    pattern: ^[^*?',
  },
  {
    id: 'X02',
    subject: 'crd',
    claim: "an edit to the waived CEL rule's text passes under the old waiver",
    anchor: "rule: self != 'kn-next' && !self.startsWith('kn-next:')",
    replacement: "rule: self != 'kn-next' && !self.startsWith('kn-next:x')",
  },
  {
    id: 'X03',
    subject: 'crd',
    claim: 'an edit to the waived pattern passes under the old waiver',
    anchor: 'pattern: ^[^*?\\[\\]\\\\ \\t',
    replacement: 'pattern: ^[^*?\\[\\]\\\\\\t',
  },
  {
    id: 'X04',
    subject: 'waivers',
    claim:
      'the waiver file lists a violation the CRD does not carry (stale) and misses one it does',
    anchor: 'keyPrefix.maxLength: added (63) where none existed before',
    replacement: 'keyPrefix.maxLength: added (64) where none existed before',
  },
];

const rule = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: RULE_SPEC,
  subjects: {
    rule: 'packages/kn-next/src/cli/redis-key-prefix.ts',
    validate: 'packages/kn-next/src/cli/validate.ts',
    doctor: 'packages/kn-next/src/cli/doctor/checks/redis-prefix.ts',
  },
});
const waivers = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: WAIVER_SPEC,
  subjects: {
    lib: 'scripts/lib/crd-schema-diff.mjs',
    script: 'scripts/crd-schema-diff.mjs',
    crd: 'packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml',
    waivers: 'scripts/crd-narrowing-waivers.json',
  },
});

console.log('=== mutation proof: keyPrefix admission (#2398), TS half ===');
rule.preflight(RULE);
waivers.preflight(WAIVERS);
declareMutations(RULE.length + WAIVERS.length);

console.log(`\n=== CLI rule + doctor rows: ${RULE_SPEC} ===`);
rule.baseline();
rule.proveCanSeeRed({
  subject: 'rule',
  anchor: 'export const LEGACY_SHARED_KEY_PREFIX = "kn-next";',
  replacement: 'export const LEGACY_SHARED_KEY_PREFIX = "kn-nexx";',
});
for (const m of RULE) {
  rule.run({ ...m, expect: 'red' });
  recordMutation();
}
rule.finish(RULE.length);

console.log(`\n=== waiver rows: ${WAIVER_SPEC} ===`);
waivers.baseline();
waivers.proveCanSeeRed({
  subject: 'lib',
  anchor: 'const MIN_JUSTIFICATION = 40;',
  replacement: 'const MIN_JUSTIFICATION = 4000;',
});
for (const m of WAIVERS) {
  waivers.run({ ...m, expect: 'red' });
  recordMutation();
}
waivers.finish(WAIVERS.length);
