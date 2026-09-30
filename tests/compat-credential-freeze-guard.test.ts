import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  evaluateFreezeGuard,
  evaluateRcTagChange,
  frozenFileSet,
  isFrozen,
  isMarkerNarrowingOnly,
  markerIntroducedByPr,
  markerValidity,
  PIN_FILE,
} from '../scripts/compat-credential-freeze-guard.mjs';

/**
 * GUARD TESTS for #1302 — the credential freeze guard.
 *
 * Layout mirrors the decision structure documented in
 * scripts/compat-credential-freeze-guard.mjs's header:
 *   1. isFrozen — reads the pin's rcTag;
 *   2. markerValidity — structural + expiry check on rcBumpMarker;
 *   3. frozenFileSet — the DERIVED (never hardcoded) protected-file set,
 *      reused from scripts/compat-window-fingerprint.mjs's collectHarness;
 *   4. evaluateFreezeGuard — the whole decision, and the four scenarios the
 *      task explicitly asks to be mutation-proved: red when frozen with a
 *      touched file, green when unfrozen, green with a valid marker, red
 *      with an expired marker.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

describe('isFrozen (#1302)', () => {
  it('rcTag: null is NOT frozen (ADR-0056: "null = no RC cut yet")', () => {
    expect(isFrozen({ rcTag: null })).toBe(false);
  });

  it('a missing rcTag key is NOT frozen', () => {
    expect(isFrozen({})).toBe(false);
  });

  it('any non-null rcTag IS frozen, including a malformed one (fail-safe direction)', () => {
    expect(isFrozen({ rcTag: 'v1.0.0-rc.1' })).toBe(true);
    expect(isFrozen({ rcTag: 'not-even-a-real-tag-format' })).toBe(true);
  });

  it('a non-object pin is NOT frozen', () => {
    expect(isFrozen(null)).toBe(false);
    expect(isFrozen(undefined)).toBe(false);
    expect(isFrozen('rcTag: v1')).toBe(false);
  });
});

describe('markerValidity (#1302)', () => {
  const NOW = new Date('2026-09-24T12:00:00Z');

  it('no rcBumpMarker present is invalid', () => {
    expect(markerValidity({ rcTag: 'v1.0.0-rc.1' }, NOW).valid).toBe(false);
  });

  it('a well-formed, unexpired marker is valid', () => {
    const result = markerValidity(
      {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: {
          date: '2026-09-24',
          expires: '2026-10-08',
          reason: 'founder-approved test',
        },
      },
      NOW,
    );
    expect(result.valid).toBe(true);
  });

  it('an EXPIRED marker is invalid (today > expires)', () => {
    const result = markerValidity(
      {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2026-08-01', expires: '2026-08-15', reason: 'stale' },
      },
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/);
  });

  it('today == expires is still valid (inclusive boundary)', () => {
    const result = markerValidity(
      {
        rcTag: 'v1.0.0-rc.1',
        // 14-day span, keeps this under the cap — the boundary under test
        // here is today-vs-expires, not the span cap (that has its own tests).
        rcBumpMarker: { date: '2026-09-10', expires: '2026-09-24', reason: 'x' },
      },
      NOW,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects malformed dates', () => {
    expect(
      markerValidity(
        { rcBumpMarker: { date: '09/24/2026', expires: '2026-10-08', reason: 'x' } },
        NOW,
      ).valid,
    ).toBe(false);
    expect(
      markerValidity({ rcBumpMarker: { date: '2026-09-24', expires: 'soon', reason: 'x' } }, NOW)
        .valid,
    ).toBe(false);
  });

  describe('the impossible-date exploit (#1370 review round 3)', () => {
    // The reviewer's repro: `expires: "9999-99-99"` (or "2026-10-99") makes
    // `Date.parse` NaN. A `spanFromTodayDays > 14` comparison is FALSE for
    // NaN (NaN is never > or <= anything), so a naive cap check silently
    // ADMITS it — a permanent exemption. `DATE_RE` alone does not catch
    // these: it only checks digit SHAPE, and all three inputs below are
    // shape-valid.

    it('REJECTS expires: "9999-99-99" (NaN-producing, not shape-invalid)', () => {
      const result = markerValidity(
        { rcBumpMarker: { date: '2026-09-24', expires: '9999-99-99', reason: 'nan exploit' } },
        NOW,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not a real calendar date/);
    });

    it('REJECTS expires: "2026-10-99" (invalid day-of-month, NaN-producing)', () => {
      const result = markerValidity(
        { rcBumpMarker: { date: '2026-09-24', expires: '2026-10-99', reason: 'nan exploit 2' } },
        NOW,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not a real calendar date/);
    });

    it('REJECTS date: "2026-02-30" (no such day — silently rolls to 2026-03-02, NOT NaN)', () => {
      // This is the sharper case: `new Date('2026-02-30T00:00:00Z')` is a
      // VALID (non-NaN) Date in V8 — it normalizes to March 2 — so only a
      // round-trip-through-toISOString check catches it, not a NaN check
      // alone.
      const result = markerValidity(
        { rcBumpMarker: { date: '2026-02-30', expires: '2026-03-05', reason: 'rollover exploit' } },
        NOW,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not a real calendar date/);
    });

    it('REJECTS expires: "2026-02-30" too (the rollover check applies to both fields)', () => {
      const result = markerValidity(
        {
          rcBumpMarker: { date: '2026-01-01', expires: '2026-02-30', reason: 'rollover exploit 2' },
        },
        NOW,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not a real calendar date/);
    });

    it('a well-formed, real calendar date still validates fine (no regression)', () => {
      const result = markerValidity(
        { rcBumpMarker: { date: '2026-09-24', expires: '2026-10-08', reason: 'normal' } },
        NOW,
      );
      expect(result.valid).toBe(true);
    });
  });

  it('rejects an empty or missing reason', () => {
    expect(
      markerValidity(
        { rcBumpMarker: { date: '2026-09-24', expires: '2026-10-08', reason: '' } },
        NOW,
      ).valid,
    ).toBe(false);
    expect(
      markerValidity({ rcBumpMarker: { date: '2026-09-24', expires: '2026-10-08' } }, NOW).valid,
    ).toBe(false);
  });

  it('rejects expires <= date (a marker that is never valid)', () => {
    expect(
      markerValidity(
        { rcBumpMarker: { date: '2026-09-24', expires: '2026-09-24', reason: 'x' } },
        NOW,
      ).valid,
    ).toBe(false);
    expect(
      markerValidity(
        { rcBumpMarker: { date: '2026-09-24', expires: '2026-09-01', reason: 'x' } },
        NOW,
      ).valid,
    ).toBe(false);
  });

  it('rejects a non-object rcBumpMarker (e.g. a stray string or array)', () => {
    expect(markerValidity({ rcBumpMarker: 'approved' }, NOW).valid).toBe(false);
    expect(markerValidity({ rcBumpMarker: [] }, NOW).valid).toBe(false);
  });

  it('a 14-day span is valid (the cap boundary, inclusive)', () => {
    const result = markerValidity(
      { rcBumpMarker: { date: '2026-09-24', expires: '2026-10-08', reason: 'exactly 14 days' } },
      NOW,
    );
    expect(result.valid).toBe(true);
  });

  it('a 15-day span is rejected — exceeds the 14-day cap (#1370 review)', () => {
    const result = markerValidity(
      { rcBumpMarker: { date: '2026-09-24', expires: '2026-10-09', reason: 'one day too long' } },
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/exceeds the 14-day cap/);
  });

  it('an unbounded-looking multi-month span is rejected, not merely a boundary nudge', () => {
    const result = markerValidity(
      { rcBumpMarker: { date: '2026-09-24', expires: '2027-01-01', reason: 'far too long' } },
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/exceeds the 14-day cap/);
  });

  it('REJECTS a future-dated marker even though date/expires span only 11 days (#1370 review round 2)', () => {
    // The reviewer's exact repro: the ORIGINAL expires-minus-date cap let a
    // future-dated marker through, since 11 days is under the 14-day cap
    // regardless of WHEN those 11 days fall. A marker dated 2099 authorizes
    // nothing today.
    const result = markerValidity(
      {
        rcBumpMarker: { date: '2099-12-20', expires: '2099-12-31', reason: 'future-dated exploit' },
      },
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/is in the future/);
  });

  it('rejects a marker dated even one day in the future', () => {
    const result = markerValidity(
      { rcBumpMarker: { date: '2026-09-25', expires: '2026-10-01', reason: 'tomorrow' } },
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/is in the future/);
  });

  it('date === today is allowed (not "in the future")', () => {
    const result = markerValidity(
      { rcBumpMarker: { date: '2026-09-24', expires: '2026-09-25', reason: 'added today' } },
      NOW,
    );
    expect(result.valid).toBe(true);
  });

  it('an OLD date with an expires that is >14 days from TODAY is still capped', () => {
    // date is safely in the past (passes the future-date check and the
    // expires>date check), and expires is >14 days from TODAY. Both the
    // today-relative and date-relative formulas reject this one (span from
    // either baseline exceeds 14 days) — see the NEXT test for the case
    // that actually tells the two formulas apart.
    const result = markerValidity(
      {
        rcBumpMarker: { date: '2026-01-01', expires: '2026-10-20', reason: 'old date, far expiry' },
      },
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/exceeds the 14-day cap/);
  });

  it('a BACKDATED marker with expires within 14 days of TODAY is VALID — the cap is today-relative, not date-relative (#1370 review round 3)', () => {
    // Corrects an earlier (wrong) comment here that called the two formulas
    // "provably equivalent" — they are not. `date` is far in the past
    // (2026-01-01), but `expires` (2026-10-05) is only 11 days from TODAY
    // (2026-09-24). spanFromToday = 11 <= 14 -> valid. The OLD `expires -
    // date` formula would have measured ~277 days and rejected this same
    // marker. The invariant this cap actually enforces is "an exemption
    // reaches at most 14 days past the run time" — not "the marker's own
    // date-to-expires span is at most 14 days" — and this is the case that
    // proves it, not merely asserts it.
    const result = markerValidity(
      {
        rcBumpMarker: {
          date: '2026-01-01',
          expires: '2026-10-05',
          reason: 'old date, still-near expiry',
        },
      },
      NOW,
    );
    expect(result.valid).toBe(true);
  });

  it('an expired marker reports "expired", never "exceeds the cap" (ordering)', () => {
    const result = markerValidity(
      { rcBumpMarker: { date: '2020-01-01', expires: '2020-01-02', reason: 'ancient' } },
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/);
    expect(result.reason).not.toMatch(/exceeds the 14-day cap/);
  });
});

describe('frozenFileSet — DERIVED from CREDENTIAL_CELLS + collectHarness, never hardcoded (#1302)', () => {
  it('unions collectHarness paths across every workflowFile-bearing cell, via DI', () => {
    const fakeCells = [
      { lane: 'a', workflowFile: 'wf-a.yml' },
      { lane: 'b', workflowFile: 'wf-b.yml' },
      // No workflowFile — must be SKIPPED, never passed to collectHarnessFn
      // (which would throw for a lane with nothing to fingerprint).
      { lane: 'c', workflowFile: null },
    ];
    const calls: string[] = [];
    const fakeCollectHarness = (_repoRoot: string, lane: string) => {
      calls.push(lane);
      if (lane === 'c') throw new Error('must never be called for a null-workflowFile cell');
      return [
        { component: 'harness', path: `${lane}/one.mjs`, line: 'x' },
        { component: 'harness', path: `${lane}/two.mjs`, line: 'y' },
      ];
    };
    const set = frozenFileSet('/repo', {
      cells: fakeCells,
      collectHarnessFn: fakeCollectHarness,
      // Isolate the harness-derivation half from the guard's own
      // self-protection union (covered separately below) — this test is
      // about CREDENTIAL_CELLS, not GUARD_SELF_FILES.
      guardSelfFiles: [],
    });
    expect(calls.sort()).toEqual(['a', 'b']);
    expect(set).toEqual(new Set(['a/one.mjs', 'a/two.mjs', 'b/one.mjs', 'b/two.mjs']));
  });

  it('REAL integration: reaches known real files in this checkout (non-vacuous)', () => {
    // No DI — the actual CREDENTIAL_CELLS and the actual collectHarness,
    // against this real repo. Proves the derivation reaches real,
    // known-frozen files rather than only ever being exercised against a
    // fake.
    const set = frozenFileSet(REPO_ROOT);
    expect(set.has('.github/workflows/test-e2e-deploy.yml')).toBe(true);
    expect(set.has('test/deploy-tests-manifest.knext.json')).toBe(true);
    expect(set.has(PIN_FILE)).toBe(true);
    expect(set.has('scripts/compat-credential-ref.mjs')).toBe(true);
    // The smoke manifest is dispatch-only and explicitly excluded from the
    // harness pattern (#1301 review round 1) — the freeze guard inherits
    // that exclusion for free by reusing collectHarness rather than
    // re-declaring the manifest glob itself.
    expect(set.has('test/deploy-tests-manifest.smoke.knext.json')).toBe(false);
  });

  it('DOES include the guard workflow/script itself — self-protection (#1370 review)', () => {
    // Superseded assertion (was: "never includes the guard ... itself"):
    // #1370 review round found a PR could weaken the guard's own code with
    // nothing stopping it, since none of GUARD_SELF_FILES were in the
    // derived harness closure. This is now a deliberate self-protection
    // union, not the harness derivation.
    const set = frozenFileSet(REPO_ROOT);
    expect(set.has('scripts/compat-credential-freeze-guard.mjs')).toBe(true);
    expect(set.has('scripts/compat-window-audit.mjs')).toBe(true);
    expect(set.has('scripts/compat-window-fingerprint.mjs')).toBe(true);
    expect(set.has('.github/workflows/compat-credential-freeze-guard.yml')).toBe(true);
  });

  it('the self-protection list is a DI seam too — an empty guardSelfFiles omits them', () => {
    const set = frozenFileSet(REPO_ROOT, { guardSelfFiles: [] });
    expect(set.has('scripts/compat-credential-freeze-guard.mjs')).toBe(false);
  });
});

describe('evaluateFreezeGuard — the four required scenarios (#1302)', () => {
  const NOW = new Date('2026-09-24T12:00:00Z');
  const FROZEN_SET = new Set([
    '.github/workflows/test-e2e-deploy.yml',
    'scripts/e2e-deploy.sh',
    PIN_FILE,
  ]);
  const VALID_MARKER = { date: '2026-09-24', expires: '2026-10-08', reason: 'reviewed rc re-cut' };

  it('RED: frozen (rcTag set) + a touched frozen file + no marker', () => {
    const result = evaluateFreezeGuard({
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: { rcTag: 'v1.0.0-rc.1' },
      touchedFiles: ['scripts/e2e-deploy.sh', 'README.md'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.touchedFrozenFiles).toEqual(['scripts/e2e-deploy.sh']);
    expect(result.reason).toMatch(/no valid rcBumpMarker/);
  });

  it('GREEN: unfrozen (rcTag null) even though the touched files WOULD be frozen ones', () => {
    const result = evaluateFreezeGuard({
      basePin: { rcTag: null },
      headPin: { rcTag: null },
      touchedFiles: ['scripts/e2e-deploy.sh'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/not frozen/);
  });

  it('GREEN: frozen + touched frozen file + a VALID rcBumpMarker present at HEAD', () => {
    const result = evaluateFreezeGuard({
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: { rcTag: 'v1.0.0-rc.1', rcBumpMarker: VALID_MARKER },
      touchedFiles: ['scripts/e2e-deploy.sh'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/rcBumpMarker exempts it/);
  });

  it('RED: frozen + touched frozen file + an EXPIRED rcBumpMarker at HEAD', () => {
    const result = evaluateFreezeGuard({
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2026-08-01', expires: '2026-08-15', reason: 'old approval' },
      },
      touchedFiles: ['scripts/e2e-deploy.sh'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired/);
  });

  it('GREEN: frozen, but the touched files are NOT in the frozen set at all', () => {
    const result = evaluateFreezeGuard({
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: { rcTag: 'v1.0.0-rc.1' },
      touchedFiles: ['README.md', 'docs/whatever.md'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.touchedFrozenFiles).toEqual([]);
  });

  it('a marker present at head but touching NO frozen files does not even need to be valid', () => {
    // The marker is only consulted once a frozen file is actually touched —
    // an unrelated PR carrying a stray/expired marker object must not be
    // penalized for it.
    const result = evaluateFreezeGuard({
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2020-01-01', expires: '2020-01-02', reason: 'ancient, irrelevant' },
      },
      touchedFiles: ['README.md'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('multiple touched frozen files are all listed', () => {
    const result = evaluateFreezeGuard({
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: { rcTag: 'v1.0.0-rc.1' },
      touchedFiles: ['scripts/e2e-deploy.sh', '.github/workflows/test-e2e-deploy.yml', 'README.md'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.touchedFrozenFiles.sort()).toEqual(
      ['.github/workflows/test-e2e-deploy.yml', 'scripts/e2e-deploy.sh'].sort(),
    );
  });

  describe('the exemption deadlock (#1370 review): a PR that adds/bumps/clears via the pin ALONE', () => {
    it('GREEN: pin-only diff that ADDS a marker while staying frozen (marker read from HEAD, not base)', () => {
      // Base has no marker at all — if the marker were still read from base
      // (the pre-#1370 behaviour), this would deadlock: the PR introducing
      // the marker could never pass, since base never has what head adds.
      const result = evaluateFreezeGuard({
        basePin: { rcTag: 'v1.0.0-rc.1' },
        headPin: { rcTag: 'v1.0.0-rc.1', rcBumpMarker: VALID_MARKER },
        touchedFiles: [PIN_FILE],
        frozenSet: FROZEN_SET,
        now: NOW,
      });
      expect(result.ok).toBe(true);
      expect(result.reason).toMatch(/rcBumpMarker exempts it/);
    });

    it('GREEN: pin-only diff that CLEARS rcTag (closes the window) — exempt with no marker at all', () => {
      const result = evaluateFreezeGuard({
        basePin: { rcTag: 'v1.0.0-rc.1' },
        headPin: { rcTag: null },
        touchedFiles: [PIN_FILE],
        frozenSet: FROZEN_SET,
        now: NOW,
      });
      expect(result.ok).toBe(true);
      expect(result.reason).toMatch(/closes the credential window/);
    });

    it('RED: pin-only diff that BUMPS rcTag to a new tag while staying frozen, with NO marker — still honest', () => {
      // "Exempt a pin-only diff, but keep it honest" (#1370 review): closing
      // is always safe, but silently re-tagging a still-live window through
      // the pin file alone, with nothing authorizing it, is exactly the
      // unsafe direction a bare pin-only exemption would open up.
      const result = evaluateFreezeGuard({
        basePin: { rcTag: 'v1.0.0-rc.1' },
        headPin: { rcTag: 'v1.0.0-rc.2' },
        touchedFiles: [PIN_FILE],
        frozenSet: FROZEN_SET,
        now: NOW,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/no valid rcBumpMarker/);
    });

    it('GREEN: pin-only diff that BUMPS rcTag to a new tag AND carries a valid marker at head', () => {
      const result = evaluateFreezeGuard({
        basePin: { rcTag: 'v1.0.0-rc.1' },
        headPin: { rcTag: 'v1.0.0-rc.2', rcBumpMarker: VALID_MARKER },
        touchedFiles: [PIN_FILE],
        frozenSet: FROZEN_SET,
        now: NOW,
      });
      expect(result.ok).toBe(true);
    });

    it('RED: a NON-pin-only diff (harness file also touched) is NOT exempted by head resolving unfrozen', () => {
      // The pin-only exemption is deliberately scoped to touchedFrozenFiles
      // === [PIN_FILE] alone — a diff that ALSO edits real harness bytes must
      // still clear the ordinary marker check, even if the pin itself is
      // being cleared in the same diff (base is still frozen, which is what
      // governs a non-pin-only touch).
      const result = evaluateFreezeGuard({
        basePin: { rcTag: 'v1.0.0-rc.1' },
        headPin: { rcTag: null },
        touchedFiles: [PIN_FILE, 'scripts/e2e-deploy.sh'],
        frozenSet: FROZEN_SET,
        now: NOW,
      });
      expect(result.ok).toBe(false);
      expect(result.touchedFrozenFiles.sort()).toEqual([PIN_FILE, 'scripts/e2e-deploy.sh'].sort());
    });
  });
});

describe('#1635 — a marker exempts only the PR that introduces it', () => {
  const NOW = new Date('2026-09-24T12:00:00Z');
  const FROZEN_SET = new Set([
    '.github/workflows/test-e2e-deploy.yml',
    'scripts/e2e-deploy.sh',
    PIN_FILE,
  ]);
  const TAG = 'v1.0.0-rc.1';
  const INHERITED = { date: '2026-09-23', expires: '2026-10-01', reason: 'an earlier PR' };
  const OWN = { date: '2026-09-24', expires: '2026-10-01', reason: 'this PR' };

  describe('markerIntroducedByPr', () => {
    it('no marker at head is never "introduced"', () => {
      expect(markerIntroducedByPr({ rcTag: TAG }, { rcTag: TAG })).toBe(false);
    });
    it('absent at merge base, present at head → introduced', () => {
      expect(markerIntroducedByPr({ rcTag: TAG }, { rcTag: TAG, rcBumpMarker: OWN })).toBe(true);
    });
    it('identical at merge base and head → inherited, not introduced', () => {
      expect(
        markerIntroducedByPr(
          { rcTag: TAG, rcBumpMarker: INHERITED },
          { rcTag: TAG, rcBumpMarker: { ...INHERITED } },
        ),
      ).toBe(false);
    });
    it('only expires/paths changed → still inherited', () => {
      expect(
        markerIntroducedByPr(
          { rcTag: TAG, rcBumpMarker: INHERITED },
          { rcTag: TAG, rcBumpMarker: { ...INHERITED, expires: '2026-10-05', paths: ['x'] } },
        ),
      ).toBe(false);
    });
    it('a replacement marker (new date or reason) → introduced', () => {
      const base = { rcTag: TAG, rcBumpMarker: INHERITED };
      expect(markerIntroducedByPr(base, { rcTag: TAG, rcBumpMarker: OWN })).toBe(true);
      expect(
        markerIntroducedByPr(base, { rcTag: TAG, rcBumpMarker: { ...INHERITED, reason: 'new' } }),
      ).toBe(true);
    });
  });

  it('ATTACK — inherited marker: RED when a frozen harness file changes under a marker already on main', () => {
    const pin = { rcTag: TAG, rcBumpMarker: INHERITED };
    const result = evaluateFreezeGuard({
      basePin: pin,
      mergeBasePin: pin,
      headPin: pin,
      touchedFiles: ['scripts/e2e-deploy.sh'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/inherited from the merge base/);
  });

  it('ATTACK — inherited marker whose expiry is merely extended: still RED', () => {
    const base = { rcTag: TAG, rcBumpMarker: INHERITED };
    const result = evaluateFreezeGuard({
      basePin: base,
      mergeBasePin: base,
      headPin: { rcTag: TAG, rcBumpMarker: { ...INHERITED, expires: '2026-10-05' } },
      touchedFiles: [PIN_FILE, 'scripts/e2e-deploy.sh'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('marker added by the PR: GREEN', () => {
    const result = evaluateFreezeGuard({
      basePin: { rcTag: TAG },
      mergeBasePin: { rcTag: TAG },
      headPin: { rcTag: TAG, rcBumpMarker: OWN },
      touchedFiles: [PIN_FILE, 'scripts/e2e-deploy.sh'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/rcBumpMarker exempts it/);
  });

  it('marker added by the PR replacing an inherited one: GREEN', () => {
    const base = { rcTag: TAG, rcBumpMarker: INHERITED };
    const result = evaluateFreezeGuard({
      basePin: base,
      mergeBasePin: base,
      headPin: { rcTag: TAG, rcBumpMarker: OWN },
      touchedFiles: [PIN_FILE, 'scripts/e2e-deploy.sh'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  describe('narrowing-only pin diffs pass with no marker of their own', () => {
    const base = { rcTag: TAG, rcBumpMarker: INHERITED };
    const guard = (headPin: unknown, touched: string[] = [PIN_FILE]) =>
      evaluateFreezeGuard({
        basePin: base,
        mergeBasePin: base,
        headPin,
        touchedFiles: touched,
        frozenSet: FROZEN_SET,
        now: NOW,
      });

    it('removal-only: GREEN', () => {
      const result = guard({ rcTag: TAG });
      expect(result.ok).toBe(true);
      expect(result.reason).toMatch(/only removes or narrows/);
    });
    it('shorten-only: GREEN', () => {
      expect(guard({ rcTag: TAG, rcBumpMarker: { ...INHERITED, expires: '2026-09-24' } }).ok).toBe(
        true,
      );
    });
    it('scope-narrowing (adding paths to an unscoped marker): GREEN', () => {
      expect(
        guard({ rcTag: TAG, rcBumpMarker: { ...INHERITED, paths: ['scripts/e2e-deploy.sh'] } }).ok,
      ).toBe(true);
    });
    it('ATTACK — extending expiry is not narrowing: RED', () => {
      expect(guard({ rcTag: TAG, rcBumpMarker: { ...INHERITED, expires: '2026-10-05' } }).ok).toBe(
        false,
      );
    });
    it('ATTACK — extending expiry while narrowing paths is still not narrowing: RED', () => {
      expect(
        guard({
          rcTag: TAG,
          rcBumpMarker: { ...INHERITED, expires: '2026-10-05', paths: ['scripts/e2e-deploy.sh'] },
        }).ok,
      ).toBe(false);
    });
    it('ATTACK — unchanged marker (no narrowing at all) through a pin-only diff: RED', () => {
      // e.g. a whitespace-only reformat of the pin: nothing is narrowed, so
      // this is not an exempt narrowing, and the inherited marker exempts nothing.
      expect(guard({ rcTag: TAG, rcBumpMarker: { ...INHERITED } }).ok).toBe(false);
    });
    it('ATTACK — rcTag change riding a marker removal: RED', () => {
      const result = guard({ rcTag: 'v1.0.0-rc.2' });
      expect(result.ok).toBe(false);
    });
    it('ATTACK — any other pin key changed alongside the removal: RED', () => {
      expect(guard({ rcTag: TAG, $comment: 'edited' }).ok).toBe(false);
    });
    it('ATTACK — removal plus a harness file is not pin-only: RED', () => {
      expect(guard({ rcTag: TAG }, [PIN_FILE, 'scripts/e2e-deploy.sh']).ok).toBe(false);
    });
  });

  describe('isMarkerNarrowingOnly edge cases', () => {
    const scoped = { ...INHERITED, paths: ['a', 'b'] };
    it('no marker at merge base → never narrowing', () => {
      expect(isMarkerNarrowingOnly({ rcTag: TAG }, { rcTag: TAG })).toBe(false);
    });
    it('dropping paths widens scope → not narrowing', () => {
      expect(
        isMarkerNarrowingOnly(
          { rcTag: TAG, rcBumpMarker: scoped },
          { rcTag: TAG, rcBumpMarker: { ...INHERITED, expires: '2026-09-24' } },
        ),
      ).toBe(false);
    });
    it('adding a path outside the base scope → not narrowing', () => {
      expect(
        isMarkerNarrowingOnly(
          { rcTag: TAG, rcBumpMarker: scoped },
          { rcTag: TAG, rcBumpMarker: { ...INHERITED, paths: ['a', 'c'] } },
        ),
      ).toBe(false);
    });
    it('dropping one path of a scoped marker → narrowing', () => {
      expect(
        isMarkerNarrowingOnly(
          { rcTag: TAG, rcBumpMarker: scoped },
          { rcTag: TAG, rcBumpMarker: { ...INHERITED, paths: ['a'] } },
        ),
      ).toBe(true);
    });
    it('changing date or reason, or adding an unknown key → not narrowing', () => {
      const base = { rcTag: TAG, rcBumpMarker: INHERITED };
      const shorter = { ...INHERITED, expires: '2026-09-24' };
      expect(
        isMarkerNarrowingOnly(base, {
          rcTag: TAG,
          rcBumpMarker: { ...shorter, date: '2026-09-22' },
        }),
      ).toBe(false);
      expect(
        isMarkerNarrowingOnly(base, { rcTag: TAG, rcBumpMarker: { ...shorter, reason: 'x' } }),
      ).toBe(false);
      expect(
        isMarkerNarrowingOnly(base, { rcTag: TAG, rcBumpMarker: { ...shorter, other: 1 } }),
      ).toBe(false);
    });
    it('key order in the pin does not matter', () => {
      expect(
        isMarkerNarrowingOnly(
          { rcTag: TAG, $comment: 'c', rcBumpMarker: INHERITED },
          { $comment: 'c', rcTag: TAG },
        ),
      ).toBe(true);
    });

    // #1649 review round 2: the "never widens `paths`" rule (the :369 subset
    // check and the :370 pathsNarrowed computation) had no red test — deleting
    // :369 or forcing :370's result to `true` kept every existing test green.
    describe('never widens paths (#1649 review round 2)', () => {
      it('ATTACK — base paths [A] -> head paths [A, B], shorter expiry, pin-only: RED (widening paths is never narrowing, even alongside a shorter expiry)', () => {
        expect(
          isMarkerNarrowingOnly(
            { rcTag: TAG, rcBumpMarker: { ...INHERITED, paths: ['A'] } },
            {
              rcTag: TAG,
              rcBumpMarker: { ...INHERITED, expires: '2026-09-25', paths: ['A', 'B'] },
            },
          ),
        ).toBe(false);
      });
      it('ATTACK — base paths [A, B] -> head paths [B, A] (reordered, same set), same expiry: RED (not narrowing)', () => {
        expect(
          isMarkerNarrowingOnly(
            { rcTag: TAG, rcBumpMarker: { ...INHERITED, paths: ['A', 'B'] } },
            { rcTag: TAG, rcBumpMarker: { ...INHERITED, paths: ['B', 'A'] } },
          ),
        ).toBe(false);
      });
      it('green counterpart — base paths [A, B] -> head paths [A], same expiry: GREEN (genuine narrowing)', () => {
        expect(
          isMarkerNarrowingOnly(
            { rcTag: TAG, rcBumpMarker: { ...INHERITED, paths: ['A', 'B'] } },
            { rcTag: TAG, rcBumpMarker: { ...INHERITED, paths: ['A'] } },
          ),
        ).toBe(true);
      });
    });
  });

  describe('path-scoped markers', () => {
    const scoped = { ...OWN, paths: ['scripts/e2e-deploy.sh'] };
    const guard = (touched: string[]) =>
      evaluateFreezeGuard({
        basePin: { rcTag: TAG },
        mergeBasePin: { rcTag: TAG },
        headPin: { rcTag: TAG, rcBumpMarker: scoped },
        touchedFiles: touched,
        frozenSet: FROZEN_SET,
        now: NOW,
      });
    it('covers a named path (and the pin file itself): GREEN', () => {
      expect(guard([PIN_FILE, 'scripts/e2e-deploy.sh']).ok).toBe(true);
    });
    it('does not cover an unnamed frozen file: RED', () => {
      const result = guard([PIN_FILE, '.github/workflows/test-e2e-deploy.yml']);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(
        /does not cover frozen file\(s\): \.github\/workflows\/test-e2e-deploy\.yml/,
      );
    });
    it('an empty or malformed paths list invalidates the marker instead of meaning "everything"', () => {
      for (const paths of [[], [''], 'scripts/e2e-deploy.sh', [1]]) {
        const v = markerValidity({ rcTag: TAG, rcBumpMarker: { ...OWN, paths } }, NOW);
        expect(v.valid).toBe(false);
        expect(v.reason).toMatch(/paths/);
      }
    });
  });
});

describe('#1641 — an rcTag change needs the tag on the remote, reachable from main', () => {
  const SHA = 'a'.repeat(40);
  const base = { rcTag: 'v1.0.0-rc.1' };
  const head = { rcTag: 'v1.0.0-rc.2' };

  it('GREEN: rcTag unchanged (no lookup needed)', () => {
    expect(evaluateRcTagChange({ mergeBasePin: base, headPin: base, tagState: null }).ok).toBe(
      true,
    );
  });
  it('GREEN: rcTag cleared to null (closing a window)', () => {
    expect(
      evaluateRcTagChange({ mergeBasePin: base, headPin: { rcTag: null }, tagState: null }).ok,
    ).toBe(true);
  });
  it('RED: rcTag changed with no lookup supplied — fails closed', () => {
    const r = evaluateRcTagChange({ mergeBasePin: base, headPin: head, tagState: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/failing closed/);
  });
  it('RED: lookup for a different tag than the head names', () => {
    const r = evaluateRcTagChange({
      mergeBasePin: base,
      headPin: head,
      tagState: { tag: 'v1.0.0-rc.1', commit: SHA, reachableFromMain: true },
    });
    expect(r.ok).toBe(false);
  });
  it('RED: the tag does not exist on the remote — "push the tag first"', () => {
    const r = evaluateRcTagChange({
      mergeBasePin: base,
      headPin: head,
      tagState: { tag: 'v1.0.0-rc.2', commit: null, reachableFromMain: false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/push the tag first/);
  });
  it('RED: the tag peels to a commit not reachable from main', () => {
    const r = evaluateRcTagChange({
      mergeBasePin: base,
      headPin: head,
      tagState: { tag: 'v1.0.0-rc.2', commit: SHA, reachableFromMain: false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not reachable from main/);
  });
  it('RED: a head rcTag that is not an RC tag name', () => {
    const r = evaluateRcTagChange({
      mergeBasePin: base,
      headPin: { rcTag: 'main' },
      tagState: { tag: 'main', commit: SHA, reachableFromMain: true },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a release-candidate tag/);
  });
  it('GREEN: the tag exists and is reachable from main', () => {
    const r = evaluateRcTagChange({
      mergeBasePin: base,
      headPin: head,
      tagState: { tag: 'v1.0.0-rc.2', commit: SHA, reachableFromMain: true },
    });
    expect(r.ok).toBe(true);
  });
  it('GREEN: the first cut (null → tag) with an existing reachable tag', () => {
    const r = evaluateRcTagChange({
      mergeBasePin: { rcTag: null },
      headPin: base,
      tagState: { tag: 'v1.0.0-rc.1', commit: SHA, reachableFromMain: true },
    });
    expect(r.ok).toBe(true);
  });
});

describe('the pin file itself documents rcBumpMarker (#1302)', () => {
  it('.github/compat-credential-ref.json parses, and the window is frozen on the live RC tag (#1529, #1560)', () => {
    const pin = JSON.parse(readFileSync(resolve(REPO_ROOT, PIN_FILE), 'utf8'));
    // rc.1 (#1529) set rcTag to a real RC tag, so the window went live on
    // `main`; rc.2 (#1560) re-pins it to the next RC tag once that tag
    // exists — this documents whichever post-cut state is live, not the
    // pre-cut one.
    expect(pin.rcTag).toBe('v1.0.0-rc.2');
    expect(isFrozen(pin)).toBe(true);
  });
});

/**
 * CLI-level end-to-end (#1302): spawns the REAL script as a subprocess
 * against real fixture files, exercising the argument parsing, file I/O and
 * exit code the workflow actually depends on — not just the exported pure
 * functions. The four scenarios below are the exact ones named in the task:
 * red when frozen with a touched file, green when unfrozen, green with a
 * valid marker, red with an expired marker. `--now` makes the process
 * deterministic without touching the system clock.
 *
 * `CLI_TEST_TIMEOUT_MS` (#1370 review): `frozenFileSet(REPO_ROOT)` runs the
 * real `collectHarness` closure walk over every credential cell for each
 * subprocess spawn — slower than bun:test's 5000ms default on a loaded CI
 * runner. Each `it` below passes it explicitly rather than relying on the
 * suite-wide default.
 */
describe('CLI subprocess — the four required scenarios, end to end (#1302)', () => {
  const SCRIPT = resolve(REPO_ROOT, 'scripts/compat-credential-freeze-guard.mjs');
  const NOW_ARG = '2026-09-24T12:00:00Z';
  const CLI_TEST_TIMEOUT_MS = 15_000;
  const EXEC_TIMEOUT_MS = 10_000;

  function run(
    basePin: unknown,
    touchedFiles: string[],
    headPin: unknown = basePin,
    extra: { mergeBasePin?: unknown; tagState?: unknown } = {},
  ): { status: number | null; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), 'knext-freeze-guard-'));
    try {
      const basePinFile = join(dir, 'base-pin.json');
      const headPinFile = join(dir, 'head-pin.json');
      const changedFile = join(dir, 'changed-files.txt');
      writeFileSync(basePinFile, JSON.stringify(basePin));
      writeFileSync(headPinFile, JSON.stringify(headPin));
      writeFileSync(changedFile, `${touchedFiles.join('\n')}\n`);
      const extraArgs: string[] = [];
      // --merge-base-pin-file is REQUIRED by the CLI (fails closed otherwise,
      // see the dedicated describe block below), so this harness always
      // supplies it — defaulting to basePin, mirroring the pre-#1635
      // behaviour for every test here that isn't specifically about the
      // merge-base distinction.
      const mergeBasePinValue = extra.mergeBasePin !== undefined ? extra.mergeBasePin : basePin;
      const mergeBaseFile = join(dir, 'merge-base-pin.json');
      writeFileSync(mergeBaseFile, JSON.stringify(mergeBasePinValue));
      extraArgs.push('--merge-base-pin-file', mergeBaseFile);
      if (extra.tagState !== undefined) {
        const f = join(dir, 'rctag-state.json');
        writeFileSync(f, JSON.stringify(extra.tagState));
        extraArgs.push('--rc-tag-state-file', f);
      }
      try {
        const stdout = execFileSync(
          process.execPath,
          [
            SCRIPT,
            '--repo-root',
            REPO_ROOT,
            '--base-pin-file',
            basePinFile,
            '--head-pin-file',
            headPinFile,
            '--changed-files-file',
            changedFile,
            '--now',
            NOW_ARG,
            ...extraArgs,
          ],
          { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS },
        );
        return { status: 0, stdout };
      } catch (err) {
        const e = err as { status: number | null; stdout?: string };
        return { status: e.status, stdout: e.stdout ?? '' };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it(
    'RED (exit 1): frozen + a real touched frozen file (test-e2e-deploy.yml) + no marker',
    () => {
      const { status, stdout } = run({ rcTag: 'v1.0.0-rc.1' }, [
        '.github/workflows/test-e2e-deploy.yml',
      ]);
      expect(status).toBe(1);
      expect(stdout).toMatch(/no valid rcBumpMarker/);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'GREEN (exit 0): unfrozen (rcTag: null), even touching a would-be-frozen file',
    () => {
      const { status, stdout } = run({ rcTag: null }, ['.github/workflows/test-e2e-deploy.yml']);
      expect(status).toBe(0);
      expect(stdout).toMatch(/not frozen/);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'GREEN (exit 0): frozen + touched frozen file + a valid rcBumpMarker at head',
    () => {
      const { status, stdout } = run(
        { rcTag: 'v1.0.0-rc.1' },
        ['.github/workflows/test-e2e-deploy.yml'],
        {
          rcTag: 'v1.0.0-rc.1',
          rcBumpMarker: { date: '2026-09-24', expires: '2026-10-08', reason: 'e2e test' },
        },
      );
      expect(status).toBe(0);
      expect(stdout).toMatch(/rcBumpMarker exempts it/);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'RED (exit 1): frozen + touched frozen file + an EXPIRED rcBumpMarker at head',
    () => {
      const { status, stdout } = run(
        { rcTag: 'v1.0.0-rc.1' },
        ['.github/workflows/test-e2e-deploy.yml'],
        {
          rcTag: 'v1.0.0-rc.1',
          rcBumpMarker: { date: '2026-08-01', expires: '2026-08-15', reason: 'stale' },
        },
      );
      expect(status).toBe(1);
      expect(stdout).toMatch(/expired/);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'GREEN (exit 0): frozen, touched files are entirely unrelated to the credential harness',
    () => {
      const { status } = run({ rcTag: 'v1.0.0-rc.1' }, ['README.md', 'docs/some-page.md']);
      expect(status).toBe(0);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'GREEN (exit 0): pin-only diff clearing rcTag — the deadlock scenario, end to end (#1370)',
    () => {
      const { status, stdout } = run({ rcTag: 'v1.0.0-rc.1' }, [PIN_FILE], { rcTag: null });
      expect(status).toBe(0);
      expect(stdout).toMatch(/closes the credential window/);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'RED (exit 1): an inherited marker (same at merge base and head) exempts nothing (#1635)',
    () => {
      const pin = {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2026-09-23', expires: '2026-10-01', reason: 'earlier PR' },
      };
      const { status, stdout } = run(pin, ['.github/workflows/test-e2e-deploy.yml'], pin, {
        mergeBasePin: pin,
      });
      expect(status).toBe(1);
      expect(stdout).toMatch(/inherited from the merge base/);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'RED (exit 1): the marker is judged at the MERGE BASE, not the base tip — a PR that branched while a marker was on main stays unexempted after main removes it (#1635)',
    () => {
      const marker = { date: '2026-09-23', expires: '2026-10-01', reason: 'earlier PR' };
      const withMarker = { rcTag: 'v1.0.0-rc.1', rcBumpMarker: marker };
      const { status, stdout } = run(
        { rcTag: 'v1.0.0-rc.1' }, // base tip: main has since removed the marker
        ['.github/workflows/test-e2e-deploy.yml'],
        withMarker, // head still carries the inherited marker
        { mergeBasePin: withMarker },
      );
      expect(status).toBe(1);
      expect(stdout).toMatch(/inherited from the merge base/);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'GREEN (exit 0): a pin-only diff that only removes the marker (#1635)',
    () => {
      const pin = {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2026-09-23', expires: '2026-10-01', reason: 'earlier PR' },
      };
      const { status, stdout } = run(
        pin,
        [PIN_FILE],
        { rcTag: 'v1.0.0-rc.1' },
        { mergeBasePin: pin },
      );
      expect(status).toBe(0);
      expect(stdout).toMatch(/only removes or narrows/);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'RED (exit 1): an rcTag bump whose tag is missing on the remote, even with a valid marker (#1641)',
    () => {
      const base = { rcTag: 'v1.0.0-rc.1' };
      const head = {
        rcTag: 'v1.0.0-rc.2',
        rcBumpMarker: { date: '2026-09-24', expires: '2026-10-01', reason: 'rc.2 bump' },
      };
      const { status, stdout } = run(base, [PIN_FILE], head, {
        mergeBasePin: base,
        tagState: { tag: 'v1.0.0-rc.2', commit: null, reachableFromMain: false },
      });
      expect(status).toBe(1);
      expect(stdout).toMatch(/push the tag first/);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'GREEN (exit 0): an rcTag bump whose tag exists and is reachable, with a valid marker (#1641)',
    () => {
      const base = { rcTag: 'v1.0.0-rc.1' };
      const head = {
        rcTag: 'v1.0.0-rc.2',
        rcBumpMarker: { date: '2026-09-24', expires: '2026-10-01', reason: 'rc.2 bump' },
      };
      const { status } = run(base, [PIN_FILE], head, {
        mergeBasePin: base,
        tagState: { tag: 'v1.0.0-rc.2', commit: 'b'.repeat(40), reachableFromMain: true },
      });
      expect(status).toBe(0);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'exits 2 (usage error) when a required flag is missing, not a silent pass',
    () => {
      expect(() =>
        execFileSync(process.execPath, [SCRIPT, '--repo-root', REPO_ROOT], {
          encoding: 'utf8',
          timeout: EXEC_TIMEOUT_MS,
        }),
      ).toThrow();
      try {
        execFileSync(process.execPath, [SCRIPT, '--repo-root', REPO_ROOT], {
          encoding: 'utf8',
          timeout: EXEC_TIMEOUT_MS,
        });
      } catch (err) {
        expect((err as { status: number }).status).toBe(2);
      }
    },
    CLI_TEST_TIMEOUT_MS,
  );

  // #1649 review round 2: --merge-base-pin-file used to fall back to
  // basePin when omitted (fail OPEN — silently treats the PR base as its
  // own merge base, defeating the #1635 checks). It must now fail closed.
  describe('--merge-base-pin-file is required, never falls back to basePin (#1649 review round 2)', () => {
    it(
      'RED — exits non-zero with a clear message when the flag is omitted, even in a scenario that would otherwise exit 0',
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'knext-freeze-guard-'));
        try {
          const basePinFile = join(dir, 'base-pin.json');
          const headPinFile = join(dir, 'head-pin.json');
          const changedFile = join(dir, 'changed-files.txt');
          // Unfrozen at base — under the old fail-open fallback this scenario
          // exits 0 regardless of mergeBasePin, so a failure here isolates the
          // missing flag itself as the cause, not the scenario.
          writeFileSync(basePinFile, JSON.stringify({ rcTag: null }));
          writeFileSync(headPinFile, JSON.stringify({ rcTag: null }));
          writeFileSync(changedFile, `${PIN_FILE}\n`);
          let threw = false;
          try {
            execFileSync(
              process.execPath,
              [
                SCRIPT,
                '--repo-root',
                REPO_ROOT,
                '--base-pin-file',
                basePinFile,
                '--head-pin-file',
                headPinFile,
                '--changed-files-file',
                changedFile,
              ],
              { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS },
            );
          } catch (err) {
            threw = true;
            const e = err as { status: number | null; stderr?: string };
            expect(e.status).not.toBe(0);
            expect(e.status).not.toBeNull();
            expect(String(e.stderr)).toMatch(/--merge-base-pin-file is required/);
          }
          expect(threw).toBe(true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      CLI_TEST_TIMEOUT_MS,
    );

    it(
      'GREEN — the identical scenario exits 0 once --merge-base-pin-file is supplied, isolating the flag as what changed',
      () => {
        const { status } = run(
          { rcTag: null },
          [PIN_FILE],
          { rcTag: null },
          {
            mergeBasePin: { rcTag: null },
          },
        );
        expect(status).toBe(0);
      },
      CLI_TEST_TIMEOUT_MS,
    );
  });
});
