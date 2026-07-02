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
 *   - The "official" compat suite row may be ✅ ONLY with verifiable run evidence: a GitHub
 *     Actions run ID, the pinned vercel/next.js ref, and an explicit "N passed / 0 failed"
 *     result (A3-3 graduation, #147). An evidence-less flip fails this test. The evidence is
 *     enforced IFF ✅ — an honest regression flip-back to ❌ always passes without ceremony.
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

  // ── Official-suite evidence contract (A3-3 graduation, #147) ──────────────────────────
  //
  // The official-suite row graduated ❌ → ✅ on the first observed green run on main
  // (run 28602886003: 788 passed / 0 failed, 16 shards, vercel/next.js v16.2.0). The old
  // rule ("no official ✅ while #89 is open") is replaced by an EVIDENCE-FORMAT contract:
  // the ✅ must cite, in the row itself, (1) a GitHub Actions run ID, (2) the pinned
  // vercel/next.js ref, and (3) an explicit "N passed / 0 failed" result. Anyone flipping
  // the row without citing a real run trips this guard — the flip is never free.

  /** A workflow run ID: "run 28602886003" or an actions/runs/<id> URL (9+ digits). */
  const RUN_ID_RE = /\b(?:run\s+|actions\/runs\/)(\d{9,})\b/i;
  /** The pinned vercel/next.js ref the run tested against, e.g. "v16.2.0". */
  const PINNED_REF_RE = /\bv\d+\.\d+\.\d+\b/;
  /** An explicit result with a zero failure count, e.g. "788 passed / 0 failed". */
  const RESULT_RE = /\b\d+\s+passed\b[^|]*?\b0\s+failed\b/i;

  /**
   * Returns the list of evidence problems for an official-suite row marked ✅.
   * Empty array = the flip is properly evidenced. A ❌/⚠️/⛔ row is never a problem.
   */
  function officialFlipProblems(row: MatrixRow): string[] {
    if (!row.status.includes('✅')) return [];
    const cell = `${row.evidence} ${row.notes}`;
    const problems: string[] = [];
    if (!RUN_ID_RE.test(cell)) {
      problems.push('missing a workflow run ID (e.g. "run 28602886003")');
    }
    if (!PINNED_REF_RE.test(cell)) {
      problems.push('missing the pinned vercel/next.js ref (e.g. "v16.2.0")');
    }
    if (!RESULT_RE.test(cell)) {
      problems.push('missing an explicit "<N> passed / 0 failed" result');
    }
    return problems;
  }

  describe('official-suite row — evidence-gated ✅ (A3-3 graduation, #147)', () => {
    const officialRows = rows.filter((r) => /official/i.test(r.feature));

    it('the matrix has exactly one official-suite row', () => {
      expect(officialRows.length).toBe(1);
    });

    it('enforces the evidence contract IFF the row is ✅ — an honest ❌ flip-back is always free', () => {
      const row = officialRows[0];
      // NEVER enforce the ✅ itself: if a red nightly makes someone honestly flip
      // the row back to ❌ (or ⚠️), this guard must pass without ceremony — the
      // honesty gradient only ever points AWAY from overclaiming. Evidence is
      // required if-and-only-if the ✅ is claimed.
      if (!row.status.includes('✅')) return;
      expect(
        officialFlipProblems(row),
        `official-suite ✅ evidence is incomplete: "${row.notes.slice(0, 200)}…"`,
      ).toEqual([]);
    });

    it('rejects an evidence-less flip (no run ID, ref, or result cited)', () => {
      const flipped: MatrixRow = {
        feature: 'Official Next.js compatibility suite',
        status: '✅',
        evidence: 'docs/adr/0007-compat-suite.md',
        notes: 'trust me, it went green',
      };
      const problems = officialFlipProblems(flipped);
      expect(problems.length).toBe(3);
    });

    it('rejects a flip that cites a run ID but omits the pinned ref or the 0-failed result', () => {
      const partial: MatrixRow = {
        feature: 'Official Next.js compatibility suite',
        status: '✅',
        evidence: '.github/workflows/test-e2e-deploy.yml',
        notes: 'green in run 28602886003',
      };
      const problems = officialFlipProblems(partial);
      expect(problems).toContain('missing the pinned vercel/next.js ref (e.g. "v16.2.0")');
      expect(problems).toContain('missing an explicit "<N> passed / 0 failed" result');
    });

    it('a non-✅ official row needs no run evidence (regressions may honestly flip back)', () => {
      const regressed: MatrixRow = {
        feature: 'Official Next.js compatibility suite',
        status: '❌',
        evidence: 'docs/adr/0007-compat-suite.md',
        notes: 'nightly went red — row flipped back pending triage',
      };
      expect(officialFlipProblems(regressed)).toEqual([]);
    });
  });
});
