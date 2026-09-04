#!/usr/bin/env node
/**
 * Mutation proof for D9 / #918 — the scratch-space guard's two new halves.
 *
 * WHAT IS BEING PROVED, AND WHY IT NEEDS PROVING
 * ----------------------------------------------
 * `tests/temp-dirs-outside-the-repo.test.ts` asserted, for months, exactly one
 * thing: that a `mkdtemp` PREFIX is rooted at `tmpdir()`. During those months
 * `tests/tomatchobject-mutation-guard.test.ts` wrote transient dot-prefixed
 * `.ts` files into the repo's own `tests/` directory and raced the typecheck
 * gate into a deterministic CI red — and the guard was green the whole time,
 * because the write was a `writeFileSync` inside a `node -e` string rather than
 * a `mkdtemp`. A guard that stayed green through a live instance of its own
 * subject is the definition of the thing this repo mutation-proves.
 *
 * So the five reds below are not "does the regex work". Each one restores a
 * state the tree was ACTUALLY in, or removes a distinction the scan was
 * ACTUALLY measured to need:
 *
 *   M1 puts #918 back, verbatim from the commit that fixed it (c3a8ca51).
 *   M2 leaks a temp directory — the half that did not exist at all before D9.
 *   M3 removes the destination-argument distinction, without which
 *      `copyFileSync(<repo>, <tmp>)` — reading a tracked file INTO scratch, the
 *      correct direction — reads as a repo write. Two live call sites do this.
 *   M4 removes the embedded pass, which is the ONLY pass that can see #918.
 *   M5 adds one leak to the file ALREADY at the top of the baseline (42 sites),
 *      because a ceiling that binds only for unlisted files hands the worst
 *      offender a place to hide the next one.
 *   M5b does the same with an EXISTING binding name. M5 and M2 both use fresh
 *      names, which is exactly why existential pairing survived them both:
 *      `cli-node-runtime.test.ts` had nine `dir` creations and one removal and
 *      reported zero leaks. A same-named leak is the shape that got through.
 *   M5c adds a fourth repo write to the one file licensed for three, so the
 *      write exception is proved to be pinned to what it licences rather than
 *      to the file's name.
 *   M5d SUBSTITUTES a licensed write for a `tests/*.tmp.ts` one. The count is
 *      unchanged, which is exactly why a count-pinned licence stayed green
 *      through it — the licence names destinations because of this mutation.
 *   M5e adds an UNREGISTERED leak to a genuinely drained-registry file. The
 *      registry exemption used to discharge every same-named creation once one
 *      was pushed; no synthetic vector caught it, because none of them had an
 *      unregistered sibling. This one is asserted against the real tree.
 *   M6 blinds the lifetime scan, which makes every baseline entry stale —
 *      proving the ratchet is asserted in BOTH directions and cannot rot into a
 *      permanent licence.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/temp-dirs-outside-the-repo.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      '#918 is put back verbatim — the scratch `.ts` returns to `tests/`, where a concurrent ' +
      "spec's disk walk reds the typecheck gate on a schedule nobody controls",
    subject: 'victim',
    anchor: "const tmp = join(tmpdir(), 'knext-tomatchobject-guard-sample.tmp.ts');",
    replacement: "const tmp = resolve(repoRoot, 'tests/.tomatchobject-guard-sample.tmp.ts');",
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'a temp directory is created and never removed — correctly PLACED and still a leak, ' +
      'one directory per run on every machine that runs the suite',
    subject: 'victim',
    anchor: 'const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), ',
    replacement:
      "const leaked = mkdtempSync(join(tmpdir(), 'knext-d9-leak-'));\nconst repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), ",
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'every write is judged on argument 0, so `copyFileSync(<tracked file>, <tmp>)` — the ' +
      'CORRECT direction, used by two live call sites — reads as a write into the checkout',
    subject: 'scan',
    anchor: '  copyFileSync: 1,',
    replacement: '  copyFileSync: 0,',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the embedded pass is removed — a write inside a `node -e` string becomes invisible, ' +
      'which is precisely how #918 shipped under a guard named for it',
    subject: 'scan',
    anchor: '  for (const [from, to] of literalSpans(blanked)) {',
    replacement: '  for (const [from, to] of []) {',
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      'a file ALREADY in the leak baseline gains one more leak — the ceiling has to bind ' +
      'per file, or the worst offender (42 sites) becomes a place to hide the next one',
    subject: 'listed',
    anchor: "    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-throw-'));",
    replacement:
      "    const extra = mkdtempSync(join(tmpdir(), 'knext-d9-extra-'));\n" +
      "    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-throw-'));",
  },
  {
    id: 'M5b',
    expect: 'red',
    claim:
      'the new leak reuses an EXISTING binding name in a listed file — the shape that defeated ' +
      'existential pairing, where one `rmSync(dir)` acquitted nine `dir` creations and a tenth ' +
      'stayed green. M5 uses a fresh name, so it never had to see this',
    subject: 'listed',
    anchor: "    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-scope-'));",
    replacement:
      "    const dir = mkdtempSync(join(tmpdir(), 'knext-d9-samename-'));\n" +
      "    const dir2 = mkdtempSync(join(tmpdir(), 'knext-pin-scope-'));\n" +
      '    void dir2;',
  },
  {
    id: 'M5c',
    expect: 'red',
    claim:
      'a FOURTH repo write is added to the one file licensed for three — the licence must not ' +
      'extend to whatever lands next to it',
    subject: 'licensed',
    anchor: '    const typesDir = join(FIXTURE, "node_modules", "@types");',
    replacement:
      '    writeFileSync(join(FIXTURE, "extra-write.txt"), "x");\n' +
      '    const typesDir = join(FIXTURE, "node_modules", "@types");',
  },
  {
    id: 'M5d',
    expect: 'red',
    claim:
      'a licensed write is SUBSTITUTED for a `tests/*.tmp.ts` scratch write — the COUNT stays ' +
      'at three, so the count-pinned licence stayed GREEN through the exact #918 shape it was ' +
      'meant to be narrowing. This is why the licence names destinations',
    subject: 'licensed',
    anchor: '    writeFileSync(join(FIXTURE, ".knext", ".gitignore"), "*\\n");',
    replacement: '    writeFileSync("tests/.a.tmp.ts", "*\\n");',
  },
  {
    id: 'M5e',
    expect: 'red',
    claim:
      'a leak is added to a genuinely drained-registry file WITHOUT enrolling it — the ' +
      'file-global exemption discharged every same-named creation once one was pushed, so five ' +
      'appended leaks reported zero. No synthetic vector caught this, because none of them had ' +
      'an unregistered sibling',
    subject: 'registry',
    anchor: "  const dir = mkdtempSync(join(tmpdir(), 'port-owned-'));",
    replacement:
      "  const dir = mkdtempSync(join(tmpdir(), 'knext-d9-unregistered-'));\n" +
      "  const dir2 = mkdtempSync(join(tmpdir(), 'port-owned-'));\n" +
      '  void dir2;',
  },
  {
    id: 'M6',
    expect: 'red',
    claim:
      'the lifetime scan goes blind — every baseline entry silently becomes stale, which is ' +
      'the direction a one-way ratchet never checks and the reason this one does',
    subject: 'scan',
    anchor: '  for (const m of blanked.matchAll(/\\bmkdtemp(?:Sync)?\\s*\\(/g)) {',
    replacement: '  for (const m of []) {',
  },
];

/**
 * NEGATIVE CONTROL. The failure message explains #914 to whoever hits it in CI.
 * Rewording it must leave the guard GREEN — otherwise the five reds above are
 * equally explained by the spec asserting on its own prose, and every
 * improvement to the diagnostics would red the guard.
 */
const NEGATIVE = {
  id: 'M7',
  expect: 'green',
  claim: 'the diagnostic is reworded — the guard asserts behaviour, not its own message text',
  subject: 'scan',
  anchor: ' * Every write whose destination resolves inside the checkout.',
  replacement: ' * Every write whose destination resolves inside the checkout (reworded).',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    scan: 'scripts/lib/scratch-space-scan.mjs',
    victim: 'tests/tomatchobject-mutation-guard.test.ts',
    listed: 'tests/action-pin-sha-tag-nightly.test.ts',
    licensed: 'packages/kn-next/src/__tests__/adapter-dev-edge-fence.test.ts',
    registry: 'tests/e2e-deploy.port-ownership.test.ts',
  },
});

console.log(`=== mutation proof: ${SPEC} (D9 + #918 scratch space) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary blinds the write scan outright. Every #918 case keys on it, so
// this must red — and it proves the runner is pointed at this spec rather than
// exiting 0 on a file it never collected.
prover.proveCanSeeRed({
  subject: 'scan',
  anchor: '  // PASS 1 — structural, over blanked source.',
  replacement: '  return found;\n  // PASS 1 — structural, over blanked source.',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
