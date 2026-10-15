#!/usr/bin/env node
/**
 * Mutation proof for the escalation-trigger classifier's widened scope (#2388).
 *
 * `.claude/rules/workflow.md`: "a guard that stays green when its subject is
 * removed is decoration." Each mutation below removes or widens one rule the
 * #2388 re-scope added — every CRD types file, every package CLI and manifest,
 * `crates/`, the supply-chain set, and fail-closed handling of unknown input —
 * and REQUIRES `tests/escalation-triggers.test.ts` to go red. The shared driver
 * (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by EXIT CODE
 * only, baseline green first, a canary that must go red, anchors that must occur
 * exactly once, byte-exact restore.
 *
 * Usage: node scripts/mutation-prove-2388-escalation-trigger-scope.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/escalation-triggers.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the CRD rule shrinks back to nextapp_types.go — a new or second API types file stops firing',
    subject: 'guard',
    anchor: '    match: (p) => CRD_TYPES.test(p),',
    replacement:
      "    match: (p) => p === 'packages/kn-next-operator/api/v1alpha1/nextapp_types.go',",
  },
  {
    id: 'M2',
    expect: 'red',
    claim: 'the CRD pattern loses its api/ anchor — any *_types.go (controller internals) fires',
    subject: 'guard',
    anchor: 'const CRD_TYPES = /(^|\\/)api\\/(.+\\/)?[^/]+_types\\.go$/;',
    replacement: 'const CRD_TYPES = /_types\\.go$/;',
  },
  {
    id: 'M3',
    expect: 'red',
    claim: "the CLI rule shrinks back to core's src/cli/ — grpc/ffi cli.ts stop firing",
    subject: 'guard',
    anchor: '    match: (p) => CLI_SURFACE.test(p) && !isTestPath(p),',
    replacement: "    match: (p) => p.startsWith('packages/kn-next/src/cli/'),",
  },
  {
    id: 'M4',
    expect: 'red',
    claim: 'the CLI rule stops excluding tests — a test under src/cli/ is mistaken for surface',
    subject: 'guard',
    anchor: '    match: (p) => CLI_SURFACE.test(p) && !isTestPath(p),',
    replacement: '    match: (p) => CLI_SURFACE.test(p),',
  },
  {
    id: 'M5',
    expect: 'red',
    claim: 'the crates rule is dropped — Rust source, Cargo.lock and deny.toml stop firing',
    subject: 'guard',
    anchor: "    match: (p) => p.startsWith('crates/'),",
    replacement: '    match: (p) => false && p,',
  },
  {
    id: 'M6',
    expect: 'red',
    claim: 'security/** stops being supply chain — scan allowlists change unflagged',
    subject: 'guard',
    anchor: "  if (p.startsWith('security/')) return true;\n",
    replacement: '',
  },
  {
    id: 'M7',
    expect: 'red',
    claim: 'scripts/audit-published.mjs stops being supply chain',
    subject: 'guard',
    anchor: "  if (p === 'scripts/audit-published.mjs') return true;\n",
    replacement: '',
  },
  {
    id: 'M8',
    expect: 'red',
    claim:
      'package supply-chain modules (packages/ffi/src/supply-chain.ts, the #2359 miss) stop firing',
    subject: 'guard',
    anchor:
      '  return /^packages\\/[^/]+\\/src\\/(.+\\/)?supply-chain\\.[cm]?[jt]s$/.test(p) && !isTestPath(p);',
    replacement: '  return false && p;',
  },
  {
    id: 'M9',
    expect: 'red',
    claim: 'supply-chain modules stop excluding test fixtures',
    subject: 'guard',
    anchor:
      '  return /^packages\\/[^/]+\\/src\\/(.+\\/)?supply-chain\\.[cm]?[jt]s$/.test(p) && !isTestPath(p);',
    replacement: '  return /^packages\\/[^/]+\\/src\\/(.+\\/)?supply-chain\\.[cm]?[jt]s$/.test(p);',
  },
  {
    id: 'M10',
    expect: 'red',
    claim: 'id-token: write (OIDC federation, keyless signing) stops counting as a credential',
    subject: 'guard',
    anchor: '  if (/id-token\\s*:\\s*[\'"]?write/.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M11',
    expect: 'red',
    claim: 'a secrets[...] index expression (name unknowable) passes instead of failing closed',
    subject: 'guard',
    anchor: '  if (/secrets\\s*\\[/.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M12',
    expect: 'red',
    claim: 'a named secret such as NPM_TOKEN stops counting as a credential',
    subject: 'guard',
    anchor: '    if (!LOW_PRIVILEGE_SECRETS.has(m[1])) return true;',
    replacement: '    if (false && m) return true;',
  },
  {
    id: 'M13',
    expect: 'red',
    claim: 'the low-privilege exemption is ignored — every ci.yml edit (CODECOV_TOKEN) fires',
    subject: 'guard',
    anchor: '    if (!LOW_PRIVILEGE_SECRETS.has(m[1])) return true;',
    replacement: '    if (m) return true;',
  },
  {
    id: 'M14',
    expect: 'red',
    claim: 'only the head side is scanned — DELETING a credential-bearing workflow passes',
    subject: 'guard',
    anchor: "      const sides = [repo.show('base', c.path), repo.show('head', c.path)];",
    replacement: "      const sides = [repo.show('head', c.path)];",
  },
  {
    id: 'M15',
    expect: 'red',
    claim: 'only the base side is scanned — ADDING a secret to a plain workflow passes',
    subject: 'guard',
    anchor: "      const sides = [repo.show('base', c.path), repo.show('head', c.path)];",
    replacement: "      const sides = [repo.show('base', c.path)];",
  },
  {
    id: 'M16',
    expect: 'red',
    claim: 'scripts run by a credential-bearing workflow stop counting as supply chain',
    subject: 'guard',
    anchor: '    runByCredential.has(p) ||',
    replacement: '    false ||',
  },
  {
    id: 'M17',
    expect: 'red',
    claim: 'local composite actions used by a credential-bearing workflow stop counting',
    subject: 'guard',
    anchor:
      "    [...runByCredential].some((r) => r.startsWith('.github/actions/') && p.startsWith(`${r}/`));",
    replacement: '    false;',
  },
  {
    id: 'M18',
    expect: 'red',
    claim:
      'every workflow is treated as credential-bearing — a script only a plain workflow runs fires',
    subject: 'guard',
    anchor: '    .filter((text) => text !== null && workflowHoldsCredential(text));',
    replacement: '    .filter((text) => text !== null);',
  },
  {
    id: 'M19',
    expect: 'red',
    claim: 'trailing prose punctuation is kept — a comment mention `scripts/a.mjs.` never resolves',
    subject: 'guard',
    anchor: "    const p = m[1].replace(/[.,;:]+$/, '');",
    replacement: '    const p = m[1];',
  },
  {
    id: 'M20',
    expect: 'red',
    claim: 'the manifest rule shrinks back to packages/kn-next — grpc/ffi exports stop firing',
    subject: 'guard',
    anchor: 'const PACKAGE_MANIFEST = /^packages\\/[^/]+\\/package\\.json$/;',
    replacement: 'const PACKAGE_MANIFEST = /^packages\\/kn-next\\/package\\.json$/;',
  },
  {
    id: 'M21',
    expect: 'red',
    claim: 'the manifest rule widens to any package.json — scaffold templates fire',
    subject: 'guard',
    anchor: 'const PACKAGE_MANIFEST = /^packages\\/[^/]+\\/package\\.json$/;',
    replacement: 'const PACKAGE_MANIFEST = /(^|\\/)package\\.json$/;',
  },
  {
    id: 'M22',
    expect: 'red',
    claim: 'an UNPARSEABLE manifest passes instead of failing closed',
    subject: 'guard',
    anchor: '    if (before === UNPARSEABLE || after === UNPARSEABLE) {',
    replacement: '    if (false) {',
  },
  {
    id: 'M23',
    expect: 'red',
    claim: 'the fired reason stops saying the manifest was unparseable',
    subject: 'guard',
    anchor:
      "        (unparseable ? ' (a manifest is UNPARSEABLE, so it cannot be proven unchanged)' : ''),",
    replacement: "        (unparseable ? '' : ''),",
  },
  {
    id: 'M24',
    expect: 'red',
    claim: 'an unknown git name-status letter is classified instead of failing',
    subject: 'guard',
    anchor: '      if (!GIT_STATUSES.has(status[0])) {',
    replacement: '      if (false) {',
  },
  {
    id: 'M25',
    expect: 'red',
    claim: 'a name-status line with no path is classified instead of failing',
    subject: 'guard',
    anchor: '      if (!path) throw new Error(`name-status line has no path: ${l}`);\n',
    replacement: '',
  },
  {
    id: 'M26',
    expect: 'red',
    claim: 'merging content triggers into path triggers drops new paths for an existing id',
    subject: 'guard',
    anchor:
      '    else for (const p of f.paths) if (!existing.paths.includes(p)) existing.paths.push(p);',
    replacement: '    else void existing;',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    guard: 'scripts/check-escalation-triggers.mjs',
  },
});

console.log(`=== mutation proof: ${SPEC} (escalation-trigger scope, #2388) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'guard',
  anchor: "    match: (p) => p.startsWith('crates/'),",
  replacement: '    match: (p) => false && p,',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
