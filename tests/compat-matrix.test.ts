import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TEST for docs/compat-matrix.md (issue #41 / A3-2).
 *
 * This test mechanically prevents OVERCLAIMING in the compatibility matrix. Every ✅
 * ("supported") row must be backed by REAL, on-disk evidence:
 *   - a file path that exists in the repo, OR
 *   - a compat-smoke check id (a–g) that actually exists in compat-smoke.mjs, OR
 *   - the `compat-smoke` CI job in .github/workflows/ci.yml.
 *
 * It also enforces the project honesty rules:
 *   - No ✅ row may rely on the `next/image` SKIP check (g) — that check is skip-on-fail.
 *   - No row may claim the "official" compat suite is ✅ while issue #89 is still open.
 *   - Every Status cell uses exactly one of the 4 legal markers (✅ ⚠️ ❌ ⛔).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MATRIX_PATH = resolve(REPO_ROOT, 'docs/compat-matrix.md');
const SMOKE_PATH = resolve(REPO_ROOT, 'apps/file-manager/scripts/compat-smoke.mjs');
const CI_PATH = resolve(REPO_ROOT, '.github/workflows/ci.yml');

const LEGAL_MARKERS = ['✅', '⚠️', '❌', '⛔'];

interface MatrixRow {
  feature: string;
  status: string;
  evidence: string;
  notes: string;
}

/** Parse the first Markdown pipe-table in the matrix doc into rows. */
function parseMatrix(md: string): MatrixRow[] {
  const lines = md.split('\n');
  const rows: MatrixRow[] = [];
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (inTable) break; // table ended
      continue;
    }
    const cells = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());
    // Header row
    if (!inTable) {
      const header = cells.map((c) => c.toLowerCase());
      if (header[0]?.includes('feature') && header.some((c) => c.includes('status'))) {
        inTable = true;
      }
      continue;
    }
    // Separator row (---|---)
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const [feature, status, evidence, notes] = cells;
    rows.push({
      feature: feature ?? '',
      status: status ?? '',
      evidence: evidence ?? '',
      notes: notes ?? '',
    });
  }
  return rows;
}

/**
 * The compat-smoke check ids that are HARD (red-on-fail).
 *
 * A check is declared as `await check('a. ...', async () => { ... })`. A check is HARD
 * only if its body does NOT call `skip(...)` — `next/image` (g) calls skip() and is
 * therefore skip-on-fail, NOT a hard gate, so it must be excluded.
 */
function hardSmokeCheckIds(smokeSrc: string): Set<string> {
  const ids = new Set<string>();
  // Match each `check('<id>. <title>', ...` and the body up to the next `await check(` or `// ──`.
  const re = /check\(\s*['"]([a-g])\.[\s\S]*?(?=await check\(|\/\/ ─{2,}|printReport\()/g;
  let m: RegExpExecArray | null;
  m = re.exec(smokeSrc);
  while (m !== null) {
    const id = m[1];
    const body = m[0];
    // skip-on-fail checks call `skip(...)` to downgrade a failure; they are NOT hard gates.
    if (!/\bskip\(/.test(body)) ids.add(id);
    m = re.exec(smokeSrc);
  }
  return ids;
}

/** Resolve an Evidence cell to a list of citation tokens (paths, check ids, ci-job refs). */
function citations(evidence: string): string[] {
  // strip Markdown code/link wrappers, split on commas / semicolons / "and"
  return evidence
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .split(/[,;]|\band\b/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('docs/compat-matrix.md — honesty guard (issue #41)', () => {
  it('the matrix file exists', () => {
    expect(existsSync(MATRIX_PATH)).toBe(true);
  });

  const md = existsSync(MATRIX_PATH) ? readFileSync(MATRIX_PATH, 'utf8') : '';
  const smokeSrc = readFileSync(SMOKE_PATH, 'utf8');
  const ciSrc = readFileSync(CI_PATH, 'utf8');
  const rows = parseMatrix(md);
  const hardIds = hardSmokeCheckIds(smokeSrc);
  const hasComptSmokeJob = /^\s*compat-smoke:/m.test(ciSrc);

  it('has a non-trivial table with the expected columns', () => {
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(md.toLowerCase()).toContain('| feature');
    expect(md.toLowerCase()).toContain('evidence');
  });

  it('every Status cell uses exactly one legal marker (✅ ⚠️ ❌ ⛔)', () => {
    for (const row of rows) {
      const markers = LEGAL_MARKERS.filter((mk) => row.status.includes(mk));
      expect(markers.length, `bad status for "${row.feature}": "${row.status}"`).toBe(1);
    }
  });

  it('every ✅ row cites real on-disk evidence or a hard smoke/ci reference', () => {
    const supported = rows.filter((r) => r.status.includes('✅'));
    // sanity: there should be some supported features
    expect(supported.length).toBeGreaterThan(0);

    for (const row of supported) {
      const cites = citations(row.evidence);
      expect(cites.length, `✅ row "${row.feature}" has no evidence`).toBeGreaterThan(0);

      const ok = cites.some((cite) => {
        // (1) compat-smoke check id like "smoke a" / "smoke (a)" / "check a".
        // The `smoke`/`check` prefix is REQUIRED so a bare trailing letter on a file
        // path (e.g. ".../a") can never be misread as a hard smoke-id citation.
        const idMatch = cite.match(/(?:smoke|check)\s*\(?([a-g])\)?$/i);
        if (idMatch && hardIds.has(idMatch[1].toLowerCase())) return true;
        // (2) the compat-smoke CI job
        if (/compat-smoke/i.test(cite) && hasComptSmokeJob) return true;
        // (3) an on-disk file path (allow a trailing :line or anchor)
        const pathToken = cite.split(/[:\s#]/)[0];
        if (pathToken.includes('/') && existsSync(resolve(REPO_ROOT, pathToken))) return true;
        return false;
      });

      expect(ok, `✅ row "${row.feature}" evidence not verifiable: "${row.evidence}"`).toBe(true);
    }
  });

  it('no ✅ row relies on the next/image SKIP check (g)', () => {
    const supported = rows.filter((r) => r.status.includes('✅'));
    for (const row of supported) {
      const cites = citations(row.evidence);
      const usesSkipCheck = cites.some((cite) => /(?:smoke|check)?\s*\(?g\)?$/i.test(cite.trim()));
      expect(
        usesSkipCheck,
        `✅ row "${row.feature}" cites the skip-on-fail next/image check (g)`,
      ).toBe(false);
    }
    // and (g) must indeed NOT be in the hard set, proving it is skip-on-fail
    expect(hardIds.has('g')).toBe(false);
  });

  it('no row claims the official compat suite is ✅ while #89 is open', () => {
    for (const row of rows) {
      if (/official/i.test(row.feature) || /official/i.test(row.evidence)) {
        expect(
          row.status.includes('✅'),
          `row "${row.feature}" claims official suite ✅ — not allowed (issue #89 open)`,
        ).toBe(false);
      }
    }
  });
});
