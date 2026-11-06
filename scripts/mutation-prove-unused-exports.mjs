#!/usr/bin/env node
/**
 * Mutation proof for the unused-export guard (`tests/unused-exports.test.ts`,
 * scan in `scripts/lib/unused-export-scan.mjs`).
 *
 * Two kinds of row, both required: the REAL TREE broken (an unused export, a
 * stale declaration, the deleted constant re-added - each must go red) and the
 * SCANNER weakened (each rule disabled in turn - the fixtures must go red). A
 * scan that is green because it reads nothing is decoration.
 *
 * The planted export name is assembled at run time. The scan counts a mention in
 * ANY tracked file as a reference, so a literal copy of the name in this script
 * would reference it and hide the very export being planted.
 *
 * Discipline (scripts/lib/guard-prover.mjs): every anchor occurs exactly once
 * (else ABORT in the preflight), every verdict is the runner's EXIT CODE, the
 * baseline must be green first, a canary must go red before any green below is
 * trusted, and the tree is checked clean between mutations.
 *
 * Exit 0 = every row went red; non-zero otherwise.
 *
 * Usage:
 *   node scripts/mutation-prove-unused-exports.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/unused-exports.test.ts';

const PLANTED = ['planted', 'Unused', 'Export'].join('');
const RESTORED = ['IMPORT', 'CONDITIONS'].join('_');

const ROWS = [
  {
    id: 'U01',
    subject: 'floor',
    claim: 'an unused export planted in a shipped, non-public file',
    anchor: 'export const NODE_FLOOR_MAJOR = 24;',
    replacement: `export const NODE_FLOOR_MAJOR = 24;\nexport const ${PLANTED} = 1;`,
  },
  {
    id: 'U02',
    subject: 'sidecardts',
    claim: 'a declaration for a name the source does not export',
    anchor: 'export const REQUIRE_CONDITIONS: string[];',
    replacement: `export const REQUIRE_CONDITIONS: string[];\nexport const ${PLANTED}: string;`,
  },
  {
    id: 'U03',
    subject: 'sidecar',
    claim: 'the deleted constant is added back',
    anchor: 'export const REQUIRE_CONDITIONS = ["bun", "node", "require", "default"];',
    replacement: `export const REQUIRE_CONDITIONS = ["bun", "node", "require", "default"];\nexport const ${RESTORED} = ["bun"];`,
  },
  {
    id: 'S01',
    subject: 'scan',
    claim: 'every export counts as referenced',
    anchor: 'if (set.has(name)) {',
    replacement: 'if (true) {',
  },
  {
    id: 'S02',
    subject: 'scan',
    claim: 'every file is exempt as public surface',
    anchor: 'if (publicFiles.has(file)) {',
    replacement: 'if (true) {',
  },
  {
    id: 'S03',
    subject: 'scan',
    claim: 'the declaration companion counts as an importer',
    anchor: 'if (own.has(p)) continue;',
    replacement: 'if (p === file) continue;',
  },
  {
    id: 'S04',
    subject: 'scan',
    claim: 'the public surface ignores the tsup entry table',
    anchor: 'const viaTsup = entries.get(name);',
    replacement: 'const viaTsup = undefined;',
  },
  {
    id: 'S05',
    subject: 'scan',
    claim: 'a stale declaration is never reported',
    anchor:
      'if (!have.has(d.name)) staleDeclarations.push({ file: c, name: d.name, line: d.line });',
    replacement: 'void staleDeclarations;',
  },
  {
    id: 'S06',
    subject: 'scan',
    claim: 'a destructuring export passes unseen',
    anchor: "unreadable.push({\n      what: 'a destructuring export',",
    replacement: "void ({\n      what: 'a destructuring export',",
  },
  {
    id: 'S07',
    subject: 'scan',
    claim: 'no source file is in scope',
    anchor: 'if (!isScopedSource(file)) continue;',
    replacement: 'if (true) continue;',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    floor: 'packages/kn-next/src/cli/node-floor.ts',
    sidecar: 'packages/kn-next/src/adapters/sidecar-runtime.mjs',
    sidecardts: 'packages/kn-next/src/adapters/sidecar-runtime.d.mts',
    scan: 'scripts/lib/unused-export-scan.mjs',
  },
});

prover.preflight(ROWS);
declareMutations(ROWS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'scan',
  anchor: 'if (set.has(name)) {',
  replacement: 'if (true) {',
});
for (const m of ROWS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(ROWS.length);
