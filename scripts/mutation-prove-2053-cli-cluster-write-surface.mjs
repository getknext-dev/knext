#!/usr/bin/env node
/**
 * Mutation proof for the CLI cluster-write surface (issue #2053, Z8b).
 *
 * Guards proved, each against its own spec:
 *   - `tests/cli-spawn-scan.test.ts`           the ADR-0052 D3 scan: the deploy path
 *                                              never shells `func deploy` / `kn service`;
 *                                              an unreadable spawn FAILS, not passes.
 *   - `tests/cli-cluster-write-kinds.test.ts`  the CLI writes only NextApp and
 *                                              BackendService; every apply is strict.
 *   - `tests/deploy-function-apply-order.test.ts` and
 *     `packages/grpc/src/__tests__/deploy-function.test.ts`
 *                                              the preflight runs FIRST, the apply
 *                                              carries `--validate=strict`, context is
 *                                              bound to both.
 *   - `packages/grpc/src/__tests__/backend-service-cr.test.ts` and
 *     `tests/backendservice-cr-crd-contract.test.ts`
 *                                              the CR the builder emits (digest-pinned
 *                                              image, no ownerReference, only fields the
 *                                              shipped CRD defines).
 *   - `tests/deploy-function-bin-e2e.test.ts`  the real built bin starts the processes
 *                                              in that order and never `func` / `kn`.
 *
 * Two kinds of row: the SCANNER weakened (a fixture must then go red), and the
 * REAL TREE broken (a violation planted in shipped code must go red). Both
 * halves matter: a scan that is green because it reads nothing is decoration.
 *
 * Discipline (see scripts/lib/guard-prover.mjs): every anchor occurs exactly once
 * (else ABORT in the preflight), every verdict is the runner's EXIT CODE, the
 * baseline must be green first, a canary must go red before any green below is
 * trusted, and the tree is checked clean between mutations.
 *
 * Not provable here: the `deploy.ts` dispatch line is only exercised by the
 * built bin, and a mutation of core source cannot rebuild `dist/`. It is held by
 * the source-level wiring tests in `tests/deploy-function-apply-order.test.ts`,
 * which this prover does mutate.
 *
 * Exit 0 = every row went red; non-zero otherwise.
 *
 * Usage:
 *   node scripts/mutation-prove-2053-cli-cluster-write-surface.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SPAWN_SPEC = 'tests/cli-spawn-scan.test.ts';
const KINDS_SPEC = 'tests/cli-cluster-write-kinds.test.ts';
const ORDER_SPEC = 'tests/deploy-function-apply-order.test.ts';
const GRPC_DEPLOY_SPEC = 'packages/grpc/src/__tests__/deploy-function.test.ts';
const GRPC_CR_SPEC = 'packages/grpc/src/__tests__/backend-service-cr.test.ts';
const CRD_SPEC = 'tests/backendservice-cr-crd-contract.test.ts';
const E2E_SPEC = 'tests/deploy-function-bin-e2e.test.ts';

const APPLY_LINE =
  "host.run(['kubectl', 'apply', '--validate=strict', '-f', crPath, '-n', namespace], context);";

// ---------------------------------------------------------------------------
// ADR-0052 D3: no `func deploy` / `kn service`
// ---------------------------------------------------------------------------
const SPAWN = [
  {
    id: 'S01',
    subject: 'spawnlib',
    claim: 'kn is no longer refused (kn service slips through)',
    anchor: "if (prog === 'kn') return 'kn is never run by the CLI';",
    replacement: "if (prog === 'kn') return undefined;",
  },
  {
    id: 'S02',
    subject: 'spawnlib',
    claim: 'func deploy is no longer recognised',
    anchor: "if (rest.some((e) => e.type === 'string' && e.value.trim() === 'deploy')) {",
    replacement: 'if (false) {',
  },
  {
    id: 'S03',
    subject: 'spawnlib',
    claim: 'a computed func subcommand passes (it might be deploy)',
    anchor: "if (sub && sub.type !== 'string') return 'unparseable';",
    replacement: "if (false) return 'unparseable';",
  },
  {
    id: 'S04',
    subject: 'spawnlib',
    claim: 'sh -c wrappers are no longer followed',
    anchor: 'if (SHELL_PROGRAMS.has(prog)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'S05',
    subject: 'spawnlib',
    claim: 'env / sudo / npx wrappers are no longer followed',
    anchor: 'if (WRAPPER_PROGRAMS.has(prog)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'S06',
    subject: 'spawnlib',
    claim: 'a spawn the scan cannot read passes instead of failing',
    anchor: "push('unparseable-spawn', m.index, `${name}(${key}): ${problem.unparseable}`);",
    replacement: 'void 0;',
  },
  {
    id: 'S07',
    subject: 'spawnlib',
    claim: 'a stale allowlist entry is never reported',
    anchor: '.filter((e) => e.used < (e.count ?? 1))',
    replacement: '.filter(() => false)',
  },
  {
    id: 'S08',
    subject: 'spawnlib',
    claim: 'the text "func deploy" / "kn service" is no longer refused in a string',
    anchor:
      'const phrase = /\\bfunc\\s+deploy\\b/.test(text) || /\\bkn\\s+service(s)?\\b/.test(text);',
    replacement: 'const phrase = false;',
  },
  {
    id: 'S09',
    subject: 'spawnlib',
    claim: 'the bare program name "kn" is no longer refused',
    anchor: "const bare = !lit.hole && text.trim() === 'kn';",
    replacement: 'const bare = false;',
  },
  {
    id: 'S10',
    subject: 'spawnlib',
    claim: 'child_process namespace/default imports are followed no longer (and pass)',
    anchor: "if (isCp && outside !== '') {",
    replacement: 'if (false) {',
  },
  {
    id: 'S11',
    subject: 'spawnlib',
    claim: 'an aliased child_process import hides the spawn',
    anchor: 'if (mm) alias.set(mm[2] ?? mm[1], mm[1]);',
    replacement: 'if (mm) alias.set(mm[1], mm[1]);',
  },
  {
    id: 'S12',
    subject: 'spawnlib',
    claim: 'a shell tagged template is ignored',
    anchor:
      "push('unparseable-spawn', m.index, 'a shell tagged template ($`...`) cannot be read');",
    replacement: 'void 0;',
  },
  {
    id: 'S13',
    subject: 'spawnlib',
    claim: 'an argv handed to a seam (host.run) or a variable is no longer read',
    anchor: "if (verdict && verdict !== 'unparseable')",
    replacement: 'if (false)',
  },
  {
    id: 'S14',
    subject: 'spawnlib',
    claim: 'withKubeContext stops being transparent (green kubectl argv now unreadable)',
    anchor: "if (node?.type === 'call' && node.name === 'withKubeContext' && node.args[0]) {",
    replacement: 'if (false) {',
  },
  {
    id: 'S15',
    subject: 'spawnlib',
    claim: '@getknext/grpc falls out of the scanned scope',
    anchor: "export const SPAWN_SCOPE_DIRS = ['packages/kn-next/src/cli', 'packages/grpc'];",
    replacement: "export const SPAWN_SCOPE_DIRS = ['packages/kn-next/src/cli'];",
  },
  {
    id: 'S16',
    subject: 'tscall',
    claim: 'an argv returned from a function is read as an index access, so it is never scanned',
    anchor: "  'return',\n  'typeof',",
    replacement: "  'typeof',",
  },
  {
    id: 'T01',
    subject: 'deployfn',
    claim: 'a func deploy argv planted in @getknext/grpc',
    anchor: APPLY_LINE,
    replacement: "host.run(['func', 'deploy'], context);",
  },
  {
    id: 'T02',
    subject: 'cleanup',
    claim: 'a kn service spawn planted in core cleanup',
    anchor: '["kubectl", "delete", "nextapp", config.name, "--ignore-not-found"],',
    replacement: '["kn", "service", "delete", config.name],',
  },
  {
    id: 'T03',
    subject: 'exec',
    claim: 'a computed spawn in the exec helper that is not on the allowlist',
    anchor: 'spawnSync(cmd, args, {',
    replacement: 'spawnSync(cmd2, args, {',
  },
  {
    id: 'T04',
    subject: 'buf',
    claim: 'a computed spawn in @getknext/grpc that is not on the allowlist',
    anchor: 'const r = spawnSync(bin, [...args], {',
    replacement: 'const r = spawnSync(bin2, [...args], {',
  },
];

// ---------------------------------------------------------------------------
// The CLI writes only NextApp and BackendService; every apply is strict
// ---------------------------------------------------------------------------
const KINDS = [
  {
    id: 'K01',
    subject: 'writelib',
    claim: 'a write of any other resource is no longer refused',
    anchor: 'if (!ALLOWED_RESOURCES.has(normResource(resource))) {',
    replacement: 'if (false) {',
  },
  {
    id: 'K02',
    subject: 'writelib',
    claim: 'a manifest write from an unlisted file passes',
    anchor: 'const entry = mine.find((e) => e.verb === site.verb);',
    replacement: 'const entry = mine.find((e) => e.verb === site.verb) ?? { used: 0 };',
  },
  {
    id: 'K03',
    subject: 'writelib',
    claim: 'an apply without --validate=strict passes',
    anchor: "if (verb === 'apply' && !flags.includes('--validate=strict')) {",
    replacement: 'if (false) {',
  },
  {
    id: 'K04',
    subject: 'writelib',
    claim: 'a flag before the verb is read as the verb',
    anchor: "if (verb === undefined || verb.startsWith('-')) {",
    replacement: 'if (verb === undefined) {',
  },
  {
    id: 'K05',
    subject: 'writelib',
    claim: 'a kind outside NextApp/BackendService is no longer refused',
    anchor: 'if (!permitted.has(kind))',
    replacement: 'if (false)',
  },
  {
    id: 'K06',
    subject: 'writelib',
    claim: 'a stale manifest-write entry is never reported',
    anchor: 'mine.filter((e) => e.used === 0)',
    replacement: 'mine.filter(() => false)',
  },
  {
    id: 'K07',
    subject: 'writelib',
    claim: 'a spawn of the literal program kubectl is no longer read (ci-preflight create unseen)',
    anchor: "if (lit(args[0]) !== 'kubectl' || !args[1]) continue;",
    replacement: 'continue;',
  },
  {
    id: 'K08',
    subject: 'writelib',
    claim: 'a server-side dry-run is treated as a write (the preflight needs a table entry)',
    anchor: 'if (dryRun) return; // stores nothing; strictness already checked above',
    replacement: 'void 0;',
  },
  {
    id: 'K09',
    subject: 'writelib',
    claim: 'deployments become an allowed write resource',
    anchor: "  'bsvc',\n]);",
    replacement: "  'bsvc',\n  'deployment',\n]);",
  },
  {
    id: 'K10',
    subject: 'writelib',
    claim: 'Job becomes an allowed kind everywhere',
    anchor: "export const ALLOWED_KINDS = new Set(['NextApp', 'BackendService']);",
    replacement: "export const ALLOWED_KINDS = new Set(['NextApp', 'BackendService', 'Job']);",
  },
  {
    id: 'K11',
    subject: 'writelib',
    claim: '@getknext/grpc falls out of the write scan',
    anchor: "  'packages/grpc',\n];",
    replacement: '];',
  },
  {
    id: 'K12',
    subject: 'writelib',
    claim: 'kind: in an object literal is no longer read',
    anchor:
      'for (const m of text.matchAll(/(?<![\\w.])kind\\s*:\\s*["\']([A-Z][A-Za-z0-9]*)["\']/g))',
    replacement: 'for (const m of [])',
  },
  {
    id: 'K13',
    subject: 'tscall',
    claim: 'an argv returned from a function (the preflight builds its argv so) is never scanned',
    anchor: "  'return',\n  'typeof',",
    replacement: "  'typeof',",
  },
  {
    id: 'T05',
    subject: 'cleanup',
    claim: 'a delete of another resource planted in core cleanup',
    anchor: '["kubectl", "delete", "nextapp", config.name, "--ignore-not-found"],',
    replacement: '["kubectl", "delete", "ksvc", config.name, "--ignore-not-found"],',
  },
  {
    id: 'T06',
    subject: 'deployfn',
    claim: '@getknext/grpc applies without --validate=strict',
    anchor: APPLY_LINE,
    replacement: "host.run(['kubectl', 'apply', '-f', crPath, '-n', namespace], context);",
  },
  {
    id: 'T07',
    subject: 'cleanup',
    claim: 'a manifest apply planted in a file with no table entry',
    anchor: '["kubectl", "delete", "nextapp", config.name, "--ignore-not-found"],',
    replacement: '["kubectl", "apply", "--validate=strict", "-f", "x.yaml"],',
  },
  {
    id: 'T08',
    subject: 'bscr',
    claim: 'the builder emits a kind other than BackendService',
    anchor: "export const BACKEND_SERVICE_KIND = 'BackendService';",
    replacement: "export const BACKEND_SERVICE_KIND = 'Deployment';",
  },
];

// ---------------------------------------------------------------------------
// Preflight first, then a strict apply, context bound to both
// ---------------------------------------------------------------------------
const PREFLIGHT_CALL = 'const outcome = host.preflight({ crPath, namespace, context });';
const APPLY_ROWS = (spec) => [
  {
    id: 'O01',
    subject: 'deployfn',
    claim: 'the preflight is skipped',
    anchor: PREFLIGHT_CALL,
    replacement:
      "const outcome: PreflightResult = { verdict: 'ok', reason: 'none', unknownFields: [], stderr: '' };",
  },
  {
    id: 'O02',
    subject: 'deployfn',
    claim: 'a failed preflight verdict no longer stops the apply',
    anchor: "if (outcome.verdict !== 'ok') {",
    replacement: 'if (false) {',
  },
  {
    id: 'O03',
    subject: 'deployfn',
    claim: 'the apply drops --validate=strict',
    anchor: APPLY_LINE,
    replacement: "host.run(['kubectl', 'apply', '-f', crPath, '-n', namespace], context);",
  },
  {
    id: 'O04',
    subject: 'deployfn',
    claim: 'the apply drops the namespace',
    anchor: APPLY_LINE,
    replacement: "host.run(['kubectl', 'apply', '--validate=strict', '-f', crPath], context);",
  },
  {
    id: 'O05',
    subject: 'deployfn',
    claim: 'the preflight no longer gets the kubectl context',
    anchor: PREFLIGHT_CALL,
    replacement: 'const outcome = host.preflight({ crPath, namespace });',
  },
  {
    id: 'O06',
    subject: 'deployfn',
    claim: 'the apply no longer gets the kubectl context',
    anchor: APPLY_LINE,
    replacement:
      "host.run(['kubectl', 'apply', '--validate=strict', '-f', crPath, '-n', namespace]);",
  },
  {
    id: 'O07',
    subject: 'deployfn',
    claim: '--dry-run reaches the cluster',
    anchor: "if (v['dry-run']) {",
    replacement: 'if (false) {',
  },
  {
    id: 'O08',
    subject: 'deployfn',
    claim: 'a failed apply is swallowed as success',
    anchor: "        'zone exists in the namespace.\\n',\n      );\n      return 1;",
    replacement: "        'zone exists in the namespace.\\n',\n      );\n      return 0;",
  },
  {
    id: 'O09',
    subject: 'deployfn',
    claim: 'a func process started before the apply',
    anchor: APPLY_LINE,
    replacement: `host.run(['func', 'build'], context);\n      ${APPLY_LINE}`,
  },
  ...(spec === ORDER_SPEC
    ? [
        {
          id: 'O10',
          subject: 'dispatch',
          claim: "core's preflight capture loses the kubectl context",
          anchor: 'kubectl.capture(withKubeContext(argv, context)),',
          replacement: 'kubectl.capture(argv),',
        },
        {
          id: 'O11',
          subject: 'dispatch',
          claim: "core's apply run loses the kubectl context",
          anchor: 'run: (argv, context) => kubectl.run(withKubeContext(argv, context)),',
          replacement: 'run: (argv, _context) => kubectl.run(argv),',
        },
        {
          id: 'O12',
          subject: 'dispatch',
          claim: 'core hands the package no cluster host for deploy',
          anchor: 'return await (verb === "deploy"',
          replacement: 'return await (verb === "deployx"',
        },
        {
          id: 'O13',
          subject: 'deploysrc',
          claim: 'the `deploy function` dispatch branch is removed from the bin',
          anchor: 'process.argv[3] === "function"',
          replacement: 'process.argv[3] === "functionx"',
        },
      ]
    : []),
];

const CR_ROWS = [
  {
    id: 'C01',
    subject: 'bscr',
    claim: 'a tag-only image is accepted',
    anchor: 'if (!DIGEST.test(image)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'C02',
    subject: 'bscr',
    claim: 'the CR carries an ownerReference the operator should set',
    anchor: 'metadata: { name: input.name, namespace: input.namespace },',
    replacement: 'metadata: { name: input.name, namespace: input.namespace, ownerReferences: [] },',
  },
  {
    id: 'C03',
    subject: 'bscr',
    claim: 'the zone is not validated as a name',
    anchor: "label('zone', input.zone);",
    replacement: 'void 0;',
  },
];

const CRD_ROWS = [
  {
    id: 'D01',
    subject: 'bscr',
    claim: 'the builder emits a field the CRD does not define (strict apply would reject it)',
    anchor: '...(input.port === undefined ? {} : { port: input.port }),',
    replacement:
      "...(input.port === undefined ? {} : { port: input.port, serviceAccountName: 'x' }),",
  },
  {
    id: 'D02',
    subject: 'bscr',
    claim: 'the builder drifts from the CRD apiVersion',
    anchor: "export const BACKEND_SERVICE_API_VERSION = 'apps.kn-next.dev/v1alpha1';",
    replacement: "export const BACKEND_SERVICE_API_VERSION = 'apps.kn-next.dev/v1beta1';",
  },
];

const E2E_ROWS = [
  {
    id: 'E01',
    subject: 'deployfn',
    claim: 'a func process is started on the deploy path (the fake func on PATH records it)',
    anchor: APPLY_LINE,
    replacement: `host.run(['func', 'build'], context);\n      ${APPLY_LINE}`,
  },
  {
    id: 'E02',
    subject: 'deployfn',
    claim: 'the real apply drops --validate=strict',
    anchor: APPLY_LINE,
    replacement: "host.run(['kubectl', 'apply', '-f', crPath, '-n', namespace], context);",
  },
  {
    id: 'E03',
    subject: 'deployfn',
    claim: 'the apply runs before the preflight',
    anchor: PREFLIGHT_CALL,
    replacement: `${APPLY_LINE}\n    const outcome = host.preflight({ crPath, namespace, context });`,
  },
];

// One literal `subjects` map per guard, so the PR-time anchor-liveness audit
// (scripts/lib/prover-lane.mjs) can read every subject path and re-check every
// anchor below without running this prover.
const spawn = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPAWN_SPEC,
  subjects: {
    spawnlib: 'scripts/lib/cli-spawn-scan.mjs',
    tscall: 'scripts/lib/ts-call-scan.mjs',
    deployfn: 'packages/grpc/src/deploy-function.ts',
    cleanup: 'packages/kn-next/src/cli/cleanup.ts',
    exec: 'packages/kn-next/src/cli/exec.ts',
    buf: 'packages/grpc/src/buf.ts',
  },
});
const kinds = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: KINDS_SPEC,
  subjects: {
    writelib: 'scripts/lib/cli-cluster-write-scan.mjs',
    tscall: 'scripts/lib/ts-call-scan.mjs',
    cleanup: 'packages/kn-next/src/cli/cleanup.ts',
    deployfn: 'packages/grpc/src/deploy-function.ts',
    bscr: 'packages/grpc/src/backend-service.ts',
  },
});
const order = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: ORDER_SPEC,
  subjects: {
    deployfn: 'packages/grpc/src/deploy-function.ts',
    dispatch: 'packages/kn-next/src/cli/grpc-dispatch.ts',
    deploysrc: 'packages/kn-next/src/cli/deploy.ts',
  },
});
const grpcDeploy = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: GRPC_DEPLOY_SPEC,
  subjects: { deployfn: 'packages/grpc/src/deploy-function.ts' },
});
const grpcCr = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: GRPC_CR_SPEC,
  subjects: { bscr: 'packages/grpc/src/backend-service.ts' },
});
const crd = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: CRD_SPEC,
  subjects: { bscr: 'packages/grpc/src/backend-service.ts' },
});
const e2e = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: E2E_SPEC,
  subjects: { deployfn: 'packages/grpc/src/deploy-function.ts' },
});

const ORDER_ROWS = APPLY_ROWS(ORDER_SPEC);
const GRPC_DEPLOY_ROWS = APPLY_ROWS(GRPC_DEPLOY_SPEC);

const CANARY_SPAWN = {
  subject: 'spawnlib',
  anchor: "if (prog === 'kn') return 'kn is never run by the CLI';",
  replacement: "if (prog === 'kn') return undefined;",
};

console.log('=== mutation proof: CLI cluster-write surface (#2053) ===');
spawn.preflight(SPAWN);
kinds.preflight(KINDS);
order.preflight(ORDER_ROWS);
grpcDeploy.preflight(GRPC_DEPLOY_ROWS);
grpcCr.preflight(CR_ROWS);
crd.preflight(CRD_ROWS);
e2e.preflight(E2E_ROWS);
declareMutations(
  SPAWN.length +
    KINDS.length +
    ORDER_ROWS.length +
    GRPC_DEPLOY_ROWS.length +
    CR_ROWS.length +
    CRD_ROWS.length +
    E2E_ROWS.length,
);

const sweep = (label, p, spec, rows, canary) => {
  console.log(`\n=== ${label}: ${spec} ===`);
  p.baseline();
  p.proveCanSeeRed(canary);
  for (const m of rows) {
    p.run({ ...m, expect: 'red' });
    recordMutation();
  }
  p.finish(rows.length);
};

sweep('D3 spawn scan', spawn, SPAWN_SPEC, SPAWN, CANARY_SPAWN);
sweep('cluster-write kinds', kinds, KINDS_SPEC, KINDS, {
  subject: 'writelib',
  anchor: "export const ALLOWED_KINDS = new Set(['NextApp', 'BackendService']);",
  replacement: "export const ALLOWED_KINDS = new Set(['NextApp', 'BackendService', 'Job']);",
});
sweep('apply order (core + package)', order, ORDER_SPEC, ORDER_ROWS, {
  subject: 'deployfn',
  anchor: APPLY_LINE,
  replacement: "host.run(['kubectl', 'apply', '-f', crPath, '-n', namespace], context);",
});
sweep('apply order (package alone)', grpcDeploy, GRPC_DEPLOY_SPEC, GRPC_DEPLOY_ROWS, {
  subject: 'deployfn',
  anchor: APPLY_LINE,
  replacement: "host.run(['kubectl', 'apply', '-f', crPath, '-n', namespace], context);",
});
sweep('the CR the builder emits', grpcCr, GRPC_CR_SPEC, CR_ROWS, {
  subject: 'bscr',
  anchor: 'if (!DIGEST.test(image)) {',
  replacement: 'if (false) {',
});
sweep('builder vs shipped CRD', crd, CRD_SPEC, CRD_ROWS, {
  subject: 'bscr',
  anchor: "export const BACKEND_SERVICE_API_VERSION = 'apps.kn-next.dev/v1alpha1';",
  replacement: "export const BACKEND_SERVICE_API_VERSION = 'apps.kn-next.dev/v1beta1';",
});
sweep('built bin end to end', e2e, E2E_SPEC, E2E_ROWS, {
  subject: 'deployfn',
  anchor: APPLY_LINE,
  replacement: "host.run(['kubectl', 'apply', '-f', crPath, '-n', namespace], context);",
});
