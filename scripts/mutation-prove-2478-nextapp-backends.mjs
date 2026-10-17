#!/usr/bin/env node
/**
 * Mutation proof for the zone half of a function binding: `knext deploy` emits
 * `spec.backends[]` on the NextApp from `backends` in the config (issue #2478).
 *
 * Guards proved, each against its own spec:
 *   - `cr-builder-backends.test.ts`    what the builder emits: {name, service}, the
 *                                      service default, config order, NO field for
 *                                      an absent or empty list, none on a preview,
 *                                      no stray keys copied through.
 *   - `validate-backends.test.ts`      an invalid name is refused locally, with the
 *                                      SAME bounds the shipped CRD enforces (read from
 *                                      the CRD file), and the validator is wired in.
 *   - `cr-preflight-backends.test.ts`  the emitted paths are defined by the CRD this
 *                                      repo ships, the entries satisfy its patterns,
 *                                      and an older CRD is named by the preflight.
 *   - `deploy-backends-applied.test.ts`  the end of the chain: the file the preflight
 *                                      dry-runs and the file `kubectl apply
 *                                      --validate=strict` sends both carry the list,
 *                                      and an invalid config stops before anything runs.
 *
 * Two kinds of row: the code under guard broken (the spec must go red), and the
 * shipped CRD changed under the CLI (the contract must go red). A CLI/CRD pair
 * that drifts is exactly what a strict apply rejects on a real cluster.
 *
 * Discipline (see scripts/lib/guard-prover.mjs): every anchor occurs exactly once
 * (else ABORT in the preflight), every verdict is the runner's EXIT CODE, the
 * baseline must be green first, a CANARY must go red before any green below is
 * trusted, and the tree is checked clean between mutations. Run it on a COMMITTED
 * tree: a dirty tree aborts the baseline.
 *
 * Not provable here: that a real operator renders the binding env from the list
 * (the operator's own envtests and the kind drill do), and the cluster-write-kinds
 * and spawn scans, which have their own prover (mutation-prove-2053-*).
 *
 * Exit 0 = every row went red; non-zero otherwise.
 *
 * Usage:
 *   node scripts/mutation-prove-2478-nextapp-backends.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A mid-line mutation in TypeScript must not comment out the rest of its line,
// so the residue marker is a block comment there.
const TS_INLINE = { commentPrefix: '/*' };
const YAML_LINE = { commentPrefix: '#' };

const EMIT = '...(backends ? { backends } : {}),';

// ---------------------------------------------------------------------------
// What the builder emits
// ---------------------------------------------------------------------------
const BUILDER = [
  {
    id: 'B01',
    subject: 'crBuilder',
    claim: 'a configured function is no longer emitted into the NextApp',
    anchor: EMIT,
    replacement: '...{},',
    options: TS_INLINE,
  },
  {
    id: 'B02',
    subject: 'crBuilder',
    claim: 'an EMPTY list is emitted as `backends: []` (old operators see a new field)',
    anchor: '!preview && config.backends?.length',
    replacement: '!preview && config.backends',
    options: TS_INLINE,
  },
  {
    id: 'B03',
    subject: 'crBuilder',
    claim: 'a preview inherits the base app bindings (a function names one zone)',
    anchor: '!preview && config.backends?.length',
    replacement: 'config.backends?.length',
    options: TS_INLINE,
  },
  {
    id: 'B04',
    subject: 'crBuilder',
    claim: 'service no longer defaults to the binding name',
    anchor: 'service: b.service ?? b.name,',
    replacement: 'service: b.service,',
    options: TS_INLINE,
  },
  {
    id: 'B05',
    subject: 'crBuilder',
    claim: 'keys the config did not define are copied into the CR',
    anchor: 'name: b.name,',
    replacement: '...b, name: b.name,',
    options: TS_INLINE,
  },
  {
    id: 'B06',
    subject: 'crBuilder',
    claim: 'the config order is not kept (the list is re-sorted)',
    anchor: 'config.backends.map(',
    replacement: '[...config.backends].sort((x, y) => x.name.localeCompare(y.name)).map(',
    options: TS_INLINE,
  },
];

// ---------------------------------------------------------------------------
// The local validator, and the CRD it must agree with
// ---------------------------------------------------------------------------
const VALIDATE = [
  {
    id: 'V01',
    subject: 'validate',
    claim: 'a double hyphen or trailing hyphen in a name is accepted',
    anchor: '/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;',
    replacement: '/^[a-z][a-z0-9-]*$/;',
    options: TS_INLINE,
  },
  {
    id: 'V02',
    subject: 'validate',
    claim: 'a 64-character name is accepted (the CRD stops at 63)',
    anchor: 'const BACKEND_NAME_MAX_LENGTH = 63;',
    replacement: 'const BACKEND_NAME_MAX_LENGTH = 64;',
    options: TS_INLINE,
  },
  {
    id: 'V03',
    subject: 'validate',
    claim: 'a 65th entry is accepted (the CRD stops at 64)',
    anchor: 'const BACKENDS_MAX_ITEMS = 64;',
    replacement: 'const BACKENDS_MAX_ITEMS = 65;',
    options: TS_INLINE,
  },
  {
    id: 'V04',
    subject: 'validate',
    claim: 'the same binding name twice is accepted (the CRD list is keyed by name)',
    anchor: 'names.has(name) && !reported.has(`name:${name}`)',
    replacement: 'false',
    options: TS_INLINE,
  },
  {
    id: 'V05',
    subject: 'validate',
    claim: 'the same function bound twice is accepted (the CRD allows each once)',
    anchor: 'services.has(bound) && !reported.has(`service:${bound}`)',
    replacement: 'false',
    options: TS_INLINE,
  },
  {
    id: 'V06',
    subject: 'validate',
    claim: 'an unknown key on an entry is accepted',
    anchor: '!BACKEND_KEYS.includes(key)',
    replacement: 'false',
    options: TS_INLINE,
  },
  {
    id: 'V07',
    subject: 'validate',
    claim: 'a value that is not a list is no longer refused',
    anchor: '!Array.isArray(backends)',
    replacement: 'false',
    options: TS_INLINE,
  },
  {
    id: 'V08',
    subject: 'validate',
    claim: 'a service longer than 63 characters is accepted',
    anchor: 'service.length > BACKEND_NAME_MAX_LENGTH ||',
    replacement: 'false ||',
    options: TS_INLINE,
  },
  {
    id: 'V09',
    subject: 'validate',
    claim: 'the validator is no longer wired into validateConfig',
    anchor: 'errors.push(...validateBackends(config.backends));',
    replacement: 'void validateBackends;',
    options: TS_INLINE,
  },
  {
    id: 'V10',
    subject: 'validate',
    claim: 'a name longer than 63 characters is accepted',
    anchor: 'name.length > BACKEND_NAME_MAX_LENGTH ||',
    replacement: 'false ||',
    options: TS_INLINE,
  },
  {
    id: 'C01',
    subject: 'crd',
    claim: 'the CRD allows a 65th entry (CLI and CRD disagree)',
    anchor:
      '                maxItems: 64\n                type: array\n                x-kubernetes-list-map-keys:',
    replacement:
      '                maxItems: 65\n                type: array\n                x-kubernetes-list-map-keys:',
    options: YAML_LINE,
  },
  {
    id: 'C02',
    subject: 'crd',
    claim: 'the CRD loses the each-function-bound-once rule (CLI and CRD disagree)',
    anchor: 'rule: self.all(a, self.exists_one(b, b.service == a.service))',
    replacement: 'rule: self.all(a, true)',
    options: YAML_LINE,
  },
];

// ---------------------------------------------------------------------------
// The CRD contract: what the CLI emits is defined by the CRD it ships against
// ---------------------------------------------------------------------------
const CONTRACT = [
  {
    id: 'P01',
    subject: 'emitted',
    claim: 'the field list the preflight diffs no longer includes spec.backends',
    anchor: '"spec.backends",',
    replacement: '',
    options: TS_INLINE,
  },
  {
    id: 'P02',
    subject: 'crBuilder',
    claim: 'the builder stops emitting the field (the contract has nothing to check)',
    anchor: EMIT,
    replacement: '...{},',
    options: TS_INLINE,
  },
  {
    id: 'P03',
    subject: 'crd',
    claim: 'the shipped CRD no longer defines spec.backends[].service',
    anchor:
      '                    service:\n                      description: Service is the name of the BackendService in this',
    replacement:
      '                    serviceX:\n                      description: Service is the name of the BackendService in this',
    options: YAML_LINE,
  },
];

// ---------------------------------------------------------------------------
// Deploy: the file that is dry-run and the file that is applied
// ---------------------------------------------------------------------------
const DEPLOY = [
  {
    id: 'D01',
    subject: 'crBuilder',
    claim: 'the applied NextApp no longer carries the list',
    anchor: EMIT,
    replacement: '...{},',
    options: TS_INLINE,
  },
  {
    id: 'D02',
    subject: 'validate',
    claim: 'an invalid name reaches the cluster path (validation not wired)',
    anchor: 'errors.push(...validateBackends(config.backends));',
    replacement: 'void validateBackends;',
    options: TS_INLINE,
  },
  {
    id: 'D03',
    subject: 'deploy',
    claim: 'the applied NextApp is rendered without the list',
    anchor: '    const crYaml = renderNextAppCR(\n        config,\n        imageRef,',
    replacement:
      '    const crYaml = renderNextAppCR(\n        { ...config, backends: undefined },\n        imageRef,',
  },
  {
    id: 'D04',
    subject: 'deploy',
    claim: 'the preflight dry-runs a NextApp without the list (it checks a different CR)',
    anchor: '        renderNextAppCR(\n            config,\n            preflightImageRef(',
    replacement:
      '        renderNextAppCR(\n            { ...config, backends: undefined },\n            preflightImageRef(',
  },
];

const builder = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/kn-next/src/__tests__/cr-builder-backends.test.ts',
  subjects: { crBuilder: 'packages/kn-next/src/cli/cr-builder.ts' },
});
const validate = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/kn-next/src/__tests__/validate-backends.test.ts',
  subjects: {
    validate: 'packages/kn-next/src/cli/validate.ts',
    crd: 'packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml',
  },
});
const contract = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/kn-next/src/__tests__/cr-preflight-backends.test.ts',
  subjects: {
    crBuilder: 'packages/kn-next/src/cli/cr-builder.ts',
    emitted: 'packages/kn-next/src/cli/schema/emitted-fields.generated.ts',
    crd: 'packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml',
  },
});
const deploy = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/kn-next/src/__tests__/deploy-backends-applied.test.ts',
  subjects: {
    crBuilder: 'packages/kn-next/src/cli/cr-builder.ts',
    validate: 'packages/kn-next/src/cli/validate.ts',
    deploy: 'packages/kn-next/src/cli/deploy.ts',
  },
});

console.log('=== mutation proof: knext deploy emits the zone bindings in the NextApp (#2478) ===');
builder.preflight(BUILDER);
validate.preflight(VALIDATE);
contract.preflight(CONTRACT);
deploy.preflight(DEPLOY);
declareMutations(BUILDER.length + VALIDATE.length + CONTRACT.length + DEPLOY.length);

console.log('\n=== what the builder emits (cr-builder-backends.test.ts) ===');
builder.baseline();
builder.proveCanSeeRed({
  subject: 'crBuilder',
  anchor: EMIT,
  replacement: '...{},',
  options: TS_INLINE,
});
for (const m of BUILDER) {
  builder.run({ ...m, expect: 'red' });
  recordMutation();
}
builder.finish(BUILDER.length);

console.log(
  '\n=== invalid names refused, bounds agree with the CRD (validate-backends.test.ts) ===',
);
validate.baseline();
validate.proveCanSeeRed({
  subject: 'validate',
  anchor: 'const BACKENDS_MAX_ITEMS = 64;',
  replacement: 'const BACKENDS_MAX_ITEMS = 65;',
  options: TS_INLINE,
});
for (const m of VALIDATE) {
  validate.run({ ...m, expect: 'red' });
  recordMutation();
}
validate.finish(VALIDATE.length);

console.log('\n=== the CRD contract (cr-preflight-backends.test.ts) ===');
contract.baseline();
contract.proveCanSeeRed({
  subject: 'emitted',
  anchor: '"spec.backends",',
  replacement: '',
  options: TS_INLINE,
});
for (const m of CONTRACT) {
  contract.run({ ...m, expect: 'red' });
  recordMutation();
}
contract.finish(CONTRACT.length);

console.log('\n=== applied by deploy (deploy-backends-applied.test.ts) ===');
deploy.baseline();
deploy.proveCanSeeRed({
  subject: 'crBuilder',
  anchor: EMIT,
  replacement: '...{},',
  options: TS_INLINE,
});
for (const m of DEPLOY) {
  deploy.run({ ...m, expect: 'red' });
  recordMutation();
}
deploy.finish(DEPLOY.length);
