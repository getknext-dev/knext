/**
 * SHARED compat LANE LEDGER (F5, #281/#282 — ADR-0007 §c/§d).
 *
 * Completes the lane-scoped compat-ledger acceptance criteria on top of the
 * schema landed by #325/#329 (which tagged each `$knextQuarantines` entry with a
 * `lane` + `family` and capped families via {@link ./compat-quarantine-bounds}):
 *
 *   1. LANE-SCOPED CASES (#281). A compat case declares the lane(s) it applies to
 *      ({@link CompatCase.lanes}); the runner FILTERS by lane ({@link casesForLane})
 *      and a per-lane verdict ({@link laneVerdict}) is computed over ONLY that
 *      lane's results — so a node-lane failure can never red the bun lane, and
 *      vice-versa. This mirrors the Node-credential / Bun-runtime-axis split the
 *      compat-matrix already draws; it is accounting, NOT a new parity claim.
 *
 *   2. PER-LANE SUMMARY (#281). {@link summarizeLedger} prints passing /
 *      quarantined / failing PER LANE, and {@link renderLaneSummaryMarkdown}
 *      renders it as a table the parity doc (docs/compat-matrix.md) can embed.
 *
 *   3. DATED + UPSTREAM-REFERENCED QUARANTINES (#282). {@link quarantineEntryProblems}
 *      enforces the entry SHAPE that keeps quarantine honest: every entry must
 *      carry (a) a DATED justification — an ISO date OR a CI run id (a timestamped,
 *      auditable artifact) — AND (b) an UPSTREAM reference (a vercel/next.js issue,
 *      a knext issue/PR, or a run id). Criterion 4: a quarantine may only cover a
 *      KNOWN-UPSTREAM gap — an entry with no upstream cause is a REGRESSION being
 *      hidden and is rejected. The per-family CAP is enforced separately by
 *      {@link ./compat-quarantine-bounds} (deploy-manifest-lanes.test.ts).
 *
 * Pure + dependency-free so both the vitest guards and any doc-generation script
 * can import it.
 */

/** The two lanes the compat-matrix already splits on (Node credential + Bun axis). */
export const LANES = ['node', 'bun'] as const;
export type Lane = (typeof LANES)[number];

/** A single quarantine ledger entry (a subset of the manifest's `$knextQuarantines`). */
export interface QuarantineEntry {
  test: string;
  cases?: string[];
  mechanism?: string;
  evidence?: string;
  provenance?: string;
  nextjsRef?: string;
  reaudited?: string;
  level?: 'case' | 'file';
  /** The matrix lane this quarantine is accounted against (default "node"). */
  lane?: Lane;
  /** The mechanism-family the entry belongs to (soft-bounded per family). */
  family?: string;
  /** An optional explicit dated-justification field (ISO date). */
  dated?: string;
}

/** A compat case declaring the lane(s) it applies to (#281). */
export interface CompatCase {
  id: string;
  lanes: Lane[];
}

/** The result of running one compat case on one lane. */
export interface CaseResult {
  id: string;
  lane: Lane;
  passed: boolean;
}

/** The per-lane accounting the ledger prints for the parity docs. */
export interface LaneSummary {
  lane: Lane;
  passing: number;
  quarantined: number;
  failing: number;
}

/** The subset of `cases` that apply to `lane` (the runner's lane filter, #281). */
export function casesForLane(cases: CompatCase[], lane: Lane): CompatCase[] {
  return cases.filter((c) => c.lanes.includes(lane));
}

/**
 * The verdict for ONE lane, computed over ONLY that lane's results. Because a
 * lane's verdict never reads another lane's results, a node-lane failure leaves
 * the bun lane green (and vice-versa) — the core #281 guarantee.
 */
export function laneVerdict(
  results: CaseResult[],
  lane: Lane,
): { lane: Lane; failing: string[]; green: boolean } {
  const inLane = results.filter((r) => r.lane === lane);
  const failing = inLane.filter((r) => !r.passed).map((r) => r.id);
  return { lane, failing, green: failing.length === 0 };
}

/** Count quarantine entries per lane (default lane is "node"). */
function quarantinedPerLane(entries: QuarantineEntry[]): Record<Lane, number> {
  const counts: Record<Lane, number> = { node: 0, bun: 0 };
  for (const q of entries) counts[q.lane ?? 'node']++;
  return counts;
}

/**
 * The per-lane ledger summary (#281): passing / quarantined / failing per lane.
 * `results` is optional — when omitted (schema-only guards) passing/failing are 0
 * and only the quarantine accounting is populated. EVERY lane is always emitted
 * so no lane can silently vanish.
 */
export function summarizeLedger(input: {
  quarantines: QuarantineEntry[];
  results?: CaseResult[];
}): LaneSummary[] {
  const q = quarantinedPerLane(input.quarantines);
  const results = input.results ?? [];
  return LANES.map((lane) => {
    const inLane = results.filter((r) => r.lane === lane);
    return {
      lane,
      passing: inLane.filter((r) => r.passed).length,
      quarantined: q[lane],
      failing: inLane.filter((r) => !r.passed).length,
    };
  });
}

/** Render the per-lane summary as a Markdown table the parity doc can embed. */
export function renderLaneSummaryMarkdown(summaries: LaneSummary[]): string {
  const header = '| Lane | Passing | Quarantined | Failing |';
  const sep = '| --- | --- | --- | --- |';
  const rows = summaries.map(
    (s) => `| ${s.lane} | ${s.passing} | ${s.quarantined} | ${s.failing} |`,
  );
  return [header, sep, ...rows].join('\n');
}

/** An ISO date token, e.g. "2026-07-05". */
const ISO_DATE_RE = /\b20\d{2}-\d{2}-\d{2}\b/;
/** A CI run id — a timestamped, auditable artifact that counts as dated evidence. */
const RUN_ID_RE = /\brun\s+\d{6,}\b/i;
/**
 * An UPSTREAM reference: a vercel/next.js issue/PR, a bare next.js#NNNNN, a knext
 * issue/PR (#NNN), or a CI run id. A quarantine with none of these is not pinned
 * to a known-upstream gap — it is a regression being hidden.
 */
const UPSTREAM_RE = /(vercel\/next\.js#\d+|next\.js#\d+|#\d{3,6}|\brun\s+\d{6,})/i;

/**
 * The problems (empty === valid) with a quarantine entry's SHAPE (#282, criterion 4):
 *   - it must carry a DATED justification (an ISO date OR a CI run id), and
 *   - it must cite an UPSTREAM reference (issue / PR / run id) so a quarantine can
 *     only ever cover a known-upstream gap, never silently hide a regression.
 */
export function quarantineEntryProblems(e: QuarantineEntry): string[] {
  const blob = [e.dated, e.evidence, e.provenance, e.mechanism, e.reaudited, e.nextjsRef]
    .filter(Boolean)
    .join(' ');
  const problems: string[] = [];
  const isDated = ISO_DATE_RE.test(blob) || RUN_ID_RE.test(blob);
  if (!isDated) {
    problems.push(
      `${e.test}: quarantine needs a DATED justification — an ISO date (2026-07-05) or a CI ` +
        `run id (run 28593534713) in evidence/provenance/dated`,
    );
  }
  if (!UPSTREAM_RE.test(blob)) {
    problems.push(
      `${e.test}: quarantine needs an UPSTREAM reference (vercel/next.js#NNNNN, a knext #NNN, ` +
        `or a run id) — a quarantine may only cover a known-upstream gap, never hide a regression`,
    );
  }
  return problems;
}
