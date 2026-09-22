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
 * bun-specific clause the node lane does not need — the observed Bun BUILD (the
 * `bun-version` input + `bun --revision`, not just the version string) is part of
 * the frozen fingerprint, so a Bun build move resets the streak. The version
 * string alone is insufficient: 1.3.14 is deterministically red, stable 1.4.0 is
 * green, yet a canary also reporting 1.4.0 was red — same string, opposite
 * outcome — so a bar frozen on the string would credential a moving target.
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

  // De-decoration (nit): a prose N is decoration if it can drift from the number
  // the grader actually enforces. So PARSE the enforced constant and COMPARE the
  // doc's stated N against it — a legitimate change to the constant is *compared*
  // (doc must move with it), not silently red by a hardcoded literal. A drift on
  // either side reds this test.
  it('the bar states N consecutive nights EQUAL to the grader-enforced constant', () => {
    const audit = read(AUDIT);
    const m = audit.match(/WINDOW_REQUIRED_NIGHTS\s*=\s*(\d+)/);
    expect(m, 'grader must define WINDOW_REQUIRED_NIGHTS = <n>').not.toBeNull();
    const n = m![1];
    const md = read(BAR_DOC).toLowerCase();
    // the doc's consecutive-night count is exactly that n (not a hardcoded 14).
    // \b so a weakened constant ("4") does NOT false-pass against doc "14" (R3).
    expect(md).toMatch(new RegExp(`\\b${n}\\s+consecutive`));
    // and it pins that count to the constant by name, so the two cannot drift.
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

  // F1 (both-halves): this is the bar's ONLY novel clause vs the node lane, so
  // it must be guarded so it cannot be deleted OR INVERTED while staying green.
  // The previous version matched its two halves independently over the whole
  // doc, so "Bun version" (headline) + "restart" (rule 1) satisfied it even with
  // rule 4 removed or reversed. Fix: extract the rule-4 BLOCK and assert, inside
  // it, that it names the recorded build identity AND states the reset DIRECTION,
  // AND does not contain the inversion.
  it('BUN-SPECIFIC (rule 4): the Bun-build freeze is stated with the correct direction, inside its own block', () => {
    // rule 4 is one list item: from "4. **The observed Bun" up to the first blank line.
    const rule4 = read(BAR_DOC).match(/^4\.\s+\*\*The observed Bun[\s\S]*?(?=\n\n)/m)?.[0] ?? '';
    expect(rule4, 'rule 4 (Bun-build freeze) is missing from the bar doc').not.toBe('');
    // names the recorded build identity, not just a bare version string.
    expect(rule4).toMatch(/runtimeVersion|bun --revision/);
    // states the DIRECTION: a Bun build move RESETS the streak (not merely pauses,
    // not "may drift"). The header phrase carries the direction inside rule 4.
    expect(rule4.toLowerCase()).toMatch(/bun build move resets the streak/);
    // and does NOT contain the inversion. A blocklist is incomplete by
    // construction (a novel phrasing dodges it), but the doc stays
    // self-contradictory if it does — the header sentence still says "resets" —
    // so a dodge is visible, not silent. Bans the known dodges: may-drift,
    // does-not-reset/restart, maintainer waiver, and an "Exception:" carve-out.
    expect(rule4.toLowerCase()).not.toMatch(
      /may drift|does\s+\*{0,2}not\s+\*{0,2}(reset|restart)|may\s+\*{0,2}waive|\bexception:/,
    );
  });

  // F2: assert the reference is ON THE BUN ROW, not merely somewhere in the 60 KB
  // file. A bare document-wide substring passes even if the path is in an
  // unrelated row or an HTML comment — the "verified-once → the defined bar"
  // linkage this test's name claims would then be unguarded.
  it('the compat matrix BUN ROW references the bar doc (verified-once → the defined bar)', () => {
    const bunRow = read(MATRIX)
      .split('\n')
      .find((l) => l.includes('Bun runtime axis (`KNEXT_RUNTIME=bun`)'));
    expect(bunRow, 'compat-matrix.md must have the Bun runtime-axis row').toBeDefined();
    expect(bunRow).toContain(BAR_DOC_REL);
  });

  // F4 (both-halves, R1): "same contract class" includes the three stricter
  // audit rules (re-attempt / short-ledger / unobtainable-ledger). A bare
  // document-wide token match reintroduces the exact defect F1 fixed — an
  // inverted "a re-attempted run IS a qualifying night" keeps the token and
  // stays green. So scope to the "Plus the three stricter rules" BLOCK, assert
  // the mechanism (runAttempt !== '1') AND the direction (NOT a qualifying
  // night), and reject the inversion.
  it('states the stricter audit rules with direction — a re-attempted run does NOT qualify (#545 vector closed)', () => {
    const block =
      read(BAR_DOC).match(/\*\*Plus the three stricter rules[\s\S]*?(?=\n\n)/m)?.[0] ?? '';
    expect(block, 'the stricter-audit-rules paragraph is missing from the bar doc').not.toBe('');
    expect(block).toMatch(/runAttempt !== '1'/);
    expect(block.toLowerCase()).toMatch(/is \*\*not\*\* a qualifying night/);
    // reject the inversion: "is a qualifying night" / "banks normally".
    expect(block.toLowerCase()).not.toMatch(/is \*{0,2}a qualifying night|banks normally/);
  });
});
