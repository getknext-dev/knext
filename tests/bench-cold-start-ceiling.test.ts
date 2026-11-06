import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The kubelet ceiling test (scripts/bench-cold-start-phases/ceiling/) wakes one patched worker (P) and
 * one untouched control worker (S) in pairs, in six blocks (oke, stock, relist100, stock, relist100,
 * oke), and asks whether a 100 ms relist removes the pod-IP wait. These tests pin the analyzer's reading
 * on synthetic runs whose answer is known. The runs are generated here from a seeded generator (no
 * cluster data): the lattice periods are off the analyzer's scan grid, the arrivals carry jitter, the
 * blocks span three hours, and the cases include no effect, one shared node, error rows and file order.
 */

const ROOT = resolve(import.meta.dir, '..');
const ANALYZER = 'scripts/bench-cold-start-phases/ceiling/lattice_analyze.py';
const PATCH = 'scripts/bench-cold-start-phases/ceiling/kubelet-patch.diff';
const BUILD = 'scripts/bench-cold-start-phases/ceiling/build.sh';
const RUNBOOK = 'scripts/bench-cold-start-phases/ceiling/RUNBOOK.md';
const MANIFEST = 'scripts/bench-cold-start-phases/ceiling/ceiling-setup.example.yaml';
const DRIVE = 'scripts/bench-cold-start-phases/drive.py';

type Run = { out: string; err: string; code: number };

function analyzeAsync(args: string[]): Promise<Run> {
  return new Promise((done) => {
    const c = spawn('python3', ['-I', join(ROOT, ANALYZER), ...args], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    c.stderr.on('data', (d) => {
      err += d;
    });
    c.on('close', (code) => done({ out, err, code: code ?? -1 }));
  });
}

function analyze(args: string[]): Run {
  const r = spawnSync('python3', ['-I', join(ROOT, ANALYZER), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  return { out: r.stdout, err: r.stderr, code: r.status ?? -1 };
}

// ------------------------------------------------------------------ synthetic runs

function rngOf(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, gauss };
}

/** An arrival process for one arm in one block: pod-IP times fall on a lattice, or are free. */
type Lat =
  | { kind: 'lattice'; period: number; sigmaMs: number; drift?: [number, number] }
  | { kind: 'free'; widthS: number };

type Row = Record<string, unknown>;
type Scn = {
  design?: [string, string][];
  P: (treat: string, block: string) => Lat;
  S: Lat;
  qp0: (treat: string) => number;
  nodes?: { p: string; s: string };
  pairs?: number;
  seed?: number;
};

const DESIGN: [string, string][] = [
  ['b1', 'oke'],
  ['b2', 'stock'],
  ['b3', 'relist100'],
  ['b4', 'relist100'],
  ['b5', 'stock'],
  ['b6', 'oke'],
];
const T0 = 1_800_000_000;
// Timing the runbook states (and the tests below check it against the runbook): a round is the zero-pod
// wait (median 84-92 s), the 10 s settle and two wakes, 1.9-2.4 minutes; a block is 30 rounds plus 17
// minutes of restart, metric reads, settle, warm-up and checks.
const ROUND_MIN = 1.9;
const ROUND_MAX = 2.4;
const OVERHEAD_MIN = 17;
const ROUND_S = 115;
const BLOCK_S = 30 * ROUND_S + OVERHEAD_MIN * 60;
// Periods chosen off any round-number grid.
const STOCK_LAT: Lat = { kind: 'lattice', period: 1.003571, sigmaMs: 5 };
const R100_LAT: Lat = { kind: 'lattice', period: 0.103371, sigmaMs: 5 };

function generate(scn: Scn): Row[] {
  const { next, gauss } = rngOf(scn.seed ?? 11);
  const design = scn.design ?? DESIGN;
  const pairs = scn.pairs ?? 30;
  const nodes = scn.nodes ?? { p: 'node-p', s: 'node-s' };
  const total = design.length * BLOCK_S;
  const phaseS = next();
  const rows: Row[] = [];

  // First lattice instant at or after x (seconds since T0). Drift: the period moves linearly.
  const nextLattice = (x: number, lat: Lat & { kind: 'lattice' }, phase: number) => {
    if (!lat.drift) {
      const k = Math.ceil((x - phase * lat.period) / lat.period);
      return (k + phase) * lat.period;
    }
    const [p0, p1] = lat.drift;
    const s = (p1 - p0) / total;
    const cycles = Math.log(1 + (s * x) / p0) / s;
    const k = Math.ceil(cycles - phase);
    return (p0 / s) * (Math.exp(s * (k + phase)) - 1);
  };

  design.forEach(([block, treat], bi) => {
    const phaseP = next();
    for (const arm of ['p', 's'] as const) {
      for (let r = 1; r <= pairs; r++) {
        const base = bi * BLOCK_S + (r - 1) * ROUND_S + (arm === 's' ? 15 : 0);
        const wall = base + next() * 30; // zero-pod waits vary by tens of seconds: regular spacing would alias
        const qp0 = scn.qp0(treat) + (next() - 0.5) * 40;
        const lat = arm === 'p' ? scn.P(treat, block) : scn.S;
        const ready = wall + qp0 / 1000;
        let arrival: number;
        if (lat.kind === 'free') arrival = ready + next() * lat.widthS;
        else {
          arrival =
            nextLattice(ready, lat, arm === 'p' ? phaseP : phaseS) + (gauss() * lat.sigmaMs) / 1000;
        }
        const ip = Math.round((arrival - wall) * 1000);
        const slow = next() < 0.5;
        rows.push({
          arm,
          block,
          round: r,
          node: arm === 'p' ? nodes.p : nodes.s,
          wall_start: new Date((T0 + wall) * 1000).toISOString(),
          clock: { offset_ms: 0.4, rtt_ms: 1.2 },
          watch: {
            pod_bound: 100,
            pod_ip: ip,
            first_byte: ip + 150 + Math.round((next() - 0.5) * 40),
          },
          logs: {
            'queue-proxy': [{ line: 'qp', t: Math.round(qp0) }],
            'user-container': [{ line: 'user', t: slow ? 900 : 400 }],
          },
        });
      }
    }
  });
  return rows;
}

const EFFECT: Scn = {
  P: (t) => (t === 'relist100' ? R100_LAT : STOCK_LAT),
  S: STOCK_LAT,
  qp0: () => 700,
};

const errorRow = (arm: string, block: string, round: number): Row => ({
  arm,
  block,
  round,
  order: 'fwd',
  waited_s: 12,
  treatment: 'none',
  error: 'harness produced no result in 240 s',
});

function write(dir: string, name: string, rows: Row[]): string {
  const p = join(dir, name);
  writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return p;
}

const dir = mkdtempSync(join(tmpdir(), 'ceiling-analyzer-'));
const FAST = ['--boot=300', '--perms=40'];

const scenarios: Record<string, { rows: Row[]; args?: string[] }> = {};
const results: Record<string, Run> = {};

function define(name: string, rows: Row[], args: string[] = []) {
  scenarios[name] = { rows, args };
}

// The scenarios are defined up front so they can all be analysed in parallel in one beforeAll.
define('effect', generate(EFFECT));
// Seeds are fixed. The carryover screen (99% per treatment) has a few percent false-alarm rate by
// design, so each known-answer case keeps a seed that does not trip it by chance.
define('effectFloor', generate({ ...EFFECT, qp0: () => 900, seed: 12 }));
define(
  'noEffect', // the patched build changed nothing: P is still on the 1 s lattice in every block
  generate({ ...EFFECT, P: () => STOCK_LAT, qp0: () => 300 }),
);
define('sameNode', generate({ ...EFFECT, qp0: () => 300, nodes: { p: 'node-x', s: 'node-x' } }));
define(
  'waitUnmoved', // the 1 s lock is gone but the wait is as long as ever
  generate({ ...EFFECT, P: (t) => (t === 'relist100' ? { kind: 'free', widthS: 1 } : STOCK_LAT) }),
);
define(
  'lockUnseen', // the wait collapsed, with no lattice at 100 ms
  generate({
    ...EFFECT,
    P: (t) => (t === 'relist100' ? { kind: 'free', widthS: 0.1 } : STOCK_LAT),
  }),
);
define(
  'smallMove', // the wait moved a little, within noise: the median is below 0, its interval is not
  generate({
    ...EFFECT,
    P: (t) => (t === 'relist100' ? { kind: 'free', widthS: 0.9 } : STOCK_LAT),
  }),
);
define(
  'mixedLock', // the 1 s lock is back in one relist100 block only
  generate({
    ...EFFECT,
    qp0: () => 300,
    P: (t, b) => (t === 'relist100' ? (b === 'b4' ? STOCK_LAT : R100_LAT) : STOCK_LAT),
  }),
);
define(
  'screen', // the two-block screen: stock then relist100, no oke block, no repeats
  generate({
    ...EFFECT,
    qp0: () => 700,
    design: [
      ['b2', 'stock'],
      ['b3', 'relist100'],
    ],
  }),
  ['--blocks=b2:stock,b3:relist100'],
);
define(
  'partial', // the wait moved down but is still about 250 ms: part of it is not the relist
  generate({
    ...EFFECT,
    P: (t) => (t === 'relist100' ? { kind: 'free', widthS: 0.5 } : STOCK_LAT),
  }),
);
define(
  'worse', // the wait got longer under relist100
  generate({ ...EFFECT, P: (t) => (t === 'relist100' ? { kind: 'free', widthS: 2 } : STOCK_LAT) }),
);
define(
  'noBaselineLock', // there is no 1 s lock to remove on P under the stock build
  generate({
    ...EFFECT,
    P: (t) => (t === 'relist100' ? R100_LAT : { kind: 'free', widthS: 1 }),
  }),
);
define(
  'carryover', // the OKE binary behaves differently at the end than at the start
  generate({
    ...EFFECT,
    P: (t) => (t === 'relist100' ? R100_LAT : STOCK_LAT),
    // b6 is shifted by 300 ms through a longer wait: handled below by editing rows
  }).map((r) =>
    r.block === 'b6' && r.arm === 'p'
      ? {
          ...r,
          watch: {
            ...(r.watch as Row),
            pod_ip: (r.watch as { pod_ip: number }).pod_ip + 800,
            first_byte: (r.watch as { first_byte: number }).first_byte + 800,
          },
        }
      : r,
  ),
);
define(
  'drift', // every kubelet's period wanders 1.0031 -> 1.0038 s over the three hours
  generate({
    ...EFFECT,
    P: (t) =>
      t === 'relist100'
        ? R100_LAT
        : { kind: 'lattice', period: 1.0035, sigmaMs: 5, drift: [1.0031, 1.0038] },
    S: { kind: 'lattice', period: 1.0035, sigmaMs: 5, drift: [1.0031, 1.0038] },
  }),
);
{
  const rows = generate(EFFECT);
  // 2 of 60 wakes per block fail, as drive.py writes them: no node, no watch.
  const failed = rows.map((r) =>
    (r.round === 3 && r.arm === 'p') || (r.round === 9 && r.arm === 's')
      ? errorRow(r.arm as string, r.block as string, r.round as number)
      : r,
  );
  define('errorRows', failed);
  // Exactly 6 failed wakes of 60 in b3 (10%, at the limit), then 7 (over it).
  const limit = (n: number) =>
    rows.map((r) =>
      r.block === 'b3' && r.arm === 'p' && (r.round as number) <= n
        ? errorRow('p', 'b3', r.round as number)
        : r,
    );
  // Clock offsets: no agent on the node (the harness then used offset 0), or a slow round trip.
  const clockOf = (block: string, n: number, clock: unknown) =>
    rows.map((r) =>
      r.block === block && r.arm === 'p' && (r.round as number) <= n ? { ...r, clock } : r,
    );
  define('noClock', clockOf('b2', 3, null));
  define('slowClock', clockOf('b3', 7, { offset_ms: 0.4, rtt_ms: 80 }));
  // A partial file: three blocks written so far, the third with 7 failed wakes of 60.
  define(
    'partialFail',
    limit(7).filter((r) => ['b1', 'b2', 'b3'].includes(r.block as string)),
  );
  // P alone drifts +100 ms per block (a linear trend): the ABBA order must cancel it in the DiD.
  define(
    'linearDrift',
    rows.map((r) => {
      if (r.arm !== 'p') return r;
      const bi = Number((r.block as string).slice(1)) - 1;
      const w = r.watch as { pod_ip: number; first_byte: number };
      return {
        ...r,
        watch: { ...w, pod_ip: w.pod_ip + 100 * bi, first_byte: w.first_byte + 100 * bi },
      };
    }),
  );
  define('failAtLimit', limit(6));
  define('failOverLimit', limit(7));
  // File order: blocks written in the order they were run, then reversed.
  const byBlock = (labels: string[]) => labels.flatMap((b) => rows.filter((r) => r.block === b));
  define('reordered', byBlock(['b5', 'b2', 'b6', 'b1', 'b4', 'b3']));
  define(
    'missingBlock',
    rows.filter((r) => r.block !== 'b4'),
  );
  define(
    'fewPairs', // b2 loses P's wake in 7 rounds (no error rows): 23 complete pairs
    rows.filter((r) => !(r.block === 'b2' && r.arm === 'p' && (r.round as number) <= 7)),
  );
}

beforeAll(async () => {
  await Promise.all(
    Object.entries(scenarios).map(async ([name, s]) => {
      const file = write(dir, `${name}.jsonl`, s.rows);
      results[name] = await analyzeAsync([file, ...FAST, ...(s.args ?? [])]);
    }),
  );
  // The swapped design is the same file as `effect`, labelled differently.
  results.swapped = await analyzeAsync([
    join(dir, 'effect.jsonl'),
    ...FAST,
    '--blocks=b1:oke,b2:relist100,b3:stock,b4:stock,b5:relist100,b6:oke',
  ]);
}, 240_000);

afterAll(() => {
  // CEILING_KEEP_DIR=1 keeps the generated runs for debugging.
  if (!process.env.CEILING_KEEP_DIR) rmSync(dir, { recursive: true, force: true });
});

const verdict = (r: Run) => r.out.match(/^VERDICT: (\w+)$/m)?.[1];

describe('the analyzer on a patched run that works (known answer)', () => {
  it('exits 0, reads six blocks of 30 pairs and passes the gate', () => {
    const r = results.effect;
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('rows read 360, unusable 0');
    for (const b of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+\\w+\\s+30\\s+0\\s+node-p / node-s$`, 'm'));
  });

  it('finds the 1 s lock on P under oke and stock, off the scan grid, and not under relist100', () => {
    const r = results.effect;
    for (const b of ['b1', 'b2', 'b5', 'b6'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+\\w+\\s+P\\s+node-p\\s+1s\\s.*\\byes$`, 'm'));
    for (const b of ['b3', 'b4'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+relist100\\s+P\\s+node-p\\s+1s\\s.*\\bno$`, 'm'));
  });

  it('finds the 100 ms lock on P under relist100 only, and S locked at 1 s in every block', () => {
    const r = results.effect;
    for (const b of ['b3', 'b4'])
      expect(r.out).toMatch(
        new RegExp(`^${b}\\s+relist100\\s+P\\s+node-p\\s+100ms\\s.*\\byes$`, 'm'),
      );
    for (const b of ['b1', 'b2', 'b5', 'b6'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+\\w+\\s+P\\s+node-p\\s+100ms\\s.*\\bno`, 'm'));
    for (const b of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+\\w+\\s+S\\s+node-s\\s+1s\\s.*\\byes$`, 'm'));
  });

  it('does not count the 1 s lattice sub-harmonic inside the 100 ms band as a new lock', () => {
    expect(results.effect.out).toMatch(
      /^b2\s+stock\s+P\s+node-p\s+100ms\s.*\bno \(sub-harmonic of the 1s lock\)$/m,
    );
  });

  it('reports the wait difference in differences as a drop with an interval below zero', () => {
    const m = results.effect.out.match(
      /^wait DiD \(relist100 - stock\): (-?\d+) \[(-?\d+), (-?\d+)\]$/m,
    );
    expect(m).not.toBeNull();
    const [, d, lo, hi] = m as RegExpMatchArray;
    expect(Number(d)).toBeLessThan(-300);
    expect(Number(lo)).toBeLessThanOrEqual(Number(d));
    expect(Number(hi)).toBeLessThan(0);
  });

  it('reads the relist100 wait on P as collapsed', () => {
    const m = results.effect.out.match(
      /^wait P-S\s+relist100\s+-?\d+ \[-?\d+, -?\d+\]\s+P wait median\s+(\d+) \[(\d+), (\d+)\]$/m,
    );
    expect(m).not.toBeNull();
    expect(Number((m as RegExpMatchArray)[3])).toBeLessThanOrEqual(150);
  });

  it('gives RELIST_IS_WAIT_GOAL_MET_ONCE, which is not a pass, when the interval is under 1000 ms', () => {
    const r = results.effect;
    expect(verdict(r)).toBe('RELIST_IS_WAIT_GOAL_MET_ONCE');
    expect(r.out).toContain('met in this run');
    expect(r.out).toContain('one run is not a pass');
    expect(r.out).not.toMatch(/VERDICT: PASS/);
  });

  it('gives a floor when the wait is gone but the first byte stays over 1000 ms', () => {
    const r = results.effectFloor;
    expect(verdict(r)).toBe('RELIST_IS_WAIT_FLOOR');
    expect(r.out).toContain('report as a floor');
  });

  it('prints p95 as descriptive and says the tail is too thin to judge', () => {
    expect(results.effect.out).toMatch(
      /^p95 relist100\s.*descriptive only: n=60 pairs, the tail is too thin to judge$/m,
    );
    expect(results.effect.out).not.toMatch(/p95 delta/);
  });
});

describe('the verdict follows the reading table, not the median alone', () => {
  it('a patched build that changed nothing (P still 1 s locked in relist100) never gets a goal verdict', () => {
    const r = results.noEffect;
    expect(r.code).toBe(0);
    expect(verdict(r)).toBe('INVALID_LOCK_PERSISTS');
    expect(r.out).not.toMatch(/GOAL_MET/);
    expect(r.out).toMatch(/^b3\s+relist100\s+P\s+node-p\s+1s\s.*\byes$/m);
  });

  it('an invalid run does not print a goal criterion, even when the numbers would meet it', () => {
    for (const name of ['noEffect', 'sameNode', 'mixedLock']) {
      const r = results[name];
      expect(r.out).toContain(
        'goal criterion: not evaluated (the run is invalid or the contrast is not attributable)',
      );
      expect(r.out).not.toContain('met in this run');
    }
  });

  it('the verdict section counts the relist100 blocks that are locked, in words that match the verdict', () => {
    expect(results.effect.out).toContain('relist100 blocks 0 of 2 locked at 1 s');
    expect(results.mixedLock.out).toContain('relist100 blocks 1 of 2 locked at 1 s');
    expect(results.noEffect.out).toContain('relist100 blocks 2 of 2 locked at 1 s');
    expect(results.mixedLock.out).not.toContain('none locked');
    expect(results.noEffect.out).not.toContain('locked in some');
  });

  it('a two-block screen (stock then relist100) is analysed on its own, without carryover or build lines', () => {
    const r = results.screen;
    expect(r.code).toBe(0);
    expect(verdict(r)).toBe('RELIST_IS_WAIT_GOAL_MET_ONCE');
    expect(r.out).not.toContain('carryover');
    expect(r.out).not.toContain('build effect');
    expect(r.out).toContain('relist100 blocks 0 of 1 locked at 1 s (each at alpha / 1)');
  });

  it('one relist100 block with the 1 s lock back is INCONCLUSIVE_LOCK_MIXED, not a condemned binary', () => {
    const r = results.mixedLock;
    expect(verdict(r)).toBe('INCONCLUSIVE_LOCK_MIXED');
    expect(r.out).toMatch(/^b4\s+relist100\s+P\s+node-p\s+1s\s.*\byes$/m);
    expect(r.out).toMatch(/^b3\s+relist100\s+P\s+node-p\s+1s\s.*\bno$/m);
  });

  it('arms on one node are INVALID_NODES, whatever the numbers say', () => {
    const r = results.sameNode;
    expect(r.code).toBe(0);
    expect(verdict(r)).toBe('INVALID_NODES');
    expect(r.out).not.toMatch(/GOAL_MET/);
  });

  it('a gone 1 s lock with an unmoved wait is a floor with the wait unattributed', () => {
    expect(verdict(results.waitUnmoved)).toBe('FLOOR_WAIT_UNMOVED');
  });

  it('a collapsed wait and gone 1 s lock with no 100 ms lock is named as such (1 s lock gone, 100 ms undetected)', () => {
    const r = results.lockUnseen;
    expect(verdict(r)).toBe('WAIT_REMOVED_LOCK_UNSEEN');
    expect(r.out).toMatch(/^b3\s+relist100\s+P\s+node-p\s+100ms\s.*\bno$/m);
  });

  it('a wait difference in differences that is negative but includes 0 is not read as a move', () => {
    const r = results.smallMove;
    const m = r.out.match(/^wait DiD \(relist100 - stock\): (-?\d+) \[(-?\d+), (-?\d+)\]$/m);
    expect(m).not.toBeNull();
    const [, d, lo, hi] = m as RegExpMatchArray;
    expect(Number(d)).toBeLessThan(0);
    expect(Number(lo)).toBeLessThan(0);
    expect(Number(hi)).toBeGreaterThan(0);
    expect(verdict(r)).toBe('FLOOR_WAIT_UNMOVED');
  });

  it('a linear drift on P alone (+100 ms per block) cancels in the difference in differences (ABBA)', () => {
    const did = (r: Run) => Number(r.out.match(/^wait DiD \(relist100 - stock\): (-?\d+) /m)?.[1]);
    expect(Math.abs(did(results.linearDrift) - did(results.effect))).toBeLessThan(40);
  });

  it('a wait that moved down but stays over 150 ms is a partial floor', () => {
    expect(verdict(results.partial)).toBe('FLOOR_WAIT_PARTIAL');
  });

  it('a wait that got longer under relist100 is reported as worse', () => {
    expect(verdict(results.worse)).toBe('WAIT_WORSE');
  });

  it('no 1 s lock on P under the stock build leaves nothing to attribute', () => {
    expect(verdict(results.noBaselineLock)).toBe('NO_BASELINE_LOCK');
  });

  it('a late block that differs from the first block of the same treatment is CARRYOVER', () => {
    const r = results.carryover;
    expect(verdict(r)).toBe('CARRYOVER');
    expect(r.out).toMatch(/^carryover oke .*DIFFERS$/m);
  });

  it('takes the treatment from the block label, not from the order of the file or the run', () => {
    const a = results.effect;
    const b = results.reordered;
    expect(verdict(b)).toBe(verdict(a));
    expect(b.out.match(/^wait DiD.*$/m)?.[0]).toBe(a.out.match(/^wait DiD.*$/m)?.[0]);
    // The same file under a swapped label map is a different experiment.
    expect(verdict(results.swapped)).not.toBe('RELIST_IS_WAIT_GOAL_MET_ONCE');
  });

  it('finds every per-block lock when the period drifts over three hours', () => {
    const r = results.drift;
    expect(verdict(r)).toBe('RELIST_IS_WAIT_GOAL_MET_ONCE');
    for (const b of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+\\w+\\s+S\\s+node-s\\s+1s\\s.*\\byes$`, 'm'));
  });
});

describe('error rows and failure rate', () => {
  it('skips and counts failed wakes (no node, no watch) instead of refusing to run', () => {
    const r = results.errorRows;
    expect(r.code).toBe(0);
    expect(r.out).toContain('unusable 12');
    expect(r.out).toContain("'wake_error': 12");
    expect(verdict(r)).toBe('RELIST_IS_WAIT_GOAL_MET_ONCE');
  });

  it('still analyses a block with exactly 10% failed wakes (6 of 60, 24 pairs)', () => {
    expect(results.failAtLimit.code).toBe(0);
  });

  it('exits 4 and judges nothing when a block has more than 10% failed wakes (7 of 60)', () => {
    const r = results.failOverLimit;
    expect(r.code).toBe(4);
    expect(r.err).toContain('block b3');
    expect(r.err).toContain('7 of 60');
    expect(r.out).toBe('');
  });
});

describe('clock offsets and partial files', () => {
  it('prints the clock offset round trip per arm', () => {
    expect(results.effect.out).toMatch(/^clock offset round trip, P: median 1\.2 ms, max 1\.2 ms/m);
  });

  it('treats a wake with no clock offset (the harness used 0) as unusable and counts it', () => {
    const r = results.noClock;
    expect(r.code).toBe(0);
    expect(r.out).toContain("'no_clock_offset': 3");
  });

  it('treats a wake whose offset round trip is over 50 ms as unusable, and refuses past 10%', () => {
    const r = results.slowClock;
    expect(r.code).toBe(4);
    expect(r.err).toContain('7 of 60');
  });

  it('applies the 10% limit to a partial file before it complains about the missing blocks', () => {
    const r = results.partialFail;
    expect(r.code).toBe(4);
    expect(r.err).toContain('block b3');
  });
});

describe('refusals and input errors', () => {
  const lines = (name: string) => scenarios[name].rows.map((r) => JSON.stringify(r));
  const file = (name: string, ls: string[]) => {
    const p = join(dir, name);
    writeFileSync(p, `${ls.join('\n')}\n`);
    return p;
  };

  it('exits 3 when a whole block is missing', () => {
    const r = results.missingBlock;
    expect(r.code).toBe(3);
    expect(r.err).toContain('block b4 has no wakes');
    expect(r.out).toBe('');
  });

  it('exits 3 when a block has 23 complete pairs, below the minimum of 24', () => {
    const r = results.fewPairs;
    expect(r.code).toBe(3);
    expect(r.err).toContain('block b2 has 23 complete pairs');
  });

  it('exits 2 on a line that is not JSON', () => {
    const ls = lines('effect');
    ls[3] = '{not json';
    const r = analyze([file('bad.jsonl', ls)]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('not JSON');
  });

  it('exits 2 on an arm that is neither the P arm nor the S arm', () => {
    const ls = lines('effect');
    ls[0] = ls[0].replace('"arm":"p"', '"arm":"cpu-base"');
    const r = analyze([file('arm.jsonl', ls)]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("arm 'cpu-base'");
  });

  it('exits 2 on a block label the design does not list', () => {
    const ls = lines('effect');
    ls[0] = ls[0].replace('"block":"b1"', '"block":"b9"');
    const r = analyze([file('block.jsonl', ls)]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("block 'b9'");
  });

  it('exits 2 on a row with no integer round', () => {
    const ls = lines('effect');
    ls[0] = ls[0].replace(/"round":\d+/, '"round":"5"');
    const r = analyze([file('round.jsonl', ls)]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('missing integer round');
  });

  it('exits 2 on a missing file, a design without both treatments, and few permutations', () => {
    expect(analyze([join(dir, 'does-not-exist.jsonl')]).code).toBe(2);
    const bad = analyze([join(dir, 'effect.jsonl'), '--blocks=b1:oke,b2:stock']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('relist100');
    const perms = analyze([join(dir, 'effect.jsonl'), '--perms=5']);
    expect(perms.code).toBe(2);
    expect(perms.err).toContain('--perms must be at least 40');
  });
});

describe('the analyzer functions', () => {
  const adir = join(ROOT, 'scripts/bench-cold-start-phases/ceiling');
  // -I drops the script directory from sys.path, so the module is put there explicitly.
  const py = (code: string): string => {
    const r = spawnSync(
      'python3',
      ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(adir)})\n${code}`],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };

  it('finds an exact lattice with R near 1, and no such peak in random phases', () => {
    const out = py(
      [
        'import random, lattice_analyze as m',
        'rng = random.Random(7)',
        'lat = [rng.randrange(0, 4000) * 0.5 + 1000.0 for _ in range(40)]',
        'r, p = m.lock_scan(lat, 0.45, 0.55)',
        'rnd = [rng.uniform(1000.0, 3000.0) for _ in range(40)]',
        'rr, _ = m.lock_scan(rnd, 0.45, 0.55)',
        'print(round(r, 3), round(p, 4), rr < 0.6)',
      ].join('\n'),
    );
    const [r, p, randomLow] = out.split(' ');
    expect(Number(r)).toBeGreaterThan(0.99);
    expect(Number(p)).toBeCloseTo(0.5, 3);
    expect(randomLow).toBe('True');
  });

  it('finds an off-grid 100 ms lattice over a three-hour span (the old 7.5 us grid read R 0.34)', () => {
    const out = py(
      [
        'import random, lattice_analyze as m',
        'rng = random.Random(3)',
        'P = 0.103371',
        'ts = sorted(rng.uniform(0, 10800) for _ in range(60))',
        'ts = [round(t / P) * P + rng.gauss(0, 0.001) for t in ts]',
        'r, p = m.lock_scan(ts, *m.BAND_100MS)',
        'print(round(r, 3), round(p, 6))',
      ].join('\n'),
    );
    const [r, p] = out.split(' ');
    expect(Number(r)).toBeGreaterThan(0.9);
    expect(Math.abs(Number(p) - 0.103371)).toBeLessThan(2e-6);
  });

  it('finds an off-grid 1 s lattice over three hours, and R falls with jitter as the model says', () => {
    const out = py(
      [
        'import math, random, lattice_analyze as m',
        'rng = random.Random(5)',
        'P = 1.003571',
        'def make(sigma, per, n=400):',
        '    return [round(rng.uniform(0, 10800) / per) * per + rng.gauss(0, sigma) for _ in range(n)]',
        'r1, p1 = m.lock_scan(make(0.002, P), *m.BAND_1S)',
        // sigma 10 ms on a 100 ms period: R = exp(-(2*pi*sigma/period)^2/2) = 0.82
        'rj, _ = m.lock_scan(make(0.010, 0.1035), *m.BAND_100MS)',
        'print(round(r1, 3), round(p1, 6), round(rj, 2), round(math.exp(-(2*math.pi*0.010/0.1035)**2/2), 2))',
      ].join('\n'),
    );
    const [r1, p1, rj, model] = out.split(' ').map(Number);
    expect(r1).toBeGreaterThan(0.95);
    expect(Math.abs(p1 - 1.003571)).toBeLessThan(2e-5);
    expect(Math.abs(rj - model)).toBeLessThan(0.08);
  });

  it('pooled over three hours a drifting period smears, while each 30-minute window still locks', () => {
    const out = py(
      [
        'import math, random, lattice_analyze as m',
        'rng = random.Random(9)',
        'p0, p1, total = 1.0031, 1.0038, 10800.0',
        's = (p1 - p0) / total',
        'def lat(x, phase):',
        '    k = math.ceil(math.log(1 + s * x / p0) / s - phase)',
        '    return (p0 / s) * (math.exp(s * (k + phase)) - 1)',
        'xs = sorted(rng.uniform(0, total) for _ in range(180))',
        'ts = [lat(x, 0.3) + rng.gauss(0, 0.004) for x in xs]',
        'pooled, _ = m.lock_scan(ts, *m.BAND_1S)',
        'wins = []',
        'for w in range(6):',
        '    seg = [t for t in ts if w * 1800 <= t < (w + 1) * 1800]',
        '    wins.append(m.lock_scan(seg, *m.BAND_1S)[0])',
        'print(round(pooled, 2), round(min(wins), 2))',
      ].join('\n'),
    );
    const [pooled, minWindow] = out.split(' ').map(Number);
    expect(pooled).toBeLessThan(0.5);
    expect(minWindow).toBeGreaterThan(0.8);
  });

  it('treats a 100 ms lock as the 1 s lattice sub-harmonic only when the periods match to the measured resolution', () => {
    const out = py(
      [
        'import lattice_analyze as m',
        'def t(period, locked=True, span=1800.0):',
        '    return {"period": period, "locked": locked, "span": span}',
        'one = t(1.0035)',
        'print(m.is_subharmonic(one, t(0.10035)),', // exactly a tenth
        '      m.is_subharmonic(one, t(0.1008)),', // 4.5 ms off, inside a fixed 1% tolerance
        '      m.is_subharmonic(one, t(0.1035)),', // the expected patched period
        '      m.is_subharmonic(t(1.0035, False), t(0.10035)),',
        '      m.is_subharmonic(one, t(0.10035, False)))',
      ].join('\n'),
    );
    expect(out).toBe('True False False False False');
  });

  it('computes percentiles by linear interpolation', () => {
    expect(py('import lattice_analyze as m\nprint(m.pct([1, 2, 3, 4], 0.5))')).toBe('2.5');
    expect(py('import lattice_analyze as m\nprint(m.pct([10, 20, 30, 40, 50], 0.95))')).toBe(
      '48.0',
    );
  });
});

describe('the stock-to-patched patch is one constant and the build is pinned', () => {
  const patch = readFileSync(join(ROOT, PATCH), 'utf8');
  const build = readFileSync(join(ROOT, BUILD), 'utf8');

  it('changes exactly one line of pkg/kubelet/kubelet.go, the generic PLEG relist period', () => {
    expect(patch).toContain('diff --git a/pkg/kubelet/kubelet.go b/pkg/kubelet/kubelet.go');
    expect(patch.match(/^@@/gm)?.length).toBe(1);
    const changed = patch.split('\n').filter((l) => /^[+-](?![+-])/.test(l));
    expect(changed).toEqual([
      '-\tgenericPlegRelistPeriod    = time.Second * 1',
      '+\tgenericPlegRelistPeriod    = time.Millisecond * 100',
    ]);
  });

  it('pins the v1.34.10 tag to its commit and refuses any other source', () => {
    expect(build).toContain('TAG="v1.34.10"');
    expect(build).toContain('COMMIT="bd6c4ad159ac77a879838b8f14f23a49bf97de5f"');
    expect(build).toContain('source is $GOT, expected $COMMIT');
  });

  it('builds the control from the untouched tree before it applies the patch', () => {
    const stock = build.indexOf('kubelet-v1.34.10-stock-linux-$ARCH');
    const apply = build.indexOf('git -C "$WORK" apply "$HERE/kubelet-patch.diff"');
    expect(stock).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(stock);
  });

  it('honours GO_TOOLCHAIN: the toolchain check compares against the override, not a literal', () => {
    // The default names the toolchain once; the check and the build read the variable.
    expect(build.match(/go1\.25\.12/g)?.length).toBe(1); // only the default names a toolchain
    expect(build).toContain('GOTOOLCHAIN="$GO_TOOLCHAIN"');
    expect(build).toContain('*" $GO_TOOLCHAIN "*) ;;');
  });

  it('refuses an arm64 build into the default output directory, which holds the amd64 SHA256SUMS', () => {
    const r = spawnSync('bash', [join(ROOT, BUILD)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', KUBELET_CEILING_GOARCH: 'arm64', TMPDIR: dir },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('needs an explicit output directory');
  });

  it('refuses a target architecture it does not know, before cloning anything', () => {
    const r = spawnSync('bash', [join(ROOT, BUILD), join(dir, 'never-created')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', KUBELET_CEILING_GOARCH: 'sparc' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('KUBELET_CEILING_GOARCH must be amd64 or arm64');
  });
});

describe('the runbook states the procedure the harness, the analyzer and the build implement', () => {
  const rb = readFileSync(join(ROOT, RUNBOOK), 'utf8');
  const drive = readFileSync(join(ROOT, DRIVE), 'utf8');
  const analyzer = readFileSync(join(ROOT, ANALYZER), 'utf8');
  const revert = rb.match(/revert\.sh >\/dev\/null <<'EOF'\n([\s\S]*?)\nEOF/)?.[1] ?? '';
  const at = (needle: string) => revert.indexOf(needle);

  it('never writes over the running kubelet, and proves the process by exe hash and arguments', () => {
    expect(rb).not.toMatch(/\bcp\b[^\n]*"\$(KP|KUBELET_PATH)[^"]*"\s+"\$(KP|KUBELET_PATH)"/);
    expect(rb).toContain('/proc/"$(kpid)"/exe');
    expect(rb).toContain('/proc/"$(kpid)"/cmdline');
    expect(rb).toContain('OKE_ARGS');
    expect(rb).toMatch(/`args_sum` must\s+equal `\$OKE_ARGS` in every block/);
  });

  it('the revert script removes the kubelet drop-in, then the CRI-O one, reloads, and restarts', () => {
    expect(revert).not.toBe('');
    const rmKubelet = at('rm -f /run/systemd/system/kubelet.service.d/99-ceiling.conf');
    const rmCrio = at('rm -f /etc/crio/crio.conf.d/99-ceiling-debug.conf');
    const reloadCrio = at('systemctl reload crio');
    const reload = at('systemctl daemon-reload');
    const restart = at('systemctl restart kubelet');
    for (const n of [rmKubelet, rmCrio, reloadCrio, reload, restart])
      expect(n).toBeGreaterThanOrEqual(0);
    expect(rmKubelet).toBeLessThan(reload);
    expect(rmCrio).toBeLessThan(reloadCrio);
    expect(reload).toBeLessThan(restart);
  });

  it('arms the timer through an explicit interpreter, and fire-tests it before block 1', () => {
    expect(rb).toMatch(
      /systemd-run --unit=ceiling-revert --on-active=\d+m --timer-property=AccuracySec=1s \/bin\/sh \/var\/lib\/ceiling\/revert\.sh/,
    );
    expect(rb).toMatch(
      /systemd-run --unit=ceiling-revert-test --on-active=\d+s --timer-property=AccuracySec=1s \/bin\/sh \/var\/lib\/ceiling\/revert\.sh/,
    );
    // an elapsed timer can stay loaded under its name: both are stopped before they are re-created
    expect(rb).toContain('sudo systemctl stop ceiling-revert.timer ceiling-revert.service');
    expect(rb).toContain(
      'sudo systemctl stop ceiling-revert-test.timer ceiling-revert-test.service',
    );
    expect(rb).toContain('Do not start block 1 without it');
    expect(rb).toContain('The run does not start on an untested net.');
    expect(rb.indexOf('Fire test')).toBeLessThan(rb.indexOf('## 6. The block loop'));
    expect(rb).toContain('chcon --reference="$KP"');
  });

  it('the block order in the runbook is the analyzer default: ABBA, a restart before every block but b1', () => {
    expect(analyzer).toContain(
      'DEFAULT_BLOCKS = "b1:oke,b2:stock,b3:relist100,b4:relist100,b5:stock,b6:oke"',
    );
    expect(rb).toMatch(
      /`b1` oke, `b2` stock, `b3` relist100, `b4`\s+relist100, `b5` stock, `b6` oke/,
    );
    expect(rb).toContain('Select X and restart, in every block but `b1`');
  });

  it('every driver flag in the runbook command exists in drive.py, and the safety flags are used', () => {
    const cmd = rb.match(/drive\.py 30[\s\S]*?--block=b1/)?.[0] ?? '';
    expect(cmd).not.toBe('');
    const flags = [...cmd.matchAll(/ (--[a-z-]+)/g)].map((m) => m[1]);
    for (const f of [
      '--place-mode',
      '--pool-label',
      '--namespace',
      '--expect-state',
      '--abort-on-foreign',
      '--abort-failed-fraction',
      '--block',
    ]) {
      expect(flags).toContain(f);
      expect(drive).toContain(`"${f}"`);
    }
    expect(cmd).toContain('--place-mode=restore');
    expect(cmd).toContain('--abort-failed-fraction=0.10');
    expect(rb).toContain('--block=b6');
  });

  it('every analyzer flag in the runbook command exists in the analyzer', () => {
    const cmd = rb.match(/lattice_analyze\.py ceiling-rows[\s\S]*?--boot=2000/)?.[0] ?? '';
    expect(cmd).not.toBe('');
    for (const f of [...cmd.matchAll(/ (--[a-z-]+)/g)].map((m) => m[1]))
      expect(analyzer).toContain(`"${f}"`);
  });

  it('lists every approval beyond one patched worker, including the cordon toggles and the repeat runs', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
      expect(rb).toContain(`| A${n} |`);
    expect(rb).toContain('no field to pin a pod to a node');
    expect(rb).toContain('Repeats, conditional on `RELIST_IS_WAIT_GOAL_MET_ONCE`');
    expect(rb).toContain('The founder personally runs the SSH steps throughout');
    expect(rb).toContain('A cluster-wide freeze of other work');
    expect(rb).toContain('Founder-only cleanup afterwards');
  });

  it('splits the approvals: what the screen needs, what the full run adds', () => {
    const a1 = rb.indexOf('### 1a. The screen');
    const a2 = rb.indexOf('### 1b. The full run');
    const sec2 = rb.indexOf('## 2. Design');
    expect(a1).toBeGreaterThan(0);
    expect(a2).toBeGreaterThan(a1);
    expect(sec2).toBeGreaterThan(a2);
    const screen = rb.slice(a1, a2);
    const full = rb.slice(a2, sec2);
    for (const n of [1, 2, 3, 4, 6, 7, 8, 9, 10, 12, 13, 14]) expect(screen).toContain(`| A${n} |`);
    expect(screen).not.toContain('| A5 |'); // CRI-O debug is the full run's
    expect(screen).not.toContain('| A11 |'); // repeats are conditional, and the full run's
    for (const n of [5, 11]) expect(full).toContain(`| A${n} |`);
    expect(screen).toContain('Risks accepted');
    for (const risk of [
      '25% of a core',
      'runs as root',
      '48 hours',
      'P stays open and S stays closed',
    ])
      expect(screen).toContain(risk);
  });

  it('puts the screen first, with its decision rule, and says what it cannot separate', () => {
    expect(rb).toContain('**Phase 1, the screen (pre-registered first).**');
    expect(rb).toContain('--blocks=b2:stock,b3:relist100');
    expect(rb).toContain('ceiling-screen.jsonl');
    expect(rb).toContain('go on to the full run only if');
    expect(rb).toMatch(/cannot separate:\*\* order[\s\S]*build/);
    expect(rb).toContain('a diagnosis and probably a floor near 1.09 s, not a shipped change');
  });

  it('says WAIT_REMOVED_LOCK_UNSEEN may be the best reachable verdict, and the wait is primary', () => {
    expect(rb).toContain('`WAIT_REMOVED_LOCK_UNSEEN` may be the best verdict reachable');
    expect(rb).toContain('0 of 12 runs at 1 ms');
    expect(rb).toContain('9 of 12 at 0.5 ms');
  });

  it('has a cleanup section that lists the founder-only deletes and runs none', () => {
    const i = rb.indexOf('## 14. Cleanup');
    expect(i).toBeGreaterThan(0);
    const sec = rb.slice(i, rb.indexOf('## 15.'));
    for (const o of [
      'ceil-p',
      'ceil-s',
      'ceil-harness',
      'node-agent pods',
      'RoleBinding',
      'kind delete',
    ])
      expect(sec).toContain(o);
    expect(sec).toContain('deletes\nnothing');
  });

  it('runs kubectl from the workstation, not from P, and labels staged binaries after staging them', () => {
    const s5 = rb.slice(rb.indexOf('## 5. On P'), rb.indexOf('## 6. The block loop'));
    const fences = [...s5.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]);
    // anything on the workstation (kubectl, or the helper that wraps it) is labelled as such
    const withKubectl = fences.filter((f) => /\bkubectl\b|wait-kubelet-heartbeat\.sh/.test(f));
    expect(withKubectl.length).toBeGreaterThan(0);
    for (const f of withKubectl) expect(f.trimStart().startsWith('# workstation')).toBe(true);
    expect(s5.indexOf('sudo install -m 0755 <stock file>')).toBeLessThan(
      s5.indexOf('chcon --reference="$KP" <file>'),
    );
    expect(s5).toContain('label after staging');
  });

  it('the cordon-write and window counts in the runbook are the ones the driver makes', () => {
    // 4 cordon writes per P window is measured against drive.py in the harness test; the totals follow.
    const W = 4;
    const rounds = 30;
    const warm = 2;
    const perBlock = rounds + warm;
    const screen = 2 * perBlock;
    const six = 6 * perBlock;
    const total = six + perBlock;
    expect(rb).toContain(`${screen} P windows, 4 cordon writes each, ${W * screen} writes`);
    expect(rb).toContain(`${six} P windows, 8 kubelet restarts`);
    expect(rb).toContain(
      `**${total} P windows, ${W * total} cordon writes**: 6 blocks x ${perBlock} windows = ${six} (${W * six} writes) plus ${perBlock} for the CRI-O block (${W * perBlock} writes)`,
    );
    expect(rb).toContain(`${screen} P windows; 5 kubelet restarts`);
  });

  it('the timer outlasts the longest re-arm-to-end stretch with a stated margin, and the hours add up', () => {
    const worst = OVERHEAD_MIN + 30 * ROUND_MAX; // 89 minutes
    const minutes = Number(rb.match(/--unit=ceiling-revert --on-active=(\d+)m/)?.[1] ?? Number.NaN);
    expect(minutes).toBeGreaterThanOrEqual(1.5 * worst);
    expect(rb).toContain(`**${Math.round(worst)} minutes**`);
    expect(rb).toContain('1.9-2.4 minutes');
    expect(rb).toContain('84-92 s');
    // the generator's spacing sits inside the runbook's per-round range
    expect(ROUND_S / 60).toBeGreaterThanOrEqual(ROUND_MIN);
    expect(ROUND_S / 60).toBeLessThanOrEqual(ROUND_MAX);
    // hours: fire test 15 + blocks + revert 10; full adds the CRI-O block
    const blk = (per: number) => OVERHEAD_MIN + 30 * per;
    const screenMin = 15 + 2 * blk(ROUND_MIN) + 10;
    const screenMax = 15 + 2 * blk(ROUND_MAX) + 10;
    const fullMin = 15 + 7 * blk(ROUND_MIN) + 10;
    const fullMax = 15 + 7 * blk(ROUND_MAX) + 10;
    expect(rb).toContain(`${Math.round(screenMin)}-${Math.round(screenMax)} minutes`);
    // every place that states the hours states these (the approval, the preconditions, the arithmetic)
    const times = (needle: string) => rb.split(needle).length - 1;
    expect(
      times(`${(screenMin / 60).toFixed(1)}-${(screenMax / 60).toFixed(1)} h`),
    ).toBeGreaterThanOrEqual(4);
    expect(rb).toContain(`${Math.round(fullMin)}-${Math.round(fullMax)} minutes`);
    expect(
      times(`${Math.round(fullMin / 60)}-${Math.round(fullMax / 60)} h`),
    ).toBeGreaterThanOrEqual(4);
    expect(rb).toContain(
      `${Math.round((3 * fullMin + 240) / 60)}-${Math.round((3 * fullMax + 240) / 60)} h`,
    );
    expect(rb).toContain(
      `${Math.round((3 * screenMin + 240) / 60)}-${Math.round((3 * screenMax + 240) / 60)} h`,
    );
    expect(rb).not.toContain('4-5 hours');
    expect(rb).not.toContain('about 90 times');
  });

  it('keeps stale statements out', () => {
    expect(rb).not.toContain('in the same round, 60 s apart');
    expect(rb).not.toMatch(/restarted four times/);
    expect(rb).not.toContain('`b1` follows no restart');
    expect(rb).not.toContain('about 35 minutes');
    expect(rb).toContain("`pod_ip` is **the harness's own watch time**");
  });

  it('never tells the operator to delete anything or to drain', () => {
    expect(rb).not.toMatch(/^\s*(sudo )?kubectl del/m);
    expect(rb).not.toMatch(/^\s*kubectl drain/m);
    expect(rb).not.toMatch(/^\s*kind del/m);
  });

  it('keeps the H3 arithmetic consistent: 1640 - 550 is not under 1000', () => {
    expect(rb).toContain('1640');
    expect(rb).toMatch(/not\s+below 1000/);
    expect(rb).not.toMatch(/bootstrap interval lies below 1000/);
  });
});

describe('a restarted kubelet is waited for by its new heartbeat, not by a stale Ready', () => {
  // Measured on the kind rehearsal: after a kubelet restart the API keeps the OLD Ready=True for ~54 s
  // (even for a crash-looping kubelet), so waiting on the Ready condition proves nothing.
  const HELPER = 'scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh';
  const rb = readFileSync(join(ROOT, RUNBOOK), 'utf8');
  const stubDir = mkdtempSync(join(tmpdir(), 'ceiling-kubectl-stub-'));
  afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

  // A kubectl that answers only `get node ... jsonpath=...lastHeartbeatTime|status` from two files,
  // logs every call's arguments, and fails (exit 1, message on stderr) when the file "fail" exists.
  writeFileSync(
    join(stubDir, 'kubectl'),
    [
      '#!/bin/sh',
      'echo "$*" >> "$STUB_DIR/calls"',
      'if [ -e "$STUB_DIR/failafter" ] && [ "$(wc -l < "$STUB_DIR/calls")" -gt "$(cat "$STUB_DIR/failafter")" ]; then echo "Error: connection refused" >&2; exit 1; fi',
      'if [ -e "$STUB_DIR/fail" ]; then echo "Error: context \\"nope\\" does not exist" >&2; exit 1; fi',
      'case "$*" in',
      '  *lastHeartbeatTime*) cat "$STUB_DIR/hb" ;;',
      '  *status*) cat "$STUB_DIR/st" ;;',
      '  *) echo "unexpected kubectl call: $*" >&2; exit 9 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  function run(args: string[], hb = '', st = 'True', fail = false) {
    writeFileSync(join(stubDir, 'hb'), hb);
    writeFileSync(join(stubDir, 'st'), st);
    writeFileSync(join(stubDir, 'calls'), '');
    rmSync(join(stubDir, 'fail'), { force: true });
    rmSync(join(stubDir, 'failafter'), { force: true });
    if (fail) writeFileSync(join(stubDir, 'fail'), '');
    const r = spawnSync('bash', [join(ROOT, HELPER), ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
        STUB_DIR: stubDir,
        WAIT_KUBELET_HEARTBEAT_INTERVAL: '0.2',
      },
    });
    const calls = readFileSync(join(stubDir, 'calls'), 'utf8').split('\n').filter(Boolean);
    return { out: r.stdout, err: r.stderr, code: r.status ?? -1, calls };
  }
  const BEFORE = '2026-11-05T09:00:00Z';
  const wait = (hb: string, st: string, before = BEFORE, timeout = '2') =>
    run(['wait', 'ctx-ceiling', 'node-p', before, timeout], hb, st);

  it('succeeds when the Ready heartbeat moved and Ready is True', () => {
    const r = wait('2026-11-05T09:10:01Z', 'True');
    expect(r.code).toBe(0);
    expect(r.out).toContain('new heartbeat 2026-11-05T09:10:01Z');
  });

  it('times out (exit 1) on the stale Ready=True that a plain wait would accept at once', () => {
    const r = wait(BEFORE, 'True');
    expect(r.code).toBe(1);
    expect(r.err).toContain('no new kubelet heartbeat after 2s');
  });

  it('does not accept a new heartbeat while Ready is not True', () => {
    expect(wait('2026-11-05T09:10:01Z', 'Unknown').code).toBe(1);
    expect(wait('2026-11-05T09:10:01Z', 'False').code).toBe(1);
  });

  it('does not accept an empty heartbeat (a node without the condition)', () => {
    expect(wait('', 'True').code).toBe(1);
  });

  it('passes the context to every kubectl call, as --context, and never relies on the current one', () => {
    const w = wait('2026-11-05T09:10:01Z', 'True');
    expect(w.calls.length).toBeGreaterThan(0);
    for (const c of w.calls)
      expect(c.startsWith('--context ctx-ceiling get node node-p')).toBe(true);
    const r = run(['read', 'ctx-ceiling', 'node-p'], '2026-11-05T09:10:01Z');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('2026-11-05T09:10:01Z');
    for (const c of r.calls)
      expect(c.startsWith('--context ctx-ceiling get node node-p')).toBe(true);
  });

  it('refuses to run without a context (exit 2, before any kubectl call)', () => {
    for (const args of [['read'], ['read', '', 'node-p'], ['wait', '', 'node-p', BEFORE, '2']]) {
      const r = run(args, '2026-11-05T09:10:01Z');
      expect(r.code).toBe(2);
      expect(r.err).toContain('without a kubectl context');
      expect(r.calls).toEqual([]);
    }
  });

  it('refuses a missing node, a missing prior heartbeat and an unknown mode (exit 2)', () => {
    expect(run(['read', 'ctx-ceiling']).code).toBe(2);
    expect(run(['wait', 'ctx-ceiling', 'node-p']).code).toBe(2);
    expect(run(['wait', 'ctx-ceiling', 'node-p', '']).code).toBe(2);
    expect(run(['sleep', 'ctx-ceiling', 'node-p']).code).toBe(2);
  });

  it('reports a failing kubectl as exit 2 with its message, not as a timeout (exit 1)', () => {
    const w = run(['wait', 'ctx-ceiling', 'node-p', BEFORE, '2'], BEFORE, 'True', true);
    expect(w.code).toBe(2);
    expect(w.err).toContain('does not exist');
    expect(w.err).not.toContain('no new kubelet heartbeat');
    const r = run(['read', 'ctx-ceiling', 'node-p'], '', 'True', true);
    expect(r.code).toBe(2);
    expect(r.err).toContain('does not exist');
    // a node with no Ready heartbeat to read is also an error, not an empty success
    expect(run(['read', 'ctx-ceiling', 'node-p'], '').code).toBe(2);
  });

  it('reports a kubectl that starts failing mid-wait as exit 2, not as a plain timeout', () => {
    // the first lookup (heartbeat, status) works and shows the stale heartbeat; every later call fails
    writeFileSync(join(stubDir, 'hb'), BEFORE);
    writeFileSync(join(stubDir, 'st'), 'True');
    writeFileSync(join(stubDir, 'calls'), '');
    rmSync(join(stubDir, 'fail'), { force: true });
    writeFileSync(join(stubDir, 'failafter'), '2');
    const r = spawnSync(
      'bash',
      [join(ROOT, HELPER), 'wait', 'ctx-ceiling', 'node-p', BEFORE, '2'],
      {
        encoding: 'utf8',
        env: {
          PATH: `${stubDir}:${process.env.PATH ?? ''}`,
          STUB_DIR: stubDir,
          WAIT_KUBELET_HEARTBEAT_INTERVAL: '0.2',
        },
      },
    );
    rmSync(join(stubDir, 'failafter'), { force: true });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('kubectl was failing at the end');
    expect(r.stderr).toContain('connection refused');
  });

  it('every wait in the runbook is preceded by a heartbeat read just before its restart', () => {
    // kubectl wait is gone, the helper is used with the context, in the four places
    expect(rb).not.toContain('kubectl wait --for=condition=Ready');
    // command occurrences only (a fenced line, or the section 8 inline step), not the prose that names it
    const waits = [
      ...rb.matchAll(
        /^\s*`?(?:scripts\/bench-cold-start-phases\/ceiling\/)?wait-kubelet-heartbeat\.sh wait "\$CTX" <P> "\$HB" 120/gm,
      ),
    ];
    expect(waits.length).toBeGreaterThanOrEqual(4);
    for (const m of waits) {
      const idx = m.index ?? 0;
      // the nearest earlier read is within the same step (a stale HB from a previous step is the bug)
      const before = rb.slice(Math.max(0, idx - 1800), idx);
      expect(before).toMatch(/wait-kubelet-heartbeat\.sh read "\$CTX" <P>\)/);
      // and no earlier restart-and-wait pair sits between that read and this wait
      const lastRead = before.lastIndexOf('wait-kubelet-heartbeat.sh read "$CTX" <P>)');
      expect(before.slice(lastRead)).not.toContain('wait-kubelet-heartbeat.sh wait');
    }
    expect(rb).not.toMatch(/HB=\$\(kubectl/);
  });

  it('the revert re-reads HB immediately before the revert restart, not once before the run', () => {
    const s8 = rb.slice(rb.indexOf('## 8. Revert'), rb.indexOf('## 9. Recover'));
    const read = s8.indexOf('wait-kubelet-heartbeat.sh read "$CTX" <P>)');
    const revert = s8.indexOf('sudo /bin/sh /var/lib/ceiling/revert.sh');
    const proof = s8.indexOf('wait-kubelet-heartbeat.sh wait "$CTX" <P> "$HB" 120');
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(revert);
    expect(revert).toBeLessThan(proof);
    expect(s8).toContain('immediately before the revert restart');
    // the manual revert in the fire test and the stop condition also re-read first
    expect(rb).toContain('read `HB` again');
  });

  it('every kubectl in the runbook names the context, and the driver gets it too', () => {
    const lines = rb
      .split('\n')
      .filter((l) => /\bkubectl (get|apply|cordon|uncordon)\b/.test(l) && !/--context/.test(l));
    // the only lines allowed to name kubectl without a context are prose that quotes the bare words
    expect(lines).toEqual([]);
    expect(rb).toContain('--namespace=<NS> --context="$CTX"');
  });
});

describe('the amd64 build is never started on P without a check and a stop condition', () => {
  const rb = readFileSync(join(ROOT, RUNBOOK), 'utf8');

  it('has an off-node start check under amd64 emulation for both builds, pinned by digest', () => {
    for (const f of ['stock', 'relist100ms']) {
      expect(rb).toMatch(
        new RegExp(
          `docker run --rm --platform linux/amd64 -v <build dir>:/k:ro --entrypoint /k/kubelet-v1\\.34\\.10-${f}-linux-amd64 busybox@sha256:[0-9a-f]{64} --version`,
        ),
      );
    }
    expect(rb).toContain('Each must print `Kubernetes v1.34.10`');
    expect(rb).toContain('proves only that the ELF\n   loads and executes');
  });

  it('stops the run if a first start of an amd64 build does not hold, under an armed timer, before any block', () => {
    const s5 = rb.slice(rb.indexOf('## 5. On P'), rb.indexOf('## 6. The block loop'));
    const stop = s5.indexOf('**Stop condition: an amd64 build that does not start as a kubelet.**');
    expect(stop).toBeGreaterThanOrEqual(0);
    // before the staging and before the fire test that first starts the stock build
    expect(stop).toBeLessThan(s5.indexOf('Fire test: the net is proved'));
    expect(stop).toBeGreaterThan(s5.indexOf('**Stop conditions.**'));
    const para = s5.slice(stop, s5.indexOf('**SELinux, for the binaries'));
    for (const needle of [
      'only under an armed revert timer',
      'wait "$CTX" <P> "$HB" 120',
      "`exe_sum` is not that build's sum",
      '`args_sum` is not `$OKE_ARGS`',
      'NRestarts',
      '**stop\nthe whole run**',
      'revert.sh',
      'Do not try the other build',
    ])
      expect(para).toContain(needle);
  });

  it('makes the daemon-reload timer re-basing a stop condition with a numeric pass rule', () => {
    const s5 = rb.slice(rb.indexOf('## 5. On P'), rb.indexOf('## 6. The block loop'));
    const at = s5.indexOf('the first reload on P is a stop-condition check');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(s5.indexOf('Fire test: the net is proved'));
    const para = s5.slice(at, s5.indexOf('Fire test: the net is proved'));
    for (const needle of [
      'systemctl list-timers ceiling-revert.timer',
      'sudo systemctl daemon-reload',
      'not earlier than `NEXT_before`',
      '151 minutes',
      '**Stop if** the timer is no longer listed',
      '**If the timer cannot be proved still armed after a reload, the run does not start.**',
    ])
      expect(para).toContain(needle);
  });
});
describe('the setup manifest is a template with no cluster literal', () => {
  const m = readFileSync(join(ROOT, MANIFEST), 'utf8');

  it('has no IPv4 address and no node name except the placeholder', () => {
    expect(m).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(m.match(/^\s*nodeName:.*$/gm)).toEqual(['  nodeName: <S node>']);
    expect(m).not.toMatch(/image:.*:latest/);
  });

  it('creates ceil-p and ceil-s as NextApps with identical specs, and a harness pinned to S', () => {
    const docs = m.split(/^---$/m);
    const apps = docs.filter((d) => /kind: NextApp/.test(d));
    expect(apps).toHaveLength(2);
    const spec = (d: string) => d.slice(d.indexOf('spec:'));
    expect(spec(apps[0])).toBe(spec(apps[1]));
    // every other bench NextApp carries a pull secret; the template does too
    for (const a of apps) expect(a).toContain('imagePullSecrets: [{name: <PULL SECRET>}]');
    expect(apps.map((d) => d.match(/name: (ceil-[ps])/)?.[1])).toEqual(['ceil-p', 'ceil-s']);
    expect(docs.some((d) => /name: ceil-harness/.test(d) && /nodeName: <S node>/.test(d))).toBe(
      true,
    );
  });
});
