import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const SCRIPT = join(REPO, 'scripts', 'verify-phase-gates.mjs');
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
function runDetail(gate: Gate): { code: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gates-'));
  const file = join(dir, 'adr-0042-gates.json');
  writeFileSync(file, JSON.stringify(gate, null, 2));
  try {
    execFileSync('node', [SCRIPT, '--file', file], { cwd: REPO, stdio: 'pipe' });
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

/** Assert the validator failed, and failed for the stated reason. */
function expectFailure(gate: Gate, because: RegExp): void {
  const { code, stderr } = runDetail(gate);
  expect(code, `expected a non-zero exit; stderr was:\n${stderr}`).not.toBe(0);
  expect(stderr).toMatch(because);
}

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

  it('rule 8c: a discharged gate claim with no gates_note fails', () => {
    const g = load();
    phase(g, '3d').gates_note = undefined;
    expectFailure(g, /no longer lists it and there is no `gates_note` recording the discharge/);
  });

  // --- rule 9: the remaining self-contradictions ---

  it('rule 9a: a done_on date on a phase that is not DONE fails', () => {
    const g = load();
    phase(g, '2').done_on = '2026-08-20';
    expectFailure(g, /carries `done_on` 2026-08-20 but its status is/);
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
