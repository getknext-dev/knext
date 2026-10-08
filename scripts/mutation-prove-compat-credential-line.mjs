#!/usr/bin/env node
/**
 * Mutation proof for `tests/compat-credential-line.test.ts` — the parallel
 * v1.3 credential lane. Both halves the lane promises are proved:
 *
 *   A. the v1.3 lane resolves the v1.3 RC tag and NEVER the v1.0 tag (nor
 *      main): delete a refusal, widen the line, mis-wire the derived workflow
 *      or its tracker — the spec must go RED;
 *   B. the v1.0 lane is unchanged and nothing collides with it: put a v1.3
 *      file into the v1.0 frozen set, move a v1.0 cron, point the v1.0 audit
 *      at the v1.3 workflow, or give the v1.3 lane a v1.0 name — RED.
 *   C. the v1.3 slots stay clear of v1.0's measured late-start tail (start
 *      >= 14:00 UTC, >= 90 min apart, tracker after the last slot's grace);
 *   D. the main-side guard CLOSURE (resolver, derivation gate, tracker and
 *      everything they transitively import) is folded into the fingerprinted
 *      executing file, so editing any of it restarts the window — drop the
 *      digest, the header check, the transitive walk, a fail-closed branch or
 *      an entry: RED.
 *
 * ATTRIBUTION — each mutation names the ONE test (`expect`) it must turn red.
 * A red spec is not enough: since the guard digests landed, ANY byte change to
 * a closure file reddens the GUARD DIGESTS / round-trip tests, so a whole-file
 * exit code went red for every mutation of a digested file whether or not the
 * assertion it targets held. So, per mutation:
 *   1. apply it; unless the derived workflow IS the subject, REGENERATE that
 *      workflow from the mutated tree (`compat-line-workflow.mjs --write`), so
 *      the digests are consistent again and only the behavioural change shows;
 *   2. run the spec through the shared runner with a JUnit report
 *      (`--junit-dir`) and read the per-test outcome from that STRUCTURED
 *      report — never from console text;
 *   3. score it caught only if the exit code is non-zero AND its target test is
 *      reported FAILED. Green is DECORATIVE; red via other tests only is
 *      MISATTRIBUTED; red with no report (a load error) is UNATTRIBUTED. All
 *      three fail the prover.
 *
 * Shared harness, same rules as every prover here:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell 29-of-30 from 30;
 *   * the `{ subject, anchor }` table shape the prover lane's static
 *     anchor-liveness audit reads (scripts/lib/prover-lane.mjs);
 *   * baseline green first (every target present and passing), and green again
 *     after every restore.
 *
 * Usage:  node scripts/mutation-prove-compat-credential-line.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { underiveLineWorkflow } from './compat-line-workflow.mjs';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-credential-line.test.ts';

/** The files the mutations land in, repo-relative. */
const PROOF = {
  subjects: {
    line: 'scripts/compat-credential-line.mjs',
    derive: 'scripts/compat-line-workflow.mjs',
    tracker: 'scripts/compat-line-tracker.mjs',
    derived: '.github/workflows/compat-credential-v1.3.yml',
    trackerWorkflow: '.github/workflows/compat-credential-v1.3-tracker.yml',
    v10workflow: '.github/workflows/test-e2e-deploy.yml',
    v10audit: 'scripts/compat-window-audit.mjs',
    freezeGuard: 'scripts/compat-credential-freeze-guard.mjs',
  },
};

const MUTATIONS = [
  // ── A. the v1.3 lane resolves the v1.3 tag, never v1.0's ─────────────────
  {
    label: 'A: drop the off-line refusal (a v1.0 tag in the v1.3 pin would run)',
    expect: 'REFUSES a v1.0 tag pinned into the v1.3 pin — with no checkout target',
    subject: 'line',
    anchor: '  if (!spec.tagPattern.test(pin.rcTag)) {',
    replacement: '  if (false) {',
  },
  {
    label: 'A: widen the v1.3 line to ANY RC tag',
    expect: 'isLineTag/isLineRef accept only v1.3 RC tags',
    subject: 'line',
    anchor: '    tagPattern: new RegExp(`^v1\\\\.3\\\\.${NUM}-rc\\\\.${NUM}$`),',
    replacement: '    tagPattern: /^v\\d+\\.\\d+\\.\\d+-rc\\.\\d+$/,',
  },
  {
    label: 'A: accept a pin that does not declare the v1.3 line (the v1.0 pin)',
    expect: 'REFUSES the real v1.0 pin file handed to the v1.3 lane (no `line` declared)',
    subject: 'line',
    anchor: '  if (pin.line !== line) {',
    replacement: '  if (false) {',
  },
  {
    label: 'A: a dispatch (early-warning) night is marked credential',
    expect:
      'a dispatch (early-warning) ALSO runs the pinned v1.3 tag — never main — and is non-credential',
    subject: 'line',
    anchor: "    state: credential ? 'resolved' : 'early-warning',\n    credential,\n",
    replacement: "    state: 'resolved',\n    credential: true,\n",
  },
  {
    label: 'A: the derived workflow resolves with the v1.0 resolver',
    expect:
      'the credential-ref job resolves via the v1.3 line resolver + pin, then verifies the derivation',
    subject: 'derived',
    anchor:
      '          node knext/scripts/compat-credential-line.mjs \\\n            --line v1.3 \\\n',
    replacement: '          node knext/scripts/compat-credential-ref.mjs \\\n',
  },
  {
    label: 'A: the derivation hands the v1.3 lane the v1.0 pin (the file is regenerated with it)',
    expect:
      'the credential-ref job resolves via the v1.3 line resolver + pin, then verifies the derivation',
    subject: 'derive',
    anchor: '        `            --pin knext/${spec.pinFile} \\\\\\n` +',
    replacement: "        '            --pin knext/.github/compat-credential-ref.json \\\\\\n' +",
  },
  {
    label: 'A: the run-time gate accepts a hand-edited executing workflow',
    expect:
      'checkLineWorkflow — the runtime gate — accepts exactly derive(source) and nothing else',
    subject: 'derive',
    anchor: '  if (derived !== executingText) {',
    replacement: '  if (false) {',
  },
  {
    label: 'A: a substitution whose anchor is missing derives silently',
    expect:
      'every substitution is anchor-exact: a missing or duplicated anchor THROWS, never derives',
    subject: 'derive',
    anchor: '    const n = count(text, s.from);\n    if (n !== s.count) {',
    replacement: '    const n = count(text, s.from);\n    if (false) {',
  },
  {
    label: 'A: the v1.3 audit lists the v1.0 workflow (no rewrite)',
    expect:
      'the v1.3 audit only ever lists the v1.3 workflow; the v1.0 audit only ever lists its own',
    subject: 'tracker',
    anchor: '      out[at[0] + 1] = spec.workflowFile;',
    replacement: '      void out;',
  },
  {
    label: 'A: a night on another line’s tag can bank in the v1.3 window',
    expect: 'a night that ran ANOTHER line’s tag (v1.0) can never bank in the v1.3 window',
    subject: 'tracker',
    anchor: '    cells[lane] = { ...a, offLineNights, met: a.met && offLineNights.length === 0 };',
    replacement: '    cells[lane] = { ...a, offLineNights, met: a.met };',
  },
  {
    label: 'A: the v1.3 tracker pins itself (would take a v1.0 pin slot)',
    expect: 'the tracker upsert creates/comments on its OWN issue and never pins',
    subject: 'tracker',
    anchor: '  const match = issues.find((i) => i.title === spec.trackerTitle);',
    replacement:
      "  gh(['issue', 'pin', '1', '--repo', repo]);\n  const match = issues.find((i) => i.title === spec.trackerTitle);",
  },

  // ── B. the v1.0 lane is unchanged and nothing collides with it ───────────
  {
    label: 'B: a v1.3 file enters the v1.0 frozen set',
    expect: 'no file of the v1.3 lane is in the v1.0 frozen set (frozenFileSet, derived)',
    subject: 'freezeGuard',
    anchor: "  '.github/workflows/compat-credential-freeze-guard.yml',\n]);",
    replacement:
      "  '.github/workflows/compat-credential-freeze-guard.yml',\n  'scripts/compat-credential-line.mjs',\n]);",
  },
  {
    label: 'B: the v1.0 node credential night moves (v1.0 cron mapping changed)',
    expect: 'the v1.0 workflow still maps its OWN four credential crons to its cells',
    subject: 'v10workflow',
    anchor: "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 1 * * *' && 'credential') ||",
    replacement:
      "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 3 * * *' && 'credential') ||",
  },
  {
    label: 'B: the v1.0 audit reads the v1.3 workflow',
    expect:
      'the v1.3 audit only ever lists the v1.3 workflow; the v1.0 audit only ever lists its own',
    subject: 'v10audit',
    anchor: "const WORKFLOW = 'test-e2e-deploy.yml';",
    replacement: "const WORKFLOW = 'compat-credential-v1.3.yml';",
  },
  {
    label: 'B: the derived workflow keeps the v1.0 name (shared concurrency groups)',
    expect: 'the workflow names differ, so github.workflow-keyed concurrency groups never collide',
    subject: 'derived',
    anchor: 'name: Compat suite v1.3 credential (official Next.js deploy harness)\n',
    replacement: 'name: Compat suite (official Next.js deploy harness)\n',
  },
  {
    label: 'B: a v1.3 credential cron lands on a v1.0 slot',
    expect: 'the v1.3 crons are disjoint from every v1.0 cron (offset, not shared slots)',
    subject: 'line',
    anchor: "      '17 1 * * *': '17 14 * * *',",
    replacement: "      '17 1 * * *': '17 3 * * *',",
  },
  {
    label: 'B: the v1.3 red alert reuses the v1.0 title',
    expect: 'alert title, reset label and tracker title/label are disjoint from v1.0',
    subject: 'line',
    anchor: "    alertTitle: 'Compat v1.3 CREDENTIAL RED (${KNEXT_LANE}, RC tag)',",
    replacement: "    alertTitle: 'Compat CREDENTIAL RED (${KNEXT_LANE}, RC tag)',",
  },
  {
    label: 'B: the v1.3 reset label is the v1.0 one',
    expect: 'alert title, reset label and tracker title/label are disjoint from v1.0',
    subject: 'line',
    anchor: "    resetLabel: 'credential-reset-v1.3',",
    replacement: "    resetLabel: 'credential-reset',",
  },
  {
    label: 'B: the v1.3 tracker label is the v1.0 tracker label',
    expect: 'alert title, reset label and tracker title/label are disjoint from v1.0',
    subject: 'line',
    anchor: "    trackerLabel: 'credential-matrix-tracker-v1.3',",
    replacement: "    trackerLabel: 'credential-matrix-tracker',",
  },

  // ── C. the v1.3 slots stay clear of v1.0's measured late-start tail ──────
  {
    label: 'C: a v1.3 credential cron moves back inside v1.0’s late-start tail (before 14:00 UTC)',
    expect: 'the v1.3 crons start after v1.0’s measured late-start window and are spaced >= 90 min',
    subject: 'line',
    anchor: "      '17 1 * * *': '17 14 * * *',",
    replacement: "      '17 1 * * *': '17 11 * * *',",
  },
  {
    label: 'C: two v1.3 crons closer than 90 min (the bun slot 30 min after node)',
    expect: 'the v1.3 crons start after v1.0’s measured late-start window and are spaced >= 90 min',
    subject: 'line',
    anchor: "      '47 5 * * *': '47 15 * * *',",
    replacement: "      '47 5 * * *': '47 14 * * *',",
  },
  {
    label: 'C: the v1.3 tracker runs before the last slot’s 10 h grace has elapsed',
    expect: 'the tracker workflow audits the v1.3 line and runs after every v1.3 slot’s grace',
    subject: 'trackerWorkflow',
    anchor: "    - cron: '31 5 * * *'",
    replacement: "    - cron: '53 1 * * *'",
  },

  // ── D. the guard CLOSURE is folded into the fingerprinted bytes ──────────
  {
    label: 'D: the guard digests stop reading the files (an edit no longer moves the header)',
    expect:
      'GUARD DIGESTS: the header records the sha256 of every file in the guard closure, and they match the files on disk',
    subject: 'derive',
    anchor: "    sha256(readFileSync(join(repoRoot, path), 'utf8')),",
    replacement: '    sha256(path),',
  },
  {
    label: 'D: the header no longer has to record the whole closure (a dropped line parses)',
    expect: 'GUARD DIGESTS: a hand-edited or missing guard line in the header is refused',
    subject: 'derive',
    anchor: '  if (JSON.stringify(guards.map(([p]) => p)) !== JSON.stringify(closure)) {',
    replacement: '  if (false) {',
  },
  {
    label:
      'D: the closure stops at the entries (auditWindow / formatCellRow / isRcTag edits go unseen)',
    expect:
      'GUARD CLOSURE: every repo file the entries transitively import (found by a real parser) is digested',
    subject: 'derive',
    anchor: "      queue.push(relTarget.split(sep).join('/'));",
    replacement: '      void relTarget;',
  },
  {
    label: 'D: the closure scan drops literal dynamic import() targets',
    expect:
      'GUARD CLOSURE: the scan follows imports transitively and fails closed on a computed specifier',
    subject: 'derive',
    anchor: '    specs.push(lit[2]);',
    replacement: '    void lit;',
  },
  {
    label: 'D: a computed import() specifier is skipped instead of refused',
    expect:
      'GUARD CLOSURE: the scan follows imports transitively and fails closed on a computed specifier',
    subject: 'derive',
    anchor: '    if (!lit) {',
    replacement: '    if (!lit) continue;\n    if (false) {',
  },
  {
    label: 'D: a createRequire route (node:module) is skipped instead of refused',
    expect:
      'GUARD CLOSURE: the scan follows imports transitively and fails closed on a computed specifier',
    subject: 'derive',
    anchor:
      "  if (specs.some((s) => s === 'module' || s === 'node:module') || LOADER_ESCAPE_RE.test(src)) {",
    replacement: '  if (false) {',
  },
  {
    label: 'D: a package `imports` alias (#x) is skipped as a package instead of refused',
    expect:
      'GUARD CLOSURE: the scan follows imports transitively and fails closed on a computed specifier',
    subject: 'derive',
    anchor: '  if (opaque !== undefined) {',
    replacement: '  if (false) {',
  },
  {
    label:
      'D: the tracker is dropped from the guard entries (the whole grading closure goes unseen)',
    expect:
      'GUARD ENTRIES: every script the line runs from main (credential-ref job + tracker workflow) is a guard entry',
    subject: 'line',
    anchor:
      "      'scripts/compat-line-workflow.mjs',\n      'scripts/compat-line-tracker.mjs',\n    ]),",
    replacement: "      'scripts/compat-line-workflow.mjs',\n    ]),",
  },
];

declareMutations(30);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

// One scratch directory for the whole run: the recovered tag source the
// regeneration reads, and the JUnit report each spec run writes.
const SCRATCH = mkdtempSync(join(tmpdir(), 'prove-v13-line-'));
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }));
const JUNIT_DIR = join(SCRATCH, 'junit');

/**
 * The spec's per-test outcome, from bun's JUnit report — STRUCTURED output,
 * never the console text. `cases` is null when the run wrote no report (the
 * file failed to load): that is "no test outcome", never proof of anything.
 *
 * @returns {{ status: number | null, cases: Map<string, boolean> | null }}
 *   `cases`: test name → true when that test FAILED.
 */
function runSpec() {
  rmSync(JUNIT_DIR, { recursive: true, force: true });
  mkdirSync(JUNIT_DIR, { recursive: true });
  const r = spawnSync(
    RUNNER.command,
    [...RUNNER.args, `--junit-dir=${JUNIT_DIR}`, ...RUNNER.runArgs(SPEC)],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const reports = readdirSync(JUNIT_DIR).filter((f) => f.endsWith('.xml'));
  if (reports.length !== 1) return { status: r.status, cases: null };
  const xml = readFileSync(join(JUNIT_DIR, reports[0]), 'utf8');
  /** @type {Map<string, boolean>} */
  const cases = new Map();
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? '');
    const failed = m[2] !== undefined && /<(?:failure|error)\b/.test(m[2]);
    cases.set(name, (cases.get(name) ?? false) || failed);
  }
  return { status: r.status, cases };
}

/** @param {string} s */
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') {
      return String.fromCodePoint(
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
  });
}

/**
 * Re-derive the v1.3 workflow from the MUTATED tree (the mutated resolver /
 * gate / tracker / libraries), so the header's guard digests match the files
 * on disk again. Without this, ANY byte change to a closure file reds the GUARD
 * DIGESTS / round-trip tests, and every mutation "goes red" whether or not the
 * assertion it targets holds — which is how 19 of 25 mutations were decorative.
 * A non-zero exit is the mutated code itself refusing to derive (e.g. a
 * substitution that is no longer invertible); the file is then left as it was,
 * and the named test must still go red on its own assertion.
 */
function regenerate() {
  const r = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/compat-line-workflow.mjs'),
      '--write',
      '--line',
      'v1.3',
      '--tag',
      TAG,
      '--source',
      SOURCE_PATH,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return r.status === 0 ? 'regenerated' : `regeneration refused (${(r.stderr ?? '').trim()})`;
}

if (MUTATIONS.length !== 30) {
  console.error(`FATAL: declared 30 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

// The tag source, recovered from the COMMITTED derived file before anything is
// mutated (exactly invertible — see underiveLineWorkflow).
const committed = readFileSync(resolve(REPO_ROOT, PROOF.subjects.derived), 'utf8');
const { sourceText, tag: TAG } = underiveLineWorkflow(committed, { line: 'v1.3' });
const SOURCE_PATH = join(SCRATCH, 'source.yml');
writeFileSync(SOURCE_PATH, sourceText);

console.log('Baseline: the spec must be GREEN, with every targeted test present and passing.');
const base = runSpec();
if (base.status !== 0 || base.cases === null) {
  console.error(`FATAL: ${SPEC} is not green to begin with (or wrote no JUnit report)`);
  process.exit(1);
}
for (const m of MUTATIONS) {
  if (!base.cases.has(m.expect) || base.cases.get(m.expect)) {
    console.error(`FATAL: "${m.label}" targets a test the baseline does not pass: ${m.expect}`);
    process.exit(1);
  }
}
console.log(`   ok baseline green (${base.cases.size} tests)\n`);

const bad = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  console.log(`   target: ${m.expect}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  // The derived workflow is restored after EVERY mutation: either it is the
  // subject, or the regeneration below rewrote it.
  const derivedSnap =
    m.subject === 'derived' ? null : snapshot(resolve(REPO_ROOT, PROOF.subjects.derived));
  try {
    mutate(snap, m.anchor, m.replacement);
    // A hand edit to the derived file IS the mutation; regenerating would erase it.
    if (derivedSnap) console.log(`   ${regenerate()}`);
    const r = runSpec();
    let verdict;
    if (r.status === 0) {
      verdict = 'DECORATIVE: the spec stayed GREEN with the behaviour removed';
    } else if (r.cases === null) {
      verdict = 'UNATTRIBUTED: red, but no test outcome was reported (the spec failed to load)';
    } else if (r.cases.get(m.expect) !== true) {
      const others = [...r.cases].filter(([, f]) => f).map(([n]) => n);
      verdict = `MISATTRIBUTED: red, but not via its target (failed: ${others.join(' | ') || 'none'})`;
    }
    if (verdict) {
      console.log(`   x ${verdict}`);
      bad.push(`${m.label} — ${verdict}`);
    } else {
      const also = [...r.cases].filter(([n, f]) => f && n !== m.expect).length;
      console.log(`   ok its target went RED${also ? ` (+${also} other test(s))` : ''}`);
    }
    recordMutation();
  } finally {
    restore(snap);
    if (derivedSnap) restore(derivedSnap);
  }
  if (runSpec().status !== 0) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(
  `\n${MUTATIONS.length - bad.length} attributed, ${bad.length} not, of ${MUTATIONS.length}.`,
);
if (bad.length > 0) {
  for (const line of bad) console.error(line);
  process.exit(1);
}
