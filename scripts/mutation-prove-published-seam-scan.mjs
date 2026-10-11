#!/usr/bin/env node
/**
 * Mutation proof for the published-seam export scan (#936).
 *
 * WHAT IS BEING PROVED, AND WHY IT MATTERS
 * ----------------------------------------
 * `scripts/scan-published-seams.mjs` is the only thing standing between a
 * `__`-prefixed test seam and the published `@getknext/*` surface — the shape
 * #936 existed for: two process-wide cache mutators exported from a subpath
 * every consumer imports. A scan that stops FOLLOWING a re-export, or that
 * reads a file it cannot parse as "no exports", does not red: it goes green
 * and says the surface is clean. That is the failure this proves cannot happen
 * quietly. Each mutation takes one of the reader's duties away and the spec
 * (`tests/published-seam-export-scan.test.ts`: fixture packages, the real
 * built dist, and injections into a copy of it) must go red:
 *
 *   - re-exports are not followed (`export *`);
 *   - a file that does not parse is treated as having no exports;
 *   - a file that cannot be READ is swallowed (the "unreadable file" case);
 *   - a seam hidden behind a public name (`export { __x as a }`) is missed;
 *   - a seam nested in `export * as ns` is missed;
 *   - an unresolvable relative re-export is skipped instead of failing;
 *   - CommonJS `module.exports = { __x }` keys are not read;
 *   - `.d.ts` interfaces are not read;
 *   - only the first `exports` condition is scanned;
 *   - a package that exposes nothing, or an empty workspace, reads as clean;
 *   - the CLI exits 0 while holding findings;
 *   - the CI step or the publish-blocking audit step stops running it.
 *
 * The NEGATIVE control rewords a message the spec must not assert on: the spec
 * judges EXIT CODES, so a prose edit leaves it green, or every red above is
 * equally explained by a text match.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations;
 * no `perl`. Needs the lib -> db -> core builds (the spec reads `dist`).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/published-seam-export-scan.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'export-star re-exports are no longer followed — a seam parked in a chunk and re-exported ' +
      'through `export *` (the shape tsup produces) then ships while the scan reports clean',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '    for (const e of readExports(ctx, r.file)) {',
    replacement: '    for (const e of /** @type {ExportEntry[]} */ ([])) {',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'a file that does not parse is read as having no exports — fail OPEN, the quietest way ' +
      'to make the scan decorative',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '  if (diagnostics.length > 0) {',
    replacement: '  if (false && diagnostics.length > 0) {',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'a file that cannot be READ is swallowed (the injected-unreadable-file case) — the scan ' +
      'then certifies a module it never looked at',
    subject: 'lib',
    validate: jsStillParses,
    anchor:
      '    fail(ctx, file, `cannot read file: ${err instanceof Error ? err.message : String(err)}`);',
    replacement: '    void err;',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'a `__`-prefixed LOCAL name is no longer a finding — `export { __x as a }` hides a seam ' +
      'behind a public name and a name-only check never sees it',
    subject: 'lib',
    validate: jsStillParses,
    anchor: "    (e.local ?? '').startsWith(SEAM_PREFIX)",
    replacement: '    false',
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      'only the TOP name is checked — a seam nested under `export * as ns` (`ns.__x`) is missed',
    subject: 'lib',
    validate: jsStillParses,
    anchor: "    e.name.split('.').some((p) => p.startsWith(SEAM_PREFIX)) ||",
    replacement: '    e.name.startsWith(SEAM_PREFIX) ||',
  },
  {
    id: 'M6',
    expect: 'red',
    claim:
      'an unresolvable relative re-export is skipped instead of failing — a dangling ' +
      '`export * from "./gone.js"` then reads as clean, which is the unreadable-file hole again',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '      : { error: `cannot resolve relative module ${JSON.stringify(spec)}` };',
    replacement: '      : { skip: true };',
  },
  {
    id: 'M7',
    expect: 'red',
    claim:
      'CommonJS `module.exports = { __x }` keys are not read — every .cjs preload entry would ' +
      'then be exempt from the convention',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '    if (ts.isObjectLiteralExpression(rhs)) return objectKeys(rhs);',
    replacement: '    if (ts.isObjectLiteralExpression(rhs)) return;',
  },
  {
    id: 'M8',
    expect: 'red',
    claim:
      'interfaces in a declaration file are not read — a type-only seam is still published, and ' +
      'the .d.ts is what a TypeScript consumer actually sees',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '      ts.isInterfaceDeclaration(st) ||',
    replacement: '      false ||',
  },
  {
    id: 'M9',
    expect: 'red',
    claim:
      'only the first `exports` condition is enumerated — a seam on `require` or `types` ' +
      'ships while the `import` target is clean',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '      for (const value of Object.values(node)) walk(subpath, value);',
    replacement: '      walk(subpath, Object.values(node)[0]);',
  },
  {
    id: 'M10',
    expect: 'red',
    claim:
      'a package that exposes nothing reads as clean — a mis-pointed `exports` map then ' +
      'certifies an empty surface instead of failing',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '  if (targets.length === 0) {',
    replacement: '  if (false) {',
  },
  {
    id: 'M11',
    expect: 'red',
    claim:
      'an empty workspace (no publishable package found) reads as clean — a renamed packages ' +
      'directory would turn the CI step into a permanent green',
    subject: 'cli',
    validate: jsStillParses,
    anchor: '  if (targets.length === 0) {',
    replacement: '  if (false) {',
  },
  {
    id: 'M12',
    expect: 'red',
    claim:
      'the CLI exits 0 while holding findings — every detection above is then reported and ' +
      'ignored by the one thing that gates the build',
    subject: 'cli',
    validate: jsStillParses,
    anchor: '  if (failed) {',
    replacement: '  if (false && failed) {',
  },
  {
    id: 'M13',
    expect: 'red',
    claim:
      'an `import { __x as y }` alias re-exported as `y` is resolved to the alias, not the ' +
      'imported name — the seam then ships under a name that carries no prefix',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '          add(exported, spec === undefined ? (aliases.get(local) ?? local) : local);',
    replacement: '          add(exported, local);',
  },
  {
    id: 'M14',
    expect: 'red',
    claim:
      'the CI step is neutered (still named, still green, scans nothing) — the guard then ' +
      'exists on paper while the build it gates never runs it',
    subject: 'ci',
    anchor: '        run: node scripts/scan-published-seams.mjs',
    replacement: "        run: 'true'",
  },
  {
    id: 'M15',
    expect: 'red',
    claim:
      'the publish-blocking audit stops dying on a non-zero scan — a seam in the INSTALLED ' +
      'tarball bytes would then be reported and shipped anyway',
    subject: 'audit',
    validate: jsStillParses,
    anchor: '  if (seamScan.status !== 0) {',
    replacement: '  if (false) {',
  },
  {
    id: 'M18',
    expect: 'red',
    claim:
      'an exported object (`export const ns = { __k }`, `const o = { __q }; export default o`) hides its `__` keys: the name `ns`/`default` is clean and the contents were never looked at (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '      objectKeys(expr, depth, prefix);',
    replacement: '      void expr;',
  },
  {
    id: 'M19',
    expect: 'red',
    claim:
      'a `__` static member on an exported class expression or identifier-bound class ships (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '      classStatics(expr, prefix);',
    replacement: '      void expr;',
  },
  {
    id: 'M20',
    expect: 'red',
    claim:
      'a seam one level down (`ns.inner.__k`) ships while the top-level keys read clean (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '        valueMembers(prop.initializer, `${prefix}${n}.`, depth + 1);',
    replacement: '        void prop;',
  },
  {
    id: 'M21',
    expect: 'red',
    claim:
      '`export default makeApi()` / an imported binding reads as clean (fail OPEN) though its keys were never seen (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: "} else if (!valueMembers(expr, 'default.') && !isInertValue(expr)) {",
    replacement: '} else if (false) {',
  },
  {
    id: 'M22',
    expect: 'red',
    claim:
      '`const o = { __q }; export default o` is no longer resolved through the binding (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '      return init ? valueMembers(init, prefix, depth + 1) : false;',
    replacement: '      return false;',
  },
  {
    id: 'M23',
    expect: 'red',
    claim:
      '`static ["__" + k]` (a computed, non-reference key) reads as clean instead of unscannable (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: 'else if (ts.isIdentifier(ke) || ts.isPropertyAccessExpression(ke)) {',
    replacement: 'else if (true) {',
  },
  {
    id: 'M24',
    expect: 'red',
    claim:
      '`static { K.__x = 1 }` assigns a seam the reader cannot see and it reads as clean (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '      if (ts.isClassStaticBlockDeclaration(m)) {',
    replacement: '      if (false) {',
  },
  {
    id: 'M25',
    expect: 'red',
    claim: 'a CJS class export hides its `__` statics (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: "    if (ts.isClassExpression(rhs)) return classStatics(rhs, '');",
    replacement: '    if (ts.isClassExpression(rhs)) return;',
  },
  {
    id: 'M26',
    expect: 'red',
    claim: 'a CJS class export held in a variable hides its `__` statics (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: "      if (init && ts.isClassDeclaration(init)) return classStatics(init, '');",
    replacement: '      if (init && ts.isClassDeclaration(init)) return;',
  },
  {
    id: 'M27',
    expect: 'red',
    claim: 'a CJS member assigned an object hides its `__` keys (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '          valueMembers(node.right, `${n}.`);',
    replacement: '          void node;',
  },
  {
    id: 'M28',
    expect: 'red',
    claim: 'an object exported through a specifier list hides its `__` keys (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '            if (init) valueMembers(init, `${exported}.`);',
    replacement: '            void init;',
  },
  {
    id: 'M29',
    expect: 'red',
    claim: 'a modifier-form exported const hides the keys of its object (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '          if (d.initializer) valueMembers(d.initializer, `${prefix}${d.name.text}.`);',
    replacement: '          void d;',
  },
  {
    id: 'M30',
    expect: 'red',
    claim: '`export declare const ns: { __k: number }` ships a type-only seam (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: '          if (d.type && ts.isTypeLiteralNode(d.type)) {',
    replacement: '          if (false) {',
  },
  {
    id: 'M31',
    expect: 'red',
    claim: '`export default class { static __x }` hides its `__` statics (#2188)',
    subject: 'lib',
    validate: jsStillParses,
    anchor: "        if (ts.isClassDeclaration(st)) classStatics(st, 'default.');",
    replacement: '        void 0;',
  },
];

/**
 * NEGATIVE CONTROL. Both messages are prose a maintainer is meant to improve.
 * The spec judges the CLI's exit code, so rewording either must leave it GREEN;
 * if it did not, the reds above would be equally explained by a text match.
 */
const NEGATIVES = [
  {
    id: 'M16',
    expect: 'green',
    claim: 'the closing advice line is reworded — the guard asserts the exit code, not the prose',
    subject: 'cli',
    validate: jsStillParses,
    anchor: "        'An unreadable construct is a failure, never a pass.',",
    replacement:
      "        'An unreadable construct is a failure, never a pass (reworded by the control).',",
  },
  {
    id: 'M17',
    expect: 'green',
    claim: 'the `unscannable` label is renamed — findings are identified by kind, not by text',
    subject: 'lib',
    validate: jsStillParses,
    anchor: "  return `  [unscannable] ${f.subpath ?? ''} ${f.file}: ${f.reason}`;",
    replacement: "  return `  [could-not-read] ${f.subpath ?? ''} ${f.file}: ${f.reason}`;",
  },
];

const ALL = [...MUTATIONS, ...NEGATIVES];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    lib: 'scripts/lib/published-export-scan.mjs',
    cli: 'scripts/scan-published-seams.mjs',
    ci: '.github/workflows/ci.yml',
    audit: 'scripts/audit-published.mjs',
  },
});

console.log(`=== mutation proof: ${SPEC} (#936 published-seam scan) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary makes `isSeam` answer "not a seam" for everything: the scan can no
// longer find anything. It must red, which also proves the runner is pointed at
// this spec rather than exiting 0 on a file it never collected.
prover.proveCanSeeRed({
  subject: 'lib',
  anchor: 'function isSeam(e) {',
  replacement: 'function isSeam(e) {\n  if (e) return false;',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
