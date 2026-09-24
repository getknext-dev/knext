import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTrackerBody,
  CREDENTIAL_RESET_LABEL,
  ensurePinned,
  findTrackerIssue,
  formatCellRow,
  looksLikeFetchFailure,
  PIN_ISSUE_MUTATION,
  PINNED_ISSUES_QUERY,
  TRACKER_LABEL,
  TRACKER_TITLE,
  UNPIN_ISSUE_MUTATION,
} from '../scripts/compat-matrix-tracker.mjs';
import { CREDENTIAL_CELLS } from '../scripts/compat-window-audit.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

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

describe('compat-matrix-tracker: ensurePinned (review round 3, finding 2 — GraphQL, live-validated)', () => {
  // Every response shape below is the REAL shape returned live against
  // getknext-dev/knext (2026-09-24): `gh issue list --search is:pinned`
  // itself was proven to ALWAYS return `[]` (not a real qualifier — the round
  // 2 bug), so this round replaces it with the GraphQL `pinnedIssues`
  // connection, live-verified to return exactly this node shape, and the
  // `pinIssue`/`unpinIssue` mutations, live round-tripped (unpinned a real
  // stale CLOSED pinned issue, pinned a scratch issue into the freed slot,
  // unpinned + closed the scratch issue) — see the commit message for the
  // issue numbers.
  const pinnedListKey = `api graphql -f query=${PINNED_ISSUES_QUERY} -f owner=getknext-dev -f name=knext`;
  const targetViewKey = `issue view 999 --repo ${REPO} --json id,isPinned`;
  const verifyViewKey = `issue view 999 --repo ${REPO} --json isPinned`;

  function pinnedIssuesResponse(nodes: Array<{ id: string; number: number; state: string }>) {
    return JSON.stringify({
      data: { repository: { pinnedIssues: { nodes: nodes.map((issue) => ({ issue })) } } },
    });
  }

  it('unpins CLOSED pinned issues to make room, then pins the tracker, then verifies', () => {
    const { gh, calls } = fakeGh({
      [pinnedListKey]: pinnedIssuesResponse([
        { id: 'I_210', number: 210, state: 'CLOSED' },
        { id: 'I_220', number: 220, state: 'CLOSED' },
        { id: 'I_255', number: 255, state: 'CLOSED' },
      ]),
      [targetViewKey]: JSON.stringify({ id: 'I_999', isPinned: false }),
      [`api graphql -f query=${UNPIN_ISSUE_MUTATION} -f id=I_210`]: '{}',
      [`api graphql -f query=${UNPIN_ISSUE_MUTATION} -f id=I_220`]: '{}',
      [`api graphql -f query=${UNPIN_ISSUE_MUTATION} -f id=I_255`]: '{}',
      [`api graphql -f query=${PIN_ISSUE_MUTATION} -f id=I_999`]: '{}',
      [verifyViewKey]: JSON.stringify({ isPinned: true }),
    });
    expect(() => ensurePinned(gh, REPO, 999)).not.toThrow();
    const joined = calls.map((c) => c.join(' '));
    expect(joined).toContain(`api graphql -f query=${UNPIN_ISSUE_MUTATION} -f id=I_210`);
    expect(joined).toContain(`api graphql -f query=${UNPIN_ISSUE_MUTATION} -f id=I_220`);
    expect(joined).toContain(`api graphql -f query=${UNPIN_ISSUE_MUTATION} -f id=I_255`);
    expect(joined).toContain(`api graphql -f query=${PIN_ISSUE_MUTATION} -f id=I_999`);
  });

  it('NEVER unpins an OPEN pinned issue, even to make room for the tracker', () => {
    const { gh, calls } = fakeGh({
      [pinnedListKey]: pinnedIssuesResponse([{ id: 'I_300', number: 300, state: 'OPEN' }]),
      [targetViewKey]: JSON.stringify({ id: 'I_999', isPinned: false }),
      [`api graphql -f query=${PIN_ISSUE_MUTATION} -f id=I_999`]: '{}',
      [verifyViewKey]: JSON.stringify({ isPinned: true }),
    });
    ensurePinned(gh, REPO, 999);
    const joined = calls.map((c) => c.join(' '));
    expect(joined.some((c) => c.includes('unpinIssue') && c.includes('I_300'))).toBe(false);
  });

  it('is a no-op when the target issue is already pinned (checked via gh issue view, not the pinnedIssues list)', () => {
    const { gh, calls } = fakeGh({
      [pinnedListKey]: pinnedIssuesResponse([{ id: 'I_999', number: 999, state: 'OPEN' }]),
      [targetViewKey]: JSON.stringify({ id: 'I_999', isPinned: true }),
    });
    ensurePinned(gh, REPO, 999);
    // The pinnedIssues lookup + the target's own isPinned check both ran —
    // but no unpin/pin/verify calls, because it was already pinned.
    expect(calls).toHaveLength(2);
  });

  it('FAILS LOUDLY (throws) when the pin verify comes back false — never a silent warning', () => {
    const { gh } = fakeGh({
      [pinnedListKey]: pinnedIssuesResponse([]),
      [targetViewKey]: JSON.stringify({ id: 'I_999', isPinned: false }),
      [`api graphql -f query=${PIN_ISSUE_MUTATION} -f id=I_999`]: '{}',
      [verifyViewKey]: JSON.stringify({ isPinned: false }),
    });
    expect(() => ensurePinned(gh, REPO, 999)).toThrow(/NOT pinned/);
  });

  it('propagates a throw from the pinIssue mutation itself (3 slots held by OPEN issues — live-confirmed error: "Maximum 3 pinned issues per repository")', () => {
    const { gh } = fakeGh({
      [pinnedListKey]: pinnedIssuesResponse([{ id: 'I_1', number: 1, state: 'OPEN' }]),
      [targetViewKey]: JSON.stringify({ id: 'I_999', isPinned: false }),
    });
    // No scripted response for the pinIssue mutation call — fakeGh throws,
    // simulating `gh api graphql` exiting non-zero on GitHub's real
    // "Maximum 3 pinned issues per repository" GraphQL error (live-confirmed:
    // `gh api graphql` exits 1 when the response body carries an `errors`
    // array, even though it also returns a 200-shaped JSON body).
    expect(() => ensurePinned(gh, REPO, 999)).toThrow();
  });
});

describe('compat-matrix-tracker: looksLikeFetchFailure (review round 3, finding 3)', () => {
  const wiredLane = CREDENTIAL_CELLS.find((c) => c.wired)!.lane;
  const unwiredLane = CREDENTIAL_CELLS.find((c) => !c.wired)!.lane;

  it('LIVE FIXTURE (2026-09-24, no RC cut): does NOT trip on the real pre-RC state', () => {
    // tests/fixtures/compat-matrix-live-2026-09-24.json is the UNMODIFIED
    // output of `node scripts/compat-window-audit.mjs --fetch --limit 12
    // --matrix --json` against getknext-dev/knext, captured live (#1300
    // review round 3, finding 3). node/bun each carry one `unresolved:
    // "no-ledger"` night (the credential-ref job legitimately refusing —
    // ADR-0056, no RC pinned yet); node-webpack/bun-webpack have an empty
    // `nights` array (no run in the 12-run window matched their cron). The
    // round-2 heuristic classified BOTH as a fetch failure and would have
    // refused to publish forever, pre-RC. This is the regression test.
    const liveMatrix = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'tests/fixtures/compat-matrix-live-2026-09-24.json'), 'utf8'),
    );
    expect(looksLikeFetchFailure(liveMatrix)).toBe(false);
  });

  it('is FALSE when every WIRED cell simply has zero graded nights (no run in the window — not a failure)', () => {
    const cells: Record<string, unknown> = {};
    for (const cell of CREDENTIAL_CELLS) cells[cell.lane] = { nights: [] };
    expect(looksLikeFetchFailure({ cells })).toBe(false);
  });

  it('is FALSE for the legitimate no-ledger/artifact-expired/ledger-unreadable reasons (not fetch-mechanism failures)', () => {
    const cells: Record<string, unknown> = {};
    for (const cell of CREDENTIAL_CELLS) {
      cells[cell.lane] = {
        nights: [
          { unresolved: 'no-ledger' },
          { unresolved: 'artifact-expired' },
          { unresolved: 'ledger-unreadable' },
        ],
      };
    }
    expect(looksLikeFetchFailure({ cells })).toBe(false);
  });

  it('is TRUE only when every WIRED cell is unresolved for a FETCH-MECHANISM reason', () => {
    const cells: Record<string, unknown> = {};
    for (const cell of CREDENTIAL_CELLS) {
      cells[cell.lane] = {
        nights: [
          { unresolved: 'artifact-api-unreachable' },
          { unresolved: 'artifact-download-failed' },
        ],
      };
    }
    expect(looksLikeFetchFailure({ cells })).toBe(true);
  });

  it('is FALSE if even one wired cell mixes a fetch-failure reason with a legitimate one (only PURE fetch-failure cells count)', () => {
    const cells: Record<string, unknown> = {};
    for (const cell of CREDENTIAL_CELLS) {
      cells[cell.lane] = { nights: [{ unresolved: 'artifact-api-unreachable' }] };
    }
    cells[wiredLane] = { nights: [{ unresolved: 'no-ledger' }] };
    expect(looksLikeFetchFailure({ cells })).toBe(false);
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
      cells[cell.lane] = cell.wired
        ? { nights: [{ unresolved: 'artifact-api-unreachable' }] }
        : { nights: [] };
    }
    expect(cells[unwiredLane]).toBeTruthy();
    expect(looksLikeFetchFailure({ cells })).toBe(true);
  });
});
