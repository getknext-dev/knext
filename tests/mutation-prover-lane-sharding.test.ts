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
import { discoverProvers, PROVER_RE } from '../scripts/lib/prover-lane.mjs';
import {
  aggregateReports,
  buildMatrix,
  estimateShardMinutes,
  LANE_REFS,
  makeReport,
  PENDING_PROVER_WEIGHT_MINUTES,
  PROVER_WEIGHT_MINUTES,
  parseShardSpec,
  proverTimeoutMs,
  proverWeight,
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

  it('a pending weight is honoured by the partition, and is promoted once its prover exists', () => {
    const have = new Set(real().map((p) => p.relPath));
    for (const [path, w] of Object.entries(PENDING_PROVER_WEIGHT_MINUTES)) {
      expect(proverWeight({ relPath: path }), path).toBe(w);
      expect(
        have.has(path),
        `${path} now exists: move its weight from PENDING_PROVER_WEIGHT_MINUTES to PROVER_WEIGHT_MINUTES`,
      ).toBe(false);
      expect(Object.keys(PROVER_WEIGHT_MINUTES), path).not.toContain(path);
    }
  });

  it('a cargo-heavy prover that arrives is balanced like any other (the pending weight shapes the split)', () => {
    const heavy = Object.keys(PENDING_PROVER_WEIGHT_MINUTES)[0];
    const withIt = [...real(), { relPath: heavy }];
    const loads = Array.from({ length: N }, (_, i) => estimateShardMinutes(withIt, i + 1, N));
    const mean = loads.reduce((a, b) => a + b, 0) / N;
    const biggest = Math.max(
      ...Object.values(PROVER_WEIGHT_MINUTES),
      ...Object.values(PENDING_PROVER_WEIGHT_MINUTES),
    );
    expect(Math.max(...loads)).toBeLessThanOrEqual(mean + biggest);
    // ...and it does not share a leg with the other >=30 minute provers.
    const legOf = (path: string) =>
      Array.from({ length: N }, (_, i) => i + 1).find((i) =>
        shardProvers(withIt, i, N).some((p) => p.relPath === path),
      );
    const big = Object.entries(PROVER_WEIGHT_MINUTES)
      .filter(([, w]) => w >= 30)
      .map(([p]) => p);
    for (const p of big) expect(legOf(p), `${p} shares a leg with ${heavy}`).not.toBe(legOf(heavy));
  });

  it('no leg exceeds the mean estimated load by more than the heaviest single prover (the LPT bound)', () => {
    const all = real();
    const loads = Array.from({ length: N }, (_, i) => estimateShardMinutes(all, i + 1, N));
    const mean = loads.reduce((a, b) => a + b, 0) / N;
    const heaviest = Math.max(...Object.values(PROVER_WEIGHT_MINUTES));
    expect(Math.max(...loads)).toBeLessThanOrEqual(mean + heaviest);
  });

  it('the heaviest provers are NOT co-located (a count split put them in one leg)', () => {
    const heavy = Object.entries(PROVER_WEIGHT_MINUTES)
      .filter(([, w]) => w >= 20)
      .map(([p]) => p);
    expect(heavy.length).toBeGreaterThanOrEqual(3);
    const all = real();
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
      /assigned set differs from the deterministic shard/,
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

  it('the final UNION check catches a partition that is wrong the same way everywhere', () => {
    // The per-leg recomputation cannot see this: runner and aggregate would agree
    // on the same lossy function. Only comparing the union with the discovered set
    // does. (Inject the lossy partition; the real one is covered above.)
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
    const out = aggregateReports({ expected, reports, shard: lossy });
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

describe('#2208 the per-prover bound', () => {
  it('defaults to a finite, positive bound well under the per-leg ceiling', () => {
    const ms = proverTimeoutMs({});
    expect(Number.isFinite(ms) && ms > 0).toBe(true);
    expect(ms).toBe(100 * 60 * 1000);
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
  const ok = (declared: number, run: number) =>
    `console.log('::prover-summary:: ' + JSON.stringify({ declared: ${declared}, run: ${run} }));`;
  const run = (dir: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(dir, RUNNER), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 60_000,
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
    try {
      const report = join(dir, 'report.json');
      const r = run(dir, ['--shard', '2/2', '--report', report], {
        PROVER_LANE_REF: 'x',
        PROVER_LANE_SHA: 'e'.repeat(40),
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
      expect(rep.sha).toBe('e'.repeat(40));
      expect(rep.results[0].declared).toBe(5);
      expect(rep.results[0].run).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(t as number).toBeLessThanOrEqual(180);
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
    // One cargo target dir per leg, outside the tree: cargo-heavy provers do a
    // cold dependency build per run otherwise.
    expect(String(env.CARGO_TARGET_DIR ?? ''), 'CARGO_TARGET_DIR').toMatch(
      /^\$\{\{ runner\.temp \}\}\//,
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
