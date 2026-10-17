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
 *   - `tests/deploy-function-bin-e2e.test.ts`  the real built bin, under node and bun, starts
 *                                              the processes in that order and never
 *                                              `func` / `kn`.
 *   - `packages/kn-next/src/__tests__/cli-help-docs-parity.test.ts`
 *                                              `knext --help` lists what the reference
 *                                              lists; the install hint names every verb.
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
const HELP_SPEC = 'packages/kn-next/src/__tests__/cli-help-docs-parity.test.ts';

const APPLY_LINE = 'host.apply({ crPath, namespace, context });';

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
    anchor: "push('unparseable-spawn', at, `${name}(${key}): ${problem.unparseable}`);",
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
    id: 'S17',
    subject: 'spawnlib',
    claim: 'a member call handed an argv (host.run, x.spawn) is no longer read as a spawn',
    anchor: 'if (!MEMBER_SPAWN.has(name)) continue;',
    replacement: 'continue;',
  },
  {
    id: 'S18',
    subject: 'spawnlib',
    claim: 'a member spawn is found but never graded',
    anchor: 'if (kind) handleSpawn(name, kind, m.index, open);',
    replacement: 'void 0;',
  },
  {
    id: 'S19',
    subject: 'spawnlib',
    claim: 'func/kn are matched by exact name only (an absolute path escapes)',
    anchor: "const base = (p) => p.replace(/^.*[\\\\/]/, '').replace(/\\.exe$/i, '');",
    replacement: 'const base = (p) => p;',
  },
  {
    id: 'S20',
    subject: 'spawnlib',
    claim: 'execa is no longer a recognised spawn',
    anchor: "  'execa',\n  'execaSync',\n]);",
    replacement: ']);',
  },
  {
    id: 'S21',
    subject: 'spawnlib',
    claim: 'a backtick require of child_process is not followed',
    anchor: 'const reqRe = /\\brequire\\s*\\(\\s*([\'"`])/g;',
    replacement: 'const reqRe = /\\brequire\\s*\\(\\s*([\'"])/g;',
  },
  {
    id: 'S22',
    subject: 'spawnlib',
    claim: 'a backtick dynamic import of child_process is not followed',
    anchor: 'const dynRe = /\\bimport\\s*\\(\\s*([\'"`])/g;',
    replacement: 'const dynRe = /\\bimport\\s*\\(\\s*([\'"])/g;',
  },
  {
    id: 'S23',
    subject: 'tscall',
    claim: 'a program kept in a constant is not read as the string it is',
    anchor: 'if (/^[A-Za-z_$][\\w$]*$/.test(b.slice(a, e)) && p.consts?.has(b.slice(a, e))) {',
    replacement: 'if (false) {',
  },
  {
    id: 'S24',
    subject: 'tscall',
    claim: 'a let that is assigned again is read as its first literal',
    anchor: "if (m[1] !== 'const') mutable.add(m[2]);",
    replacement: 'void 0;',
  },
  {
    id: 'S25',
    subject: 'tscall',
    claim: 'a let/var program is not resolved at all',
    anchor: 'const re = /\\b(const|let|var)\\s+([A-Za-z_$][\\w$]*)',
    replacement: 'const re = /\\b(const)\\s+([A-Za-z_$][\\w$]*)',
  },
  {
    id: 'S26',
    subject: 'spawnlib',
    claim: "createRequire(...)('node:child_process') is not followed",
    anchor: 'const crRe = /\\bcreateRequire\\s*\\([^)]*\\)\\s*\\(\\s*([\'"`])/g;',
    replacement: 'const crRe = /\\bcreateRequireNever\\s*\\([^)]*\\)\\s*\\(\\s*([\'"`])/g;',
  },
  {
    id: 'S27',
    subject: 'spawnlib',
    claim: 'a flag value before the program (sudo -u root kn) hides kn',
    anchor: 'const [direct, ...others] = wrappedArgvs(elems);',
    replacement: 'const [direct] = wrappedArgvs(elems);',
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
    anchor: 'if (!kinds.every((k) => ALLOWED_RESOURCES.has(k))) {',
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
    anchor: '.filter((e) => e.used < (e.count ?? 1))',
    replacement: '.filter(() => false)',
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
    id: 'K13',
    subject: 'tscall',
    claim: 'an argv returned from a function (the preflight builds its argv so) is never scanned',
    anchor: "  'return',\n  'typeof',",
    replacement: "  'typeof',",
  },
  {
    id: 'K14',
    subject: 'tscall',
    claim: 'a kubectl kept in a constant is not read as kubectl',
    anchor: 'if (/^[A-Za-z_$][\\w$]*$/.test(b.slice(a, e)) && p.consts?.has(b.slice(a, e))) {',
    replacement: 'if (false) {',
  },
  {
    id: 'K15',
    subject: 'writelib',
    claim: 'a quoted "kind" key or a computed [\'kind\'] key is not read',
    anchor:
      'const KEY = String.raw`(?:["\']kind["\']|\\[\\s*["\'\\x60]kind["\'\\x60]\\s*\\]|(?<![\\w$])kind)`;',
    replacement: 'const KEY = String.raw`(?<![\\w$])kind`;',
  },
  {
    id: 'K16',
    subject: 'writelib',
    claim: 'a kind built from a template with a hole passes unseen',
    anchor:
      'if (/^`[^`]*\\$\\{/.test(v)) out.push({ kind: undefined, line: i + 1, unreadable: true });',
    replacement: 'void 0;',
  },
  {
    id: 'K17',
    subject: 'tscall',
    claim: 'kubectl is matched by exact name only (an absolute path escapes)',
    anchor: ".replace(/^.*[\\\\/]/, '')\n    .replace(/\\.exe$/i, '');",
    replacement: ';',
  },
  {
    id: 'K18',
    subject: 'writelib',
    claim: 'an argv array is no longer read for kubectl or a sh -c string',
    anchor: 'inspect(elems, i);',
    replacement: 'void 0;',
  },
  {
    id: 'K19',
    subject: 'writelib',
    claim: 'a program started with execFile/spawn plus an argument array is no longer read',
    anchor: 'inspect([args[0], ...args[1].elems], m.index);',
    replacement: 'void 0;',
  },
  {
    id: 'K20',
    subject: 'writelib',
    claim: 'an exec/execSync string is no longer read for kubectl',
    anchor:
      "if (args[0].type === 'string' || args[0].type === 'template') shell(args[0], m.index);",
    replacement: 'void 0;',
  },
  {
    id: 'K21',
    subject: 'writelib',
    claim: 'kubectl behind env/xargs in a shell string passes unread',
    anchor: 'if (mentions > heads) {',
    replacement: 'if (false) {',
  },
  {
    id: 'K22',
    subject: 'writelib',
    claim: 'the value of a flag such as -l is taken for the resource',
    anchor: 'if (VALUE_FLAGS.has(v)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'K23',
    subject: 'writelib',
    claim: 'an unknown flag before the resource is skipped instead of failing',
    anchor: 'if (BOOL_FLAGS.has(v)) continue;',
    replacement: 'continue;',
  },
  {
    id: 'K24',
    subject: 'writelib',
    claim: 'the slash form (nextapp/foo) and comma lists are not split into kinds',
    anchor: "const kinds = resource.split(',').map((x) => normResource(x.split('/')[0]));",
    replacement: 'const kinds = [normResource(resource)];',
  },
  {
    id: 'K25',
    subject: 'writelib',
    claim: 'manifest writes are not counted (a second apply in a listed file passes)',
    anchor: 'if (entry.used > (entry.count ?? 1)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'K26',
    subject: 'writelib',
    claim: 'an entry whose sites dropped below its count is not reported stale',
    anchor: '.filter((e) => e.used < (e.count ?? 1))',
    replacement: '.filter((e) => e.used === 0)',
  },
  {
    id: 'K27',
    subject: 'writelib',
    claim: 'a kind a source emits but the entry does not declare passes',
    anchor: 'if (!declared.has(k)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'K28',
    subject: 'writelib',
    claim: 'a declared kind that no source emits passes',
    anchor: 'if (!found.has(k)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'K29',
    subject: 'writelib',
    claim: 'an entry that names no kind source is accepted',
    anchor: 'if (!e.kindSources || e.kindSources.length === 0) {',
    replacement: 'if (false) {',
  },
  {
    id: 'K30',
    subject: 'writelib',
    claim: 'the tree scan no longer compares declared kinds with the sources',
    anchor: '...checkManifestKinds(allow, (f) => {',
    replacement: '...checkManifestKinds([], (f) => {',
  },
  {
    id: 'K31',
    subject: 'writelib',
    claim: 'kubectl behind env/sudo in an argv array is not read',
    anchor: 'const cands = [elems, ...wrappedArgvs(elems)];',
    replacement: 'const cands = [elems];',
  },
  {
    id: 'K32',
    subject: 'tscall',
    claim: 'a wrapper flag that takes a value (sudo -u root kubectl) hides the program',
    anchor: 'out.push(elems.slice(i));',
    replacement: 'void 0;',
  },
  {
    id: 'K33',
    subject: 'tscall',
    claim: 'sudo is no longer a wrapper program',
    anchor: "  'sudo',\n",
    replacement: '',
  },
  {
    id: 'K34',
    subject: 'writelib',
    claim: 'a kind assigned to a member (m.kind = X) is not read',
    anchor: 'if (a1) value(a1[1], true);',
    replacement: 'void 0;',
  },
  {
    id: 'K35',
    subject: 'writelib',
    claim: 'a constant used as a kind value is not resolved',
    anchor: 'if (consts.has(name)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'K36',
    subject: 'writelib',
    claim: 'an identifier kind value that is not a known constant passes',
    anchor: "if (!isAssign && [';', '|', '', '`', '\\\\', '\"', \"'\"].includes(id[2])) return;",
    replacement: 'return;',
  },
  {
    id: 'K37',
    subject: 'writelib',
    claim: 'an unreadable-kind waiver admits any number of unreadable kinds',
    anchor: 'if (waiver && unreadableSeen <= waiver.count) continue;',
    replacement: 'if (waiver) continue;',
  },
  {
    id: 'K38',
    subject: 'writelib',
    claim: 'a stale unreadable-kind waiver is not reported',
    anchor: 'if (waiver && unreadableSeen < waiver.count) {',
    replacement: 'if (false) {',
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
    subject: 'dispatch',
    claim: "core's apply (the only kubectl apply of a BackendService) drops --validate=strict",
    anchor: '"apply",\n                            "--validate=strict",',
    replacement: '"apply",',
  },
  {
    id: 'T07',
    subject: 'cleanup',
    claim: 'a manifest apply planted in a file with no table entry',
    anchor: '["kubectl", "delete", "nextapp", config.name, "--ignore-not-found"],',
    replacement: '["kubectl", "apply", "--validate=strict", "-f", "x.yaml"],',
  },
  {
    id: 'T09',
    subject: 'crbuilder',
    claim: 'the NextApp builder starts emitting an allowed kind the deploy entry does not declare',
    anchor: 'kind: "NextApp",',
    replacement: 'kind: "BackendService",',
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
const CORE_ARGV_STRICT = '"apply",\n                            "--validate=strict",';
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
    replacement: 'host.apply({ crPath, namespace });',
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
    claim: 'the apply is issued twice',
    anchor: APPLY_LINE,
    replacement: `${APPLY_LINE}\n      ${APPLY_LINE}`,
  },
  ...(spec === ORDER_SPEC
    ? [
        {
          id: 'O03',
          subject: 'dispatch',
          claim: "core's apply drops --validate=strict",
          anchor: CORE_ARGV_STRICT,
          replacement: '"apply",',
        },
        {
          id: 'O04',
          subject: 'dispatch',
          claim: "core's apply drops the namespace",
          anchor:
            '                            corePath,\n                            "-n",\n                            namespace,',
          replacement: '                            corePath,',
        },
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
          claim: "core's apply loses the kubectl context",
          anchor:
            '                        ],\n                        context,\n                    ),\n                );',
          replacement:
            '                        ],\n                        undefined,\n                    ),\n                );',
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
        {
          id: 'O14',
          subject: 'dispatch',
          claim: 'the seam core hands the package grows a way to run any argv',
          anchor: '        apply: ({ crPath, namespace, context }) =>',
          replacement:
            '        run: (argv: readonly string[]) => kubectl.run(argv),\n        apply: ({ crPath, namespace, context }) =>',
        },
        {
          id: 'C01',
          subject: 'dispatch',
          claim: "core's apply does not validate the file before running kubectl",
          anchor: 'const cr = readValidatedBackendService(crPath, namespace);',
          replacement:
            'const cr = YAML.parse(readFileSync(crPath, "utf-8")) as ValidatedBackendService;',
        },
        {
          id: 'C02',
          subject: 'dispatch',
          claim: 'a file of another kind (a Secret) is applied',
          anchor: 'if (cr.kind !== "BackendService") {',
          replacement: 'if (false) {',
        },
        {
          id: 'C03',
          subject: 'dispatch',
          claim: 'a wrong apiVersion is applied',
          anchor: 'if (cr.apiVersion !== BACKEND_SERVICE_API_VERSION) {',
          replacement: 'if (false) {',
        },
        {
          id: 'C04',
          subject: 'dispatch',
          claim: 'a multi-document file is applied',
          anchor: 'if (docs.length !== 1) {',
          replacement: 'if (false) {',
        },
        {
          id: 'C05',
          subject: 'dispatch',
          claim: 'a namespace in the file other than the one applied to is accepted',
          anchor: 'if (ns !== undefined && ns !== namespace) {',
          replacement: 'if (false) {',
        },
        {
          id: 'C06',
          subject: 'dispatch',
          claim: 'a list or scalar file is not refused as such',
          anchor: 'if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {',
          replacement: 'if (false) {',
        },
        {
          id: 'C07',
          subject: 'dispatch',
          claim: "kubectl is told to read the caller's path, not core's validated copy",
          anchor: 'return fn(corePath);',
          replacement: 'return fn(crPath);',
        },
        {
          id: 'C08',
          subject: 'dispatch',
          claim: 'an unknown top-level key (items, status, foo) is accepted',
          anchor: 'if (extra.length > 0) {',
          replacement: 'if (false) {',
        },
        {
          id: 'C09',
          subject: 'dispatch',
          claim: "core's copy is the caller's text, not the validated object re-serialised",
          anchor: 'writeFileSync(corePath, `${JSON.stringify(cr, null, 2)}\\n`, "utf-8");',
          replacement: 'writeFileSync(corePath, readFileSync(crPath, "utf-8"), "utf-8");',
        },
        {
          id: 'C10',
          subject: 'dispatch',
          claim: 'unexpected metadata fields (ownerReferences, finalizers) are accepted',
          anchor: 'if (extraMeta.length > 0) {',
          replacement: 'if (false) {',
        },
        {
          id: 'C11',
          subject: 'dispatch',
          claim: 'a metadata name that is not a name (../x) is accepted',
          anchor: '!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) ||',
          replacement: 'false ||',
        },
        {
          id: 'C12',
          subject: 'dispatch',
          claim: "core's temporary copy is never removed",
          anchor: 'rmSync(dir, { recursive: true, force: true });',
          replacement: 'void 0;',
        },
        {
          id: 'C13',
          subject: 'dispatch',
          claim: "the preflight reads the caller's path, not core's copy",
          anchor: '{ crPath: corePath, namespace },',
          replacement: '{ crPath, namespace },',
        },
        {
          id: 'C14',
          subject: 'dispatch',
          claim: 'a file core refuses is reported as some other verdict reason',
          anchor: 'reason: "invalid-file",',
          replacement: 'reason: "apply-failed",',
        },
        {
          id: 'O15',
          subject: 'dispatch',
          claim: "core's apply runs a program other than kubectl",
          anchor: '                            "kubectl",\n                            "apply",',
          replacement: '                            "echo",\n                            "apply",',
        },
      ]
    : []),
];

const HELP_ROWS = [
  {
    id: 'H01',
    subject: 'help',
    claim: '`deploy function` is dropped from the printed help',
    anchor: 'display: "deploy function",',
    replacement: 'display: "deploy fn",',
  },
  {
    id: 'H02',
    subject: 'dispatch',
    claim: 'the install hint stops naming `knext deploy function`',
    anchor:
      '\\`knext generate\\`, \\`knext add function\\` and \\`knext deploy function\\` come from\n${GRPC_PACKAGE}, which is',
    replacement:
      '\\`knext generate\\` and \\`knext add function\\` come from ${GRPC_PACKAGE}, which is',
  },
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
    replacement: `${APPLY_LINE}\n      (globalThis as unknown as { Bun: { spawnSync(a: string[]): void } }).Bun.spawnSync(['func', 'build']);`,
  },
  {
    id: 'E02',
    subject: 'deployfn',
    claim: 'the apply runs before the preflight',
    anchor: PREFLIGHT_CALL,
    replacement: `${APPLY_LINE}\n    const outcome = host.preflight({ crPath, namespace, context });`,
  },
  {
    id: 'E03',
    subject: 'deployfn',
    claim: 'the preflight is skipped (no dry-run reaches kubectl)',
    anchor: PREFLIGHT_CALL,
    replacement:
      "const outcome: PreflightResult = { verdict: 'ok', reason: 'none', unknownFields: [], stderr: '' };",
  },
  {
    id: 'E04',
    subject: 'deployfn',
    claim: 'the apply is issued twice (a third kubectl process)',
    anchor: APPLY_LINE,
    replacement: `${APPLY_LINE}\n      ${APPLY_LINE}`,
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
    dispatch: 'packages/kn-next/src/cli/grpc-dispatch.ts',
    crbuilder: 'packages/kn-next/src/cli/cr-builder.ts',
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
const help = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: HELP_SPEC,
  subjects: {
    help: 'packages/kn-next/src/cli/help.ts',
    dispatch: 'packages/kn-next/src/cli/grpc-dispatch.ts',
  },
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
help.preflight(HELP_ROWS);
declareMutations(
  SPAWN.length +
    KINDS.length +
    ORDER_ROWS.length +
    GRPC_DEPLOY_ROWS.length +
    CR_ROWS.length +
    CRD_ROWS.length +
    E2E_ROWS.length +
    HELP_ROWS.length,
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
  replacement: 'host.apply({ crPath, namespace });',
});
sweep('apply order (package alone)', grpcDeploy, GRPC_DEPLOY_SPEC, GRPC_DEPLOY_ROWS, {
  subject: 'deployfn',
  anchor: APPLY_LINE,
  replacement: 'host.apply({ crPath, namespace });',
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
  replacement: `${APPLY_LINE}\n      ${APPLY_LINE}`,
});
sweep('help vs the reference', help, HELP_SPEC, HELP_ROWS, {
  subject: 'help',
  anchor: 'display: "deploy function",',
  replacement: 'display: "deploy fn",',
});
