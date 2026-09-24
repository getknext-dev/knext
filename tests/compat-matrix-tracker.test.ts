import { describe, expect, it } from 'bun:test';
import {
  buildTrackerBody,
  CREDENTIAL_RESET_LABEL,
  ensurePinned,
  findTrackerIssue,
  formatCellRow,
  looksLikeFetchFailure,
  TRACKER_LABEL,
  TRACKER_TITLE,
} from '../scripts/compat-matrix-tracker.mjs';
import { CREDENTIAL_CELLS } from '../scripts/compat-window-audit.mjs';

/**
 * A scripted fake `gh` — records every call and returns a canned response
 * keyed by the joined argv, so `ensurePinned`/`findTrackerIssue` are proven
 * against their REAL branch logic without a network call or the `gh` binary.
 */
function fakeGh(responses: Record<string, string>) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const key = args.join(' ');
    if (!(key in responses)) {
      throw new Error(`fakeGh: no scripted response for "${key}"`);
    }
    return responses[key];
  };
  return { gh, calls };
}

/**
 * #1300 (TD2) — the pinned aggregate matrix tracker.
 *
 * Body-building is pure (no `gh`, no network), so these tests assert its
 * shape directly. The workflow-level wiring (cron cadence, the `--matrix`
 * flag, the pin call) is asserted separately in
 * `tests/compat-credential-alert-wiring.test.ts` by scanning the real YAML.
 */

function entry(over: Record<string, unknown> = {}) {
  return {
    lane: 'node',
    scope: 'credential',
    requiredNights: 14,
    current: { nights: 5, restartCause: null },
    met: false,
    ...over,
  };
}

function fullMatrix(overrides: Record<string, Record<string, unknown>> = {}) {
  const cells: Record<string, unknown> = {};
  for (const cell of CREDENTIAL_CELLS) {
    cells[cell.lane] = entry({ lane: cell.lane, ...(overrides[cell.lane] ?? {}) });
  }
  return { cells, allMet: false };
}

describe('compat-matrix-tracker: buildTrackerBody', () => {
  it('lists every credential cell, including unwired ones', () => {
    const body = buildTrackerBody(fullMatrix());
    for (const cell of CREDENTIAL_CELLS) {
      expect(body).toContain(`\`${cell.lane}\``);
    }
  });

  it('names UNWIRED cells distinctly from wired-but-not-met cells', () => {
    const unwired = CREDENTIAL_CELLS.filter((c) => !c.wired);
    expect(unwired.length).toBeGreaterThan(0);
    for (const cell of unwired) {
      expect(formatCellRow(cell, entry())).toContain('UNWIRED');
    }
  });

  it('surfaces the restart cause when the current streak carries one', () => {
    const matrix = fullMatrix({
      node: { current: { nights: 1, restartCause: 'fingerprint-changed' } },
    });
    const body = buildTrackerBody(matrix);
    expect(body).toContain('fingerprint-changed');
  });

  it('omits a restart-cause parenthetical when the streak never restarted', () => {
    const row = formatCellRow(
      CREDENTIAL_CELLS[0],
      entry({ current: { nights: 3, restartCause: null } }),
    );
    expect(row).not.toContain('last restart');
  });

  it('reports the MET verdict honestly both ways', () => {
    expect(buildTrackerBody({ ...fullMatrix(), allMet: true })).toContain('v1.0 CREDENTIAL MET');
    expect(buildTrackerBody({ ...fullMatrix(), allMet: false })).toContain(
      'v1.0 credential NOT YET met',
    );
  });

  it('points readers at the credential-reset label for per-cell detail', () => {
    expect(buildTrackerBody(fullMatrix())).toContain(`label:${CREDENTIAL_RESET_LABEL}`);
  });

  it('throws rather than silently omitting a cell missing from the matrix', () => {
    const matrix = fullMatrix();
    delete (matrix.cells as Record<string, unknown>)[CREDENTIAL_CELLS[0].lane];
    expect(() => buildTrackerBody(matrix)).toThrow();
  });

  it('embeds the run URL when provided, and stays valid without one', () => {
    const withUrl = buildTrackerBody(fullMatrix(), { runUrl: 'https://example.test/run/1' });
    expect(withUrl).toContain('https://example.test/run/1');
    expect(() => buildTrackerBody(fullMatrix())).not.toThrow();
  });
});

describe('compat-matrix-tracker: constants', () => {
  it('the title and labels are stable identifiers (idempotency keys)', () => {
    expect(TRACKER_TITLE).toBe('Compat v1.0 credential matrix tracker (pinned)');
    expect(TRACKER_LABEL).toBe('credential-matrix-tracker');
    expect(CREDENTIAL_RESET_LABEL).toBe('credential-reset');
  });
});

const REPO = 'getknext-dev/knext';

describe('compat-matrix-tracker: findTrackerIssue (review finding 2)', () => {
  it('finds the tracker by LABEL first, defensively confirmed by title', () => {
    const { gh, calls } = fakeGh({
      [`issue list --repo ${REPO} --state all --label ${TRACKER_LABEL} --limit 20 --json number,title`]:
        JSON.stringify([{ number: 42, title: TRACKER_TITLE }]),
    });
    expect(findTrackerIssue(gh, REPO)).toBe(42);
    // Proves the lookup NEVER filters on `--state open --limit 100` by title
    // alone (the old defect: a >100-open-issue repo drops the tracker off
    // page 1) — the only call made is the label-scoped one above.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--label');
    // The old defect was `--limit 100` over an UNFILTERED (title-only) list;
    // this call is filtered by label first, so it only ever needs a small
    // page — proven by the smaller limit, not by omitting --state.
    expect(calls[0]).not.toContain('100');
  });

  it('returns null when no labelled issue matches the title (defends against a label collision)', () => {
    const { gh } = fakeGh({
      [`issue list --repo ${REPO} --state all --label ${TRACKER_LABEL} --limit 20 --json number,title`]:
        JSON.stringify([{ number: 7, title: 'some unrelated issue that also got the label' }]),
    });
    expect(findTrackerIssue(gh, REPO)).toBeNull();
  });

  it('returns null when the label has never been used', () => {
    const { gh } = fakeGh({
      [`issue list --repo ${REPO} --state all --label ${TRACKER_LABEL} --limit 20 --json number,title`]:
        '[]',
    });
    expect(findTrackerIssue(gh, REPO)).toBeNull();
  });
});

describe('compat-matrix-tracker: ensurePinned (review finding 1)', () => {
  const pinnedListKey = `issue list --repo ${REPO} --state all --search is:pinned --limit 10 --json number,state`;

  it('unpins CLOSED pinned issues to make room, then pins the tracker, then verifies', () => {
    const { gh, calls } = fakeGh({
      [pinnedListKey]: JSON.stringify([
        { number: 210, state: 'CLOSED' },
        { number: 220, state: 'CLOSED' },
        { number: 255, state: 'CLOSED' },
      ]),
      [`issue unpin 210 --repo ${REPO}`]: '',
      [`issue unpin 220 --repo ${REPO}`]: '',
      [`issue unpin 255 --repo ${REPO}`]: '',
      [`issue pin 999 --repo ${REPO}`]: '',
      [`issue view 999 --repo ${REPO} --json isPinned`]: JSON.stringify({ isPinned: true }),
    });
    expect(() => ensurePinned(gh, REPO, 999)).not.toThrow();
    const joined = calls.map((c) => c.join(' '));
    expect(joined).toContain(`issue unpin 210 --repo ${REPO}`);
    expect(joined).toContain(`issue unpin 220 --repo ${REPO}`);
    expect(joined).toContain(`issue unpin 255 --repo ${REPO}`);
    expect(joined).toContain(`issue pin 999 --repo ${REPO}`);
  });

  it('NEVER unpins an OPEN pinned issue, even to make room for the tracker', () => {
    const { gh, calls } = fakeGh({
      [pinnedListKey]: JSON.stringify([{ number: 300, state: 'OPEN' }]),
      [`issue pin 999 --repo ${REPO}`]: '',
      [`issue view 999 --repo ${REPO} --json isPinned`]: JSON.stringify({ isPinned: true }),
    });
    ensurePinned(gh, REPO, 999);
    const joined = calls.map((c) => c.join(' '));
    expect(joined.some((c) => c.startsWith('issue unpin 300'))).toBe(false);
  });

  it('is a no-op when the target issue is already pinned', () => {
    const { gh, calls } = fakeGh({
      [pinnedListKey]: JSON.stringify([{ number: 999, state: 'OPEN' }]),
    });
    ensurePinned(gh, REPO, 999);
    // Only the lookup ran — no pin/view calls, because it was already pinned.
    expect(calls).toHaveLength(1);
  });

  it('FAILS LOUDLY (throws) when the pin verify comes back false — never a silent warning', () => {
    const { gh } = fakeGh({
      [pinnedListKey]: '[]',
      [`issue pin 999 --repo ${REPO}`]: '',
      [`issue view 999 --repo ${REPO} --json isPinned`]: JSON.stringify({ isPinned: false }),
    });
    expect(() => ensurePinned(gh, REPO, 999)).toThrow(/NOT pinned/);
  });

  it('propagates a throw from `gh issue pin` itself (3 slots held by OPEN issues)', () => {
    const { gh } = fakeGh({ [pinnedListKey]: JSON.stringify([{ number: 1, state: 'OPEN' }]) });
    // No scripted response for `issue pin 999 ...` — fakeGh throws, simulating
    // execFileSync throwing on a real `gh` non-zero exit.
    expect(() => ensurePinned(gh, REPO, 999)).toThrow();
  });
});

describe('compat-matrix-tracker: looksLikeFetchFailure (review finding 3)', () => {
  const wiredLane = CREDENTIAL_CELLS.find((c) => c.wired)!.lane;
  const unwiredLane = CREDENTIAL_CELLS.find((c) => !c.wired)!.lane;

  it('is true when every WIRED cell has zero graded nights', () => {
    const cells: Record<string, unknown> = {};
    for (const cell of CREDENTIAL_CELLS) cells[cell.lane] = { nights: [] };
    expect(looksLikeFetchFailure({ cells })).toBe(true);
  });

  it('is true when every WIRED cell graded only unresolved nights', () => {
    const cells: Record<string, unknown> = {};
    for (const cell of CREDENTIAL_CELLS) {
      cells[cell.lane] = {
        nights: [{ unresolved: 'artifact-api-unreachable' }, { unresolved: 'no-ledger' }],
      };
    }
    expect(looksLikeFetchFailure({ cells })).toBe(true);
  });

  it('is FALSE the moment even one wired cell has a real resolved night (the honest half)', () => {
    const cells: Record<string, unknown> = {};
    for (const cell of CREDENTIAL_CELLS) cells[cell.lane] = { nights: [] };
    cells[wiredLane] = { nights: [{ unresolved: false, fingerprint: 'abc' }] };
    expect(looksLikeFetchFailure({ cells })).toBe(false);
  });

  it('ignores UNWIRED cells entirely — they legitimately have zero nights forever', () => {
    const cells: Record<string, unknown> = {};
    for (const cell of CREDENTIAL_CELLS) {
      cells[cell.lane] = cell.wired ? { nights: [{ unresolved: false }] } : { nights: [] };
    }
    expect(cells[unwiredLane]).toBeTruthy();
    expect(looksLikeFetchFailure({ cells })).toBe(false);
  });
});
