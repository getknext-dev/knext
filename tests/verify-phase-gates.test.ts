import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The gate validator had NO test and ran in NO job, so two of the four rules its own
 * docblock advertised were unenforced and nothing noticed:
 *
 *   - Rule 3 tested `status === 'DONE'` exactly, but the shipped file's only done-ish
 *     phase is `DONE_WITH_REOPENED_RESIDUAL` — so the check was inert against the very
 *     data it ships with, and nulling a phase-0 measurement still exited 0.
 *   - The comment "current_phase must not have run ahead of the evidence" sat above
 *     code that only checked `current_phase` named a DECLARED phase.
 *
 * A gate that cannot fail is decoration. Each case below MUTATES a copy of the real
 * gate file and requires a non-zero exit, so a rule that stops enforcing turns this
 * red rather than going quietly inert.
 */

const REPO = join(__dirname, '..');
/**
 * The validator under test. `GATE_VALIDATOR` lets the mutation prover point this
 * suite at a MUTANT COPY in a temp directory, so proving the guards never writes to
 * the working tree at all. Round 5 lost a mutation-restore to a command timeout and
 * the residue — a disabled registry audit — was invisible to `git status`, because
 * the file was already legitimately modified. A mutant that is never written to the
 * tree cannot leave residue in it.
 */
const SCRIPT = process.env.GATE_VALIDATOR ?? join(REPO, 'scripts', 'verify-phase-gates.mjs');
const GATE = join(REPO, 'docs', 'adr', 'gates', 'adr-0042-gates.json');

type Phase = {
  phase: string | number;
  status: string;
  status_note?: string;
  done_on?: string;
  gates?: Array<string | number>;
  gates_note?: string;
  blocked_by?: Array<string | number>;
  concurrent_with?: Array<string | number>;
  reversible?: boolean;
  preconditions?: Array<Record<string, unknown>>;
  criteria?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type Gate = {
  current_phase: string | number;
  admissibility?: { conditions?: Array<Record<string, unknown>> };
  phases: Phase[];
  [key: string]: unknown;
};

/**
 * Run the validator against a gate file, returning its exit code AND its stderr.
 *
 * The stderr matters: `expect(code).not.toBe(0)` passes when ANY rule fires, so a
 * fixture built to break rule N can be certified by rule M firing on the same edit
 * — the test then proves nothing about N. Every relational case below asserts the
 * message too.
 */
function runDetail(gate: Gate, args: string[] = []): { code: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gates-'));
  const file = join(dir, 'adr-0042-gates.json');
  writeFileSync(file, JSON.stringify(gate, null, 2));
  try {
    execFileSync('node', [SCRIPT, '--file', file, ...args], { cwd: REPO, stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { code: err.status ?? 1, stderr: String(err.stderr ?? '') };
  }
}

/** Run the validator against a gate file, returning its exit code. */
function runOn(gate: Gate): number {
  return runDetail(gate).code;
}

/**
 * Assert the validator REPORTED a problem, and reported the stated one.
 *
 * Exit 1 exactly, never merely non-zero. The validator exits 3 on an uncaught
 * throw, so a mutation that turns a guard into a crash no longer satisfies a test
 * that was asserting "something went wrong" — the difference between a report and a
 * crash is now visible to any harness that reads only exit codes.
 */
function expectFailure(gate: Gate, because: RegExp, args: string[] = []): void {
  const { code, stderr } = runDetail(gate, args);
  expect(code, `expected exit 1 (a REPORTED problem); stderr was:\n${stderr}`).toBe(1);
  expect(stderr).toMatch(because);
}

/**
 * Declare one registry entry for a single run — the seam rules 6b and 6c need.
 *
 * Those rules live in `auditRegistry`, whose only other input is the committed
 * registry, so without this their failing case cannot be constructed and they had
 * NO test at all: all three halves were deleted independently and the suite stayed
 * green. A guard whose failing case cannot be built is decoration.
 */
const declare = (level: string, key: string, entry: unknown): string[] => [
  '--declare',
  `${level}.${key}=${JSON.stringify(entry)}`,
];

const load = (): Gate => JSON.parse(readFileSync(GATE, 'utf8')) as Gate;
const phase = (g: Gate, id: string): Phase => {
  const p = g.phases.find((x) => String(x.phase) === id);
  if (!p) throw new Error(`fixture has no phase ${id}`);
  return p;
};
const crit = (g: Gate, id: string): Record<string, unknown> => {
  for (const p of g.phases) {
    for (const c of [...(p.preconditions ?? []), ...(p.criteria ?? [])]) {
      if ((c as Record<string, unknown>).id === id) return c as Record<string, unknown>;
    }
  }
  throw new Error(`fixture has no criterion ${id}`);
};

describe('verify-phase-gates enforces the rules its docblock claims', () => {
  it('the shipped gate file passes', () => {
    expect(runOn(load())).toBe(0);
  });

  it('rule 1: a measured value with no source fails', () => {
    const g = load();
    const c = phase(g, '0').criteria?.[0] as Record<string, unknown>;
    c.source = undefined;
    expect(runOn(g)).not.toBe(0);
  });

  it('rule 3: a qualified DONE status with unmet criteria needs a status_note', () => {
    const g = load();
    phase(g, '0').status_note = undefined;
    expect(runOn(g)).not.toBe(0);
  });

  it('rule 3: a qualified DONE status with NOTHING unmet must just say DONE', () => {
    const g = load();
    const p0 = phase(g, '0');
    for (const c of p0.criteria ?? []) c.measured = c.target;
    expect(runOn(g)).not.toBe(0);
  });

  it('rule 3: an exact DONE status with an unmet criterion fails', () => {
    const g = load();
    const p0 = phase(g, '0');
    p0.status = 'DONE';
    p0.status_note = undefined;
    expect(runOn(g)).not.toBe(0);
  });

  it('rule 3b: current_phase naming a phase with unmet preconditions fails', () => {
    const g = load();
    const withPre = g.phases.find((p) => (p.preconditions ?? []).length > 0);
    if (!withPre) throw new Error('fixture has no phase with preconditions');
    for (const c of withPre.preconditions ?? []) {
      c.measured = false;
      c.target = true;
    }
    g.current_phase = withPre.phase;
    expect(runOn(g)).not.toBe(0);
  });

  it('rule 3b: current_phase that is not a declared phase fails', () => {
    const g = load();
    g.current_phase = 'no-such-phase';
    expect(runOn(g)).not.toBe(0);
  });

  it('rule 4: a null target with no target_note fails', () => {
    const g = load();
    // Must be a NON-derived criterion: rule 4 deliberately exempts `kind: 'derived'`,
    // whose value is computed rather than checked against a threshold. Picking a derived
    // one silently asserts nothing — this test failing on exactly that is what caught it.
    const c = g.phases
      .flatMap((p) => p.criteria ?? [])
      .find((x) => (x as Record<string, unknown>).kind !== 'derived') as Record<string, unknown>;
    if (!c) throw new Error('fixture has no non-derived criterion');
    c.target = null;
    c.target_note = undefined;
    c.measured = true;
    c.source = 'test';
    expect(runOn(g)).not.toBe(0);
  });

  it('rule 4 exempts derived criteria, and that exemption is deliberate', () => {
    const g = load();
    const derived = g.phases
      .flatMap((p) => p.criteria ?? [])
      .find((x) => (x as Record<string, unknown>).kind === 'derived') as
      | Record<string, unknown>
      | undefined;
    if (!derived) return; // nothing to assert if the fixture has none
    derived.target = null;
    derived.target_note = undefined;
    expect(runOn(g)).toBe(0);
  });

  it('rule 5: an array target is compared element-wise, not by length', () => {
    const g = load();
    let touched = false;
    for (const p of g.phases) {
      for (const c of [...(p.preconditions ?? []), ...(p.criteria ?? [])]) {
        const rec = c as Record<string, unknown>;
        if (Array.isArray(rec.target)) {
          // same LENGTH, entirely wrong contents
          rec.measured = rec.target.map(() => '__wrong__');
          rec.source = 'test';
          p.status = 'DONE';
          p.status_note = undefined;
          touched = true;
        }
      }
    }
    if (!touched) throw new Error('fixture has no array target');
    expect(runOn(g)).not.toBe(0);
  });
});

/**
 * #753 — the file could state a RELATION that no checker read, so it could contradict
 * ITSELF and stay green. Phase `3d` read `NOT_STARTED` while its own criteria carried
 * measured values, from 2026-08-08 to 2026-08-17; a reader trusted the ADR prose over
 * the file and re-ran a whole measurement phase that was already done.
 *
 * The fix is deliberately a SCAN rather than a rule per case — an enumerated list of
 * cases is how the second one gets missed, and there WAS a second one: phase 2 shipped
 * in the same `NOT_STARTED`-with-a-measured-criterion shape as phase 3d, and no rule
 * proposed in the issue would have named it.
 */
describe('#753 — every relation the gate file can state is read by a checker', () => {
  // --- rule 6: the key registry. A key with no consumer is the generative defect. ---

  it('rule 6: a phase key that no checker reads fails the scan', () => {
    const g = load();
    phase(g, '2').depends_on = [1];
    expectFailure(g, /key `depends_on` is not in the key registry/);
  });

  it('rule 6: a criterion key that no checker reads fails the scan', () => {
    const g = load();
    crit(g, 'P2-1').supersedes_run = 'Run 24';
    expectFailure(g, /key `supersedes_run` is not in the key registry/);
  });

  it('rule 6: a gate-level key that no checker reads fails the scan', () => {
    const g = load();
    g.depends_on_adr = '0036';
    expectFailure(g, /key `depends_on_adr` is not in the key registry/);
  });

  // --- rule 6b: a relation may not be filed as commentary (registry-wide) ---

  it('rule 6b: a relationally-named key declared PROSE fails at startup', () => {
    expectFailure(
      load(),
      /`phase\.gated_by_zzz` is declared PROSE but its name states a relation/,
      declare('phase', 'gated_by_zzz', { prose: 'who cares' }),
    );
  });

  it('rule 6b: it fires on the DECLARATION, with no such key in any gate file', () => {
    const g = load();
    expect(g.phases.some((p) => 'requires_zzz' in p)).toBe(false);
    expectFailure(
      g,
      /`criterion\.requires_zzz` is declared PROSE but its name states a relation/,
      declare('criterion', 'requires_zzz', { prose: 'commentary, honest' }),
    );
  });

  // --- rule 6c: the third door. READ must be BOUND, not merely labelled. ---

  it("rule 6c: read('<label>') on a key nothing consumes fails — the third door", () => {
    // The reviewer's defeat of rule 6, verbatim: a relationally-NAMED key labelled
    // read('8'), carrying a reference that is unresolved, duplicated AND
    // self-referential. Rule 8 never saw it, because `phaseRef` was simply omitted.
    const g = load();
    phase(g, '5').requires_phase = ['99', '99', '5'];
    expectFailure(
      g,
      /`phase\.requires_phase` is declared READ but no rule read it off the gate file/,
      declare('phase', 'requires_phase', { by: '8' }),
    );
  });

  it('rule 6c: binding is RECORDED CONSUMPTION — the validator’s own locals do not count', () => {
    // Round 2 defeated the previous textual binding with fifteen names that appear
    // as a property access somewhere in this file with nothing reading them off the
    // gate file: `phase[relation]` / `phase[note]` are rule 8c's LOCAL VARIABLES
    // holding 'gates' and 'gates_note', and `entry.inverse` / `entry.by` are reads
    // on REGISTRY entries. `relation` and `inverse` are also the names an author
    // would actually reach for, and neither trips RELATIONAL_NAME.
    for (const name of ['relation', 'inverse', 'note', 'by', 'entry', 'key', 'level', 'pair']) {
      const g = load();
      (phase(g, '3') as Record<string, unknown>)[name] = ['5'];
      expectFailure(
        g,
        new RegExp(`\`phase\\.${name}\` is declared READ but no rule read it off the gate file`),
        declare('phase', name, { by: '8' }),
      );
    }
  });

  it('rule 6c: and once the same key is BOUND, its defects are all caught', () => {
    const g = load();
    phase(g, '5').requires_phase = ['99', '99', '5'];
    const bound = declare('phase', 'requires_phase', {
      by: '8/13',
      phaseRef: 'ordered',
      inverse: 'requires_phase',
    });
    const { code, stderr } = runDetail(g, bound);
    expect(code, stderr).not.toBe(0);
    expect(stderr).toMatch(/requires_phase\[0\] `99` is not a declared phase/);
    expect(stderr).toMatch(/requires_phase\[1\] `99` is listed twice/);
    expect(stderr).toMatch(/requires_phase\[2\] refers to itself/);
    expect(stderr).not.toMatch(/nothing in this validator reads it/);
  });

  it('rule 6c: a READ naming a rule id that does not exist fails', () => {
    // `evidence: read('12')` shipped in this very PR against a rule 12 that never
    // existed, and passed authorship and review because nothing checked the label.
    // The id here is `42` rather than `12` for a reason worth stating: closing this
    // required NUMBERING the checks, and rule 12 now exists — so the original
    // defect's literal is no longer a defect, and reusing it would test nothing.
    // `criterion.source` is a key that IS bound, so the binding half cannot be
    // what fires and the rule-id half is proved alone.
    expectFailure(
      load(),
      /`criterion\.source` is declared READ by rule `42`, which is not a rule this validator implements/,
      declare('criterion', 'source', { by: '42' }),
    );
  });

  it('rule 6c: a phaseRef key with no valid ordering fails', () => {
    expectFailure(
      load(),
      /`phase\.gates` declares `phaseRef: true` — it must be ordered or unordered/,
      declare('phase', 'gates', { by: '8/13', phaseRef: true, inverse: 'blocked_by' }),
    );
  });

  it('rule 6c: binding is scoped to the LEVEL — a key read on criteria does not bind it on phases', () => {
    // `target` is read off every criterion and off no phase. A flat set of property
    // names would call `phase.target` bound; the tracker records `<level>.<key>`.
    const g = load();
    (phase(g, '3') as Record<string, unknown>).target = true;
    expectFailure(
      g,
      /`phase\.target` is declared READ but no rule read it off the gate file/,
      declare('phase', 'target', { by: '5' }),
    );
  });

  it('rule 6c: the SCAN does not bind — reading a key to check it is declared is not consuming it', () => {
    // `phase.relation` is PRESENT in the data here, so rule 6's scan reads it. If
    // the scan ran on tracked data, that read alone would bind every key in the
    // registry the moment it appeared in any gate file — the exact coincidence
    // recorded consumption exists to stop being a binding.
    const g = load();
    (phase(g, '3') as Record<string, unknown>).relation = ['5'];
    expectFailure(
      g,
      /`phase\.relation` is declared READ but no rule read it off the gate file/,
      declare('phase', 'relation', { by: '8' }),
    );
  });

  it('rule 6c: an inverse naming a key that does not exist at all fails', () => {
    // Distinct from "does not point home": there `inverse` resolves and disagrees,
    // here it resolves to nothing. Without the `!inverse` half the next line reads
    // a property off undefined.
    expectFailure(
      load(),
      /`phase\.gates` declares `inverse: "no_such_key"`/,
      declare('phase', 'gates', { by: '8/13', phaseRef: 'ordered', inverse: 'no_such_key' }),
    );
  });

  it('rule 1b: an EMPTY derived_from is no provenance at all', () => {
    const g = load();
    const c = crit(g, 'P2-1');
    c.kind = 'derived';
    c.measured = 4.5;
    c.source = undefined;
    c.derived_from = [];
    expectFailure(g, /with a measured value and no `derived_from`/);
  });

  it('rule 6c: a malformed --declare spec is refused rather than silently ignored', () => {
    let code = 0;
    let stderr = '';
    const dir = mkdtempSync(join(tmpdir(), 'gates-bad-'));
    const file = join(dir, 'adr-0042-gates.json');
    writeFileSync(file, JSON.stringify(load(), null, 2));
    try {
      execFileSync('node', [SCRIPT, '--file', file, '--declare', 'not-a-spec'], {
        cwd: REPO,
        stdio: 'pipe',
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      code = err.status ?? 1;
      stderr = String(err.stderr ?? '');
    }
    expect(code).toBe(2);
    expect(stderr).toMatch(/expects <level>\.<key>=<json>/);
  });

  it('rule 6c: an inverse that does not point home fails', () => {
    expectFailure(
      load(),
      /`phase\.gates` declares `inverse: "concurrent_with"`, which is not a phaseRef key at this level declaring `gates` back/,
      declare('phase', 'gates', { by: '8/13', phaseRef: 'ordered', inverse: 'concurrent_with' }),
    );
  });

  it('rule 6c: the --declare seam is refused against the REAL gate files', () => {
    // Both ways in. The refusal used to be scoped to the ABSENCE of `--file`, so
    // naming the real path reached it anyway — the docblock claimed the seam could
    // "never loosen rule 6 for the file it exists to protect", and that was false.
    const refuse = (args: string[]): { code: number; stderr: string } => {
      try {
        execFileSync('node', [SCRIPT, ...args], { cwd: REPO, stdio: 'pipe' });
        return { code: 0, stderr: '' };
      } catch (e) {
        const err = e as { status?: number; stderr?: Buffer };
        return { code: err.status ?? 1, stderr: String(err.stderr ?? '') };
      }
    };

    for (const args of [
      ['--declare', 'phase.anything={"prose":"x"}'], // directory mode
      ['--file', GATE, '--declare', 'phase.anything={"prose":"x"}'], // named explicitly
      ['--declare', 'phase.anything={"prose":"x"}', '--file', GATE], // seam before --file
      ['--declare-pattern', 'phase.^zz_(.+)$={"prose":"x"}'],
    ]) {
      const { code, stderr } = refuse(args);
      expect(code, `expected refusal for ${args.join(' ')}; stderr:\n${stderr}`).toBe(2);
      expect(stderr).toMatch(/is a test seam and may not be used against a real gate file/);
    }

    // ...and a SYMLINK is the real file too. The refusal was a path-string compare,
    // so pointing `--file` at a link reached the shipped gate file with a loosened
    // registry, while the sentence claiming refusal was stated absolutely.
    const linkDir = mkdtempSync(join(tmpdir(), 'gates-link-'));
    const link = join(linkDir, 'adr-0042-gates.json');
    symlinkSync(GATE, link);
    const viaLink = refuse(['--file', link, '--declare', 'phase.unblocks_phase={"prose":"x"}']);
    expect(viaLink.code, `expected refusal via symlink; stderr:\n${viaLink.stderr}`).toBe(2);
  });

  // --- rule 6b/6c: the key PATTERNS half of the registry audit ---

  it('rule 6b: a key PATTERN declared PROSE with a relational name fails', () => {
    // Round 2: this half was LIVE code with no constructible failing case, because
    // `--declare` writes only KEY_REGISTRY. Deleting the loop that feeds it left
    // the suite green — decoration by this repo's own standard, one half over.
    expectFailure(load(), /`phase\.\^gated_zz_\(\.\+\)\$` is declared PROSE/, [
      '--declare-pattern',
      'phase.^gated_zz_(.+)$={"prose":"who cares"}',
    ]);
  });

  it('rule 6c: a key PATTERN whose phaseClaim names a relation that is not a phaseRef key fails', () => {
    expectFailure(load(), /declares `phaseClaim\.relation: "nope"`, which is not a phaseRef key/, [
      '--declare-pattern',
      'phase.^why_zz_phase_(.+)$={"by":"8c","phaseClaim":{"relation":"nope","note":"nope_note"}}',
    ]);
  });

  it('rule 6c: a key PATTERN whose phaseClaim names an undeclared note field fails', () => {
    expectFailure(load(), /declares `phaseClaim\.note: "nope_note"`, which is not a declared key/, [
      '--declare-pattern',
      'phase.^why_zz_phase_(.+)$={"by":"8c","phaseClaim":{"relation":"gates","note":"nope_note"}}',
    ]);
  });

  // --- rule 6e: PROSE decided by VALUE SHAPE, not by a ten-word vocabulary ---

  it('rule 6e: a PROSE key whose value resolves to phase ids fails, whatever it is named', () => {
    // Thirteen synonyms walked straight through RELATIONAL_NAME in round 2.
    // `unblocks` is not exotic: the shipped file uses UNBLOCKED_3d_DISCHARGED as a
    // status, and `(^|_)blocked` cannot match the `blocked` inside `unblocked`.
    for (const name of [
      'unblocks',
      'unblocks_phase',
      'follows_phase',
      'precedes_phase',
      'waits_for_phase',
      'prerequisite_phase',
      'needs_phase',
      'enabled_by_phase',
      'downstream_of_phase',
      'must_complete_before_phase',
      'invalidated_by_phase',
      'triggers_phase',
      'parent_phase',
    ]) {
      const g = load();
      (phase(g, '3') as Record<string, unknown>)[name] = ['5'];
      expectFailure(
        g,
        new RegExp(
          `key \`${name}\` is declared PROSE but its value resolves to declared phase ids`,
        ),
        declare('phase', name, { prose: 'just commentary' }),
      );
    }
  });

  it('rule 6e: it reaches nested values too, where 6d’s vocabulary does not', () => {
    const g = load();
    (crit(g, 'P3d-1').evidence as Record<string, unknown>).unblocks_phase = '5';
    expectFailure(g, /nested key `unblocks_phase` has a value that resolves to declared phase ids/);
  });

  it('rule 6e: a phase-keyed map is caught as the DIRECT value of a PROSE key, not only nested', () => {
    // Round 6: `statesPhaseKeyMap` was called from exactly one place — `scanNested`
    // — so the map was caught one level down and not at the top. Depth 2 had a test;
    // depth 1 had never been constructed.
    const direct = load();
    (crit(direct, 'P1-1') as Record<string, unknown>).attempt = {
      5: 'must finish before this one',
      3: 'and after',
    };
    expectFailure(direct, /key `attempt` is declared PROSE but its keys resolve/);

    // ...and at the phase level too, where `arms` is the PROSE key.
    const onPhase = load();
    (phase(onPhase, '3') as Record<string, unknown>).arms = { 5: 'before', 2: 'after' };
    expectFailure(onPhase, /key `arms` is declared PROSE but its keys resolve/);
  });

  it('rule 6e: ONE ARRAY BRACKET does not blind it — array ELEMENTS are shape-tested', () => {
    // `scanNested` recursed THROUGH array elements but only ever asked the shape
    // question of the value of an OBJECT key, so an element that was itself a list
    // or a map was recursed into and never tested. Live code with no test: deleting
    // the array recursion outright left the suite green.
    const cases: Array<[string, unknown, RegExp]> = [
      ['a list inside a list', [['5', '3']], /resolves to declared phase ids/],
      [
        'a list inside an object inside a list',
        { must_run_after: [['5']] },
        /resolves to declared/,
      ],
      [
        'a phase-keyed map inside a list',
        [{ 5: 'this phase must finish first' }],
        /keys that resolve/,
      ],
    ];
    for (const [what, value, because] of cases) {
      const g = load();
      (crit(g, 'P1-1') as Record<string, unknown>).attempt = value;
      const { code, stderr } = runDetail(g);
      expect(code, `${what} should fail; stderr:\n${stderr}`).not.toBe(0);
      expect(stderr, what).toMatch(because);
    }
  });

  it('rule 1b: CIRCULAR derived provenance fails at every cycle length, not just self-reference', () => {
    // Round 5 closed `derived_from: ['P2-1']` on P2-1 — path length 1. Two measured
    // derived criteria each derived from the other are the same defect one hop out:
    // rule 1b's own message, "a value whose provenance is itself has none", at
    // length 2. Phase 3 is PARTIAL, so the fixture is not confounded by rule 7a.
    const build = (edges: Record<string, string[]>): Gate => {
      const g = load();
      for (const [id, from] of Object.entries(edges)) {
        const c = crit(g, id);
        c.kind = 'derived';
        c.measured = 4.5;
        c.source = undefined;
        c.derived_from = from;
      }
      return g;
    };
    expectFailure(build({ 'P3-1': ['P3-2'], 'P3-2': ['P3-1'] }), /circular/i);
    expectFailure(build({ 'P3-1': ['P3-2'], 'P3-2': ['P3-4'], 'P3-4': ['P3-1'] }), /circular/i);
    // control: an acyclic derivation still passes
    const ok = runDetail(build({ 'P3-1': ['P3-3'] }));
    expect(ok.code, ok.stderr).toBe(0);
  });

  it('rule 6e: a relation keyed BY phase id is caught — the closed world covers nested KEYS too', () => {
    // Round 4: 6e inspected values only, so a map from phase id to prose sailed
    // through — `attempt` is PROSE, `ordering` is not a relational name, and the
    // references are the object's KEYS.
    const g = load();
    (crit(g, 'P1-1') as Record<string, unknown>).attempt = {
      ordering: { '5': 'must finish before this one', '3': 'and after' },
    };
    expectFailure(g, /nested key `ordering` has keys that resolve to declared phase ids/);
  });

  it('rule 6e: a NUMERIC reference list is caught — ids are compared as strings everywhere else', () => {
    const g = load();
    g.phases.push({ phase: 93, name: 'label 93', status: 'NOT_STARTED' } as unknown as Phase);
    (phase(g, '3') as Record<string, unknown>).unblocks_phase = [93];
    expectFailure(
      g,
      /key `unblocks_phase` is declared PROSE but its value resolves to declared phase ids/,
      declare('phase', 'unblocks_phase', { prose: 'commentary' }),
    );
  });

  it('rule 6b: EVERY identifier run in a pattern is tested, not only the longest', () => {
    // Naming a pattern by its longest run let a decorative suffix hide the relation:
    // `RELATIONAL_NAME` never saw `gates`, while the pattern matched keys like
    // `gates_5_supplementary_annotation_text`.
    expectFailure(load(), /is declared PROSE but its name states a relation/, [
      '--declare-pattern',
      'phase.^gates_(.+)_supplementary_annotation_text$={"prose":"commentary"}',
    ]);
  });

  it('rule 6c: the seam is refused for a HARD LINK — identity is the inode, not the path', () => {
    // `realpathSync` resolves a SYMLINK, which is a second path to the file. A hard
    // link is not a path at all — it is the same inode under another name — so the
    // absolute claim was still one indirection too wide.
    const dir = mkdtempSync(join(tmpdir(), 'gates-hard-'));
    const hard = join(dir, 'adr-0042-gates.json');
    linkSync(GATE, hard);
    expect(statSync(hard).ino).toBe(statSync(GATE).ino);
    let code = 0;
    try {
      execFileSync('node', [SCRIPT, '--file', hard, '--declare', 'gate.title={"by":"99"}'], {
        cwd: REPO,
        stdio: 'pipe',
      });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
    }
    expect(code).toBe(2);
  });

  it('rule 6e: a bare number IS a reference at the phase level, where no measurement lives', () => {
    // The exemption is forced by measurements, and measurements live on criteria.
    const g = load();
    (phase(g, '3') as Record<string, unknown>).follows_phase = 5;
    expectFailure(
      g,
      /key `follows_phase` is declared PROSE but its value resolves to declared phase ids/,
      declare('phase', 'follows_phase', { prose: 'commentary' }),
    );
  });

  it('rule 6e: a bare NUMBER is a measurement, not a reference — the file is full of them', () => {
    // `samples_lost: 1` and `server_modules_read_from_disk_on_cold_first_request: 0`
    // both stringify to declared phase ids. Treating a scalar number as a reference
    // would red the shipped file; only a LIST is read as a reference list.
    const g = load();
    (crit(g, 'P3d-1').evidence as Record<string, unknown>).some_count = 1;
    const { code, stderr } = runDetail(g);
    expect(code, stderr).toBe(0);
  });

  it('rule 6e: a phase whose `name` equals its OWN id is not a cross-phase relation', () => {
    const g = load();
    g.phases.push({ phase: 'wb', name: 'wb', status: 'NOT_STARTED' } as Phase);
    const { code, stderr } = runDetail(g);
    expect(code, stderr).toBe(0);
  });

  it('rule 6e: but a scalar naming ANOTHER phase still fails', () => {
    const g = load();
    g.phases.push({ phase: 'wb', name: '5', status: 'NOT_STARTED' } as Phase);
    expectFailure(g, /key `name` is declared PROSE but its value resolves to declared phase ids/);
  });

  it('rule 6e: an EMPTY array is not a reference — `gates: []` is a discharged gate', () => {
    // "All zero elements resolve" is vacuous, and failing it would red the shape a
    // discharged gate is required to take. Phase 3d ships `gates: []` today.
    const g = load();
    (phase(g, '3') as Record<string, unknown>).parent_phase = [];
    const { code, stderr } = runDetail(
      g,
      declare('phase', 'parent_phase', { prose: 'commentary' }),
    );
    expect(code, stderr).toBe(0);
  });

  // --- rule 6d: a relational name hiding one level down ---

  it('rule 6d: a relational key nested inside a declared key fails', () => {
    const g = load();
    (crit(g, 'P3d-1').evidence as Record<string, unknown>).blocked_by_phase = '99';
    expectFailure(g, /nested key `blocked_by_phase` has a relational name/);
  });

  it('rule 6d: it reaches arbitrarily deep, not just one level', () => {
    const g = load();
    const ev = crit(g, 'P3d-1').evidence as Record<string, Record<string, unknown>>;
    ev.deployed_digest_check_2026_08_17.gates_the_flip = true;
    expectFailure(g, /nested key `gates_the_flip` has a relational name/);
  });

  // --- rule 7: the status vocabulary, and what each class implies about measurement ---

  it('rule 7: a status outside the declared vocabulary fails', () => {
    const g = load();
    phase(g, '2').status = 'NOT_STARTD'; // one keystroke; silently disabled every status rule
    expectFailure(g, /status `NOT_STARTD` matches no declared status class/);
  });

  it('rule 7a: NOT_STARTED while its own criteria are measured fails — the phase-3d state', () => {
    const g = load();
    const p = phase(g, '3d');
    p.status = 'NOT_STARTED';
    p.status_note = undefined;
    expectFailure(g, /status NOT_STARTED but \d+ criteri\S+ already measured/);
  });

  it('rule 7a: a qualified NOT_STARTED with nothing measured is just NOT_STARTED', () => {
    const g = load();
    const p = phase(g, '5');
    p.status = 'NOT_STARTED_WITH_A_QUALIFIER';
    p.status_note = 'a qualifier the evidence does not support';
    expectFailure(g, /but no criterion is measured — use NOT_STARTED/);
  });

  it('rule 7a: a qualified NOT_STARTED must carry a status_note', () => {
    const g = load();
    phase(g, '2').status_note = undefined;
    expectFailure(g, /has no status_note/);
  });

  it('rule 7: PARTIAL with nothing measured is NOT_STARTED', () => {
    const g = load();
    phase(g, '5').status = 'PARTIAL';
    expectFailure(g, /status PARTIAL but no criterion is measured/);
  });

  it('rule 7: PARTIAL with every criterion met is DONE', () => {
    const g = load();
    for (const c of phase(g, '3').criteria ?? []) {
      c.measured = c.target;
      c.source = 'test';
    }
    expectFailure(g, /status PARTIAL but every criterion is met/);
  });

  it('rule 7: a BLOCKED phase that no phase gates fails — blocked by what?', () => {
    const g = load();
    phase(g, '5').status = 'BLOCKED_ON_SOMETHING';
    expectFailure(g, /status BLOCKED_ON_SOMETHING but no phase declares it in `gates`/);
  });

  it('rule 7: an UNBLOCKED phase must say what discharged the gate', () => {
    const g = load();
    phase(g, '1').status_note = undefined;
    expectFailure(g, /asserts a gate was discharged and has no status_note saying by what/);
  });

  // --- rule 8: the gating relation itself (#753 instance 2) ---

  it('rule 8: an UNBLOCKED phase still named in another phase gates fails', () => {
    const g = load();
    phase(g, '2').gates = [1]; // phase 1 reads UNBLOCKED_3d_DISCHARGED
    expectFailure(g, /status UNBLOCKED_3d_DISCHARGED but phase 2 still declares it in `gates`/);
  });

  it('rule 7: a NOT_STARTED phase IS a blockable state — gating one is fine', () => {
    // `blockable: true` on the NOT_STARTED row. Every other fixture that gates a
    // phase gates a BLOCKED one, so flipping this flag reported nothing new and
    // nothing stopped reporting — it was a declaration nobody exercised.
    const g = load();
    g.phases.push(
      { phase: 'na', name: 'label na', status: 'NOT_STARTED', gates: ['nb'] },
      { phase: 'nb', name: 'label nb', status: 'NOT_STARTED' },
    );
    const { code, stderr } = runDetail(g);
    expect(code, stderr).toBe(0);
  });

  it('rule 7: an UNBLOCKED phase is NOT a blockable state — gating one says so', () => {
    // `blockable: false` on the UNBLOCKED row, asserted through the gater's own
    // message rather than through `checkUnblocked`, which reports the same file for
    // a different reason.
    const g = load();
    phase(g, '2').gates = [1];
    expectFailure(g, /gates phase 1, whose status UNBLOCKED\S* is not a blocked state/);
  });

  it('rule 8: a DONE phase may not still declare gates', () => {
    const g = load();
    phase(g, '3d').gates = [5];
    expectFailure(g, /phase 3d: status DONE\S* but still declares `gates`/);
  });

  it('rule 8: gates naming a phase that is not in a blocked state fails', () => {
    const g = load();
    phase(g, '5').gates = [3]; // phase 3 is PARTIAL — it has already advanced
    expectFailure(g, /gates phase 3, whose status PARTIAL is not a blocked state/);
  });

  it('rule 8: a gated phase that has already measured fails', () => {
    const g = load();
    phase(g, '5').gates = [2]; // phase 2 is blocked-state, but P2-4 is measured
    expectFailure(g, /is gated by phase 5 but has already measured/);
  });

  it('rule 8: gates naming an undeclared phase fails', () => {
    const g = load();
    phase(g, '5').gates = ['99'];
    expectFailure(g, /gates\[0\] `99` is not a declared phase/);
  });

  it('rule 8: a self-referencing gates entry fails', () => {
    const g = load();
    phase(g, '5').gates = [5];
    expectFailure(g, /gates\[0\] refers to itself/);
  });

  it('rule 8: concurrent_with naming an undeclared phase fails', () => {
    const g = load();
    phase(g, '2').concurrent_with = [1, 'ghost'];
    expectFailure(g, /concurrent_with\[1\] `ghost` is not a declared phase/);
  });

  it('rule 8: blocked_by with no matching gates on the other side fails', () => {
    const g = load();
    phase(g, '5').blocked_by = [3];
    expectFailure(g, /blocked_by \[3\] but phase 3 does not declare `gates` \[5\]/);
  });

  it('rule 8b: a gates_note with no gates field fails', () => {
    const g = load();
    phase(g, '2').gates_note = 'discharged, allegedly';
    expectFailure(g, /`gates_note` but no `gates` field/);
  });

  it('rule 8c: why_it_gated_phase_N naming an undeclared phase fails', () => {
    const g = load();
    const p = phase(g, '3d');
    p.why_it_gated_phase_9 = p.why_it_gated_phase_1;
    p.why_it_gated_phase_1 = undefined;
    expectFailure(g, /why_it_gated_phase_9 names phase 9, which is not declared/);
  });

  it('rule 8: concurrent_with stated on one side only fails', () => {
    // Corroboration is table-driven: `concurrent_with` declares itself its own
    // inverse, so it inherits the same "stated once, denied on the other side"
    // check `blocked_by` gets, without a branch written for it.
    const g = load();
    phase(g, '1').concurrent_with = undefined;
    expectFailure(g, /concurrent_with \[1\] but phase 1 does not declare `concurrent_with` \[2\]/);
  });

  it('rule 8c: a discharged gate claim with no gates_note fails', () => {
    const g = load();
    phase(g, '3d').gates_note = undefined;
    expectFailure(g, /no longer lists it and there is no `gates_note` recording the discharge/);
  });

  it('rule 8c: a gates_note about SOME OTHER phase does not discharge the claim', () => {
    // The discharge check used to be `!gates.includes(target) && !phase.gates_note`,
    // so ANY note discharged ANY claim — the prose outliving the relation, which is
    // the exact defect 8c was written to close, one level up.
    const g = load();
    phase(g, '3d').why_it_gated_phase_5 = 'it did, allegedly';
    expectFailure(g, /`gates_note` does not name phase 5 — a note about some other phase/);
  });

  // --- rule 13: an ordered and an unordered relation over the same pair ---

  it('rule 13: gates and concurrent_with may not name the same phase', () => {
    const g = load();
    phase(g, '3').gates = ['5'];
    phase(g, '3').concurrent_with = ['5'];
    phase(g, '5').concurrent_with = ['3'];
    // The direct pair is now the shortest case of the reachability walk, not a
    // separate branch — same defect, one rule instead of two.
    expectFailure(g, /are declared concurrent by .*while the ordered relation makes/);
  });

  it('rule 13: the ordered relation must be ACYCLIC at EVERY cycle length', () => {
    // Round 2's defeat: the check compared PAIRS, so length 2 failed and 3, 4 and 5
    // all exited 0 — an ordering no phase on the cycle can ever satisfy. By this
    // file's own argument, an enumerated list of cases is how the second one gets
    // missed, and cycle length was the enumeration.
    const blocked = (id: string, gates: string[]): Phase => ({
      phase: id,
      name: `s${id}`,
      status: 'BLOCKED',
      gates,
    });
    for (const n of [2, 3, 4, 5, 8]) {
      const g = load();
      const ids = Array.from({ length: n }, (_, i) => `x${i}`);
      ids.forEach((id, i) => {
        g.phases.push(blocked(id, [ids[(i + 1) % n]]));
      });
      expectFailure(g, /the ordered relation contains a cycle/);
    }
  });

  it('rule 13: a TRANSITIVE ordered chain contradicting a declared concurrency fails', () => {
    // Round 4's defeat: the ordered-vs-unordered half was still a PAIR lookup, so a
    // direct `gates`+`concurrent_with` on the same pair failed while `ta → tb → tc`
    // with `ta concurrent_with tc` exited 0. Cycle length was round 2's enumeration;
    // PATH length was this one. The graph was built and then consulted for only one
    // of the two questions it can answer.
    const P = (id: string, extra: Partial<Phase> = {}): Phase => ({
      phase: id,
      name: `label ${id}`,
      status: 'NOT_STARTED',
      ...extra,
    });
    for (const hops of [1, 2, 3]) {
      const g = load();
      const ids = ['t0', ...Array.from({ length: hops }, (_, i) => `t${i + 1}`)];
      ids.forEach((id, i) => {
        g.phases.push(
          P(id, i < ids.length - 1 ? { gates: [ids[i + 1]] } : { concurrent_with: [ids[0]] }),
        );
      });
      // head is concurrent with the tail it transitively precedes
      (phase(g, 't0') as Phase).concurrent_with = [ids[ids.length - 1]];
      expectFailure(g, /while the ordered relation makes/);
    }
  });

  it('rule 13: concurrency between phases the ordered relation does NOT connect is fine', () => {
    // The control for the case above: reachability, not "any concurrency near a gate".
    const g = load();
    g.phases.push(
      { phase: 'ua', name: 'label ua', status: 'NOT_STARTED', gates: ['ub'] },
      { phase: 'ub', name: 'label ub', status: 'BLOCKED_ON_UA' },
      { phase: 'uc', name: 'label uc', status: 'NOT_STARTED', concurrent_with: ['ud'] },
      { phase: 'ud', name: 'label ud', status: 'NOT_STARTED', concurrent_with: ['uc'] },
    );
    const { code, stderr } = runDetail(g);
    expect(code, stderr).toBe(0);
  });

  it('rule 13: a cycle closed through `blocked_by` — the INVERSE sense — also fails', () => {
    // The edge's direction comes from the registry's `edge: forward|reverse`, so a
    // cycle that mixes the two senses is the same walk, not a second case.
    const g = load();
    g.phases.push(
      { phase: 'xa', name: 'sxa', status: 'BLOCKED', gates: ['xb'], blocked_by: ['xc'] },
      { phase: 'xb', name: 'sxb', status: 'BLOCKED', gates: ['xc'] },
      { phase: 'xc', name: 'sxc', status: 'BLOCKED', gates: ['xa'] },
    );
    expectFailure(g, /the ordered relation contains a cycle/);
  });

  it('rule 13: an acyclic ordered chain is fine — the walk is not just "any gates edge"', () => {
    const g = load();
    // `xa` is NOT_STARTED rather than BLOCKED because rule 7 requires a BLOCKED
    // phase to have a gater, and nothing gates the head of the chain.
    g.phases.push(
      { phase: 'xa', name: 'sxa', status: 'NOT_STARTED', gates: ['xb'] },
      { phase: 'xb', name: 'sxb', status: 'BLOCKED_ON_XA', gates: ['xc'] },
      { phase: 'xc', name: 'sxc', status: 'BLOCKED_ON_XB' },
    );
    const { code, stderr } = runDetail(g);
    expect(code, stderr).toBe(0);
  });

  // --- rule 12: the phase in flight may not be one the file says is blocked ---

  it('rule 12: current_phase naming a gated phase fails', () => {
    const g = load();
    phase(g, '3').gates = ['5'];
    g.current_phase = '5';
    expectFailure(g, /current_phase 5 is still gated by phase 3/);
  });

  // --- rule 9: the remaining self-contradictions ---

  it('rule 9a: a done_on date on a phase that is not DONE fails', () => {
    const g = load();
    phase(g, '2').done_on = '2026-08-20';
    expectFailure(g, /carries `done_on` 2026-08-20 but its status is/);
  });

  it('rule 9a: the OTHER half — a strict DONE with no done_on fails', () => {
    // Guards in this repo have a record of asserting one half; 9a asserted only
    // that a non-DONE phase carries no date. A qualified DONE_* stays exempt on
    // purpose: it has not completed, so there is no date to give.
    const g = load();
    const p = phase(g, '0');
    for (const c of p.criteria ?? []) c.measured = c.target;
    p.status = 'DONE';
    p.status_note = undefined;
    p.done_on = undefined;
    expectFailure(g, /status DONE with no `done_on`/);
  });

  it('rule 9a: a QUALIFIED done with no done_on is deliberately allowed', () => {
    const g = load();
    phase(g, '0').done_on = undefined;
    expect(runOn(g)).toBe(0);
  });

  // --- preconditions are inside the status rules, not one field over ---

  it('rules 3/7a: a PRECONDITION counts, so the rules are not restatable one field over', () => {
    // The status rules read `phase.criteria` alone, which made a strictly DONE
    // phase whose only PRECONDITION was unmet exit 0 — the file saying the phase
    // completed and that its own entry condition failed.
    const done = load();
    const p1 = phase(done, '1');
    p1.status = 'DONE';
    p1.status_note = undefined;
    p1.done_on = '2026-08-20';
    for (const c of p1.criteria ?? []) c.measured = c.target;
    expectFailure(done, /status DONE but \d+ criterion\/criteria not met: P1-pre-2/);

    // ...and the phase-3d shape, one field over.
    const notStarted = load();
    phase(notStarted, '5').preconditions = [
      { id: 'X-pre', text: 't', kind: 'boolean', target: true, measured: true, source: 'test' },
    ];
    expectFailure(notStarted, /status NOT_STARTED but \d+ criteria\/criterion already measured/);
  });

  // --- rule 1b: `derived` is an exemption, not a free pass ---

  it('rule 8: a gated phase that has already measured a PRECONDITION fails', () => {
    // Round 3 claimed N-a "closed"; two of its three cases were. This one reads
    // `target.criteria` and so missed the same measurement one field over — the
    // #753 defect class itself, a phase advancing while the file says it is blocked.
    // A report that says "closed" is what stops the next reader from checking.
    const g = load();
    g.phases.push(
      { phase: 'wa', name: 'label wa', status: 'NOT_STARTED', gates: ['wb'] },
      {
        phase: 'wb',
        name: 'label wb',
        status: 'NOT_STARTED_WITH_BASELINE',
        status_note: 'a baseline precondition was measured',
        preconditions: [
          { id: 'WB-pre', text: 't', kind: 'value', measured: 4, target: 4, source: 'repo:x' },
        ],
      },
    );
    expectFailure(g, /phase wb: is gated by phase wa but has already measured WB-pre/);
  });

  it('rule 1b: derived_from may not name the criterion ITSELF (the cycle walk, length 1)', () => {
    // Circular provenance: a measured number whose entire provenance is itself —
    // the "number with no provenance" rule 1 forbids, wearing rule 1b's label. This
    // is now reported by the SAME walk that catches length 2 and beyond, so there is
    // one reporter rather than a special case that could never be the sole one.
    const g = load();
    const c = crit(g, 'P2-1');
    c.kind = 'derived';
    c.measured = 4.5;
    c.source = undefined;
    c.derived_from = ['P2-1'];
    expectFailure(g, /circular/i);
  });

  it('rule 1b: derived_from may not name an UNMEASURED criterion', () => {
    const g = load();
    const c = crit(g, 'P2-1');
    c.kind = 'derived';
    c.measured = 4.5;
    c.source = undefined;
    c.derived_from = ['P5-1']; // derived from something nobody has run
    expectFailure(g, /`derived_from` names `P5-1`, which is not measured/);
  });

  it('rule 1b: derived_from may not list the same source twice', () => {
    const g = load();
    const c = crit(g, 'P2-1');
    c.kind = 'derived';
    c.measured = 4.5;
    c.source = undefined;
    c.derived_from = ['P0-1', 'P0-1'];
    expectFailure(g, /`derived_from` lists `P0-1` twice/);
  });

  it('rule 1b: a well-formed derived_from passes — the rule is not "derived always fails"', () => {
    const g = load();
    const c = crit(g, 'P2-1');
    c.kind = 'derived';
    c.measured = 4.5;
    c.source = undefined;
    c.derived_from = ['P0-1', 'P0-3'];
    const { code, stderr } = runDetail(g);
    expect(code, stderr).toBe(0);
  });

  it('rule 1b: kind "derived" with a measured value and no derived_from fails', () => {
    // `derived` exempts a criterion from rule 1's source requirement, so relabelling
    // one was a one-keystroke escape from the file's HEADLINE rule: a measured value
    // with no provenance, exit 0.
    const g = load();
    const c = crit(g, 'P2-1');
    c.kind = 'derived';
    c.measured = 4.5;
    c.source = undefined;
    expectFailure(g, /`kind: "derived"` with a measured value and no `derived_from`/);
  });

  it('rule 1b: derived_from must name declared criterion ids', () => {
    const g = load();
    const c = crit(g, 'P2-1');
    c.kind = 'derived';
    c.measured = 4.5;
    c.source = undefined;
    c.derived_from = ['P9-9'];
    expectFailure(g, /`derived_from` names `P9-9`, which is not a declared criterion id/);
  });

  it('rule 1b: an UNMEASURED derived criterion stays exempt — P5-1 ships that way', () => {
    const g = load();
    expect(crit(g, 'P5-1').kind).toBe('derived');
    expect(crit(g, 'P5-1').measured).toBe(null);
    expect(runOn(g)).toBe(0);
  });

  it('rule 9b: evidence on an unmeasured criterion fails', () => {
    const g = load();
    crit(g, 'P2-1').evidence = { method: 'none, that is the point' };
    expectFailure(g, /carries `evidence` but is unmeasured/);
  });

  it('rule 6c: `reversible` stays bound on a file with NO open ship blockers', () => {
    // The guard is the UNCONDITIONAL read of `p.reversible`. Behind the
    // `openShipBlockers.length > 0` test it was never reached on a file with none,
    // so `phase.reversible` would be reported as a READ nothing consumes — the
    // binding would be a property of the fixture rather than of the code. That guard
    // shipped with no test, which is the same decoration charge round 3 laid against
    // the KEY_PATTERNS half, one guard over.
    const g = load();
    for (const p of g.phases) {
      for (const c of [...(p.preconditions ?? []), ...(p.criteria ?? [])]) {
        (c as Record<string, unknown>).blocks_ship = undefined;
      }
    }
    const { code, stderr } = runDetail(g);
    expect(code, stderr).toBe(0);
  });

  it('rule 13: a corroborated `blocked_by` contributes NO second edge', () => {
    // `blocked_by` is required to be mirrored by `gates`, and that `gates` entry
    // already states the same edge. If the corroborated side contributed one too it
    // would point the other way and every valid pair would read as a 2-cycle.
    const g = load();
    g.phases.push(
      { phase: 'va', name: 'label va', status: 'NOT_STARTED', gates: ['vb'] },
      { phase: 'vb', name: 'label vb', status: 'BLOCKED_ON_VA', blocked_by: ['va'] },
    );
    const { code, stderr } = runDetail(g);
    expect(code, stderr).toBe(0);
  });

  it('rule 6c: an ordered inverse pair must have EXACTLY ONE corroborating side', () => {
    // Which side contributes the edge is decided by which side does not corroborate.
    // If both corroborate, no edge is ever contributed and the graph is empty; if
    // neither does, both are contributed and every valid pair is a 2-cycle.
    expectFailure(
      load(),
      /`phase\.gates` and its inverse `blocked_by` both declare `mustCorroborate`/,
      declare('phase', 'gates', {
        by: '8/13',
        phaseRef: 'ordered',
        inverse: 'blocked_by',
        mustCorroborate: true,
      }),
    );
    expectFailure(
      load(),
      /`phase\.blocked_by` and its inverse `gates` — neither declares `mustCorroborate`/,
      declare('phase', 'blocked_by', { by: '8/13', phaseRef: 'ordered', inverse: 'gates' }),
    );
  });

  it('rule 3b: current_phase with an unmet precondition fails, and ONLY rule 3b fires', () => {
    // Round 4: rule 3b had no test that isolated it. The obvious fixture (phase 1)
    // is confounded — its P1-pre-2 carries `source: null`, so rule 1 fires on the
    // same edit and would certify 3b's deletion. Phase 3 is PARTIAL, which tolerates
    // a measured-but-unmet condition, so 3b is the only rule left standing.
    const g = load();
    phase(g, '3').preconditions = [
      { id: 'P3-pre', text: 't', kind: 'boolean', target: true, measured: false, source: 'test' },
    ];
    g.current_phase = '3';
    expectFailure(g, /current_phase 3 has 1 unmet precondition\(s\): P3-pre/);
  });

  // --- the halves round 6's independent harness found live but untested ---

  it('rule 8: a `gates` entry that is not an array fails', () => {
    const g = load();
    (phase(g, '3') as Record<string, unknown>).concurrent_with = '5';
    expectFailure(g, /`concurrent_with` must be an array of phase ids/);
  });

  it('rule 9d: superseded_evidence must say WHY, not only that it is withdrawn', () => {
    const g = load();
    crit(g, 'P1-2').superseded_evidence = { status: 'WITHDRAWN' };
    expectFailure(g, /`superseded_evidence` must say `why` it no longer stands/);
  });

  it('rule 7: a strictly DONE phase is not a blockable state — it may not be gated', () => {
    // `blockable: false` on the DONE row of STATUS_CLASSES. Deleting it was green:
    // no fixture gated a strictly-DONE phase.
    const g = load();
    g.phases.push(
      { phase: 'ba', name: 'label ba', status: 'NOT_STARTED', gates: ['bb'] },
      { phase: 'bb', name: 'label bb', status: 'DONE', done_on: '2026-08-20' },
    );
    expectFailure(g, /gates phase bb, whose status DONE is not a blocked state/);
  });

  it('rule 13: reachability is tested in BOTH directions, not just a→b', () => {
    // `concurrentPairs` keys on a SORTED pair, so which of the two `orderedPath`
    // calls answers depends on the alphabetical order of the ids. Only the a→b call
    // had a fixture; deleting the b→a call was green.
    const g = load();
    g.phases.push(
      { phase: 'za', name: 'label za', status: 'BLOCKED_ON_ZB', concurrent_with: ['zb'] },
      {
        phase: 'zb',
        name: 'label zb',
        status: 'NOT_STARTED',
        gates: ['za'],
        concurrent_with: ['za'],
      },
    );
    expectFailure(g, /while the ordered relation makes/);
  });

  /**
   * A phase whose ONLY condition is one array-target criterion, claimed strictly
   * DONE. Rule 3 then reports exactly when `meetsTarget` says the array is unmet,
   * so each half of rule 5 can be isolated. The shipped rule-5 test differs in
   * LENGTH, so only the length precheck ever fired and the element-wise comparison
   * the docblock advertises was as untested as the defect it replaced.
   */
  const withArrayTarget = (measured: string[]): Gate => {
    const g = load();
    g.phases.push({
      phase: 'ra',
      name: 'label ra',
      status: 'DONE',
      done_on: '2026-08-20',
      criteria: [
        {
          id: 'RA-1',
          text: 't',
          kind: 'checklist',
          target: ['A1', 'A2'],
          measured,
          source: 'test',
        },
      ],
    });
    return g;
  };

  it('rule 5: an array target is compared ELEMENT-WISE — same length, wrong ORDER fails', () => {
    expectFailure(
      withArrayTarget(['A2', 'A1']),
      /status DONE but 1 criterion\/criteria not met: RA-1/,
    );
  });

  it('rule 5: and the LENGTH precheck is its own half — one item longer fails', () => {
    expectFailure(
      withArrayTarget(['A1', 'A2', 'A1']),
      /status DONE but 1 criterion\/criteria not met: RA-1/,
    );
  });

  it('rule 5: the same list in the same order is met — the rule is not "arrays always fail"', () => {
    const { code, stderr } = runDetail(withArrayTarget(['A1', 'A2']));
    expect(code, stderr).toBe(0);
  });

  it('meetsTarget: a `derived` criterion is never "met", so it can hold ship open', () => {
    // `if (c.kind === 'derived') return false` — deleting it was green because no
    // fixture put a measured derived criterion on the blocks_ship path.
    const g = load();
    const c = crit(g, 'P5-1');
    c.measured = true;
    c.blocks_ship = true;
    c.derived_from = ['P0-1'];
    const p5 = phase(g, '5');
    p5.status = 'DONE_WITH_A_QUALIFIER';
    p5.status_note = 'qualified so rule 3 is satisfied and rule 9c is what fires';
    expectFailure(g, /is irreversible and DONE\S* while \d+ `blocks_ship`/);
  });

  /**
   * A phase whose ONLY condition is the one criterion given, claimed strictly DONE.
   * Rule 3 then reports exactly when `meetsTarget` says that criterion is unmet, so
   * each half of `meetsTarget` can be isolated without another rule confounding it.
   */
  const soleCriterion = (c: Record<string, unknown>): Gate => {
    const g = load();
    g.phases.push({
      phase: 'rm',
      name: 'label rm',
      status: 'DONE',
      done_on: '2026-08-20',
      criteria: [c],
    });
    return g;
  };
  const RM_UNMET = /status DONE but 1 criterion\/criteria not met: RM-1/;

  it('meetsTarget: an UNMEASURED criterion is never met, even with no threshold', () => {
    // Without this half a null-target criterion returns "met" before anyone asks
    // whether it was measured — "nobody has run it" would read as "it passed".
    expectFailure(
      soleCriterion({
        id: 'RM-1',
        text: 't',
        kind: 'boolean',
        target: null,
        target_note: 'no threshold, deliberately',
        measured: null,
      }),
      RM_UNMET,
    );
  });

  it('meetsTarget: a `derived` criterion is never met, so it can hold ship open', () => {
    expectFailure(
      soleCriterion({
        id: 'RM-1',
        text: 't',
        kind: 'derived',
        target: true,
        measured: true,
        derived_from: ['P0-1'],
      }),
      RM_UNMET,
    );
  });

  it('meetsTarget: a MEASURED value against a null target IS met — rule 4 owns the absence', () => {
    // The passing control for the branch above. It also pins the two halves of
    // `unmet.length > 0` / `!strictlyDone` in `checkDone`: flip either and this
    // fixture starts reporting.
    const { code, stderr } = runDetail(
      soleCriterion({
        id: 'RM-1',
        text: 't',
        kind: 'value',
        target: null,
        target_note: 'no threshold, deliberately',
        measured: 42,
        source: 'test',
      }),
    );
    expect(code, stderr).toBe(0);
  });

  it('meetsTarget: an array target requires an ARRAY, not something with a length', () => {
    // `!Array.isArray(c.measured)` is its own half: an object carrying `length` and
    // indices passes the length precheck and the element-wise compare, and would be
    // "met" without it.
    expectFailure(
      soleCriterion({
        id: 'RM-1',
        text: 't',
        kind: 'checklist',
        target: ['A1'],
        measured: { 0: 'A1', length: 1 },
        source: 'test',
      }),
      RM_UNMET,
    );
  });

  it('rule 6: an undeclared key on `admissibility` itself fails', () => {
    const g = load();
    (g.admissibility as Record<string, unknown>).depends_on_adr = '0036';
    expectFailure(g, /key `depends_on_adr` is not in the key registry/);
  });

  it('rule 6: an undeclared key on an admissibility CONDITION fails', () => {
    const g = load();
    const cond = (g.admissibility?.conditions ?? [])[0] as Record<string, unknown>;
    cond.zzz_undeclared = 'x';
    expectFailure(g, /key `zzz_undeclared` is not in the key registry/);
  });

  it('rule 8c: a claim whose relation is STILL stated needs no discharge note', () => {
    // The early `continue` is a half of its own: without it, a phase that still
    // gates the phase its note describes would be told to record a discharge that
    // has not happened.
    const g = load();
    const p = phase(g, '3d');
    p.gates = ['1'];
    p.status = 'PARTIAL';
    p.status_note = undefined;
    p.done_on = undefined;
    phase(g, '1').status = 'BLOCKED_ON_3D';
    const { code, stderr } = runDetail(g);
    expect(stderr).not.toMatch(/recording the discharge/);
    expect(stderr).not.toMatch(/does not name phase 1/);
    expect(code, stderr).not.toBe(0); // phase 1 is BLOCKED, which other rules report
  });

  it('rule 9c: an irreversible DONE phase with NO open ship blocker is not reported', () => {
    // The other half of rule 9c's condition, and it was EXCLUDED from the prover on
    // a reason that was false on the data: "phase 5 is the only irreversible phase
    // and its P5-1 is derived, so the state is not constructible". Phase 5 has no
    // `blocks_ship` criteria at all — the three open blockers are P3-3/4/5 on phase
    // 3, plain booleans a fixture closes with one assignment, and any phase can be
    // marked irreversible. The state is two lines away.
    const g = load();
    for (const p of g.phases) {
      for (const c of [...(p.preconditions ?? []), ...(p.criteria ?? [])]) {
        if ((c as Record<string, unknown>).blocks_ship === true) c.measured = c.target;
      }
    }
    phase(g, '0').reversible = false; // phase 0's status already startsWith('DONE')
    const { code, stderr } = runDetail(g);
    expect(code, stderr).toBe(0);
  });

  it('rule 4: an ABSENT target is a null target — JSON expresses `undefined` by omission', () => {
    // The `c.target === undefined` half was excused as "JSON cannot express
    // undefined". An absent KEY expresses it trivially; the exclusion only held
    // because all 25 shipped criteria carry an explicit `target`.
    const g = load();
    const c = crit(g, 'P2-1');
    c.target = undefined; // serialises as an absent key
    c.target_note = undefined;
    c.measured = true;
    c.source = 'test';
    expectFailure(g, /target is null with no `target_note`/);
  });

  it('rule 9c: an irreversible phase may not be DONE while a blocks_ship criterion is unmet', () => {
    const g = load();
    const p = phase(g, '5');
    p.status = 'DONE_WITH_A_QUALIFIER';
    p.status_note = 'qualified so that rule 3 is satisfied and rule 9c is what fires';
    expectFailure(g, /is irreversible and DONE\S* while \d+ `blocks_ship`/);
  });

  it('rule 9d: superseded_evidence that does not declare itself withdrawn fails', () => {
    const g = load();
    (crit(g, 'P1-2').superseded_evidence as Record<string, unknown>).status = 'RECORDED';
    expectFailure(g, /`superseded_evidence.status` is `RECORDED`/);
  });

  it('rule 9d: superseded_evidence on an unmeasured criterion fails', () => {
    const g = load();
    crit(g, 'P2-1').superseded_evidence = { status: 'WITHDRAWN', why: 'because' };
    expectFailure(g, /carries `superseded_evidence` but is itself unmeasured/);
  });

  // --- rule 10 / 11 / 3c ---

  it('rule 10: a checklist naming an undeclared admissibility condition fails', () => {
    const g = load();
    (crit(g, 'P1-1').target as string[])[0] = 'A9';
    expectFailure(g, /`A9` is not a declared admissibility condition/);
  });

  it('rule 11: a duplicate phase id fails instead of silently winning', () => {
    const g = load();
    g.phases.push(JSON.parse(JSON.stringify(phase(g, '5'))) as Phase);
    expectFailure(g, /phase id `5` is declared 2 times/);
  });

  it('rule 11: a duplicate criterion id fails', () => {
    const g = load();
    const p = phase(g, '2');
    p.criteria?.push(JSON.parse(JSON.stringify(p.criteria[0])) as Record<string, unknown>);
    expectFailure(g, /criterion id `P2-1` is declared 2 times/);
  });

  it('rule 3c: current_phase naming a strictly DONE phase fails', () => {
    const g = load();
    const p = phase(g, '0');
    for (const c of p.criteria ?? []) {
      c.measured = c.target;
      c.source = 'test';
    }
    p.status = 'DONE';
    p.status_note = undefined;
    g.current_phase = 0;
    expectFailure(g, /current_phase 0 names phase 0, whose status is DONE/);
  });
});
