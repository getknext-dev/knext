/**
 * Sharding, planning and aggregation for the multi-ref mutation-prover lane
 * (#2499 / #2208). Pure: nothing here spawns, reads the tree or touches git on
 * import, so every rule that has been WRONG is testable without paying for a
 * mutation (`tests/mutation-prover-lane-sharding.test.ts`).
 *
 * WHY THE LANE IS SHARDED. It was ONE serial job over every prover under a
 * 100-minute ceiling, and the last five runs were cancelled at that ceiling.
 * Measured on run 38140088966: 40 provers took 53 minutes, then one prover ran
 * 47 minutes with no bound of its own until the job was cancelled, and ninety
 * never started. Sharding gives each slice its own timeout; the per-prover bound
 * (see `run-mutation-provers.mjs`) means one hang costs one prover, not the night.
 *
 * WHY AN AGGREGATE. Splitting a lane is how a prover quietly falls out of it: a
 * leg that is cancelled, a shard function that drops an index, a discovery that
 * differs between legs. The aggregate proves, from the legs' own reports, that
 * every leg reported, every leg proved the same tree, the shards' union is the
 * discovered set exactly once, and declared == run for every prover. A missing
 * piece is a finding, never a skip.
 */

/**
 * The refs the SCHEDULED lane covers. A schedule only fires from the default
 * branch, so `main`'s workflow file is the one that runs, and it reaches the
 * v2 provers by checking the ref out — they exist nowhere else.
 */
export const LANE_REFS = Object.freeze(['main', 'integration/v2']);

/** A branch-ish ref. No leading dash, no `..`, no shell or YAML metacharacters. */
const SAFE_REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * @param {string} spec  `"<index>/<count>"`, 1-based
 * @returns {{ index: number, count: number }}
 */
export function parseShardSpec(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec));
  if (!m) throw new Error(`invalid shard ${JSON.stringify(spec)} — expected <index>/<count>`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1 || index < 1 || index > count) {
    throw new Error(`invalid shard ${spec} — need 1 <= index <= count`);
  }
  return { index, count };
}

/**
 * The provers of ONE shard: a function of the SET (sorted by path), never of
 * readdir order, so every leg computes the same partition independently.
 * Round-robin rather than contiguous ranges: provers that share a prefix
 * (`compat-*`, `2xxx-*`) are written together and are slow together, and a range
 * split would hand a whole family to one leg.
 *
 * @template {{ relPath: string }} P
 * @param {P[]} provers
 * @param {number} index 1-based
 * @param {number} count
 * @returns {P[]}
 */
export function shardProvers(provers, index, count) {
  parseShardSpec(`${index}/${count}`);
  return [...provers]
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    .filter((_, i) => i % count === index - 1);
}

/** A filesystem- and artifact-safe name for a ref. */
export function refSlug(ref) {
  return ref.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** The file one leg writes (and uploads) its report to. */
export function reportFileName(leg) {
  return `mutation-prover-report-${refSlug(leg.ref)}-${leg.shard}-of-${leg.shards}.json`;
}

/**
 * The matrix: one leg per ref x shard, each PINNED to a sha. A moving branch
 * name would let two legs of one ref prove different trees if a push landed
 * between their checkouts, and the aggregate could not tell that from a bug.
 *
 * @param {{ refs: Array<{ref: string, sha: string}>, shards: number, onlyShard?: number }} opts
 */
export function buildMatrix({ refs, shards, onlyShard }) {
  if (!Array.isArray(refs) || refs.length === 0)
    throw new Error('no refs to plan — nothing would be proved');
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`invalid shard count ${shards}`);
  if (
    onlyShard !== undefined &&
    (!Number.isInteger(onlyShard) || onlyShard < 1 || onlyShard > shards)
  ) {
    throw new Error(`only_shard ${onlyShard} is outside 1..${shards}`);
  }
  const include = [];
  for (const { ref, sha } of refs) {
    if (!SAFE_REF_RE.test(ref) || ref.includes('..'))
      throw new Error(`unsafe ref ${JSON.stringify(ref)}`);
    if (!SHA_RE.test(sha))
      throw new Error(`ref ${ref} resolved to a non-sha ${JSON.stringify(sha)}`);
    for (let shard = 1; shard <= shards; shard++) {
      if (onlyShard !== undefined && shard !== onlyShard) continue;
      include.push({
        ref,
        slug: refSlug(ref),
        sha,
        shard,
        shards,
        name: `${ref} ${shard}/${shards}`,
      });
    }
  }
  return { include };
}

/**
 * The report a leg writes. `assigned` is DERIVED from `discovered` by the same
 * function the aggregate re-runs, so a leg cannot claim a different slice than
 * the one it was entitled to.
 *
 * @param {{ ref: string, sha: string, shard: number, shards: number, discovered: string[],
 *           results: Array<{relPath: string, summary?: {declared:number, run:number}|null, findings: string[]}> }} r
 */
export function makeReport({ ref, sha, shard, shards, discovered, results }) {
  const sorted = [...discovered].sort();
  const assigned = shardProvers(
    sorted.map((relPath) => ({ relPath })),
    shard,
    shards,
  ).map((p) => p.relPath);
  return {
    version: 1,
    ref,
    sha,
    shard,
    shards,
    discovered: sorted,
    assigned,
    results: results.map((r) => ({
      relPath: r.relPath,
      declared: r.summary ? r.summary.declared : null,
      run: r.summary ? r.summary.run : null,
      findings: [...r.findings],
    })),
  };
}

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * Prove the lane from its legs' reports.
 *
 * @param {{ expected: Array<{ref: string, sha: string, shard: number, shards: number}>,
 *           reports: Array<object | undefined | null> }} input
 *   `reports[i]` is the report for `expected[i]` (`undefined` when the leg wrote
 *   none — cancelled, crashed, artifact lost).
 * @returns {{ findings: string[], partialRefs: string[] }}
 */
export function aggregateReports({ expected, reports }) {
  const findings = [];
  const partialRefs = [];
  if (!Array.isArray(expected) || expected.length === 0) {
    return {
      findings: [
        'the plan expected no legs at all — a lane that proves nothing is not a green lane',
      ],
      partialRefs,
    };
  }

  /** @type {Map<string, Array<{leg: any, report: any}>>} */
  const byRef = new Map();
  expected.forEach((leg, i) => {
    const label = `${leg.ref} ${leg.shard}/${leg.shards}`;
    const report = reports[i];
    const list = byRef.get(leg.ref) ?? [];
    list.push({ leg, report });
    byRef.set(leg.ref, list);
    if (!report || typeof report !== 'object') {
      findings.push(
        `${label}: no report — the leg was cancelled, crashed, or its artifact is missing`,
      );
      return;
    }
    if (report.sha !== leg.sha) {
      findings.push(`${label}: report is for sha ${report.sha}, the plan pinned ${leg.sha}`);
    }
    if (report.shard !== leg.shard || report.shards !== leg.shards) {
      findings.push(`${label}: report claims shard ${report.shard}/${report.shards}`);
    }
    if (!Array.isArray(report.discovered) || report.discovered.length === 0) {
      findings.push(`${label}: discovered zero provers — a vacuous green`);
      return;
    }
    const entitled = shardProvers(
      report.discovered.map((relPath) => ({ relPath })),
      leg.shard,
      leg.shards,
    ).map((p) => p.relPath);
    if (!Array.isArray(report.assigned) || !sameSet(entitled, report.assigned)) {
      findings.push(
        `${label}: assigned set differs from the deterministic shard of the discovered set — a prover would be in no shard or in two (union broken)`,
      );
    }
    const results = new Map((report.results ?? []).map((r) => [r.relPath, r]));
    for (const relPath of entitled) {
      const r = results.get(relPath);
      if (!r) {
        findings.push(
          `${label}: ${relPath} is assigned to this shard but missing from its results`,
        );
        continue;
      }
      for (const f of r.findings ?? []) findings.push(`${label}: ${relPath}: ${f}`);
      // Re-derive the count verdict rather than trusting `findings`: a report
      // that says "clean" with declared != run must still fail here.
      if (!Number.isInteger(r.declared) || !Number.isInteger(r.run)) {
        if ((r.findings ?? []).length === 0)
          findings.push(`${label}: ${relPath}: no declared/run counts`);
      } else if (r.declared === 0) {
        findings.push(`${label}: ${relPath}: declared zero mutations`);
      } else if (r.declared !== r.run) {
        if ((r.findings ?? []).length === 0) {
          findings.push(
            `${label}: ${relPath}: declared ${r.declared} mutation(s) but ran ${r.run}`,
          );
        }
      }
    }
  });

  for (const [ref, legs] of byRef) {
    const present = legs.filter((l) => l.report && Array.isArray(l.report.discovered));
    if (present.length === 0) continue;
    const first = present[0].report.discovered;
    for (const { leg, report } of present) {
      if (!sameSet(first, report.discovered)) {
        findings.push(
          `${ref} ${leg.shard}/${leg.shards}: discovered a different prover set than shard ${present[0].leg.shard} — the legs did not prove one tree`,
        );
      }
    }
    const shards = legs[0].leg.shards;
    const distinct = new Set(legs.map((l) => l.leg.shard));
    if (distinct.size < shards) {
      partialRefs.push(ref);
      continue;
    }
    const assignedAll = present.flatMap((l) => l.report.assigned ?? []);
    if (present.length === legs.length && !sameSet(first, assignedAll)) {
      findings.push(
        `${ref}: the shards' union is not the discovered set (a prover is in no shard or in two)`,
      );
    }
  }
  return { findings, partialRefs };
}

/** The per-prover bound, in ms. Overridable so the guard can use a short one. */
export function proverTimeoutMs(env = process.env) {
  const raw = env.KNEXT_PROVER_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 35 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `KNEXT_PROVER_TIMEOUT_MS must be a positive number of ms, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}
