import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  classifyFindings,
  KNOWN_RED_PROVERS,
  knownRedMarkdown,
} from '../scripts/lib/known-red-provers.mjs';
import {
  countProcesses,
  DEFAULT_THRESHOLDS,
  describeResources,
  evaluateResources,
  isSafeGroupTarget,
  parseMeminfo,
  REGENERABLE_BUILD_DIRS,
  runawayReason,
  sampleLine,
  thresholdsFromEnv,
} from '../scripts/lib/lane-resources.mjs';
import { discoverProvers, PROVER_RE } from '../scripts/lib/prover-lane.mjs';
import {
  aggregateReports,
  buildMatrix,
  estimateShardMinutes,
  ISOLATED_PROVERS,
  LANE_REFS,
  makeReport,
  PROVER_WEIGHT_MINUTES,
  parseShardSpec,
  proverTimeoutMs,
  reportFileName,
  shardProvers,
  WEIGHTED_ON_ONE_REF_ONLY,
} from '../scripts/lib/prover-shard.mjs';
import { auditJobCanNotSkip } from './helpers/blocking-gate.js';

/**
 * GUARDS for the SHARDED, multi-ref mutation-prover lane (#2499 / #2208).
 *
 * Two failures motivate this file.
 *
 *   #2499 — the scheduled lane ran on `main` only (a schedule fires from the
 *   DEFAULT branch), so every sovereignty prover that exists only on
 *   `integration/v2` was a one-time PR artifact: a later commit that weakened a
 *   rule while keeping the unit tests green went undetected.
 *
 *   #2208 — the lane was ONE serial job over every prover with a 100-minute
 *   ceiling, and the last five runs were cancelled at that ceiling. The cause was
 *   measured, not guessed (run 38140088966): the first 40 provers took 53
 *   minutes, then `mutation-prove-empty-dir-guard.mjs` was still running 47
 *   minutes later when the job ceiling cancelled the whole run — a runner that
 *   set `maxBuffer` and NO `timeout`, printing a prover's output only after it
 *   exited. The log of the cancelled run therefore held nothing about the
 *   prover that ate the night, and ninety provers never started.
 *
 * The fix this file pins: a plan job pins every ref to a SHA, the provers are
 * SHARDED across matrix legs (each with its own timeout), every prover has its
 * own bound, and an aggregate job proves the shard UNION equals the discovered
 * set with declared == run for every prover.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/mutation-prover-nightly.yml');
const RUNNER = 'scripts/run-mutation-provers.mjs';
const read = (p: string) => readFileSync(p, 'utf8');

type Step = Record<string, unknown>;
type Job = Record<string, unknown> & { steps?: Step[]; needs?: string | string[] };
const workflow = () => parse(read(WORKFLOW_PATH)) as { jobs: Record<string, Job>; on: unknown };

const fakeProvers = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    relPath: `scripts/mutation-prove-p${String(i).padStart(2, '0')}.mjs`,
  }));

describe('#2499 shardProvers — the shard union is the full set, exactly once', () => {
  it('parses i/n and refuses anything else', () => {
    expect(parseShardSpec('3/6')).toEqual({ index: 3, count: 6 });
    for (const bad of ['0/6', '7/6', '3', '3/0', 'a/b', '1/2/3', '', '-1/4', '1.5/4']) {
      expect(() => parseShardSpec(bad), bad).toThrow();
    }
  });

  it('the union over all shards equals the input and no prover is in two shards', () => {
    const all = fakeProvers(131);
    for (const count of [1, 2, 6, 7, 131, 200]) {
      const seen: string[] = [];
      for (let index = 1; index <= count; index++) {
        seen.push(...shardProvers(all, index, count).map((p) => p.relPath));
      }
      expect(seen.length, `count=${count}`).toBe(all.length);
      expect([...new Set(seen)].sort(), `count=${count}`).toEqual(all.map((p) => p.relPath).sort());
    }
  });

  it('is independent of input order (the shard is a function of the SET, not of readdir order)', () => {
    const all = fakeProvers(40);
    const shuffled = [...all].reverse();
    expect(shardProvers(shuffled, 2, 5).map((p) => p.relPath)).toEqual(
      shardProvers(all, 2, 5).map((p) => p.relPath),
    );
  });

  it('shards are balanced to within one prover', () => {
    const all = fakeProvers(131);
    const sizes = Array.from({ length: 6 }, (_, i) => shardProvers(all, i + 1, 6).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });
});

describe('#2208 legs are balanced by ESTIMATED COST, not by count', () => {
  const real = () => discoverProvers(REPO_ROOT) as Array<{ relPath: string }>;
  const N = 6;

  it('every weighted prover is a real, discovered prover (a rename cannot silently unweight it)', () => {
    const have = new Set(real().map((p) => p.relPath));
    for (const path of Object.keys(PROVER_WEIGHT_MINUTES)) {
      expect(
        have.has(path) || WEIGHTED_ON_ONE_REF_ONLY.includes(path),
        `${path} is weighted but not discovered (and not listed as a one-ref-only prover)`,
      ).toBe(true);
    }
    for (const path of WEIGHTED_ON_ONE_REF_ONLY) {
      expect(Object.keys(PROVER_WEIGHT_MINUTES), `${path} is listed but not weighted`).toContain(
        path,
      );
    }
  });

  it('no leg exceeds the mean estimated load by more than the heaviest single prover (the LPT bound)', () => {
    const all = real();
    const loads = Array.from({ length: N }, (_, i) => estimateShardMinutes(all, i + 1, N));
    const mean = loads.reduce((a, b) => a + b, 0) / N;
    const heaviest = Math.max(...Object.values(PROVER_WEIGHT_MINUTES));
    expect(Math.max(...loads)).toBeLessThanOrEqual(mean + heaviest);
  });

  it('the heaviest provers are NOT co-located (a count split put them in one leg)', () => {
    const all = real();
    const present = new Set(all.map((p) => p.relPath));
    // Only provers this ref HAS: the cargo-heavy Rust scaffold prover (60) exists
    // on integration/v2 only, and must not share a leg with the other long ones.
    const heavy = Object.entries(PROVER_WEIGHT_MINUTES)
      .filter(([path, w]) => w >= 20 && present.has(path))
      .map(([p]) => p);
    expect(heavy.length).toBeGreaterThanOrEqual(3);
    const legOf = (path: string) =>
      Array.from({ length: N }, (_, i) => i + 1).find((i) =>
        shardProvers(all, i, N).some((p) => p.relPath === path),
      );
    const legs = heavy.map(legOf);
    expect(new Set(legs).size, `heavy provers share a leg: ${legs.join(',')}`).toBe(heavy.length);
  });
});

describe('#2499 buildMatrix — one leg per ref x shard, each pinned to a SHA', () => {
  const sha = (c: string) => c.repeat(40);

  it('covers both refs with every shard', () => {
    const m = buildMatrix({
      refs: [
        { ref: 'main', sha: sha('a') },
        { ref: 'integration/v2', sha: sha('b') },
      ],
      shards: 3,
    });
    expect(m.include.length).toBe(6);
    expect(new Set(m.include.map((l: { ref: string }) => l.ref))).toEqual(
      new Set(['main', 'integration/v2']),
    );
    for (const leg of m.include) {
      expect(leg.shards).toBe(3);
      expect(leg.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('artifact-safe slug: no slash in the report file name', () => {
    const m = buildMatrix({ refs: [{ ref: 'integration/v2', sha: sha('b') }], shards: 2 });
    for (const leg of m.include) expect(reportFileName(leg)).not.toContain('/');
  });

  it('onlyShard narrows to one leg per ref (the dispatch experiment)', () => {
    const m = buildMatrix({
      refs: [{ ref: 'integration/v2', sha: sha('b') }],
      shards: 6,
      onlyShard: 4,
    });
    expect(m.include.map((l: { shard: number }) => l.shard)).toEqual([4]);
  });

  it('refuses a shard outside 1..N, a bad sha, and a ref that could smuggle shell syntax', () => {
    expect(() =>
      buildMatrix({ refs: [{ ref: 'main', sha: sha('a') }], shards: 3, onlyShard: 4 }),
    ).toThrow();
    expect(() => buildMatrix({ refs: [{ ref: 'main', sha: 'nothex' }], shards: 3 })).toThrow();
    expect(() =>
      buildMatrix({ refs: [{ ref: 'main; rm -rf /', sha: sha('a') }], shards: 3 }),
    ).toThrow();
    expect(() => buildMatrix({ refs: [], shards: 3 })).toThrow();
  });

  it('the default lane refs are main AND integration/v2', () => {
    expect(LANE_REFS).toEqual(['main', 'integration/v2']);
  });
});

describe('#2499 aggregateReports — declared == run, and a missing prover FAILS', () => {
  const SHA = 'c'.repeat(40);
  const discovered = fakeProvers(6).map((p) => p.relPath);
  const legsFor = (shards: number) =>
    Array.from({ length: shards }, (_, i) => ({
      ref: 'integration/v2',
      sha: SHA,
      shard: i + 1,
      shards,
    }));
  const goodReport = (leg: { ref: string; sha: string; shard: number; shards: number }) => {
    const assigned = shardProvers(
      discovered.map((relPath) => ({ relPath })),
      leg.shard,
      leg.shards,
    ).map((p) => p.relPath);
    return makeReport({
      ref: leg.ref,
      sha: leg.sha,
      shard: leg.shard,
      shards: leg.shards,
      discovered,
      results: assigned.map((relPath) => ({
        relPath,
        summary: { declared: 3, run: 3 },
        findings: [],
      })),
    });
  };
  const reportsFor = (expected: ReturnType<typeof legsFor>) => expected.map((l) => goodReport(l));

  it('a complete, clean lane has no findings', () => {
    const expected = legsFor(3);
    expect(aggregateReports({ expected, reports: reportsFor(expected) }).findings).toEqual([]);
  });

  it('a shard that produced NO report (cancelled / crashed) is a finding', () => {
    const expected = legsFor(3);
    const reports = reportsFor(expected);
    reports[1] = undefined as never;
    const { findings } = aggregateReports({ expected, reports });
    expect(findings.join('\n')).toMatch(/integration\/v2.*2\/3.*no report/s);
  });

  it('a prover that ran fewer mutations than it declared is a finding', () => {
    const expected = legsFor(2);
    const reports = reportsFor(expected);
    reports[0].results[0] = {
      relPath: reports[0].results[0].relPath,
      declared: 13,
      run: 4,
      findings: ['declared 13 mutation(s) but ran 4 — the prover did not do what it claims'],
    };
    expect(aggregateReports({ expected, reports }).findings.join('\n')).toMatch(
      /declared 13.*ran 4/s,
    );
  });

  it('a prover assigned to a shard but absent from its results is a finding (never silently dropped)', () => {
    const expected = legsFor(2);
    const reports = reportsFor(expected);
    const dropped = reports[1].results.pop();
    const { findings } = aggregateReports({ expected, reports });
    expect(findings.join('\n')).toContain(dropped?.relPath ?? '<none dropped>');
    expect(findings.join('\n')).toMatch(/missing/i);
  });

  it('a report from the WRONG sha is a finding (the legs must prove the same tree)', () => {
    const expected = legsFor(2);
    const reports = reportsFor(expected);
    reports[0].sha = 'd'.repeat(40);
    expect(aggregateReports({ expected, reports }).findings.join('\n')).toMatch(/sha/i);
  });

  it('shards that disagree about what was DISCOVERED are a finding', () => {
    const expected = legsFor(2);
    const reports = reportsFor(expected);
    reports[1].discovered = reports[1].discovered.slice(1);
    expect(aggregateReports({ expected, reports }).findings.join('\n')).toMatch(
      /discovered a different prover set/,
    );
  });

  it('a prover discovered but assigned to NO shard is a finding (the union must equal the set)', () => {
    const expected = legsFor(2);
    const reports = reportsFor(expected);
    // Hand a leg a smaller assignment than the function gives it.
    reports[0].assigned = reports[0].assigned.slice(1);
    reports[0].results = reports[0].results.slice(1);
    expect(aggregateReports({ expected, reports }).findings.join('\n')).toMatch(
      /union is not the discovered set.*in no shard/s,
    );
  });

  it('a prover whose count is wrong is a finding EVEN IF the leg reported no findings of its own', () => {
    // The aggregate re-derives the verdict from declared/run. A leg that wrote
    // `findings: []` next to declared 13 / run 4 (an old runner, a hand-edited
    // report) must not read as clean.
    const expected = legsFor(2);
    const reports = reportsFor(expected);
    reports[0].results[0] = {
      relPath: reports[0].results[0].relPath,
      declared: 13,
      run: 4,
      findings: [],
    };
    expect(aggregateReports({ expected, reports }).findings.join('\n')).toMatch(
      /declared 13.*ran 4/s,
    );
  });

  /**
   * #2592 — a leg shards with the weight table of the ref it checked out; the
   * aggregate runs from main's checkout. Model "another ref's table" as a different
   * but VALID partition (a rotated round-robin over the sorted set, which is not what the
   * aggregate's own `shardProvers` returns) and hand it to every leg of that ref.
   */
  const otherTable = (all: string[], index: number, count: number) =>
    [...all].sort().filter((_, i) => (i + 1) % count === index - 1);
  const reportWith = (
    leg: { ref: string; sha: string; shard: number; shards: number },
    assigned: string[],
    all: string[] = discovered,
  ) => ({
    version: 1,
    ref: leg.ref,
    sha: leg.sha,
    shard: leg.shard,
    shards: leg.shards,
    discovered: [...all].sort(),
    assigned,
    results: assigned.map((relPath) => ({ relPath, declared: 2, run: 2, findings: [] })),
  });
  const twoRefLegs = (shards: number) =>
    ['main', 'integration/v2'].flatMap((ref) =>
      Array.from({ length: shards }, (_, i) => ({ ref, sha: SHA, shard: i + 1, shards })),
    );

  it('#2592 a ref whose legs sharded with a DIFFERENT weight table than the aggregate is not a finding', () => {
    const expected = twoRefLegs(3);
    const reports = expected.map((leg) =>
      leg.ref === 'main'
        ? goodReport(leg)
        : reportWith(leg, otherTable(discovered, leg.shard, leg.shards)),
    );
    // Precondition: the two tables really disagree, or this proves nothing.
    expect(reports[3].assigned).not.toEqual(reports[0].assigned);
    const out = aggregateReports({ expected, reports });
    expect(out.findings).toEqual([]);
    expect(out.unionVerified.sort()).toEqual(['integration/v2', 'main']);
  });

  it('#2592 a prover dropped from EVERY leg of a ref is a finding naming it', () => {
    const expected = legsFor(3);
    const victim = discovered[0];
    const reports = expected.map((leg) =>
      reportWith(
        leg,
        otherTable(discovered, leg.shard, leg.shards).filter((r) => r !== victim),
      ),
    );
    const { findings } = aggregateReports({ expected, reports });
    expect(findings.join('\n')).toMatch(/union is not the discovered set/);
    expect(findings.join('\n')).toContain(victim);
  });

  it('#2592 a prover assigned to TWO legs is a finding naming it, even when nothing else is dropped', () => {
    const expected = legsFor(3);
    const reports = expected.map((leg) =>
      reportWith(leg, otherTable(discovered, leg.shard, leg.shards)),
    );
    const dup = reports[0].assigned[0];
    reports[1].assigned.push(dup);
    reports[1].results.push({ relPath: dup, declared: 2, run: 2, findings: [] });
    const { findings } = aggregateReports({ expected, reports });
    expect(findings.join('\n')).toMatch(/more than one leg/);
    expect(findings.join('\n')).toContain(dup);
  });

  it('#2592 a leg whose results miss a prover it was assigned is a finding, whatever table it used', () => {
    const expected = legsFor(3);
    const reports = expected.map((leg) =>
      reportWith(leg, otherTable(discovered, leg.shard, leg.shards)),
    );
    const dropped = reports[2].results.pop();
    const { findings } = aggregateReports({ expected, reports });
    expect(findings.join('\n')).toMatch(/missing from its results/);
    expect(findings.join('\n')).toContain(dropped?.relPath ?? '<none>');
  });

  it('#2592 a leg assigned a prover that was never discovered is a finding', () => {
    const expected = legsFor(2);
    const reports = expected.map((leg) =>
      reportWith(leg, otherTable(discovered, leg.shard, leg.shards)),
    );
    reports[0].assigned.push('scripts/mutation-prove-ghost.mjs');
    reports[0].results.push({
      relPath: 'scripts/mutation-prove-ghost.mjs',
      declared: 2,
      run: 2,
      findings: [],
    });
    expect(aggregateReports({ expected, reports }).findings.join('\n')).toMatch(
      /not in its discovered set/,
    );
  });

  it('#2592 a leg with no assigned list is a finding', () => {
    const expected = legsFor(2);
    const reports = reportsFor(expected);
    delete (reports[0] as { assigned?: string[] }).assigned;
    expect(aggregateReports({ expected, reports }).findings.join('\n')).toMatch(/no assigned list/);
  });

  it('#2592 r2: a PARTIAL dispatch still catches a prover claimed by two present legs', () => {
    const expected = legsFor(3).slice(0, 2);
    const [a, b, c] = discovered;
    const reports = [reportWith(expected[0], [a, b]), reportWith(expected[1], [b, c])];
    const out = aggregateReports({ expected, reports });
    expect(out.partialRefs).toEqual(['integration/v2']);
    expect(out.findings.join('\n')).toMatch(/more than one leg/);
    expect(out.findings.join('\n')).toContain(b);
    expect(out.unionVerified).toEqual([]);
  });

  it('#2592 r2: an empty assigned list is a finding when there are at least as many provers as shards', () => {
    const expected = legsFor(3);
    const reports = expected.map((leg) =>
      reportWith(leg, leg.shard === 1 ? discovered : leg.shard === 2 ? [] : []),
    );
    // Shard 1 claims everything while 2 and 3 claim nothing: disjoint, union complete.
    const out = aggregateReports({ expected, reports });
    expect(out.findings.join('\n')).toMatch(/empty assigned list/);
    expect(out.unionVerified).toEqual([]);
  });

  it('#2592 r2: a finding of any kind about a ref keeps it out of unionVerified', () => {
    // A prover named twice inside ONE leg's assigned list.
    const dupExpected = legsFor(2);
    const dupReports = dupExpected.map((leg) =>
      reportWith(leg, otherTable(discovered, leg.shard, leg.shards)),
    );
    dupReports[0].assigned.push(dupReports[0].assigned[0]);
    const dup = aggregateReports({ expected: dupExpected, reports: dupReports });
    expect(dup.findings.join('\n')).toMatch(/more than once/);
    expect(dup.unionVerified).toEqual([]);

    // Legs that discovered different sets.
    const diffExpected = legsFor(2);
    const diffReports = diffExpected.map((leg) =>
      reportWith(leg, otherTable(discovered, leg.shard, leg.shards)),
    );
    diffReports[1].discovered = diffReports[1].discovered.slice(0, -1);
    const diff = aggregateReports({ expected: diffExpected, reports: diffReports });
    expect(diff.findings.join('\n')).toMatch(/discovered a different prover set/);
    expect(diff.unionVerified).toEqual([]);
  });

  it('the final UNION check catches a partition that is wrong the same way everywhere', () => {
    // The per-leg recomputation cannot see this: runner and aggregate would agree
    // on the same lossy function. Only comparing the union with the discovered set
    // does. (The aggregate never calls a partition function now; the reports carry it.)
    const lossy = (all: Array<{ relPath: string }>, index: number, count: number) =>
      shardProvers(all, index, count).slice(1);
    const expected = legsFor(2);
    const reports = expected.map((leg) => {
      const assigned = lossy(
        discovered.map((relPath) => ({ relPath })),
        leg.shard,
        leg.shards,
      ).map((p) => p.relPath);
      return makeReport({
        ...leg,
        discovered,
        results: assigned.map((relPath) => ({
          relPath,
          summary: { declared: 1, run: 1 },
          findings: [],
        })),
      });
    });
    // makeReport derives `assigned` with the REAL function; overwrite with the lossy one.
    reports.forEach((r, i) => {
      r.assigned = r.results.map((x: { relPath: string }) => x.relPath);
      void i;
    });
    const out = aggregateReports({ expected, reports });
    expect(out.findings.join('\n')).toMatch(/union is not the discovered set/);
  });

  it('a PARTIAL dispatch (fewer legs than shards) is reported as partial, not as a union failure', () => {
    const expected = [legsFor(6)[3]];
    const out = aggregateReports({ expected, reports: reportsFor(expected) });
    expect(out.findings).toEqual([]);
    expect(out.partialRefs).toEqual(['integration/v2']);
  });

  it('an EMPTY expectation is a finding (a plan that produced nothing certifies nothing)', () => {
    expect(aggregateReports({ expected: [], reports: [] }).findings.length).toBeGreaterThan(0);
  });

  it('zero discovered provers is a finding', () => {
    const leg = legsFor(1)[0];
    const r = makeReport({ ...leg, discovered: [], results: [] });
    expect(aggregateReports({ expected: [leg], reports: [r] }).findings.length).toBeGreaterThan(0);
  });
});

describe('#2499 resource tripwire — pure logic', () => {
  const T = DEFAULT_THRESHOLDS;
  const ev = (freeDiskMiB: number | null, availMemMiB: number | null) =>
    evaluateResources({ freeDiskMiB, availMemMiB }, T);

  it('healthy resources are ok', () => {
    expect(ev(10_000, 8_000).level).toBe('ok');
  });

  it('low free disk is HARD below the threshold and names the number', () => {
    const v = ev(T.hardFreeDiskMiB - 1, 8_000);
    expect(v.level).toBe('hard');
    expect(v.reasons.join(' ')).toMatch(/free disk 1023 MiB < 1024 MiB/);
  });

  it('low available memory is HARD and names the number', () => {
    const v = ev(10_000, T.hardAvailMemMiB - 1);
    expect(v.level).toBe('hard');
    expect(v.reasons.join(' ')).toMatch(/available memory 255 MiB < 256 MiB/);
  });

  it('between the soft and hard disk thresholds is SOFT (clean, do not stop)', () => {
    expect(ev(T.softFreeDiskMiB - 1, 8_000).level).toBe('soft');
    expect(ev(T.hardFreeDiskMiB, 8_000).level).toBe('soft');
  });

  it('an unreadable reading is skipped, never fabricated into a trip', () => {
    expect(ev(null, null).level).toBe('ok');
  });

  it('memory comes from MemAvailable, not MemFree', () => {
    const text =
      'MemTotal:       16384000 kB\nMemFree:          100000 kB\nMemAvailable:    8192000 kB\n';
    expect(parseMeminfo(text)).toEqual({ availMemMiB: 8000, totalMemMiB: 16000 });
    expect(parseMeminfo('nothing useful')).toEqual({ availMemMiB: null, totalMemMiB: null });
  });

  it('thresholds are env-overridable and refuse nonsense', () => {
    expect(thresholdsFromEnv({})).toEqual(DEFAULT_THRESHOLDS);
    expect(thresholdsFromEnv({ KNEXT_LANE_MIN_FREE_DISK_MIB: '5' }).hardFreeDiskMiB).toBe(5);
    for (const bad of ['abc', '-1', 'Infinity']) {
      expect(() => thresholdsFromEnv({ KNEXT_LANE_MIN_FREE_DISK_MIB: bad }), bad).toThrow();
    }
  });

  it('the defaults are the jev-picked ones for a standard 14 GB / 16 GB hosted runner', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      hardFreeDiskMiB: 1024,
      hardAvailMemMiB: 256,
      softFreeDiskMiB: 3072,
      killAvailMemMiB: 2048,
    });
  });

  it('a RUNNING prover is a runaway only below the kill threshold, and the reason names the number', () => {
    const t = DEFAULT_THRESHOLDS;
    expect(runawayReason({ availMemMiB: 14_000 }, t)).toBeNull();
    expect(runawayReason({ availMemMiB: null }, t)).toBeNull();
    expect(runawayReason({ availMemMiB: t.killAvailMemMiB }, t)).toBeNull();
    expect(runawayReason({ availMemMiB: t.killAvailMemMiB - 1 }, t)).toMatch(
      /available memory 2047 MiB < 2048 MiB while the prover was running/,
    );
  });

  it('the kill threshold is env-overridable', () => {
    expect(thresholdsFromEnv({ KNEXT_LANE_KILL_AVAIL_MEM_MIB: '512' }).killAvailMemMiB).toBe(512);
  });

  it('only a real child’s own group may be signalled (never 0, 1, NaN or ourselves)', () => {
    expect(isSafeGroupTarget(4242, 100)).toBe(true);
    for (const bad of [0, 1, -1, Number.NaN, undefined, null, '5', 1.5, 100]) {
      expect(isSafeGroupTarget(bad, 100), String(bad)).toBe(false);
    }
  });

  it('counts only numeric /proc entries as processes', () => {
    expect(countProcesses(['1', '42', 'self', 'sys', '9000'])).toBe(3);
    expect(countProcesses(null)).toBeNull();
  });

  it('the sample line carries memory, processes, load, disk and any extra lines', () => {
    const line = sampleLine({
      prover: 'scripts/mutation-prove-cdn-purge.mjs',
      res: { availMemMiB: 1234, freeDiskMiB: 5678 },
      procs: 321,
      load: [1.5, 2, 0.25],
      extra: ['ps: 1 0 100 00:01 node', 'kernel: Out of memory'],
    });
    expect(line).toContain('sample [cdn-purge.mjs]');
    expect(line).toContain('mem avail 1234 MiB');
    expect(line).toContain('procs 321');
    expect(line).toContain('load 1.50/2.00/0.25');
    expect(line).toContain('disk free 5678 MiB');
    expect(line).toContain('kernel: Out of memory');
  });

  it('the description line is what the runner prints', () => {
    expect(describeResources({ freeDiskMiB: 5000.4, availMemMiB: 1200, totalMemMiB: 16000 })).toBe(
      'free memory 1200 of 16000 MiB available, free disk 5000 MiB',
    );
  });

  it('regenerable build output NEVER includes a built CLI bundle, node_modules or the toolchain', () => {
    // Several provers REQUIRE packages/kn-next/dist and do not rebuild it.
    for (const d of REGENERABLE_BUILD_DIRS) {
      expect(d, d).not.toMatch(/dist|node_modules|operator|\/bin\b/);
    }
    expect(REGENERABLE_BUILD_DIRS.length).toBeGreaterThan(0);
  });
});

describe('#2499 the known-red list labels the alert, it never excuses a prover', () => {
  // The REAL list is empty when nothing is known-red; the mechanics are proved on
  // a fixture list so they stay proved while the real one is empty.
  const FIXTURE = Object.freeze([
    { prover: 'scripts/mutation-prove-zz-known.mjs', issue: 9001, why: 'a tracked red (fixture)' },
    { prover: 'scripts/mutation-prove-zz-other-known.mjs', issue: 9002, why: 'another (fixture)' },
  ]);

  it('every entry is a well-formed prover path with a distinct open-issue number', () => {
    const issues = new Set<number>();
    const paths = new Set<string>();
    for (const k of KNOWN_RED_PROVERS) {
      expect(Number.isInteger(k.issue) && k.issue > 0, JSON.stringify(k)).toBe(true);
      expect(k.prover, k.prover).toMatch(/^scripts\/mutation-prove-.*\.mjs$/);
      expect(k.why.length, k.prover).toBeGreaterThan(5);
      expect(issues.has(k.issue), `duplicate issue ${k.issue}`).toBe(false);
      expect(paths.has(k.prover), `duplicate prover ${k.prover}`).toBe(false);
      issues.add(k.issue);
      paths.add(k.prover);
    }
  });

  it('every listed prover EXISTS in the tree and is still discovered (nothing is skipped)', () => {
    const have = new Set(discoverProvers(REPO_ROOT).map((p: { relPath: string }) => p.relPath));
    for (const k of KNOWN_RED_PROVERS) {
      expect(
        have.has(k.prover) || 'onlyOn' in k,
        `${k.prover} is listed as known-red but is not a prover`,
      ).toBe(true);
    }
  });

  it('classifies a finding that names a listed prover as KNOWN, everything else as FRESH', () => {
    const [a] = FIXTURE;
    const known = `integration/v2 4/6: ${a.prover}: non-zero exit (1)`;
    const fresh1 = 'integration/v2 4/6: scripts/mutation-prove-other.mjs: non-zero exit (1)';
    const fresh2 =
      'integration/v2 6/6: no report — the leg was cancelled, crashed, or its artifact is missing';
    const out = classifyFindings([known, fresh1, fresh2], FIXTURE);
    expect(out.known).toEqual([{ finding: known, issue: a.issue }]);
    expect(out.fresh).toEqual([fresh1, fresh2]);
  });

  it('the alert markdown names every listed issue and says they still fail', () => {
    const md = knownRedMarkdown(FIXTURE);
    for (const k of FIXTURE) expect(md).toContain(`#${k.issue}`);
    expect(md).toMatch(/still FAIL the lane/);
    // An empty list says so, instead of printing a header over nothing.
    expect(knownRedMarkdown([])).toMatch(/every red finding above is NEW/);
  });

  it('the runner and the shard library never read the list (it cannot skip or recount anything)', () => {
    for (const f of ['scripts/run-mutation-provers.mjs', 'scripts/lib/prover-shard.mjs']) {
      expect(read(resolve(REPO_ROOT, f)), f).not.toMatch(/known-red/);
    }
  });

  describe('through the real aggregate script', () => {
    const [known] = FIXTURE;
    const discovered = [known.prover, 'scripts/mutation-prove-zz-other.mjs'];
    const SHA = 'a'.repeat(40);
    const leg = { ref: 'integration/v2', sha: SHA, shard: 1, shards: 1 };
    const aggregate = (
      results: Array<{
        relPath: string;
        summary: { declared: number; run: number } | null;
        findings: string[];
      }>,
    ) => {
      const dir = mkdtempSync(join(tmpdir(), 'knext-agg-'));
      try {
        const rep = makeReport({ ...leg, discovered, results });
        writeFileSync(join(dir, reportFileName(leg)), JSON.stringify(rep));
        const out = join(dir, 'gh-output.txt');
        const r = spawnSync(
          process.execPath,
          [resolve(REPO_ROOT, 'scripts/prover-lane-aggregate.mjs')],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              EXPECTED_LEGS: JSON.stringify([leg]),
              REPORT_DIR: dir,
              GITHUB_OUTPUT: out,
              KNEXT_LANE_KNOWN_RED_JSON: JSON.stringify(FIXTURE),
            },
          },
        );
        return { r, output: existsSync(out) ? read(out) : '' };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const ok = (relPath: string) => ({
      relPath,
      summary: { declared: 1, run: 1 },
      findings: [] as string[],
    });
    const red = (relPath: string) => ({
      relPath,
      summary: { declared: 3, run: 1 },
      findings: ['declared 3 mutation(s) but ran 1 — the prover did not do what it claims'],
    });

    it('a KNOWN-red prover still FAILS the lane (exit 1) but is labelled, with zero new reds', () => {
      const { r, output } = aggregate([
        red(known.prover),
        ok('scripts/mutation-prove-zz-other.mjs'),
      ]);
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
      expect(output).toContain('New red findings (not on the known-red list): 0');
      expect(output).toContain(`(#${known.issue})`);
      expect(r.stderr).toContain(`(known #${known.issue})`);
    });

    it('an UNLISTED red is NEW and fails the lane', () => {
      const { r, output } = aggregate([
        ok(known.prover),
        red('scripts/mutation-prove-zz-other.mjs'),
      ]);
      expect(r.status).toBe(1);
      expect(output).toContain('New red findings (not on the known-red list): 1');
      expect(output).toContain('mutation-prove-zz-other.mjs');
    });

    it('a clean lane passes and PRINTS that the union equals the discovered set', () => {
      const { r, output } = aggregate([
        ok(known.prover),
        ok('scripts/mutation-prove-zz-other.mjs'),
      ]);
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('union == discovered set: verified for integration/v2');
      expect(output).toContain('Shard union == discovered set: verified');
    });

    it('a PARTIAL run does not claim the union was checked', () => {
      const dir = mkdtempSync(join(tmpdir(), 'knext-agg-'));
      try {
        const partialLeg = { ...leg, shard: 1, shards: 2 };
        const rep = makeReport({
          ...partialLeg,
          discovered,
          results: shardProvers(
            discovered.map((relPath) => ({ relPath })),
            1,
            2,
          ).map((p) => ({ relPath: p.relPath, summary: { declared: 1, run: 1 }, findings: [] })),
        });
        writeFileSync(join(dir, reportFileName(partialLeg)), JSON.stringify(rep));
        const r = spawnSync(
          process.execPath,
          [resolve(REPO_ROOT, 'scripts/prover-lane-aggregate.mjs')],
          {
            encoding: 'utf8',
            env: { ...process.env, EXPECTED_LEGS: JSON.stringify([partialLeg]), REPORT_DIR: dir },
          },
        );
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
        expect(r.stdout).toContain('PARTIAL run, union == discovered set was NOT checked');
        expect(r.stdout).not.toMatch(/union == discovered set: verified/);
        expect(r.stdout).not.toMatch(/; union == discovered set\s*$/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('the union line is printed even when the lane is red (it is evidence, not a reward)', () => {
      const { r } = aggregate([red(known.prover), ok('scripts/mutation-prove-zz-other.mjs')]);
      expect(r.stdout).toContain('union == discovered set: verified for integration/v2');
    });
  });
});

describe('#2499 an isolated prover gets a leg of its own, and the union stays exact', () => {
  const ISO = ISOLATED_PROVERS[0].prover;
  const withIso = () => [...fakeProvers(40), { relPath: ISO }];
  const legsOf = (all: Array<{ relPath: string }>, count: number) =>
    Array.from({ length: count }, (_, i) => shardProvers(all, i + 1, count).map((p) => p.relPath));

  it('the list names its reason and a real prover path', () => {
    for (const i of ISOLATED_PROVERS) {
      expect(i.prover).toMatch(/^scripts\/mutation-prove-.*\.mjs$/);
      expect(i.reason.length).toBeGreaterThan(20);
    }
  });

  it('the isolated prover is ALONE in the last leg', () => {
    const legs = legsOf(withIso(), 6);
    expect(legs[5]).toEqual([ISO]);
    for (const leg of legs.slice(0, 5)) expect(leg).not.toContain(ISO);
  });

  it('the union over all legs is still the full set, exactly once', () => {
    for (const count of [2, 3, 6, 7]) {
      const all = withIso();
      const seen = legsOf(all, count).flat();
      expect(seen.length, `count=${count}`).toBe(all.length);
      expect([...new Set(seen)].sort(), `count=${count}`).toEqual(all.map((p) => p.relPath).sort());
    }
  });

  it('the rest is still balanced over the remaining legs', () => {
    const legs = legsOf(withIso(), 6).slice(0, 5);
    const sizes = legs.map((l) => l.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('with no balanced leg left (one leg), isolation is skipped and nothing is dropped', () => {
    const legs = legsOf(withIso(), 1);
    expect(legs[0].length).toBe(41);
  });

  it('a ref without the prover is unaffected (the list is inert, not an error)', () => {
    const legs = legsOf(fakeProvers(40), 6);
    expect(legs.flat().length).toBe(40);
    for (const leg of legs) expect(leg.length).toBeGreaterThan(0);
  });

  it('is independent of input order', () => {
    const a = withIso();
    expect(legsOf([...a].reverse(), 6)).toEqual(legsOf(a, 6));
  });

  it('the aggregate accepts the isolated layout (recomputed from the same function)', () => {
    const all = withIso();
    const discovered = all.map((p) => p.relPath);
    const expected = Array.from({ length: 6 }, (_, i) => ({
      ref: 'integration/v2',
      sha: 'c'.repeat(40),
      shard: i + 1,
      shards: 6,
    }));
    const reports = expected.map((leg) =>
      makeReport({
        ...leg,
        discovered,
        results: shardProvers(all, leg.shard, 6).map((p) => ({
          relPath: p.relPath,
          summary: { declared: 1, run: 1 },
          findings: [],
        })),
      }),
    );
    const out = aggregateReports({ expected, reports });
    expect(out.findings).toEqual([]);
    expect(out.unionVerified).toEqual(['integration/v2']);
  });

  it('on the real tree, if the prover exists it is alone in the last leg', () => {
    const all = discoverProvers(REPO_ROOT) as Array<{ relPath: string }>;
    if (!all.some((p) => p.relPath === ISO)) return;
    expect(shardProvers(all, 6, 6).map((p) => p.relPath)).toEqual([ISO]);
  });
});

describe('#2208 the per-prover bound', () => {
  it('defaults to a finite, positive bound well under the per-leg ceiling', () => {
    const ms = proverTimeoutMs({});
    expect(Number.isFinite(ms) && ms > 0).toBe(true);
    expect(ms).toBe(130 * 60 * 1000);
  });

  it('is overridable by KNEXT_PROVER_TIMEOUT_MS and refuses nonsense rather than running unbounded', () => {
    expect(proverTimeoutMs({ KNEXT_PROVER_TIMEOUT_MS: '1500' })).toBe(1500);
    for (const bad of ['abc', '0', '-5', 'Infinity']) {
      expect(() => proverTimeoutMs({ KNEXT_PROVER_TIMEOUT_MS: bad }), bad).toThrow();
    }
  });
});

describe('#2208 the runner: --shard, --list, --report and a PER-PROVER timeout', () => {
  const makeTree = (provers: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-lane-shard-'));
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
    cpSync(resolve(REPO_ROOT, RUNNER), join(dir, RUNNER));
    for (const f of readdirSync(resolve(REPO_ROOT, 'scripts/lib')).filter((n) =>
      n.endsWith('.mjs'),
    )) {
      cpSync(resolve(REPO_ROOT, 'scripts/lib', f), join(dir, 'scripts/lib', f));
    }
    for (const [name, body] of Object.entries(provers)) {
      writeFileSync(join(dir, 'scripts', name), body);
    }
    return dir;
  };
  /** Make `dir` a one-commit repository and return its HEAD. */
  const commitAll = (dir: string): string => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    for (const a of [
      ['init', '-q'],
      ['add', '-A'],
      ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x'],
    ]) {
      const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    }
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  };
  const ok = (declared: number, run: number) =>
    `console.log('::prover-summary:: ' + JSON.stringify({ declared: ${declared}, run: ${run} }));`;
  // The lane's OWN variables must not leak into a runner under test. This spec runs
  // INSIDE the lane (the lane prover grades it), where PROVER_LANE_SHA is the real
  // planned sha and GITHUB_ACTIONS is true: leaking either turned every temp-repo
  // runner test red on the first live run that carried the HEAD check.
  const LANE_ENV = [
    'PROVER_LANE_SHA',
    'PROVER_LANE_REF',
    'KNEXT_PROVER_TIMEOUT_MS',
    'KNEXT_LANE_RESTORE_AFTER_KILL',
    'KNEXT_LANE_CARGO_TARGET_DIR',
    'KNEXT_RUST_CODEGEN_DIR',
    'CARGO_TARGET_DIR',
    'GITHUB_ACTIONS',
    'KNEXT_LANE_CLEANUP',
    'KNEXT_LANE_MIN_FREE_DISK_MIB',
    'KNEXT_LANE_MIN_AVAIL_MEM_MIB',
    'KNEXT_LANE_SOFT_FREE_DISK_MIB',
    'KNEXT_LANE_KILL_AVAIL_MEM_MIB',
    'KNEXT_LANE_MEMINFO_PATH',
    'KNEXT_LANE_SAMPLE_MS',
    'KNEXT_LANE_WATCH_MS',
    'KNEXT_LANE_EXTRAS_CMD',
  ];
  const hermeticEnv = (extra: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of LANE_ENV) delete env[k];
    return { ...env, ...extra } as Record<string, string>;
  };
  const run = (dir: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(dir, RUNNER), ...args], {
      encoding: 'utf8',
      env: hermeticEnv(env),
      timeout: 60_000,
    });

  it('prints free memory and disk after each prover (a starved runner dies without a log)', () => {
    const dir = makeTree({ 'mutation-prove-a.mjs': ok(1, 1), 'mutation-prove-b.mjs': ok(1, 1) });
    try {
      const r = run(dir, []);
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      const lines =
        r.stdout.match(/resources: free memory \S+ of \S+ MiB available, free disk \S+ MiB/g) ?? [];
      expect(lines.length, 'one resource line per prover').toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('the watch: samples while a prover runs and kills a runaway', () => {
    const meminfo = (dir: string, availMiB: number) => {
      const path = join(dir, 'meminfo');
      writeFileSync(path, `MemTotal:       16384000 kB\nMemAvailable:    ${availMiB * 1024} kB\n`);
      return path;
    };
    const base = { KNEXT_LANE_MIN_AVAIL_MEM_MIB: '0', KNEXT_LANE_MIN_FREE_DISK_MIB: '0' };
    const marker = (name: string) =>
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(name)}, 'ran');` +
      `console.log('::prover-summary:: ' + JSON.stringify({ declared: 1, run: 1 }));`;

    it('streams a sample line (memory, processes, load) every interval WHILE the prover runs', () => {
      const dir = makeTree({
        'mutation-prove-a.mjs': `await new Promise((r) => setTimeout(r, 1800));
          console.log('::prover-summary:: ' + JSON.stringify({ declared: 1, run: 1 }));`,
      });
      try {
        const r = run(dir, [], {
          ...base,
          KNEXT_LANE_MEMINFO_PATH: meminfo(dir, 8000),
          KNEXT_LANE_SAMPLE_MS: '300',
          KNEXT_LANE_WATCH_MS: '200',
        });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
        const samples =
          r.stdout.match(/sample \[a\.mjs\]: mem avail 8000 MiB, procs \S+, load \S+/g) ?? [];
        expect(samples.length, 'sample lines while it ran').toBeGreaterThanOrEqual(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('kills a prover whose machine runs out of memory, names it, and the NEXT prover still runs', () => {
      const dir = makeTree({
        'mutation-prove-a-runaway.mjs': 'setInterval(() => {}, 1000);',
        'mutation-prove-b-after.mjs': marker('ran-b'),
      });
      try {
        const report = join(dir, 'report.json');
        const t0 = Date.now();
        const r = run(dir, ['--report', report], {
          ...base,
          KNEXT_LANE_MEMINFO_PATH: meminfo(dir, 100), // 100 MiB available: starved
          KNEXT_LANE_WATCH_MS: '200',
          KNEXT_PROVER_TIMEOUT_MS: '20000', // the watch must win long before this
        });
        expect(Date.now() - t0, 'the runaway was not killed promptly').toBeLessThan(15_000);
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(
          /RESOURCE RUNAWAY: available memory 100 MiB < 2048 MiB/,
        );
        const rep = JSON.parse(read(report));
        const by = Object.fromEntries(rep.results.map((x: { relPath: string }) => [x.relPath, x]));
        expect(by['scripts/mutation-prove-a-runaway.mjs'].findings.join(' ')).toMatch(
          /RESOURCE RUNAWAY/,
        );
        expect(existsSync(join(dir, 'ran-b')), 'the next prover did not run').toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 40_000);

    it('KILLS FIRST: a slow sample (ps, dmesg, journalctl) cannot delay the runaway kill', () => {
      const dir = makeTree({
        'mutation-prove-a-runaway.mjs': `
          import { writeFileSync } from 'node:fs';
          const start = Date.now();
          writeFileSync('started', String(start));
          setInterval(() => writeFileSync('heartbeat', String(Date.now())), 100);`,
      });
      // The sample command takes 6 s. If the runner sampled BEFORE killing, the
      // prover would keep beating for those 6 s.
      const slow = join(dir, 'slow-extras.sh');
      writeFileSync(slow, '#!/bin/sh\nsleep 6\necho "kernel: slow"\n', { mode: 0o755 });
      try {
        run(dir, [], {
          ...base,
          KNEXT_LANE_MEMINFO_PATH: meminfo(dir, 100),
          KNEXT_LANE_WATCH_MS: '200',
          KNEXT_LANE_EXTRAS_CMD: slow,
          KNEXT_PROVER_TIMEOUT_MS: '30000',
        });
        const started = Number(read(join(dir, 'started')));
        const lastBeat = Number(read(join(dir, 'heartbeat')));
        expect(
          lastBeat - started,
          'the prover kept running while the slow sample was gathered',
        ).toBeLessThan(3000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    it('the sampler lists processes by command NAME (comm), never their full argv', () => {
      const src = read(resolve(REPO_ROOT, RUNNER));
      expect(src).toContain("'pid,ppid,rss,etime,comm'");
      expect(src).not.toMatch(/etime,args/);
    });

    it('a healthy machine is never killed', () => {
      const dir = makeTree({ 'mutation-prove-a.mjs': marker('ran-a') });
      try {
        const r = run(dir, [], { ...base, KNEXT_LANE_MEMINFO_PATH: meminfo(dir, 14_000) });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
        expect(`${r.stdout}${r.stderr}`).not.toMatch(/RESOURCE RUNAWAY/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('resource tripwire and between-prover cleanup', () => {
    const marker = (name: string) =>
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(name)}, 'ran');` +
      `console.log('::prover-summary:: ' + JSON.stringify({ declared: 1, run: 1 }));`;
    const threeProvers = () =>
      makeTree({
        'mutation-prove-a.mjs': marker('ran-a'),
        'mutation-prove-b.mjs': marker('ran-b'),
        'mutation-prove-c.mjs': marker('ran-c'),
      });

    it('a hard shortage STOPS the leg after the prover, names it, and marks the rest NOT RUN', () => {
      const dir = threeProvers();
      try {
        const report = join(dir, 'report.json');
        const r = run(dir, ['--report', report], { KNEXT_LANE_MIN_FREE_DISK_MIB: '999999999' });
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(
          /RESOURCE TRIPWIRE after scripts\/mutation-prove-a\.mjs: free disk/,
        );
        expect(existsSync(join(dir, 'ran-a'))).toBe(true);
        expect(existsSync(join(dir, 'ran-b')), 'the leg kept going after the tripwire').toBe(false);
        expect(existsSync(join(dir, 'ran-c'))).toBe(false);
        // The report STILL exists (the runner is alive), and names every assigned prover.
        const rep = JSON.parse(read(report));
        const by = Object.fromEntries(rep.results.map((x: { relPath: string }) => [x.relPath, x]));
        expect(Object.keys(by).sort()).toEqual([
          'scripts/mutation-prove-a.mjs',
          'scripts/mutation-prove-b.mjs',
          'scripts/mutation-prove-c.mjs',
        ]);
        expect(by['scripts/mutation-prove-a.mjs'].findings.join(' ')).toMatch(/RESOURCE TRIPWIRE/);
        expect(by['scripts/mutation-prove-b.mjs'].findings.join(' ')).toMatch(/NOT RUN/);
        expect(by['scripts/mutation-prove-c.mjs'].findings.join(' ')).toMatch(/NOT RUN/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a memory shortage stops the leg too (a fixture meminfo, on every platform)', () => {
      const dir = threeProvers();
      const meminfo = join(dir, 'meminfo');
      writeFileSync(meminfo, 'MemTotal:       16384000 kB\nMemAvailable:      102400 kB\n');
      try {
        const r = run(dir, [], {
          KNEXT_LANE_MEMINFO_PATH: meminfo, // 100 MiB available: below the 256 MiB hard stop
          KNEXT_LANE_KILL_AVAIL_MEM_MIB: '0', // keep the mid-prover kill out of this test
          KNEXT_LANE_MIN_FREE_DISK_MIB: '0',
        });
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(
          /RESOURCE TRIPWIRE after scripts\/mutation-prove-a\.mjs: available memory 100 MiB < 256 MiB/,
        );
        expect(existsSync(join(dir, 'ran-b'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('no shortage: every prover runs and no tripwire fires', () => {
      const dir = threeProvers();
      try {
        const r = run(dir, [], {
          KNEXT_LANE_MIN_FREE_DISK_MIB: '0',
          KNEXT_LANE_MIN_AVAIL_MEM_MIB: '0',
        });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
        expect(`${r.stdout}${r.stderr}`).not.toMatch(/RESOURCE TRIPWIRE/);
        for (const n of ['ran-a', 'ran-b', 'ran-c']) expect(existsSync(join(dir, n))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    const withBuildOutput = () => {
      const dir = threeProvers();
      for (const rel of [
        'crates/target/release/x.bin',
        'templates/rust/target/debug/y.bin',
        'packages/kn-next/dist/cli/kn-next.js',
      ]) {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), 'x');
      }
      return dir;
    };
    const SOFT = { KNEXT_LANE_SOFT_FREE_DISK_MIB: '999999999', KNEXT_LANE_MIN_FREE_DISK_MIB: '0' };

    it('under SOFT pressure in CI the regenerable build output is deleted, the built CLI is not', () => {
      const dir = withBuildOutput();
      try {
        const r = run(dir, [], { ...SOFT, KNEXT_LANE_CLEANUP: '1' });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
        expect(r.stdout).toMatch(/removed regenerable build output/);
        expect(existsSync(join(dir, 'crates/target'))).toBe(false);
        expect(existsSync(join(dir, 'templates/rust/target'))).toBe(false);
        expect(
          existsSync(join(dir, 'packages/kn-next/dist/cli/kn-next.js')),
          'the built CLI was deleted',
        ).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('outside CI (no opt-in) build output is NEVER deleted, whatever the pressure', () => {
      const dir = withBuildOutput();
      try {
        run(dir, [], SOFT);
        expect(existsSync(join(dir, 'crates/target/release/x.bin'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a pre-existing lane-owned cargo dir is cleaned only under pressure, never when healthy', () => {
      const dir = threeProvers();
      const cargo = join(dir, 'lane-cargo');
      mkdirSync(cargo);
      writeFileSync(join(cargo, 'dep.rlib'), 'x');
      try {
        run(dir, [], {
          KNEXT_LANE_CLEANUP: '1',
          KNEXT_LANE_CARGO_TARGET_DIR: cargo,
          KNEXT_LANE_SOFT_FREE_DISK_MIB: '0',
        });
        expect(existsSync(join(cargo, 'dep.rlib')), 'cleaned while healthy').toBe(true);
        run(dir, [], { ...SOFT, KNEXT_LANE_CLEANUP: '1', KNEXT_LANE_CARGO_TARGET_DIR: cargo });
        expect(existsSync(join(cargo, 'dep.rlib')), 'not cleaned under pressure').toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('temp entries a prover leaves are removed in CI; entries that pre-existed are kept', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'knext-lane-tmp-'));
      writeFileSync(join(tmp, 'pre-existing.txt'), 'keep');
      const dir = makeTree({
        'mutation-prove-a.mjs': `
          import { mkdtempSync, writeFileSync } from 'node:fs';
          import { join } from 'node:path';
          import { tmpdir } from 'node:os';
          const d = mkdtempSync(join(tmpdir(), 'leaky-'));
          writeFileSync(join(d, 'big.bin'), 'x');
          console.log('::prover-summary:: ' + JSON.stringify({ declared: 1, run: 1 }));`,
      });
      try {
        const leftovers = (extra: Record<string, string>) => {
          run(dir, [], { TMPDIR: tmp, ...extra });
          return readdirSync(tmp).filter((n) => n.startsWith('leaky-'));
        };
        expect(leftovers({}), 'left alone outside CI without the opt-in').toHaveLength(1);
        for (const n of readdirSync(tmp).filter((x) => x.startsWith('leaky-'))) {
          rmSync(join(tmp, n), { recursive: true, force: true });
        }
        expect(leftovers({ KNEXT_LANE_CLEANUP: '1' }), 'leaked temp dir survived').toHaveLength(0);
        expect(existsSync(join(tmp, 'pre-existing.txt'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it('is HERMETIC: a lane-style environment does not leak into the runner under test', () => {
    const dir = makeTree({ 'mutation-prove-a.mjs': ok(1, 1) });
    commitAll(dir);
    const saved = Object.fromEntries(LANE_ENV.map((k) => [k, process.env[k]]));
    try {
      process.env.PROVER_LANE_SHA = 'd'.repeat(40); // not this temp repo's HEAD
      process.env.GITHUB_ACTIONS = 'true';
      process.env.KNEXT_PROVER_TIMEOUT_MS = '1';
      const r = run(dir, ['--shard', '1/1']);
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--list prints exactly the shard and runs nothing', () => {
    const dir = makeTree({
      'mutation-prove-a.mjs': 'throw new Error("must not run");',
      'mutation-prove-b.mjs': 'throw new Error("must not run");',
      'mutation-prove-c.mjs': 'throw new Error("must not run");',
    });
    try {
      const r = run(dir, ['--list', '--shard', '1/2']);
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.split('\n').filter((l) => l.startsWith('scripts/'));
      expect(lines).toEqual(['scripts/mutation-prove-a.mjs', 'scripts/mutation-prove-c.mjs']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a hung prover is KILLED at its own bound, reported TIMED OUT, and the NEXT prover still runs', () => {
    const dir = makeTree({
      'mutation-prove-a-hang.mjs': 'setInterval(() => {}, 1000);',
      'mutation-prove-b-fine.mjs': ok(2, 2),
    });
    try {
      const report = join(dir, 'report.json');
      const t0 = Date.now();
      const r = run(dir, ['--report', report], { KNEXT_PROVER_TIMEOUT_MS: '1500' });
      expect(Date.now() - t0).toBeLessThan(30_000);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/TIMED OUT/);
      const rep = JSON.parse(read(report));
      const byName = Object.fromEntries(
        rep.results.map((x: { relPath: string }) => [x.relPath, x]),
      );
      expect(byName['scripts/mutation-prove-a-hang.mjs'].findings.join(' ')).toMatch(/timed out/i);
      expect(byName['scripts/mutation-prove-b-fine.mjs'].findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a prover that outlives the timeout takes its CHILDREN with it (no orphan mutating the tree)', () => {
    const dir = makeTree({});
    const mark = join(dir, 'orphan-mark.txt');
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'late'), 2500)`;
    writeFileSync(
      join(dir, 'scripts/mutation-prove-a-orphan.mjs'),
      `import { spawn } from 'node:child_process';
       spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
       setInterval(() => {}, 1000);`,
    );
    try {
      const r = run(dir, [], { KNEXT_PROVER_TIMEOUT_MS: '800' });
      expect(r.status).not.toBe(0);
      // Wait past the orphan's own delay; if the group kill missed it, it writes.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
      expect(existsSync(mark), 'the grandchild survived the kill and wrote after the timeout').toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('writes a report whose assigned set is the shard and whose counts are declared/run', () => {
    const dir = makeTree({
      'mutation-prove-a.mjs': ok(3, 3),
      'mutation-prove-b.mjs': ok(5, 5),
      'mutation-prove-c.mjs': ok(2, 1),
    });
    const head = commitAll(dir);
    try {
      const report = join(dir, 'report.json');
      const r = run(dir, ['--shard', '2/2', '--report', report], {
        PROVER_LANE_REF: 'x',
        PROVER_LANE_SHA: head,
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const rep = JSON.parse(read(report));
      expect(rep.assigned).toEqual(['scripts/mutation-prove-b.mjs']);
      expect(rep.discovered).toEqual([
        'scripts/mutation-prove-a.mjs',
        'scripts/mutation-prove-b.mjs',
        'scripts/mutation-prove-c.mjs',
      ]);
      expect(rep.shard).toBe(2);
      expect(rep.shards).toBe(2);
      expect(rep.sha, 'the report carries the leg’s ACTUAL HEAD').toBe(head);
      expect(rep.results[0].declared).toBe(5);
      expect(rep.results[0].run).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a checked-out HEAD that is not the planned sha FAILS the leg before any prover runs', () => {
    const dir = makeTree({ 'mutation-prove-a.mjs': 'throw new Error("must not run");' });
    commitAll(dir);
    try {
      const r = run(dir, ['--shard', '1/1'], { PROVER_LANE_SHA: 'd'.repeat(40) });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/is not the sha the plan pinned/);
      expect(r.stdout).not.toMatch(/▶ scripts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the report records the ACTUAL head, not the sha the plan claimed', () => {
    // No PROVER_LANE_SHA in the environment: nothing to compare, but the report
    // must still carry the real HEAD (it used to echo the env var back).
    const dir = makeTree({ 'mutation-prove-a.mjs': ok(1, 1) });
    const head = commitAll(dir);
    try {
      const report = join(dir, 'report.json');
      const r = run(dir, ['--report', report]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(JSON.parse(read(report)).sha).toBe(head);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('after a timeout the tree is restored — tracked AND untracked residue', () => {
    // A killed prover never ran its byte-snapshot restore. Two kinds of residue:
    // a modified tracked file (git checkout fixes it) and a NEW untracked file
    // (git checkout cannot see it). Files that existed before the prover started
    // are lane-owned and must survive.
    const tree = () => {
      const dir = makeTree({
        'mutation-prove-a-leaky.mjs': `
          import { writeFileSync } from 'node:fs';
          writeFileSync('tracked.txt', 'MUTATED');
          writeFileSync('leak.txt', 'planted by the killed prover');
          setInterval(() => {}, 1000);`,
        'mutation-prove-b-after.mjs': ok(1, 1),
      });
      writeFileSync(join(dir, 'tracked.txt'), 'original');
      commitAll(dir);
      // Untracked, and present BEFORE any prover starts: lane-owned.
      writeFileSync(join(dir, 'lane-owned.txt'), 'lane');
      return dir;
    };
    const env = { KNEXT_PROVER_TIMEOUT_MS: '1500', KNEXT_LANE_RESTORE_AFTER_KILL: '1' };

    it('restores the modified tracked file', () => {
      const dir = tree();
      try {
        const r = run(dir, [], env);
        expect(r.status).not.toBe(0);
        expect(read(join(dir, 'tracked.txt'))).toBe('original');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('removes the untracked file the killed prover created, but keeps lane-owned files', () => {
      const dir = tree();
      try {
        run(dir, [], env);
        expect(existsSync(join(dir, 'leak.txt')), 'the killed prover’s new file survived').toBe(
          false,
        );
        expect(existsSync(join(dir, 'lane-owned.txt')), 'a lane-owned file was deleted').toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('the next prover still runs on the restored tree', () => {
      const dir = tree();
      try {
        const r = run(dir, [], env);
        expect(r.stdout).toMatch(/ok\s+1\/1\s+scripts\/mutation-prove-b-after\.mjs/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('outside CI (and without the opt-in) the tree is NOT touched, and the finding says so', () => {
      const dir = tree();
      try {
        const r = run(dir, [], { KNEXT_PROVER_TIMEOUT_MS: '1500', GITHUB_ACTIONS: '' });
        expect(read(join(dir, 'tracked.txt'))).toBe('MUTATED');
        expect(`${r.stdout}${r.stderr}`).toMatch(/tree was NOT restored/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  });

  it('declared != run in a shard still FAILS the shard (the count check survived the split)', () => {
    const dir = makeTree({ 'mutation-prove-a.mjs': ok(13, 4) });
    try {
      const r = run(dir, ['--shard', '1/1']);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/declared 13.*ran 4/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unrecognised flag is fatal, not "run everything"', () => {
    const dir = makeTree({ 'mutation-prove-a.mjs': ok(1, 1) });
    try {
      const r = run(dir, ['--shrad', '1/2']);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/unknown argument/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an invalid --shard is fatal, not "run everything"', () => {
    const dir = makeTree({ 'mutation-prove-a.mjs': ok(1, 1) });
    try {
      expect(run(dir, ['--shard', '9/2']).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty SHARD (more shards than provers) is fatal, never a vacuous green', () => {
    const dir = makeTree({ 'mutation-prove-a.mjs': ok(1, 1) });
    try {
      const r = run(dir, ['--shard', '2/2']);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/no prover|empty shard/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#2499 the live tree: every committed prover is in exactly one shard of the workflow', () => {
  const wf = workflow();
  const planStepText = () => JSON.stringify(wf.jobs.plan?.steps ?? []);
  const shardCount = (): number => {
    const m = planStepText().match(/"LANE_SHARDS":"?(\d+)/);
    expect(m, 'the plan job must set LANE_SHARDS explicitly').toBeTruthy();
    return Number(m?.[1]);
  };

  it('the plan job states a shard count that is > 1 and not more than the prover count', () => {
    const n = shardCount();
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(discoverProvers(REPO_ROOT).length);
  });

  it('every scripts/mutation-prove-*.mjs on disk is discovered', () => {
    const onDisk = readdirSync(resolve(REPO_ROOT, 'scripts'))
      .filter((n) => PROVER_RE.test(n))
      .map((n) => `scripts/${n}`)
      .sort();
    expect(discoverProvers(REPO_ROOT).map((p: { relPath: string }) => p.relPath)).toEqual(onDisk);
  });

  it('`run-mutation-provers --list --shard i/N` over i=1..N covers the discovered set exactly once', () => {
    const n = shardCount();
    const seen: string[] = [];
    for (let i = 1; i <= n; i++) {
      const r = spawnSync(
        process.execPath,
        [resolve(REPO_ROOT, RUNNER), '--list', '--shard', `${i}/${n}`],
        {
          encoding: 'utf8',
        },
      );
      expect(r.status, r.stderr).toBe(0);
      const got = r.stdout.split('\n').filter((l) => l.startsWith('scripts/'));
      expect(got.length, `shard ${i}/${n} is empty`).toBeGreaterThan(0);
      seen.push(...got);
    }
    const all = discoverProvers(REPO_ROOT).map((p: { relPath: string }) => p.relPath);
    expect(seen.length).toBe(all.length);
    expect([...seen].sort()).toEqual(all);
  });
});

describe('#2499 the workflow: both refs, sharded, per-shard timeout, aggregated, alerting', () => {
  const wf = workflow();
  const text = read(WORKFLOW_PATH);
  const lane = () => wf.jobs['run-mutation-provers'];

  it('plans over BOTH main and integration/v2 by default (a schedule runs from main only)', () => {
    // Two places state the default and BOTH must carry both refs: the plan's own
    // fallback is what a SCHEDULE uses (no inputs exist then), the dispatch
    // input default is what a manual run shows. Asserting the pair as one blob
    // would let either be dropped while the other kept the test green.
    const planStep = (wf.jobs.plan?.steps ?? []).find((s) => s.id === 'plan');
    const scheduled = String((planStep?.env as Record<string, unknown>)?.LANE_REFS ?? '');
    expect(scheduled, 'the SCHEDULED default').toMatch(/'main integration\/v2'/);
    const dispatch = (wf.on as { workflow_dispatch?: { inputs?: { refs?: { default?: string } } } })
      .workflow_dispatch?.inputs?.refs?.default;
    expect(dispatch, 'the dispatch input default').toBe('main integration/v2');
    expect(LANE_REFS.join(' '), 'the library constant the plan script falls back to').toBe(
      'main integration/v2',
    );
  });

  it('the schedule is weekly over BOTH refs plus a DAILY entry that proves integration/v2 ONLY', () => {
    const crons = (wf.on as { schedule?: Array<{ cron: string }> }).schedule?.map((e) => e.cron);
    expect(crons).toEqual(['7 6 * * 0', '37 6 * * 1,2,3,4,5,6']);
    const planStep = (wf.jobs.plan?.steps ?? []).find((s) => s.id === 'plan');
    const refs = String((planStep?.env as Record<string, unknown>)?.LANE_REFS ?? '');
    // The daily cron string appears in the mapping, and maps to v2 alone...
    expect(refs).toContain("github.event.schedule == '37 6 * * 1,2,3,4,5,6' && 'integration/v2'");
    // ...while the fall-through (the weekly run, and a drifted string) is BOTH refs.
    expect(refs).toMatch(/\|\| 'main integration\/v2' \}\}$/);
  });

  it('the residue step also catches NEW untracked files, against a snapshot taken before the provers', () => {
    const steps = (wf.jobs['run-mutation-provers'].steps ?? []) as Step[];
    const snap = steps.findIndex(
      (s) =>
        /untracked-before\.txt/.test(String(s.run ?? '')) && !/comm /.test(String(s.run ?? '')),
    );
    const lane = steps.findIndex((s) => /run-mutation-provers\.mjs/.test(String(s.run ?? '')));
    const residue = steps.find((s) => /scan-mutation-residue\.mjs/.test(String(s.run ?? '')));
    expect(snap, 'no step records the untracked files').toBeGreaterThanOrEqual(0);
    expect(snap, 'the snapshot must precede the provers').toBeLessThan(lane);
    expect(String(residue?.run)).toMatch(/comm -13 .*untracked-before\.txt.*untracked-after\.txt/);
    expect(String(residue?.run)).toMatch(/if \[ -n "\$\{new\}" \]; then/);
    expect(String(residue?.run)).toMatch(/exit 1/);
  });

  it('the cargo-heavy Rust scaffold prover ADOPTS the per-leg cargo dir, for its own process only', () => {
    // It exists on integration/v2 only; on a ref without it there is nothing to adopt
    // and the seam stays unused, which is correct, not a gap.
    const path = resolve(REPO_ROOT, 'scripts/mutation-prove-2489-rust-scaffold.mjs');
    if (existsSync(path)) {
      expect(read(path)).toMatch(
        /if \(process\.env\.KNEXT_LANE_CARGO_TARGET_DIR\) \{\s*process\.env\.CARGO_TARGET_DIR = process\.env\.KNEXT_LANE_CARGO_TARGET_DIR;/,
      );
    }
    // The lane keeps the generators between that prover's runs (unconditional: the
    // workflow is the same file on every ref, whether or not the prover exists).
    const step = (wf.jobs['run-mutation-provers'].steps ?? []).find((s) =>
      /run-mutation-provers\.mjs/.test(String(s.run ?? '')),
    );
    expect(String((step?.env as Record<string, unknown>)?.KNEXT_RUST_CODEGEN_DIR)).toMatch(
      /^\$\{\{ runner\.temp \}\}\//,
    );
  });

  it('the lane job is a matrix fed by the plan job, fail-fast OFF (a red leg must not hide the others)', () => {
    const strategy = lane().strategy as { matrix?: unknown; 'fail-fast'?: unknown };
    expect(JSON.stringify(strategy.matrix)).toMatch(/fromJSON\(needs\.plan\.outputs\./);
    expect(strategy['fail-fast']).toBe(false);
    const needs = ([] as string[]).concat((lane().needs as string | string[]) ?? []);
    expect(needs).toContain('plan');
  });

  it('every leg checks out its PINNED sha, not a moving branch name', () => {
    const checkout = (lane().steps ?? []).find((s) =>
      String(s.uses ?? '').startsWith('actions/checkout'),
    );
    expect(checkout, 'no checkout step').toBeTruthy();
    expect(JSON.stringify(checkout?.with)).toContain('matrix.sha');
  });

  it('the TIMEOUT is set on the leg (per shard) as a number, and is a real bound (not the 360-minute default)', () => {
    const t = lane()['timeout-minutes'];
    expect(typeof t).toBe('number');
    expect(t as number).toBeGreaterThan(0);
    expect(t as number).toBeLessThanOrEqual(240);
  });

  it('every prover is bounded too: the lane step sets KNEXT_PROVER_TIMEOUT_MS below the leg timeout', () => {
    const step = (lane().steps ?? []).find((s) =>
      /run-mutation-provers\.mjs/.test(String(s.run ?? '')),
    );
    expect(step, 'no step runs the lane runner').toBeTruthy();
    const env = (step?.env ?? {}) as Record<string, string | number>;
    const ms = Number(env.KNEXT_PROVER_TIMEOUT_MS);
    expect(Number.isFinite(ms) && ms > 0).toBe(true);
    expect(ms / 60_000).toBeLessThan(lane()['timeout-minutes'] as number);
    expect(String(step?.run)).toMatch(
      /--shard \$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.shards \}\}/,
    );
    expect(String(step?.run)).toMatch(/--report/);
    // An OPT-IN per-leg cargo target dir, outside the tree...
    expect(String(env.KNEXT_LANE_CARGO_TARGET_DIR ?? ''), 'KNEXT_LANE_CARGO_TARGET_DIR').toMatch(
      /^\$\{\{ runner\.temp \}\}\//,
    );
    // ...and NEVER lane-wide: a global CARGO_TARGET_DIR was measured live to turn
    // `knext-ffi-crates` red at its baseline (it hardcodes target/release/).
    expect(Object.keys(env), 'a lane-wide CARGO_TARGET_DIR breaks provers').not.toContain(
      'CARGO_TARGET_DIR',
    );
  });

  it('every leg uploads its report even when the leg is red', () => {
    const up = (lane().steps ?? []).find((s) =>
      String(s.uses ?? '').startsWith('actions/upload-artifact'),
    );
    expect(up, 'no upload-artifact step').toBeTruthy();
    expect(String(up?.if ?? '')).toMatch(/always\(\)/);
  });

  it('the residue assertion survives the matrix, unconditional', () => {
    const steps = lane().steps ?? [];
    const res = steps.filter((s) => /scan-mutation-residue\.mjs/.test(String(s.run ?? '')));
    expect(res.length).toBe(1);
    expect(String(res[0].if ?? '')).toMatch(/always\(\)/);
  });

  it('an aggregate job asserts the shard union, runs always(), and needs the lane and the plan', () => {
    const agg = wf.jobs.aggregate;
    expect(agg, 'no aggregate job').toBeTruthy();
    const needs = ([] as string[]).concat((agg.needs as string | string[]) ?? []);
    expect(needs).toEqual(expect.arrayContaining(['plan', 'run-mutation-provers']));
    expect(String(agg.if ?? '')).toMatch(/always\(\)/);
    expect(JSON.stringify(agg.steps)).toContain('prover-lane-aggregate.mjs');
  });

  it('the alert embeds the aggregate summary and the known-red list', () => {
    const agg = wf.jobs.aggregate;
    expect(JSON.stringify(agg.outputs)).toContain('steps.aggregate.outputs.summary');
    expect((agg.steps ?? []).some((s) => s.id === 'aggregate')).toBe(true);
    const step = (wf.jobs['nightly-red-alert'].steps ?? []).find((s) =>
      /nightly-alert-issue\.mjs/.test(String(s.run ?? '')),
    );
    expect(String((step?.env as Record<string, unknown>)?.AGG_SUMMARY)).toBe(
      '${{ needs.aggregate.outputs.summary }}',
    );
    expect(String(step?.run)).toContain('${AGG_SUMMARY}');
    expect(String(step?.run)).toContain('node scripts/prover-lane-known-red.mjs');
  });

  it('the alert fires on failure OR cancelled of ANY of plan / lane / aggregate', () => {
    const alert = wf.jobs['nightly-red-alert'];
    const needs = ([] as string[]).concat((alert.needs as string | string[]) ?? []);
    expect(needs).toEqual(expect.arrayContaining(['plan', 'run-mutation-provers', 'aggregate']));
    const cond = String(alert.if ?? '');
    for (const j of ['plan', 'run-mutation-provers', 'aggregate']) {
      expect(cond, j).toContain(`needs.${j}.result == 'failure'`);
      expect(cond, j).toContain(`needs.${j}.result == 'cancelled'`);
    }
    expect(cond).toContain("github.event_name == 'schedule'");
  });

  it('no job in the lane closure carries a disarm (job-level if / continue-on-error)', () => {
    const jobs = wf.jobs as unknown as Record<string, never>;
    const problems: string[] = [];
    auditJobCanNotSkip(jobs, 'run-mutation-provers', problems, {
      dynamicMatrixJobs: ['run-mutation-provers'],
    });
    expect(problems, problems.join(' | ')).toEqual([]);
  });

  it('permissions stay minimal: contents: read at the top; only the alert job can write issues', () => {
    const top = (wf as unknown as { permissions: Record<string, string> }).permissions;
    expect(top).toEqual({ contents: 'read' });
    for (const [id, job] of Object.entries(wf.jobs)) {
      const p = (job.permissions ?? {}) as Record<string, string>;
      if (id !== 'nightly-red-alert') {
        expect(Object.values(p).includes('write'), `${id} must not hold a write scope`).toBe(false);
      }
    }
  });

  it('dispatch can narrow to one shard of one ref, and the scheduled alert ignores dispatch', () => {
    const inputs = (wf.on as { workflow_dispatch?: { inputs?: Record<string, unknown> } })
      .workflow_dispatch?.inputs;
    expect(Object.keys(inputs ?? {})).toEqual(expect.arrayContaining(['refs', 'only_shard']));
    expect(text).not.toMatch(/continue-on-error/);
  });

  it('the Go on PATH satisfies EVERY go.mod a prover builds (the last setup-go is the newest needed)', () => {
    const goLine = (rel: string) => {
      const path = resolve(REPO_ROOT, rel);
      if (!existsSync(path)) return null;
      const m = /^go (\d+)\.(\d+)(?:\.(\d+))?/m.exec(read(path));
      return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
    };
    const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const mods = ['packages/kn-next-operator/go.mod', 'templates/go/go.mod'].filter((m) =>
      existsSync(resolve(REPO_ROOT, m)),
    );
    const needed = mods
      .map((m) => ({ m, v: goLine(m) as number[] }))
      .sort((a, b) => cmp(b.v, a.v))[0];
    const goSteps = (lane().steps ?? []).filter((s) =>
      String(s.uses ?? '').startsWith('actions/setup-go'),
    );
    expect(goSteps.length).toBeGreaterThan(0);
    // setup-go prepends to PATH, so the LAST step that runs wins. Each step is
    // gated by file presence, so the last one whose go.mod EXISTS is the one.
    const live = goSteps.filter((s) => {
      const f = String((s.with as Record<string, unknown>)['go-version-file']);
      return existsSync(resolve(REPO_ROOT, f));
    });
    const last = live[live.length - 1];
    expect(String((last.with as Record<string, unknown>)['go-version-file'])).toBe(needed.m);
    // On EVERY ref (whether or not templates/go exists there) the lane carries the
    // template's Go install, so the guard does not go quiet on a ref without it.
    expect(
      goSteps.some(
        (s) => (s.with as Record<string, unknown>)['go-version-file'] === 'templates/go/go.mod',
      ),
      'no setup-go step for templates/go/go.mod',
    ).toBe(true);
    // ...and a step for a module that may be absent on some ref is gated by presence.
    for (const s of goSteps) {
      const f = String((s.with as Record<string, unknown>)['go-version-file']);
      if (f.startsWith('templates/')) {
        expect(String(s.if ?? ''), f).toContain(`hashFiles('${f}')`);
      }
    }
  });

  it('toolchains that exist only on some refs are installed by FILE PRESENCE, not skipped by ref name', () => {
    // main has no crates/ or templates/rust/. A step that runs unconditionally
    // would red every main leg; a step skipped by `matrix.ref == ...` would
    // silently drop a toolchain the next time a prover needs it on main.
    for (const marker of ['crates/rust-toolchain.toml', 'templates/rust/rust-toolchain.toml']) {
      const step = (lane().steps ?? []).find((s) =>
        JSON.stringify(s).includes(`hashFiles('${marker}')`),
      );
      expect(step, `no step gated by hashFiles('${marker}')`).toBeTruthy();
    }
    expect(JSON.stringify(lane().steps)).not.toMatch(/matrix\.ref ==/);
  });
});
