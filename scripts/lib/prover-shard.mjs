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
 * Estimated wall-clock MINUTES of the provers that are not ~1 minute, by path.
 *
 * Sharding by COUNT put the slowest provers in one leg. Measured on run
 * 38140088966 (the cancelled one) the cost is wildly uneven: 40 provers took 53
 * minutes, one of them (`compat-cell-fingerprint`) 20 and another
 * (`bytecode-liveness`) 11; `empty-dir-guard` declares 58 mutations that each run
 * a ~30-60 s spec (so ~30-55 minutes on its own). The first live sharded run
 * (39002159226) then MEASURED three more: `kind-manifest-apply-safety` 67
 * minutes (111 mutations), `published-seam-scan` 26, `install-smoke-coverage`
 * 9.5. A count-balanced split put 100+ minutes in one leg and ~20 in others.
 *
 * These are ESTIMATES, used only to BALANCE legs. A stale weight makes a leg
 * longer or shorter; it cannot make a prover drop out, because the partition is
 * a pure function of the set and the aggregate re-proves the union. Any prover
 * not listed weighs 1.
 */
export const PROVER_WEIGHT_MINUTES = Object.freeze({
  // MEASURED on hosted runners: run 39016841640 (all six legs, integration/v2) unless
  // noted. Minutes are wall-clock for the whole prover.
  'scripts/mutation-prove-empty-dir-guard.mjs': 68,
  // 71 minutes on one runner (run 39016841640), but still on mutation 109 of 111
  // when a 100-minute bound killed it on another (run 39029215555).
  'scripts/mutation-prove-kind-manifest-apply-safety.mjs': 100,
  'scripts/mutation-prove-published-seam-scan.mjs': 27,
  'scripts/mutation-prove-2052-backendservice.mjs': 27,
  'scripts/mutation-prove-compat-cell-fingerprint.mjs': 20,
  'scripts/mutation-prove-2331-use-cache-tag-replay.mjs': 14,
  'scripts/mutation-prove-2462-operator-write-policy.mjs': 14,
  // 26 mutations, each a `go test` (the envtest rows start a real apiserver) or a bundle re-render.
  'scripts/mutation-prove-2500-write-policy-selfcheck.mjs': 12,
  // 12 minutes for 23 mutations with the per-leg cargo dir and generator dir adopted;
  // the earlier 60-minute estimate was the cold worst case.
  'scripts/mutation-prove-2489-rust-scaffold.mjs': 12,
  // MEASURED, run 39002159226: 11 and 9.5 minutes.
  'scripts/mutation-prove-bytecode-liveness.mjs': 11,
  'scripts/mutation-prove-install-smoke-coverage.mjs': 10,
  'scripts/mutation-prove-rust-template-auth.mjs': 10,
  'scripts/mutation-prove-publish-lane-supply-chain.mjs': 7,
  'scripts/mutation-prove-go-template-auth.mjs': 5,
  'scripts/mutation-prove-1533-kubeconfig-ci-secret.mjs': 5,
  'scripts/mutation-prove-2171-redis-prefix-isolation.mjs': 4,
  'scripts/mutation-prove-2051-rust-verifier.mjs': 4,
  // 27 rows each. ESTIMATES (local run), not yet measured on a hosted runner.
  'scripts/mutation-prove-2510-go-verifier.mjs': 4,
  'scripts/mutation-prove-2510-rust-verifier.mjs': 6,
  'scripts/mutation-prove-compat-window-packed-anchor.mjs': 4,
  'scripts/mutation-prove-compat-credential-freeze-guard.mjs': 2,
  'scripts/mutation-prove-compat-credential-line.mjs': 2,
  'scripts/mutation-prove-continuation-attribution.mjs': 2,
});

/**
 * Weighted provers that exist on ONE lane ref only (today: `integration/v2`).
 * This file is identical on `main` and `integration/v2`, so a measured weight for
 * a v2-only prover is legitimately "not discovered" on `main`. The rename-rot
 * guard accepts a weighted-but-absent path only if it is listed here, and it is
 * inert on a ref that lacks the prover (the partition only iterates what exists).
 * Drop an entry once the prover exists on both refs.
 */
export const WEIGHTED_ON_ONE_REF_ONLY = Object.freeze([
  'scripts/mutation-prove-published-seam-scan.mjs',
  'scripts/mutation-prove-2052-backendservice.mjs',
  'scripts/mutation-prove-2331-use-cache-tag-replay.mjs',
  'scripts/mutation-prove-2462-operator-write-policy.mjs',
  'scripts/mutation-prove-2500-write-policy-selfcheck.mjs',
  'scripts/mutation-prove-2489-rust-scaffold.mjs',
  'scripts/mutation-prove-rust-template-auth.mjs',
  'scripts/mutation-prove-go-template-auth.mjs',
  'scripts/mutation-prove-2171-redis-prefix-isolation.mjs',
  'scripts/mutation-prove-2051-rust-verifier.mjs',
  'scripts/mutation-prove-2510-go-verifier.mjs',
  'scripts/mutation-prove-2510-rust-verifier.mjs',
]);

/** @param {{ relPath: string }} p */
export const proverWeight = (p) => PROVER_WEIGHT_MINUTES[p.relPath] ?? 1;

/**
 * Provers that get a leg of their OWN, by path, with the reason.
 *
 * `mutation-prove-cdn-purge.mjs` row M03 (MAX_ATTEMPTS 3 -> 4) made the spec run
 * away: the retry back-off table had no fourth entry, `sleep(NaN)` poisoned the
 * fake clock, and the rate limiter then spun forever pushing to an array, taking
 * the hosted runner's 16 GB in seconds. The runner died with no log, TWICE, in the
 * same leg. The cause is fixed (the fake clock now refuses a non-finite sleep and
 * a runaway count) and the lane now kills a runaway prover, but a prover that has
 * once taken a runner down stays isolated: a loss then costs one prover, not the
 * 30 others that share its leg.
 *
 * The list is applied only where the prover EXISTS, and only when at least one
 * balanced leg remains, so the file stays identical on every ref. Isolated provers
 * take the LAST legs, one each; everything else is balanced over the rest.
 */
export const ISOLATED_PROVERS = Object.freeze([
  {
    prover: 'scripts/mutation-prove-cdn-purge.mjs',
    reason:
      'row M03 ran away with memory (NaN sleep spun a fake-clock loop) and killed the hosted runner twice',
  },
]);

const byPath = (a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);

/**
 * Longest-processing-time-first assignment: heaviest prover first, each to the
 * currently lightest leg (ties to the lowest index). Pure and deterministic, a
 * function of the SET and the weights, never of readdir order, so every leg
 * computes the same partition independently and the aggregate can recompute it.
 *
 * @param {Array<{ relPath: string }>} provers
 * @param {number} count
 * @returns {Map<string, number>} relPath -> 0-based shard
 */
function assignShards(provers, count) {
  const isolatedPaths = new Set(ISOLATED_PROVERS.map((i) => i.prover));
  let isolated = provers.filter((p) => isolatedPaths.has(p.relPath)).sort(byPath);
  // Isolation needs a balanced leg left over for everything else.
  if (isolated.length >= count) isolated = [];
  const taken = new Set(isolated.map((p) => p.relPath));
  const rest = provers.filter((p) => !taken.has(p.relPath));
  const balanced = count - isolated.length;
  const order = [...rest].sort((a, b) => proverWeight(b) - proverWeight(a) || byPath(a, b));
  const load = new Array(balanced).fill(0);
  const owner = new Map();
  for (const p of order) {
    let best = 0;
    for (let k = 1; k < balanced; k++) if (load[k] < load[best]) best = k;
    owner.set(p.relPath, best);
    load[best] += proverWeight(p);
  }
  isolated.forEach((p, i) => {
    owner.set(p.relPath, balanced + i);
  });
  return owner;
}

/**
 * The provers of ONE shard (see `assignShards`), sorted by path.
 *
 * @template {{ relPath: string }} P
 * @param {P[]} provers
 * @param {number} index 1-based
 * @param {number} count
 * @returns {P[]}
 */
export function shardProvers(provers, index, count) {
  parseShardSpec(`${index}/${count}`);
  const owner = assignShards(provers, count);
  return [...provers].sort(byPath).filter((p) => owner.get(p.relPath) === index - 1);
}

/** Estimated minutes of one shard, for the balance guard and the plan log. */
export function estimateShardMinutes(provers, index, count) {
  return shardProvers(provers, index, count).reduce((n, p) => n + proverWeight(p), 0);
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
 *           reports: Array<object | undefined | null>,
 *           shard?: (provers: Array<{ relPath: string }>, index: number, count: number) => Array<{ relPath: string }> }} input
 *   `shard` is the partition function the legs are entitled to; it defaults to the
 *   real one and is injectable ONLY so a test can hand it a lossy partition and
 *   prove the final union check catches what the per-leg recomputation cannot
 *   (a partition that is wrong the same way in the runner and here).
 *   `reports[i]` is the report for `expected[i]` (`undefined` when the leg wrote
 *   none — cancelled, crashed, artifact lost).
 * @returns {{ findings: string[], partialRefs: string[], unionVerified: string[] }}
 *   `unionVerified` lists the refs whose legs ALL reported and whose shards' union
 *   was proved equal to the discovered set.
 */
export function aggregateReports({ expected, reports, shard = shardProvers }) {
  const findings = [];
  const partialRefs = [];
  const unionVerified = [];
  if (!Array.isArray(expected) || expected.length === 0) {
    return {
      findings: [
        'the plan expected no legs at all — a lane that proves nothing is not a green lane',
      ],
      partialRefs,
      unionVerified,
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
    const entitled = shard(
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
    } else if (present.length === legs.length) {
      unionVerified.push(ref);
    }
  }
  return { findings, partialRefs, unionVerified };
}

/** The per-prover bound, in ms. Overridable so the guard can use a short one. */
export function proverTimeoutMs(env = process.env) {
  const raw = env.KNEXT_PROVER_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 130 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `KNEXT_PROVER_TIMEOUT_MS must be a positive number of ms, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}
