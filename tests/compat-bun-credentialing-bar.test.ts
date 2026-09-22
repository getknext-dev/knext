import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard for the bun-lane "credentialed" bar (issue #1158).
 *
 * The compat matrix's Bun runtime-axis row is "verified-once" — two dispatch
 * runs at 778/0 — not "credentialed". Before #1158 there was no operational,
 * falsifiable definition of what "credentialed" would mean for the bun lane, so
 * `verified → credentialed` had nothing to clear. This test pins that
 * definition down so it cannot silently soften: the bar is stated, it is the
 * SAME contract class as the node lane's 14-night gate, AND it carries the one
 * bun-specific clause the node lane does not need — the observed Bun version is
 * part of the frozen fingerprint, so a Bun bump resets the streak (1.3.14 is
 * deterministically red, 1.4.0 is green; a bar that let the version drift would
 * credential a moving target).
 *
 * Every assertion below is mutation-proved: delete the clause it guards from
 * `docs/compat/window-bun-lane.md` (or the matrix reference) and this test goes
 * red. A bar doc that stayed green when its teeth were removed would be
 * decoration.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const BAR_DOC = join(REPO_ROOT, 'docs/compat/window-bun-lane.md');
const MATRIX = join(REPO_ROOT, 'docs/compat-matrix.md');
const AUDIT = join(REPO_ROOT, 'scripts/compat-window-audit.mjs');
const BAR_DOC_REL = 'compat/window-bun-lane.md';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('bun-lane credentialed bar (issue #1158)', () => {
  it('the bar doc exists', () => {
    expect(existsSync(BAR_DOC)).toBe(true);
  });

  it('states N = 14 consecutive nights — the same contract class as the node lane', () => {
    const md = read(BAR_DOC).toLowerCase();
    // "14 consecutive" — the count. Same class as window-node-lane.md rule set.
    expect(md).toMatch(/14\s+consecutive/);
  });

  // De-decoration: a prose "14" is decoration if it can drift from the number
  // the grader actually enforces. Tie the two together — the doc names the
  // constant, and the constant IS 14 in the grader — so a change to either side
  // reds this test instead of letting the doc lie about the enforced N.
  it('the bar N is the SAME constant the grader enforces, not free prose', () => {
    const audit = read(AUDIT);
    expect(audit).toMatch(/WINDOW_REQUIRED_NIGHTS\s*=\s*14/);
    // The doc pins its "14" to that constant by name.
    expect(read(BAR_DOC)).toContain('WINDOW_REQUIRED_NIGHTS');
  });

  // AC2 ("#1147's scheduled lane is measured against it") made concrete: the
  // grader must actually be able to grade the BUN lane, else "measured against
  // it" is a hand-wave. Prove the real infra — `--lane` is a CLI arg and the
  // night filter keys on the ledger's lane, so `--lane bun` grades bun nights.
  it('AC2: the grader can actually grade the bun lane (measured-against-it is real infra)', () => {
    const audit = read(AUDIT);
    expect(audit).toContain('--lane');
    expect(audit).toMatch(/l\?\.lane\s*===\s*lane/);
    // and the doc points at exactly this grader + invocation.
    const md = read(BAR_DOC);
    expect(md).toContain('compat-window-audit.mjs');
    expect(md).toContain('--lane bun');
  });

  it('states every shard must be failed:0 and notRun:0 (a shard that enumerated no test is not a pass)', () => {
    const md = read(BAR_DOC).toLowerCase();
    expect(md).toContain('failed:0');
    expect(md).toContain('notrun:0');
  });

  it('states zero net new quarantine entries', () => {
    const md = read(BAR_DOC).toLowerCase();
    expect(md).toMatch(/zero net new quarantine/);
  });

  it('states the harness fingerprint must be unchanged across all nights', () => {
    const md = read(BAR_DOC).toLowerCase();
    expect(md).toMatch(/fingerprint\s+unchanged|unchanged\s+.*fingerprint/);
  });

  it('BUN-SPECIFIC: the observed Bun version is part of the frozen fingerprint — a Bun bump resets the streak', () => {
    const md = read(BAR_DOC).toLowerCase();
    // The clause that makes this bar honest for a lane whose result depends on
    // the runtime version. It must name the recorded field (runtimeVersion /
    // `bun --version`) AND say a version move resets the count.
    expect(md).toMatch(/bun\s+version|runtimeversion|bun\s+--version/);
    expect(md).toMatch(/reset|restart/);
  });

  it('the compat matrix bun row references the bar doc (verified-once → the defined bar)', () => {
    const md = read(MATRIX);
    expect(md).toContain(BAR_DOC_REL);
  });
});
