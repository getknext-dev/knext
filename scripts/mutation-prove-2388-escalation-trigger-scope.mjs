#!/usr/bin/env node
/**
 * Mutation proof for the escalation-trigger classifier's widened scope (#2388).
 *
 * `.claude/rules/workflow.md`: "a guard that stays green when its subject is
 * removed is decoration." Each mutation below removes or widens one rule the
 * #2388 re-scope added — every CRD types file, every package CLI and manifest,
 * `crates/`, the supply-chain set, and fail-closed handling of unknown input —
 * plus round 2's rules (M27–M44): the transitive release-path import closure and
 * its fail-closed gaps, both paths of a rename, `-z` parsing, and write-grant /
 * `toJSON(secrets)` credentials —
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
    anchor: '  if (!status || !GIT_STATUSES.has(status[0])) {',
    replacement: '  if (!status) {',
  },
  {
    id: 'M25',
    expect: 'red',
    claim: 'a name-status line with no path is classified instead of failing',
    subject: 'guard',
    anchor: '    if (paths.length < n || paths.some((p) => !p)) {',
    replacement: '    if (false) {',
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
  {
    id: 'M27',
    expect: 'red',
    claim:
      'static `import \u2026 from` / `export \u2026 from` edges stop being followed \u2014 a transitive release-path import changes unflagged',
    subject: 'guard',
    anchor: '  for (const m of text.matchAll(STATIC_IMPORT)) specs.push(m[2]);',
    replacement: '  void STATIC_IMPORT;',
  },
  {
    id: 'M28',
    expect: 'red',
    claim: 'a literal require()/import() argument stops being followed',
    subject: 'guard',
    anchor: '    if (lit) specs.push(lit[2] ?? lit[3]);',
    replacement: '    if (lit) void lit;',
  },
  {
    id: 'M29',
    expect: 'red',
    claim: 'a NON-LITERAL import()/require() is skipped instead of failing closed',
    subject: 'guard',
    anchor: "    else nonLiteral.push(`${m[1]}(${rest.slice(0, 40).split('\\n')[0].trim()}`);",
    replacement: '    else void m;',
  },
  {
    id: 'M30',
    expect: 'red',
    claim: 'an unresolvable relative import is skipped instead of failing closed',
    subject: 'guard',
    anchor: "        if (target === null) gaps.push(`${file}: unresolvable import '${spec}'`);",
    replacement: '        if (target === null) continue;',
  },
  {
    id: 'M31',
    expect: 'red',
    claim:
      'the import closure is computed but never consulted \u2014 only literally-named scripts fire',
    subject: 'guard',
    anchor: '    closure.has(p) ||',
    replacement: '    false ||',
  },
  {
    id: 'M32',
    expect: 'red',
    claim:
      'files are read from the head tree only \u2014 a DELETED import target is never followed',
    subject: 'guard',
    anchor: "    if (!cache.has(p)) cache.set(p, repo.show('head', p) ?? repo.show('base', p));",
    replacement: "    if (!cache.has(p)) cache.set(p, repo.show('head', p));",
  },
  {
    id: 'M33',
    expect: 'red',
    claim: 'a shell script or action.yml on the release path is not scanned for what IT runs',
    subject: 'guard',
    anchor: '      for (const p of referencedPaths(text)) addNamed(p);',
    replacement: '      void text;',
  },
  {
    id: 'M34',
    expect: 'red',
    claim: 'a local action directory is not listed \u2014 its action.yml is never opened',
    subject: 'guard',
    anchor: '    else for (const f of listUnder(`${p}/`)) add(f); // a local action directory',
    replacement: '    else void listUnder;',
  },
  {
    id: 'M35',
    expect: 'red',
    claim: 'an INCOMPLETE closure stops failing closed \u2014 changed modules pass',
    subject: 'guard',
    anchor:
      "    } else if (gaps.length > 0 && (MODULE_FILE.test(c.path) || c.path.endsWith('.json'))) {",
    replacement: '    } else if (false) {',
  },
  {
    id: 'M36',
    expect: 'red',
    claim: 'the fired reason stops naming the edge that made the closure incomplete',
    subject: 'guard',
    anchor:
      "          ? ` (the release-path import closure is INCOMPLETE \u2014 ${gaps.join('; ')} \u2014 so a changed module cannot be proven off it)`",
    replacement: "          ? ' (incomplete)'",
  },
  {
    id: 'M37',
    expect: 'red',
    claim: 'comment lines are scanned \u2014 a JSDoc mention of import() fires on every module PR',
    subject: 'guard',
    anchor: "  const text = source.replace(/^[ \\t]*(?:\\/\\/|\\/\\*|\\*).*$/gm, '');",
    replacement: '  const text = source;',
  },
  {
    id: 'M38',
    expect: 'red',
    claim: 'a rename/copy yields only its destination \u2014 moving a file OUT of scope passes',
    subject: 'guard',
    anchor: '      .slice(0, n)',
    replacement: '      .slice(n - 1, n)',
  },
  {
    id: 'M39',
    expect: 'red',
    claim: 'the CLI reads C-quoted name-status \u2014 a non-ASCII CRD types path never matches',
    subject: 'guard',
    anchor: "git(['diff', '-z', '--name-status',",
    replacement: "git(['diff', '--name-status',",
  },
  {
    id: 'M40',
    expect: 'red',
    claim: 'the NUL-separated (-z) record form is not parsed',
    subject: 'guard',
    anchor: "  if (text.includes('\\0')) {",
    replacement: '  if (false) {',
  },
  {
    id: 'M41',
    expect: 'red',
    claim: 'permissions: write-all stops counting as a credential',
    subject: 'guard',
    anchor: '  if (/permissions\\s*:\\s*[\'"]?write-all/.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M42',
    expect: 'red',
    claim: 'packages/contents/attestations: write stop counting as credentials',
    subject: 'guard',
    anchor:
      '  if (/(?:^|[\\s{,])(?:packages|contents|attestations)\\s*:\\s*[\'"]?write\\b/m.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M43',
    expect: 'red',
    claim: 'toJSON(secrets) stops counting as a credential',
    subject: 'guard',
    anchor: '  if (/toJSON\\s*\\(\\s*secrets\\s*\\)/i.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M44',
    expect: 'red',
    claim: 'the git reader treats a TREE as a file \u2014 a local action directory is never listed',
    subject: 'guard',
    anchor: "      if (type !== 'blob') return null;\n",
    replacement: '',
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
