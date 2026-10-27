#!/usr/bin/env node
/**
 * Mutation prover for #2500, TS half: the alert on the operator's write-policy
 * gauge, and `knext doctor`'s mirror of the operator's verdict.
 *
 * The operator half (the verdict, the gauge, the RBAC, the kustomize wiring) is
 * `mutation-prove-2500-write-policy-selfcheck.mjs`. This half proves, by exit
 * code, that the two TS consumers BITE:
 *
 *   A1-A3  the alert: the comparison (a 1 instead of a 0), the `for` (a restart
 *          would flap it), and the severity (every pre-1.30 cluster would page);
 *   D1-D8  doctor: it must reach the operator's verdict on the same objects, so
 *          each rule of the verdict is broken in turn (Deny, the username, the
 *          fail-open policy), plus the version floor, the configured policy name,
 *          the RBAC-denied and not-found branches, and "forced to pass".
 *
 * Runs on the shared driver (`lib/guard-prover.mjs`): exit codes only, anchors
 * exactly once (preflight), green baseline, a canary red first, tree checked
 * clean between rows, partial run = failure.
 *
 *   node scripts/mutation-prove-2500-write-policy-ts.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RULE = 'packages/kn-next-operator/config/observability/prometheusrule.yaml';
const DOCTOR = 'packages/kn-next/src/cli/doctor/checks/write-policy.ts';
const ALERT_SPEC = 'apps/file-manager/src/app/api/_metrics/prometheusrule.test.ts';
const DOCTOR_SPEC = 'packages/kn-next/src/__tests__/doctor-write-policy.test.ts';
const CANONICAL_SPEC = 'packages/kn-next/src/__tests__/doctor-write-policy-canonical.test.ts';

const ALERT_ROWS = [
  {
    id: 'A1',
    expect: 'red',
    claim: 'the alert fires on a 1 (enforced) instead of a 0',
    subject: 'rule',
    anchor: '          expr: knext_operator_write_policy_enforced == 0',
    replacement: '          expr: knext_operator_write_policy_enforced == 1',
  },
  {
    id: 'A2',
    expect: 'red',
    claim: 'the alert has no `for`, so a restart flaps it',
    subject: 'rule',
    anchor: '          expr: knext_operator_write_policy_enforced == 0\n          for: 15m\n',
    replacement: '          expr: knext_operator_write_policy_enforced == 0\n',
  },
  {
    id: 'A3',
    expect: 'red',
    claim: 'the alert pages at critical severity on every pre-1.30 cluster',
    subject: 'rule',
    anchor:
      '          expr: knext_operator_write_policy_enforced == 0\n          for: 15m\n          labels:\n            severity: warning',
    replacement:
      '          expr: knext_operator_write_policy_enforced == 0\n          for: 15m\n          labels:\n            severity: critical',
  },
  {
    id: 'A4',
    expect: 'red',
    claim:
      'the companion alert no longer pairs the scraped target with the gauge (it would never fire, or always)',
    subject: 'rule',
    anchor: 'unless on (namespace, pod) knext_operator_write_policy_enforced\n          for: 15m',
    replacement:
      'unless on (namespace, pod) knext_operator_write_policy_enforced_typo\n          for: 15m',
  },
  {
    id: 'A5',
    expect: 'red',
    claim:
      'the companion alert selects a job the operator is not scraped under (silent in exactly the case it exists for)',
    subject: 'rule',
    anchor: 'up{job=~".*controller-manager-metrics-service"}',
    replacement: 'up{job=~"knext-nextapp"}',
  },
  {
    id: 'A6',
    expect: 'red',
    claim: 'the companion alert has no `for`, so a scrape gap at start-up pages',
    subject: 'rule',
    anchor: 'unless on (namespace, pod) knext_operator_write_policy_enforced\n          for: 15m\n',
    replacement: 'unless on (namespace, pod) knext_operator_write_policy_enforced\n',
  },
];

const DOCTOR_ROWS = [
  {
    id: 'D1',
    expect: 'red',
    claim: 'doctor accepts a binding that does not Deny',
    subject: 'doctor',
    anchor: '    if (!(binding.spec?.validationActions ?? []).includes("Deny")) {',
    replacement: '    if (false) {',
  },
  {
    id: 'D2',
    expect: 'red',
    claim: "doctor does not compare the policy's username with the operator's",
    subject: 'doctor',
    anchor: '    if (confined !== operatorUsername) {',
    replacement: '    if (false) {',
  },
  {
    id: 'D3',
    expect: 'red',
    claim: 'doctor does not compare the server version with the 1.30 floor',
    subject: 'doctor',
    anchor: 'version.minor < FLOOR.minor',
    replacement: 'version.minor < 0',
  },
  {
    id: 'D4',
    expect: 'red',
    claim: 'doctor reports PASS whatever the verdict is (forced to true)',
    subject: 'doctor',
    anchor: '    if (v.enforced) {',
    replacement: '    if (true) {',
  },
  {
    id: 'D5',
    expect: 'red',
    claim: 'doctor ignores the policy name the operator was configured with',
    subject: 'doctor',
    anchor: 'container?.env?.find((e) => e.name === "WRITE_POLICY_NAME")?.value ||',
    replacement: 'undefined ||',
  },
  {
    id: 'D6',
    expect: 'red',
    claim: 'doctor reports an RBAC-denied read as an error, not as "cannot determine"',
    subject: 'doctor',
    anchor: '        if (cls === "forbidden") {',
    replacement: '        if (false) {',
  },
  {
    id: 'D7',
    expect: 'red',
    claim: 'doctor does not treat a not-found policy as a missing policy',
    subject: 'doctor',
    anchor: '        if (cls === "not-found") continue;',
    replacement: '        if (false) continue;',
  },
  {
    id: 'D8',
    expect: 'red',
    claim: 'doctor treats a policy that fails open as fine',
    subject: 'doctor',
    anchor: '    if (policy.spec?.failurePolicy === "Ignore") {',
    replacement: '    if (false) {',
  },
  {
    id: 'D9',
    expect: 'red',
    claim: 'doctor accepts an excludeResourceRules entry that carves resources out of the policy',
    subject: 'doctor',
    anchor: '    if ((policy.spec.matchConstraints.excludeResourceRules ?? []).length > 0) {',
    replacement: '    if (false) {',
  },
  {
    id: 'D10',
    expect: 'red',
    claim: 'doctor accepts a covering rule that names objects (resourceNames)',
    subject: 'doctor',
    anchor: '(r.resourceNames ?? []).length === 0 &&',
    replacement: 'true &&',
  },
  {
    id: 'D11',
    expect: 'red',
    claim: 'doctor accepts a cluster-scoped rule as covering namespaced Secrets and ConfigMaps',
    subject: 'doctor',
    anchor: '                    (r.scope === undefined ||',
    replacement: '                    (true ||',
  },
  {
    id: 'D12',
    expect: 'red',
    claim: 'doctor accepts a rule for another apiVersion as covering core v1',
    subject: 'doctor',
    anchor: 'has(r.apiVersions, "v1") &&',
    replacement: 'true &&',
  },
  {
    id: 'D13',
    expect: 'red',
    claim:
      'doctor never compares the policy body with the shipped CEL (validations: [true] passes)',
    subject: 'doctor',
    anchor: '    if (!sameCEL(policy)) {',
    replacement: '    if (false) {',
  },
  {
    id: 'D17',
    expect: 'red',
    claim:
      'doctor accepts a policy that declares paramKind (a paramRef that finds nothing then runs no validation)',
    subject: 'doctor',
    anchor: '    if (policy.spec?.paramKind != null) {',
    replacement: '    if (false) {',
  },
  {
    id: 'D18',
    expect: 'red',
    claim:
      'doctor accepts a binding that sets paramRef (a missing parameter makes the apiserver skip every validation)',
    subject: 'doctor',
    anchor: '    if (binding.spec?.paramRef != null) {',
    replacement: '    if (false) {',
  },
];

const CANONICAL_ROWS = [
  {
    id: 'D14',
    expect: 'red',
    claim: 'doctor SKIPs, instead of WARNing, on a read failure it cannot classify',
    subject: 'doctor',
    anchor: '                "warn",\n                `could not read the operator\'s write policy',
    replacement:
      '                "skip",\n                `could not read the operator\'s write policy',
  },
  {
    id: 'D15',
    expect: 'red',
    claim: 'doctor SKIPs, instead of WARNing, on unparseable policy output',
    subject: 'doctor',
    anchor:
      '                "warn",\n                `the operator\'s write policy ${name} returned unreadable output',
    replacement:
      '                "skip",\n                `the operator\'s write policy ${name} returned unreadable output',
  },
  {
    id: 'D16',
    expect: 'red',
    claim: "doctor's canonical CEL copy drifts from the shipped policy",
    subject: 'doctor',
    anchor: '{ name: "allowedSecretType", expression: "\'Opaque\'" },',
    replacement: '{ name: "allowedSecretType", expression: "\'Opaque2\'" },',
  },
];

// Real mutations of the real subjects, so each also proves its runner reads them.
const ALERT_CANARY = {
  subject: 'rule',
  anchor: '          expr: knext_operator_write_policy_enforced == 0',
  replacement: '          expr: knext_operator_write_policy_enforced == 1',
};
const CANONICAL_CANARY = {
  subject: 'doctor',
  anchor: '{ name: "allowedSecretType", expression: "\'Opaque\'" },',
  replacement: '{ name: "allowedSecretType", expression: "\'Opaque3\'" },',
};
const DOCTOR_CANARY = {
  subject: 'doctor',
  anchor: '    if (v.enforced) {',
  replacement: '    if (true) {',
};

const alert = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: ALERT_SPEC,
  subjects: { rule: RULE },
});
const doctor = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: DOCTOR_SPEC,
  subjects: { doctor: DOCTOR },
});

const canonical = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: CANONICAL_SPEC,
  subjects: { doctor: DOCTOR },
});

console.log('=== mutation proof: the write-policy alert and the doctor mirror (#2500) ===');
alert.preflight([...ALERT_ROWS, { id: 'canary', ...ALERT_CANARY }]);
doctor.preflight([...DOCTOR_ROWS, { id: 'canary', ...DOCTOR_CANARY }]);
canonical.preflight([...CANONICAL_ROWS, { id: 'canary', ...CANONICAL_CANARY }]);
declareMutations(ALERT_ROWS.length + DOCTOR_ROWS.length + CANONICAL_ROWS.length);

console.log(`\n=== ${ALERT_SPEC} ===`);
alert.baseline();
alert.proveCanSeeRed(ALERT_CANARY);
for (const m of ALERT_ROWS) {
  alert.run(m);
  recordMutation();
}
alert.finish(ALERT_ROWS.length);

console.log(`\n=== ${DOCTOR_SPEC} ===`);
doctor.baseline();
doctor.proveCanSeeRed(DOCTOR_CANARY);
for (const m of DOCTOR_ROWS) {
  doctor.run(m);
  recordMutation();
}
doctor.finish(DOCTOR_ROWS.length);

console.log(`\n=== ${CANONICAL_SPEC} ===`);
canonical.baseline();
canonical.proveCanSeeRed(CANONICAL_CANARY);
for (const m of CANONICAL_ROWS) {
  canonical.run(m);
  recordMutation();
}
canonical.finish(CANONICAL_ROWS.length);
