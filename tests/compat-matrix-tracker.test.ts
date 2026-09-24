import { describe, expect, it } from 'bun:test';
import {
  buildTrackerBody,
  CREDENTIAL_RESET_LABEL,
  formatCellRow,
  TRACKER_LABEL,
  TRACKER_TITLE,
} from '../scripts/compat-matrix-tracker.mjs';
import { CREDENTIAL_CELLS } from '../scripts/compat-window-audit.mjs';

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
