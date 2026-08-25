import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  citedIssues,
  correctsFigure,
  findUncorrected,
  matchesFigure,
  normalize,
} from '../scripts/lib/retracted-figures.mjs';

/**
 * GUARD TEST — the LOGIC half of the retracted-figure boundary gate (#545, #710).
 *
 * DIVISION OF LABOUR, deliberately the same as the action-pin gate
 * ----------------------------------------------------------------
 * `security.md` records why that pair is split: `tests/release-action-pins.test.ts`
 * asserts form and scope at PR time, and the resolution against upstream happens
 * at RUN time in a nightly, never baked into a committed assertion — because
 * baking it in reddened every correct bump and made editing the guard the routine
 * way to get green.
 *
 * Same split here. This file tests the pure decision logic with **no network**:
 * given sources and a ledger, is a retracted figure uncorrected? The live
 * resolution against real issues is `scripts/verify-retracted-figures.mjs`,
 * run nightly. A committed snapshot of issue text would rot the moment anyone
 * commented.
 *
 * WHAT THIS DEFENDS
 * -----------------
 * Over three review rounds the same defect reproduced: a figure corrected in one
 * place while another copy went on publishing the old value. Rounds 1–2 chased
 * it inside the repo; round 3 found it outside, on the issues the release docs
 * cite. The gate this file protects then found a fifth instance nobody had
 * looked at. That is the case for a check rather than another hand sweep.
 *
 * BOTH HALVES
 * -----------
 *   1. the ledger is real and reaches the tree (a vacuous ledger passes trivially);
 *   2. the decision logic actually distinguishes an offence from a correction.
 */

const REPO_ROOT = resolve(__dirname, '..');
const LEDGER_PATH = 'docs/compat/retracted-figures.json';

function ledger() {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, LEDGER_PATH), 'utf8'));
}

const FIG = {
  id: 'nine-restarts',
  patterns: ['9 restarts'],
  correctionSignature: '10 restarts',
};

describe('the ledger is real (the positive half)', () => {
  it('lists figures, so the gate cannot pass vacuously', () => {
    const figures = ledger().figures;
    expect(Array.isArray(figures)).toBe(true);
    expect(figures.length).toBeGreaterThan(0);
  });

  it('gives every figure an id, at least one pattern, and a correction signature', () => {
    for (const f of ledger().figures) {
      expect(f.id, 'a figure with no id cannot be reported').toBeTruthy();
      expect(f.patterns?.length, `${f.id} has no patterns`).toBeGreaterThan(0);
      expect(f.correctionSignature, `${f.id} has no correctionSignature`).toBeTruthy();
      expect(f.correct, `${f.id} does not state the corrected value`).toBeTruthy();
    }
  });

  it('never lets a correction signature be matched by its own retracted pattern', () => {
    // If a figure's signature were a substring of its own wrong claim, quoting
    // the error would "correct" it and the gate would discharge every offence.
    for (const f of ledger().figures) {
      for (const p of f.patterns) {
        expect(
          normalize(p).includes(normalize(f.correctionSignature)),
          `${f.id}: pattern "${p}" contains its own correction signature — self-discharging`,
        ).toBe(false);
      }
    }
  });
});

describe('normalisation', () => {
  it('strips markdown emphasis so one pattern matches several surface forms', () => {
    expect(normalize('778/0 on **28 of 28** ledgered')).toBe('778/0 on 28 of 28 ledgered');
  });

  it('strips blockquote markers — the false negative found by running it live', () => {
    // GitHub wraps long quoted lines, so a quoted sentence arrives split across
    // `>` prefixes. Without this the correcting comment fails to match its own
    // quote and the gate reports a corrected figure as uncorrected.
    const quoted = '> at exactly\n>    `timeoutMs: 60000` is a per-*case* timeout';
    expect(normalize(quoted)).toBe('at exactly timeoutms: 60000 is a per-case timeout');
  });

  it('strips list markers, including ordered ones', () => {
    expect(normalize('3. **The timeout signature** is a hang')).toBe(
      'the timeout signature is a hang',
    );
  });
});

describe('cited issues are SCANNED, never enumerated', () => {
  it('finds hash references and full GitHub URLs alike', () => {
    const doc = 'See #545 and https://github.com/getknext-dev/knext/issues/710 plus #850.';
    expect(citedIssues(doc)).toEqual([545, 710, 850]);
  });

  it('does not mistake a fragment path or an anchor count for a citation', () => {
    expect(citedIssues('colour #fff and shard 6/16')).toEqual([]);
  });

  it('reaches the real citing documents and finds the issues this work is about', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/release/compat-honesty-gate.md'), 'utf8');
    const found = citedIssues(doc);
    expect(found).toContain(545);
    expect(found).toContain(710);
    expect(found).toContain(850);
  });
});

describe('offence vs correction (the negative half)', () => {
  it('flags a source that publishes the retracted figure', () => {
    const sources = [{ ref: '#1 body', body: 'churn: 9 restarts in 27 nights.' }];
    expect(findUncorrected(sources, [FIG])).toEqual([
      { figure: 'nine-restarts', ref: '#1 body', matched: '9 restarts' },
    ]);
  });

  it('is silent when the figure never appears', () => {
    expect(findUncorrected([{ ref: '#1 body', body: 'all quiet' }], [FIG])).toEqual([]);
  });

  it('discharges the figure when a source quotes it AND states the right value', () => {
    const sources = [
      { ref: '#1 body', body: 'churn: 9 restarts in 27 nights.' },
      { ref: '#1 comment 2', body: 'That said 9 restarts; re-derived it is 10 restarts.' },
    ];
    expect(findUncorrected(sources, [FIG])).toEqual([]);
  });

  it('does NOT discharge on the corrected value alone — the reader lands on the wrong comment', () => {
    // This is exactly #545's shape: a correct comment 6 sitting under an
    // uncorrected comment 5, which is how the defect survived three rounds.
    const sources = [
      { ref: '#1 body', body: 'churn: 9 restarts in 27 nights.' },
      { ref: '#1 comment 2', body: 'Measured 10 restarts across the window.' },
    ];
    expect(findUncorrected(sources, [FIG]).map((o) => o.ref)).toEqual(['#1 body']);
  });

  it('does NOT discharge on quoting alone — that is republishing the error', () => {
    const sources = [
      { ref: '#1 body', body: 'churn: 9 restarts.' },
      { ref: '#1 comment 2', body: 'As noted above, 9 restarts.' },
    ];
    expect(findUncorrected(sources, [FIG]).length).toBeGreaterThan(0);
  });

  it('cannot be satisfied by relabelling a comment as a correction', () => {
    // The rule keys off the CLAIM, not a heading. An earlier version keyed off
    // a `## Correction` marker and would have exempted this.
    const sources = [
      { ref: '#1 body', body: 'churn: 9 restarts.' },
      { ref: '#1 comment 2', body: '## Correction\nNothing to see here.' },
    ];
    expect(findUncorrected(sources, [FIG]).length).toBeGreaterThan(0);
  });

  it('treats a plain-prose reconciliation as a correction (the #850 shape)', () => {
    // #850's body says "a prior analysis put this at 9 restarts … this one says
    // 10". That is a real correction and must not be flagged.
    const body =
      'At the observed rate — 10 restarts in 27 nights — a 14-night window needs a fortnight. ' +
      '(A prior analysis put this at 9 restarts / streak 7.)';
    expect(correctsFigure(body, FIG)).toBe(true);
    expect(findUncorrected([{ ref: '#850 body', body }], [FIG])).toEqual([]);
  });

  it('reports which surface form matched, so the offence is actionable', () => {
    const fig = { ...FIG, patterns: ['778/0 on 28 of 28', '28 of 28 ledgered nights at 778/0/0'] };
    const sources = [{ ref: '#1 body', body: 'we saw 778/0 on **28 of 28** ledgered nights' }];
    expect(findUncorrected(sources, [fig])[0].matched).toBe('778/0 on 28 of 28');
  });

  it('matchesFigure returns every surface form present, not merely a boolean', () => {
    const fig = { ...FIG, patterns: ['9 restarts', 'nine restarts'] };
    expect(matchesFigure('9 restarts and nine restarts', fig)).toEqual([
      '9 restarts',
      'nine restarts',
    ]);
  });
});
