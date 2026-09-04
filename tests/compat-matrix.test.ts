import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';

/**
 * GUARD TEST for docs/compat-matrix.md (issue #41 / A3-2).
 *
 * This test mechanically prevents OVERCLAIMING in the compatibility matrix. Every ✅
 * ("supported") row must be backed by REAL, on-disk evidence:
 *   - a file path that exists in the repo, OR
 *   - a compat-smoke check id (a–z) that actually exists in compat-smoke.mjs, OR
 *   - the `compat-smoke` CI job in .github/workflows/ci.yml.
 *
 * It also enforces the project honesty rules:
 *   - A ✅ row may only cite a smoke check that is HARD (red-on-fail) ON EVERY LANE THE ROW
 *     CLAIMS. Sprint 1 / T4 removed the last skip-on-fail path from the runner, so
 *     `next/image` (g) is now hard — but the rule that produced that work stands, and it has
 *     TWO halves (#655): a check may duck a failure by calling `skip(...)` in its body, or by
 *     declaring a narrowed `lanes` third argument (#281) that makes it a declared no-op on the
 *     other runtime lane. Neither can back an unconditional ✅. A row that honestly declares its
 *     lane scope with the structured marker `(lane: bun)` in its Feature cell may cite a
 *     lane-scoped check — that is the escape valve for a genuinely runtime-specific contract
 *     like (h), the bun keep-alive guard. The declaration is a marker rather than free prose
 *     so that ordinary wording ("the bun lane only runs weekly") can never silently narrow a
 *     row's claim. Declarations are counted over a CODE-ONLY view of the runner, so a
 *     `check(` written inside a comment or a string declares nothing — it can neither
 *     redefine a real check nor back a ✅ row on its own (a check commented out is a check
 *     that does not exist) — and a repeated id is AMBIGUOUS rather than last-write-wins.
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

// ── compat-smoke check hardness, PER LANE (#655) ───────────────────────────────────────
//
// The runner has TWO sanctioned ways for a check not to red a run, and a guard that scans
// for only one of them is the same one-sided-scan defect it exists to prevent:
//   1. `skip(...)` in the body — a skip-on-fail downgrade (none exist today, T4 removed them);
//   2. the LANE FILTER (#281) — `await check(name, fn, ['node'])`, whose lane list is the
//      THIRD ARGUMENT, so it never appears in the body and reads as "hard" to a body scan.
// A check narrowed to one lane emits a declared SKIP on the other and reds nothing there, so
// it cannot back a ✅ row that claims both lanes.

type Lane = 'node' | 'bun';
const ALL_LANES: readonly Lane[] = ['node', 'bun'] as const;

/**
 * The check ids the runner is known to declare today. Asserted as a SUBSET of what the
 * derivation finds, never as an equality — see the "NOT GREEN BY SKIP" test.
 */
const KNOWN_SMOKE_IDS = [...'abcdefghijk'];

interface SmokeCheck {
  id: string;
  /** The lanes on which this check is a HARD, red-on-fail gate. */
  hardLanes: Set<Lane>;
  /** Why it is not hard on every lane ('' when it is). */
  reason: string;
}

/**
 * Split the argument list of a call whose `(` sits at `open`, at TOP-LEVEL commas, returning
 * `[start, end)` offsets into the original source. Returns `null` if the call never closes —
 * the caller then treats the check as unparseable (fail closed).
 *
 * MUST be given a `blankNonCode(...)` view: it is bracket-aware only, because in that view no
 * comment or literal content survives to confuse it. Offsets are preserved by the blanking,
 * so the caller slices the ORIGINAL source with what this returns.
 */
function splitCallArgs(blanked: string, open: number): Array<[number, number]> | null {
  const args: Array<[number, number]> = [];
  let start = open + 1;
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        if (c !== ')') return null;
        args.push([start, i]);
        return args;
      }
      continue;
    }
    if (c === ',' && depth === 1) {
      args.push([start, i]);
      start = i + 1;
    }
  }
  return null;
}

/**
 * The lanes a `check(...)` call's third argument scopes it to.
 *
 * FAIL CLOSED: anything that is not a literal array of known lane strings (a variable, a
 * spread, a computed expression) yields NO lanes, so a citation of it reds. Laundering a
 * lane restriction through indirection must never read as "hard on both lanes".
 */
function laneScope(laneArg: string | null): { lanes: Set<Lane>; reason: string } {
  if (laneArg === null) return { lanes: new Set(ALL_LANES), reason: '' };
  const arr = laneArg.match(/^\s*\[([^\]]*)\]\s*$/);
  if (!arr) {
    return {
      lanes: new Set(),
      reason: `lanes argument is not a literal lane array: \`${laneArg.trim()}\``,
    };
  }
  const tokens = arr[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const lanes = new Set<Lane>();
  for (const token of tokens) {
    const lit = token.match(/^['"]([a-z]+)['"]$/);
    if (!lit || !ALL_LANES.includes(lit[1] as Lane)) {
      return { lanes: new Set(), reason: `unrecognised lane token \`${token}\`` };
    }
    lanes.add(lit[1] as Lane);
  }
  if (lanes.size === 0) return { lanes, reason: 'lanes argument is an empty array' };
  const excluded = ALL_LANES.filter((l) => !lanes.has(l));
  return {
    lanes,
    reason: excluded.length ? `lane-scoped to ${[...lanes].join('+')} (#281 lane filter)` : '',
  };
}

/**
 * How many `check(...)` declarations the runner actually makes, derived independently of the
 * parse below so an invented or swallowed id reds.
 *
 * ONE derivation, over the same code-only view the parse uses (round 4). The previous
 * line-anchored `^\s*await check\(` was wrong in both directions: it MISSED a legitimate
 * `if (process.env.X) await check(...)` one-liner — a false red whose message ("the runner
 * parse lost or invented check ids") sent the author hunting the parse rather than the
 * regex — and it COUNTED a commented-out declaration, so it agreed with the pre-round-4
 * parse on the wrong answer instead of contradicting it.
 */
function declaredCheckCount(src: string): number {
  return (blankNonCode(src).match(/\bawait\s+check\(/g) ?? []).length;
}

/**
 * Parse every `check('<id>. …', fn[, lanes])` in the runner into its per-lane hardness.
 *
 * The derivation stays SCANNED rather than enumerated, so reintroducing either skip path
 * demotes that id instead of going unnoticed.
 *
 * AMBIGUITY FAILS CLOSED (round 2). The scan is context-aware only INSIDE a call it has
 * already entered — nothing decides whether the `check(` it entered was code. A later
 * occurrence inside a comment or a string therefore used to overwrite the real entry
 * (last-write-wins) with an unrestricted, both-lanes one, so a documentation comment
 * restating a check could silently return this guard to green while the runner genuinely
 * read `}, ['node']);`. An id declared more than once is now hard on NO lane: a mis-parse
 * costs a red, never a false pass.
 */
function parseSmokeChecks(smokeSrc: string): Map<string, SmokeCheck> {
  // Scan the CODE-ONLY view, then slice the ORIGINAL at the offsets it yields: a `check(`
  // inside a comment or a string is not an occurrence at all, while the id and the lanes
  // argument are still read as literally written.
  const code = blankNonCode(smokeSrc);
  const checks = new Map<string, SmokeCheck>();
  const callRe = /\bcheck\(/g;
  let m: RegExpExecArray | null;
  m = callRe.exec(code);
  while (m !== null) {
    const open = m.index + m[0].length - 1;
    const args = splitCallArgs(code, open)?.map(([s, e]) => smokeSrc.slice(s, e));
    const idMatch = args?.[0]?.match(/^\s*['"]([a-z])\.\s/);
    if (args && idMatch && checks.has(idMatch[1])) {
      checks.set(idMatch[1], {
        id: idMatch[1],
        hardLanes: new Set<Lane>(),
        reason:
          'ambiguous — declared more than once; a second `check(` occurrence for this id ' +
          '(including one inside a comment or a string) must never redefine it',
      });
      m = callRe.exec(code);
      continue;
    }
    if (args && idMatch) {
      const id = idMatch[1];
      const body = args[1] ?? '';
      // A third argument may itself be split across top-level commas only if it is not a
      // lane array; re-joining keeps such a case unparseable, i.e. fail-closed.
      const laneArg = args.length > 2 ? args.slice(2).join(',') : null;
      const scoped = laneScope(laneArg);
      // skip-on-fail checks call `skip(...)` to downgrade a failure; hard on NO lane.
      const skips = /\bskip\(/.test(body);
      checks.set(id, {
        id,
        hardLanes: skips ? new Set<Lane>() : scoped.lanes,
        reason: skips ? 'body calls skip() — a skip-on-fail check is never hard' : scoped.reason,
      });
    }
    m = callRe.exec(code);
  }
  return checks;
}

/**
 * The STRUCTURED marker a row uses to declare that its claim is scoped to one lane, e.g.
 * `| Bun keep-alive guard (lane: bun) | ✅ | …`. Deliberately not free prose (round 2):
 * keying the scope on wording across feature+evidence+notes misfired both ways — the old
 * `/(node|bun)[\s-]lane[\s-]only/` matched `the bun lane only runs weekly (schedule), not
 * per-PR`, entirely plausible prose for THIS matrix, and silently WEAKENED that row, while
 * `only on the bun lane` and `verified on bun only` did not open the valve at all. That is
 * the "encodes yesterday's wording" class this repo rejects elsewhere.
 */
const LANE_MARKER_RE = /\(\s*lane:\s*(node|bun)\s*\)/gi;
/** Named in every failure message, so a legitimately scoped row is discoverable. */
const LANE_MARKER_FORM = "the marker `(lane: node)` / `(lane: bun)` in the row's Feature cell";

/**
 * The lanes a matrix row CLAIMS. Both, unless the FEATURE cell carries exactly one lane
 * marker — that opt-out is what keeps a genuinely runtime-specific check (h, the bun
 * keep-alive guard contract) expressible without weakening the guard: it may back a ✅ row,
 * but only a row that declares the restriction instead of reading as unconditional.
 *
 * FAILS CLOSED: no marker, an unreadable one, or two conflicting ones all yield the
 * STRICTEST claim (both lanes). Only the Feature cell counts — Evidence and Notes are
 * prose, and prose must never narrow a claim.
 */
function claimedLanes(row: MatrixRow): Lane[] {
  const found = new Set<Lane>();
  for (const m of row.feature.matchAll(LANE_MARKER_RE)) {
    found.add(m[1].toLowerCase() as Lane);
  }
  return found.size === 1 ? [...found] : [...ALL_LANES];
}

/**
 * Problems with a ✅ row's compat-smoke citations: a cited check must be a hard,
 * red-on-fail gate on EVERY lane the row claims. Non-✅ rows are never a problem.
 */
function smokeCitationProblems(row: MatrixRow, checks: Map<string, SmokeCheck>): string[] {
  if (!row.status.includes('✅')) return [];
  const claimed = claimedLanes(row);
  const problems: string[] = [];
  for (const cite of citations(row.evidence)) {
    const idMatch = cite.match(/(?:smoke|check)\s*\(?([a-z])\)?$/i);
    if (!idMatch) continue;
    const id = idMatch[1].toLowerCase();
    const check = checks.get(id);
    if (!check) {
      problems.push(`cites compat-smoke check (${id}), which does not exist in the runner`);
      continue;
    }
    const missing = claimed.filter((lane) => !check.hardLanes.has(lane));
    if (missing.length > 0) {
      problems.push(
        `cites check (${id}), which is not a hard, red-on-fail gate on lane(s) ` +
          `${missing.join(', ')}${check.reason ? ` — ${check.reason}` : ''}. ` +
          `If this row is genuinely scoped to one lane, declare it with ${LANE_MARKER_FORM} ` +
          '— free prose such as "bun lane only" does NOT scope a row.',
      );
    }
  }
  return problems;
}

/** True iff the cited check backs this row on every lane the row claims. */
function backsRow(row: MatrixRow, id: string, checks: Map<string, SmokeCheck>): boolean {
  const check = checks.get(id);
  if (!check) return false;
  return claimedLanes(row).every((lane) => check.hardLanes.has(lane));
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
  const smokeChecks = parseSmokeChecks(smokeSrc);
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
        const idMatch = cite.match(/(?:smoke|check)\s*\(?([a-z])\)?$/i);
        if (idMatch && backsRow(row, idMatch[1].toLowerCase(), smokeChecks)) return true;
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

  it('the four T4 capability checks are HARD ON BOTH LANES, so a ✅ row may cite them', () => {
    // next/image (g), Server Actions (i), Streaming/Suspense (j), ISR (k) — the four rows
    // that were implemented-but-unbacked. Hardness is SCANNED from the runner, so if any of
    // them regains a skip-on-fail path OR is narrowed to one lane, this assertion is what reds.
    for (const id of ['g', 'i', 'j', 'k']) {
      const check = smokeChecks.get(id);
      expect(check, `compat-smoke check (${id}) is not present in the runner`).toBeDefined();
      expect(
        [...ALL_LANES].filter((lane) => !check?.hardLanes.has(lane)),
        `compat-smoke check (${id}) is not a hard, red-on-fail check on every lane` +
          `${check?.reason ? ` — ${check.reason}` : ''}`,
      ).toEqual([]);
    }
  });

  it('no ✅ row cites a check that skips — on failure OR by lane (#655)', () => {
    for (const row of rows) {
      expect(
        smokeCitationProblems(row, smokeChecks),
        `✅ row "${row.feature}" is not backed on every lane it claims`,
      ).toEqual([]);
    }
  });

  // ── Lane-aware hardness derivation (#655) ─────────────────────────────────────────────
  //
  // BOTH HALVES. The real-source assertions above go green whether or not the derivation can
  // actually SEE a lane restriction — a parser hardwired to "both lanes" satisfies every one
  // of them, because no check is lane-narrowed today. The synthetic fixtures below are the
  // other half: they feed the derivation a restriction and assert it is observed. Without
  // them the guard is decoration.

  describe('the derivation reads the lanes argument, not just the body (#655)', () => {
    /** A minimal but structurally faithful excerpt of the runner. */
    const fixture = (call: string) => `
async function main() {
  await check('a. baseline both-lane check', async () => {
    assert.equal(res.status, 200);
    return \`200 \${res.bytes}B\`;
  });

  ${call}

  printReport();
}
`;

    it('NOT GREEN BY SKIP: the real runner is actually parsed (a–k all present)', () => {
      // If SMOKE_PATH ever stops being readable/parseable, every lane assertion above would
      // pass vacuously over an empty map. This is what makes that impossible.
      expect(existsSync(SMOKE_PATH)).toBe(true);
      expect(smokeSrc.length).toBeGreaterThan(1000);
      // SUPERSET, not an equality on the id string: adding a twelfth check (l) is a
      // legitimate change and must not red this guard, because "edit the guard to get
      // green" is exactly the antipattern `security.md` names for release-action-pins.
      // Losing or renaming one of the known ids still reds.
      const ids = new Set(smokeChecks.keys());
      for (const id of KNOWN_SMOKE_IDS) {
        expect(ids.has(id), `the runner parse lost compat-smoke check (${id})`).toBe(true);
      }
      // …and the COUNT is DERIVED from the runner rather than written down, so an
      // invented or swallowed id still reds while growth stays free.
      const declared = declaredCheckCount(smokeSrc);
      expect(declared, 'no `await check(` declarations found in the runner').toBeGreaterThanOrEqual(
        KNOWN_SMOKE_IDS.length,
      );
      expect(
        smokeChecks.size,
        'the runner parse lost or invented check ids: the code-only `await check(` declaration ' +
          'count disagrees with the parse (a duplicated id, or a call whose id is unparseable)',
      ).toBe(declared);
    });

    // ── A `check(` occurrence that is not CODE (round 2, strengthened in round 4) ──────
    //
    // The scanner used to be context-aware only INSIDE a call it had entered; nothing
    // decided whether the `check(` it entered was code at all. Combined with a
    // last-write-wins map, a later occurrence inside a comment or a string silently
    // overwrote the real entry with an unrestricted, both-lanes one — a documentation
    // comment could return the guard to green while the runner genuinely read
    // `}, ['node']);`. Round 2 made a repeated id AMBIGUOUS; round 4 removed the premise
    // instead, by scanning a code-only view, so a non-code occurrence is not an
    // occurrence. The assertion that matters is unchanged and is the reason these tests
    // exist: a comment or a string must never widen `g` back to the bun lane.

    const NODE_ONLY_G = `await check('g. next/image optimization (transcode + resize)', async () => {
    return 'ok';
  }, ['node']);`;

    it('a COMMENT restating a check cannot launder a lane-narrowed id back to both lanes', () => {
      const checks = parseSmokeChecks(
        fixture(`${NODE_ONLY_G}

  // NOTE: the canonical form of this check is
  //   await check('g. next/image optimization (transcode + resize)', imageFn);`),
      );
      expect([...(checks.get('g')?.hardLanes ?? [])]).toEqual(['node']);
      expect(checks.get('g')?.hardLanes.has('bun')).toBe(false);
      expect(checks.get('g')?.reason).toMatch(/lane-scoped/);
    });

    it('a STRING containing a check call is equally powerless', () => {
      const checks = parseSmokeChecks(
        fixture(`${NODE_ONLY_G}

  const HELP = "await check('g. next/image optimization (transcode + resize)', imageFn);";`),
      );
      expect([...(checks.get('g')?.hardLanes ?? [])]).toEqual(['node']);
      expect(checks.get('g')?.hardLanes.has('bun')).toBe(false);
      expect(checks.get('g')?.reason).toMatch(/lane-scoped/);
    });

    it('a duplicate id fails closed even when BOTH occurrences are real code', () => {
      const checks = parseSmokeChecks(
        fixture(`${NODE_ONLY_G}

  await check('g. next/image optimization (transcode + resize)', async () => {
    return 'ok';
  });`),
      );
      expect([...(checks.get('g')?.hardLanes ?? [])]).toEqual([]);
      expect(checks.get('g')?.reason).toMatch(/declared more than once/);
    });

    it('a ✅ row citing an ambiguously-declared check FAILS the guard', () => {
      const checks = parseSmokeChecks(
        fixture(`${NODE_ONLY_G}

  await check('g. next/image optimization (transcode + resize)', async () => {
    return 'ok';
  });`),
      );
      const row: MatrixRow = {
        feature: 'next/image optimization',
        status: '✅',
        evidence: 'smoke g',
        notes: '',
      };
      expect(smokeCitationProblems(row, checks).length).toBe(1);
      expect(backsRow(row, 'g', checks)).toBe(false);
    });

    // ── A `check(` occurrence that is not CODE, part 2: BLOCK comments (round 4) ───────
    //
    // Round 2 closed the case where a non-code occurrence REDEFINED an existing id, via the
    // repeated-id⇒ambiguous rule. It did not close the case where the non-code occurrence is
    // the ONLY one for that id — a check commented out (`/* TEMPORARILY DISABLED … */`) still
    // read as declared, hard, and both-lane, and a ✅ row could cite an id that exists only
    // inside a comment. Both derivations agreed on the wrong answer, because the count regex
    // matched the commented line too. Occurrences are now scanned over a CODE-ONLY view of
    // the source, so a comment or a string declares nothing at all.

    it('a check commented OUT with a block comment is not declared at all', () => {
      const checks = parseSmokeChecks(
        fixture(`/* TEMPORARILY DISABLED (flaky on CI runners):
  await check('g. next/image optimization (transcode + resize)', async () => {
    return 'ok';
  });
  */`),
      );
      expect(checks.has('g'), 'a block-commented check must not read as declared').toBe(false);
      // …and the baseline check in the fixture is still parsed, so this is not a total misparse.
      expect([...(checks.get('a')?.hardLanes ?? [])].sort()).toEqual(['bun', 'node']);
    });

    it('a ✅ row citing a check that exists only inside a block comment FAILS the guard', () => {
      const checks = parseSmokeChecks(
        fixture(`/* new capability, landing next sprint:
  await check('l. brand-new capability', async () => {
    return 'ok';
  });
  */`),
      );
      const row: MatrixRow = {
        feature: 'Brand-new capability',
        status: '✅',
        evidence: 'smoke l',
        notes: '',
      };
      expect(smokeCitationProblems(row, checks)).toEqual([
        'cites compat-smoke check (l), which does not exist in the runner',
      ]);
      expect(backsRow(row, 'l', checks)).toBe(false);
    });

    it('a block comment INSIDE a live check body does not swallow the checks after it', () => {
      const checks = parseSmokeChecks(
        fixture(`await check('z. node-only check', async () => {
    /* explanatory note, with an unbalanced ( paren and a ' quote */
    return 'ok';
  }, ['node']);`),
      );
      expect([...(checks.get('z')?.hardLanes ?? [])]).toEqual(['node']);
      expect([...(checks.get('a')?.hardLanes ?? [])].sort()).toEqual(['bun', 'node']);
    });

    it('the derived declaration COUNT is code-only and not line-anchored (round 4)', () => {
      // Two shapes the anchored `^\s*await check\(` regex got wrong, in opposite directions:
      // it MISSED a legitimate conditional one-liner (a false red whose message blamed the
      // parse), and it COUNTED a commented-out declaration (agreeing with the pre-round-4
      // parse on the wrong answer). One derivation, over the same code-only view.
      expect(
        declaredCheckCount(`  if (process.env.EXTRA) await check('z. conditional', fn);`),
      ).toBe(1);
      expect(declaredCheckCount(`  // await check('z. commented out', fn);`)).toBe(0);
      expect(declaredCheckCount(`  /* await check('z. commented out', fn); */`)).toBe(0);
      expect(declaredCheckCount(`  const HELP = "await check('z. in a string', fn);";`)).toBe(0);
      expect(declaredCheckCount(`  await check('z. plain', fn);`)).toBe(1);
    });

    it('a check with no lanes argument is hard on both lanes', () => {
      const checks = parseSmokeChecks(fixture(''));
      expect([...(checks.get('a')?.hardLanes ?? [])].sort()).toEqual(['bun', 'node']);
    });

    it('a check narrowed to ["node"] is NOT hard on the bun lane', () => {
      const checks = parseSmokeChecks(
        fixture(`await check('z. node-only check', async () => {
    assert.ok(true);
  }, ['node']);`),
      );
      expect([...(checks.get('z')?.hardLanes ?? [])]).toEqual(['node']);
      expect(checks.get('z')?.reason).toMatch(/lane-scoped/);
    });

    it('a check narrowed to ["bun"] is NOT hard on the node lane', () => {
      const checks = parseSmokeChecks(
        fixture(`await check('z. bun-only check', async () => {
    return 'ok';
  }, ['bun']);`),
      );
      expect([...(checks.get('z')?.hardLanes ?? [])]).toEqual(['bun']);
    });

    it('FAILS CLOSED on a lanes argument laundered through indirection', () => {
      // `['node']` behind a variable must not read as "hard on both lanes" — that would be
      // the same loophole with one extra step.
      const checks = parseSmokeChecks(
        fixture(`await check('z. indirect lanes', async () => {
    return 'ok';
  }, NODE_ONLY);`),
      );
      expect([...(checks.get('z')?.hardLanes ?? [])]).toEqual([]);
      expect(checks.get('z')?.reason).toMatch(/not a literal lane array/);
    });

    it('FAILS CLOSED on an empty or unknown lane list', () => {
      const empty = parseSmokeChecks(
        fixture(`await check('z. empty lanes', async () => {
    return 'ok';
  }, []);`),
      );
      expect([...(empty.get('z')?.hardLanes ?? [])]).toEqual([]);
      const unknown = parseSmokeChecks(
        fixture(`await check('z. unknown lane', async () => {
    return 'ok';
  }, ['deno']);`),
      );
      expect([...(unknown.get('z')?.hardLanes ?? [])]).toEqual([]);
    });

    it('still demotes a skip-on-fail body (the original half is not lost)', () => {
      const checks = parseSmokeChecks(
        fixture(`await check('z. skip-on-fail check', async () => {
    if (!process.env.REDIS_URL) return skip('no redis');
    return 'ok';
  });`),
      );
      expect([...(checks.get('z')?.hardLanes ?? [])]).toEqual([]);
    });

    it('a ✅ row citing a lane-narrowed check FAILS the guard', () => {
      const checks = parseSmokeChecks(
        fixture(`await check('z. node-only check', async () => {
    return 'ok';
  }, ['node']);`),
      );
      const row: MatrixRow = {
        feature: 'Some capability',
        status: '✅',
        evidence: 'smoke z',
        notes: 'reads as unconditional, but never runs on the bun lane',
      };
      const problems = smokeCitationProblems(row, checks);
      expect(problems.length).toBe(1);
      expect(problems[0]).toMatch(/not a hard, red-on-fail gate on lane\(s\) bun/);
      expect(backsRow(row, 'z', checks)).toBe(false);
    });

    // ── The lane opt-out is a STRUCTURED MARKER, not free prose (round 2) ──────────────
    //
    // Keying the row's scope on prose across feature+evidence+notes misfired in BOTH
    // directions: `the bun lane only runs weekly (schedule), not per-PR` — entirely
    // plausible prose for THIS matrix, whose Bun row documents a weekly schedule — matched
    // and silently WEAKENED the row, while `only on the bun lane` did not open the valve at
    // all and the failure message never named the phrase that would. That is the "encodes
    // yesterday's wording" class this repo rejects elsewhere. The declaration is now the
    // marker `(lane: bun)` in the FEATURE cell, and the failure message names it.

    it('incidental PROSE about a lane never narrows a row (the false-positive half)', () => {
      const checks = parseSmokeChecks(
        fixture(`await check('z. node-only check', async () => {
    return 'ok';
  }, ['node']);`),
      );
      for (const notes of [
        'the bun lane only runs weekly (schedule), not per-PR',
        'only on the bun lane',
        'verified on bun only',
        'node lane only',
      ]) {
        const row: MatrixRow = {
          feature: 'Some capability',
          status: '✅',
          evidence: 'smoke z',
          notes,
        };
        expect([...claimedLanes(row)].sort(), `prose narrowed the row: "${notes}"`).toEqual([
          'bun',
          'node',
        ]);
        expect(smokeCitationProblems(row, checks).length).toBe(1);
      }
    });

    it('the declaration is the marker `(lane: …)` and only in the Feature cell', () => {
      const base: MatrixRow = { feature: 'x', status: '✅', evidence: '', notes: '' };
      expect(claimedLanes({ ...base, feature: 'Bun keep-alive guard (lane: bun)' })).toEqual([
        'bun',
      ]);
      expect(claimedLanes({ ...base, feature: 'Something (lane: node)' })).toEqual(['node']);
      // Evidence/Notes are prose cells; a marker there does NOT scope the row.
      expect(
        [...claimedLanes({ ...base, evidence: '(lane: bun)', notes: '(lane: bun)' })].sort(),
      ).toEqual(['bun', 'node']);
      // Two conflicting markers are ambiguous — fail closed to the strictest claim.
      expect([...claimedLanes({ ...base, feature: 'x (lane: bun) (lane: node)' })].sort()).toEqual([
        'bun',
        'node',
      ]);
    });

    it('the failure message NAMES the marker form, so a scoped row is discoverable', () => {
      const checks = parseSmokeChecks(
        fixture(`await check('z. node-only check', async () => {
    return 'ok';
  }, ['node']);`),
      );
      const row: MatrixRow = {
        feature: 'Some capability',
        status: '✅',
        evidence: 'smoke z',
        notes: '',
      };
      const [problem] = smokeCitationProblems(row, checks);
      expect(problem).toMatch(/\(lane: bun\)/);
      expect(problem).toMatch(/Feature cell/i);
    });

    it('a genuinely runtime-specific check stays expressible if the row SAYS so (h)', () => {
      // The escape valve that keeps this from pushing authors toward deleting (h) or faking
      // a lane: a lane-scoped check may back a ✅ row that declares the same lane scope.
      const checks = parseSmokeChecks(
        fixture(`await check('z. bun keep-alive guard contract', async () => {
    return 'ok';
  }, ['bun']);`),
      );
      const scoped: MatrixRow = {
        feature: 'Bun keep-alive guard (lane: bun)',
        status: '✅',
        evidence: 'smoke z',
        notes: 'A node-lane claim would be dishonest; the row says so.',
      };
      expect(smokeCitationProblems(scoped, checks)).toEqual([]);
      expect(backsRow(scoped, 'z', checks)).toBe(true);
      // …but the SAME check cannot back an unscoped row.
      const unscoped: MatrixRow = { ...scoped, feature: 'Keep-alive', notes: '' };
      expect(smokeCitationProblems(unscoped, checks).length).toBe(1);
    });

    it('a non-✅ row is never a problem (an honest ⚠️/❌ needs no lane backing)', () => {
      const checks = parseSmokeChecks(
        fixture(`await check('z. node-only check', async () => {
    return 'ok';
  }, ['node']);`),
      );
      expect(
        smokeCitationProblems(
          { feature: 'x', status: '⚠️', evidence: 'smoke z', notes: '' },
          checks,
        ),
      ).toEqual([]);
    });
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
    // Scan feature AND evidence (like the pre-graduation rule did): a row that
    // claims official-suite backing via its Evidence cell is held to the same
    // contract as the row that names the suite in its Feature cell.
    const officialRows = rows.filter(
      (r) => /official/i.test(r.feature) || /official/i.test(r.evidence),
    );

    it('exactly one row NAMES the official suite (the Node credential row)', () => {
      // The CREDENTIAL row — "Official Next.js compatibility suite" — must be
      // unique. The Bun runtime-axis lane row (also /official/i, see below) is
      // a separate, subordinate claim and is counted separately.
      expect(
        rows.filter((r) => /official next\.js compatibility suite/i.test(r.feature)).length,
      ).toBe(1);
    });

    it('every official-claiming row is one of the known lane rows', () => {
      // No unnamed row may ride the word "official" into the evidence contract's
      // blind spot: anything claiming official-suite backing is one of the known
      // rows — the Node credential, the Bun runtime axis, and (#608) the vinext
      // single-executable axis, the lane that runs the same corpus against the
      // artifact ADR-0048 actually ships. Each is still held INDIVIDUALLY to the
      // ✅ evidence contract by the test below, so widening this allowlist buys
      // a row no ceremony — only the right to exist while it is ❌.
      const unknown = rows.filter(
        (r) =>
          /official/i.test(r.feature) &&
          !/official next\.js compatibility suite/i.test(r.feature) &&
          !/bun runtime axis/i.test(r.feature) &&
          !/vinext single-executable axis/i.test(r.feature),
      );
      expect(
        unknown.map((r) => r.feature),
        'unexpected extra official-claiming row(s)',
      ).toEqual([]);
    });

    it('enforces the evidence contract IFF a row is ✅ — an honest ❌ flip-back is always free', () => {
      expect(officialRows.length).toBeGreaterThan(0);
      for (const row of officialRows) {
        // NEVER enforce the ✅ itself: if a red nightly makes someone honestly flip
        // the row back to ❌ (or ⚠️), this guard must pass without ceremony — the
        // honesty gradient only ever points AWAY from overclaiming. Evidence is
        // required if-and-only-if the ✅ is claimed.
        if (!row.status.includes('✅')) continue;
        expect(
          officialFlipProblems(row),
          `official-claiming ✅ row "${row.feature}" evidence is incomplete: "${row.notes.slice(0, 200)}…"`,
        ).toEqual([]);
      }
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

  // ── Bun runtime-axis row (#147 item 4) ──────────────────────────────────────
  //
  // The Node ✅ above is a NODE claim (run 28602886003, KNEXT_RUNTIME=node). The
  // workflow now carries a SEPARATE Bun lane (dispatch input + weekly schedule),
  // but a lane EXISTING is not a lane PASSING: the Bun row must stay honest
  // (❌ "first green pending") until a green KNEXT_RUNTIME=bun run is observed,
  // and any future ✅ flip is held to the SAME evidence contract as the Node row
  // (run ID + pinned ref + "N passed / 0 failed") — plus it must name the bun
  // lane so a Node run ID can never be laundered into Bun evidence.

  describe('Bun runtime-axis row — separate lane, evidence-gated like the credential row (#147 item 4)', () => {
    const bunRows = rows.filter((r) => /bun runtime axis/i.test(r.feature));

    it('has exactly one Bun runtime-axis row', () => {
      expect(bunRows.length).toBe(1);
    });

    it('the Bun row is captured by the official-suite evidence contract (names "official")', () => {
      // officialRows above filters on /official/i in feature or evidence; the
      // Bun row must fall inside that net so a ✅ flip can never dodge the
      // run-ID + ref + "0 failed" contract.
      const row = bunRows[0];
      expect(/official/i.test(row?.feature ?? '') || /official/i.test(row?.evidence ?? '')).toBe(
        true,
      );
    });

    it('a non-✅ Bun row states honestly that the first green run is pending', () => {
      const row = bunRows[0];
      if (!row || row.status.includes('✅')) return; // once green, the next test governs
      expect(
        /pending|no green|not (yet )?green|never (run|gone green)/i.test(row.notes),
        'the pre-green Bun row must say the green run is pending (lane exists ≠ lane passes)',
      ).toBe(true);
      // And it must not present the Node run's numbers as its own result: the
      // "N passed / 0 failed" result shape is reserved for a real run of THIS lane.
      expect(
        RESULT_RE.test(`${row.evidence} ${row.notes}`),
        'a non-✅ Bun row must not carry a "N passed / 0 failed" result (that shape claims a green run)',
      ).toBe(false);
    });

    it('a ✅ Bun row requires the full evidence contract AND must name the bun lane', () => {
      const row = bunRows[0];
      if (!row || !row.status.includes('✅')) return; // enforced IFF ✅ (flip-back stays free)
      expect(
        officialFlipProblems(row),
        'a ✅ Bun row needs run ID + pinned ref + "N passed / 0 failed" like the Node row',
      ).toEqual([]);
      expect(
        /bun/i.test(`${row.evidence} ${row.notes}`),
        'a ✅ Bun row must name the bun lane (runtime=bun) so the run is attributable',
      ).toBe(true);
    });
  });
});
