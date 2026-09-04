import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

type Gate = {
  current_phase: string | number;
  phases: Array<{
    phase: string | number;
    status: string;
    status_note?: string;
    preconditions?: Array<Record<string, unknown>>;
    criteria?: Array<Record<string, unknown>>;
  }>;
};

/** Run the validator against a gate file, returning its exit code. */
function runOn(gate: Gate): number {
  const dir = mkdtempSync(join(tmpdir(), 'gates-'));
  const file = join(dir, 'adr-0042-gates.json');
  writeFileSync(file, JSON.stringify(gate, null, 2));
  try {
    execFileSync('node', [SCRIPT, '--file', file], { cwd: REPO, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 1;
  }
}

const load = (): Gate => JSON.parse(readFileSync(GATE, 'utf8')) as Gate;
const phase = (g: Gate, id: string) =>
  g.phases.find((p) => String(p.phase) === id) as NonNullable<ReturnType<typeof g.phases.find>>;

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
