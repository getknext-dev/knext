// Guards the attribution arithmetic of benchmarks/scale-to-zero-oke/cold-attribution-report.mjs.
//
// The instrument's whole value is that it is allowed to say "I cannot tell you why". These tests
// are the mutation proof for the three ways it could still emit a FALSE attribution:
//   1. argmax survives a floor applied to the SUM (five intervals × ~20% clears 50%, and the tool
//      names a bucket that itself explains 20%);
//   2. overlapping intervals (pulling→pulled sits inside scheduled→started) double-count and inflate
//      the explained share;
//   3. ready→response is an upper bound whose end marker is the k6 driver container's termination,
//      so it is the interval most likely to be named spuriously.
// A fourth: clipping per-interval excess at zero biases the explained share upward only.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_FLOOR,
  attributeSlowSample,
  DECOMPOSITION_KEYS,
  DIAGNOSTIC_KEYS,
  fastBaseline,
  QUANTIZATION_S,
} from '../benchmarks/scale-to-zero-oke/cold-attribution-attribute.mjs';

// A baseline where every interval's worst fast value is 0 s, and the worst fast total is 2.8 s.
const baseline = {
  fastDurCeil: 2.8,
  fastCeil: { schedDelay: 0, pullDelta: 0, startDelay: 0, boot: 0, postReady: 0 },
};

describe('the decomposition is non-overlapping', () => {
  it('scores only the contiguous create→scheduled→started→ready chain', () => {
    expect(DECOMPOSITION_KEYS).toEqual(['schedDelay', 'startDelay', 'boot']);
  });

  it('treats the contained and the contaminated intervals as diagnostics, never as evidence', () => {
    expect(DIAGNOSTIC_KEYS).toEqual(['pullDelta', 'postReady']);
  });
});

describe('argmax cannot name a cause that only explains a fifth of the excess', () => {
  // THE ANCHOR CASE. Five intervals each contributing ~20% of a 10 s excess. Under the old rule
  // the summed share is 100%, clears the 50% floor, and the tool names excesses[0] — a bucket that
  // explains 20%. That is a false attribution.
  const fiveWayTie = {
    dur: 12.8, // 10.0 s excess over the 2.8 s worst fast sample
    intervals: { schedDelay: 2.0, pullDelta: 2.0, startDelay: 2.0, boot: 2.0, postReady: 2.0 },
  };

  it('reports it as UNATTRIBUTABLE rather than naming the largest interval', () => {
    const a = attributeSlowSample(fiveWayTie, baseline);
    expect(a.cause).toBe('UNATTRIBUTABLE');
    expect(a.note).toMatch(/no single interval/i);
  });

  it('emits a ranked list so the reader sees the spread that defeated the floor', () => {
    const a = attributeSlowSample(fiveWayTie, baseline);
    expect(a.ranked.map((e) => e.k)).toEqual(DECOMPOSITION_KEYS);
    for (const e of a.ranked) expect(e.share).toBeLessThan(ATTRIBUTION_FLOOR);
  });
});

describe('overlapping intervals do not inflate the explained share', () => {
  // pulling→pulled is CONTAINED inside scheduled→started. Summing both double-counts the pull: a
  // sample that is 30% pull-driven scored ~60% under the old rule and cleared the floor.
  it('a 30%-pull sample does not reach the floor by counting the pull twice', () => {
    const a = attributeSlowSample(
      {
        dur: 12.8, // 10 s excess
        intervals: { schedDelay: 0, pullDelta: 3.0, startDelay: 3.0, boot: 0, postReady: 4.0 },
      },
      baseline,
    );
    expect(a.explained).toBeCloseTo(3.0, 6); // the pull counted ONCE, inside startDelay
    expect(a.share).toBeCloseTo(0.3, 6);
    expect(a.cause).toBe('UNATTRIBUTABLE');
  });
});

describe('ready→response cannot be named', () => {
  it('is excluded from the explained share, because its end marker is the driver pod teardown', () => {
    const a = attributeSlowSample(
      {
        dur: 12.8,
        intervals: { schedDelay: 0, pullDelta: null, startDelay: 0, boot: 0, postReady: 10.0 },
      },
      baseline,
    );
    expect(a.explained).toBe(0);
    expect(a.cause).toBe('UNATTRIBUTABLE');
    expect(a.note).toMatch(/ready→response/);
    const postReady = a.diagnostics.find((d) => d.k === 'postReady');
    expect(postReady?.excess).toBeCloseTo(10.0, 6);
    expect(postReady?.reason).toMatch(/driver/i);
  });
});

describe('per-interval excess is signed, so quantization noise cannot only push upward', () => {
  it('an interval below its fast ceiling subtracts from the explained share', () => {
    const a = attributeSlowSample(
      {
        dur: 12.8,
        intervals: { schedDelay: -1.0, pullDelta: null, startDelay: 6.0, boot: 0, postReady: 0 },
      },
      { fastDurCeil: 2.8, fastCeil: { ...baseline.fastCeil } },
    );
    expect(a.explained).toBeCloseTo(5.0, 6); // 6.0 - 1.0, not 6.0
  });
});

describe('a genuinely dominant interval is still named', () => {
  it('names started→ready when it alone clears the floor and the 1 s quantization', () => {
    const a = attributeSlowSample(
      {
        dur: 12.8,
        intervals: { schedDelay: 0, pullDelta: 0, startDelay: 1.0, boot: 8.0, postReady: 1.0 },
      },
      baseline,
    );
    expect(a.cause).toMatch(/started→ready/);
    expect(a.share).toBeGreaterThanOrEqual(ATTRIBUTION_FLOOR);
  });

  it('refuses to name an interval whose excess is inside the 1 s condition-timestamp resolution', () => {
    const a = attributeSlowSample(
      {
        dur: 3.6,
        intervals: { schedDelay: 0, pullDelta: 0, startDelay: 0, boot: 0.8, postReady: 0 },
      },
      baseline,
    );
    expect(QUANTIZATION_S).toBe(1.0);
    expect(a.cause).toBe('UNATTRIBUTABLE');
    expect(a.note).toMatch(/quantiz/i);
  });
});

describe('baseline and non-excess handling', () => {
  it('uses the WORST fast sample per interval, never a median', () => {
    const b = fastBaseline([
      {
        dur: 2.0,
        intervals: { schedDelay: 0, pullDelta: 0, startDelay: 1, boot: 1, postReady: 1 },
      },
      {
        dur: 2.8,
        intervals: { schedDelay: 1, pullDelta: 0, startDelay: 0, boot: 2, postReady: 3 },
      },
    ]);
    expect(b.fastDurCeil).toBe(2.8);
    expect(b.fastCeil.boot).toBe(2);
    expect(b.fastCeil.schedDelay).toBe(1);
  });

  it('says so when a sample is not in excess of the fast mode', () => {
    const a = attributeSlowSample(
      {
        dur: 2.5,
        intervals: { schedDelay: 0, pullDelta: 0, startDelay: 0, boot: 0, postReady: 0 },
      },
      baseline,
    );
    expect(a.cause).toBeNull();
  });

  it('cannot attribute without a fast baseline', () => {
    const a = attributeSlowSample(
      {
        dur: 11.0,
        intervals: { schedDelay: 0, pullDelta: 0, startDelay: 0, boot: 0, postReady: 0 },
      },
      { fastDurCeil: null, fastCeil: {} },
    );
    expect(a.cause).toBe('UNATTRIBUTABLE');
    expect(a.note).toMatch(/no fast samples/i);
  });

  it('treats an interval with no fast baseline as unmeasured, not as zero', () => {
    const a = attributeSlowSample(
      {
        dur: 12.8,
        intervals: { schedDelay: null, pullDelta: 0, startDelay: 9.0, boot: 0, postReady: 0 },
      },
      {
        fastDurCeil: 2.8,
        fastCeil: { schedDelay: null, pullDelta: 0, startDelay: 0, boot: 0, postReady: 0 },
      },
    );
    expect(a.unmeasured).toContain('schedDelay');
    expect(a.explained).toBeCloseTo(9.0, 6);
  });
});

// End-to-end through the real report script — the arithmetic being right is worth nothing if the
// script stops calling it. The fixture is the case the cluster has never produced: a slow sample
// whose excess is split five ways.
describe('cold-attribution-report.mjs on a synthetic five-way split', () => {
  const REPORT = resolve(
    import.meta.dirname,
    '../benchmarks/scale-to-zero-oke/cold-attribution-report.mjs',
  );
  const iso = (base: number, sec: number) => new Date(base + sec * 1000).toISOString();
  const T0 = Date.parse('2026-07-27T10:00:00Z');
  const k6log = (med: string) =>
    [
      '     checks.........................: 100.00% ✓ 1        ✗ 0',
      `     http_req_duration..............: avg=${med}s  med=${med}s  min=${med}s  max=${med}s`,
      '     http_req_connecting............: avg=500µs med=500µs min=500µs max=500µs',
      `     http_req_waiting...............: avg=${med}s  med=${med}s  min=${med}s  max=${med}s`,
    ].join('\n');

  // sample 1 FAST: every interval 0 s, so every fast ceiling is 0 and excess == raw value.
  // sample 2 SLOW: 12.80 s = 2.80 s worst-fast + 10.00 s excess, 2 s into each of the five
  //   intervals (pull 2 s sits inside the 2 s container start, as it does on a real pod).
  const samples = [
    { i: 1, t: 0, dur: '2.80', sched: 0, start: 0, ready: 0, end: 0, pull: null },
    { i: 2, t: 100, dur: '12.80', sched: 2, start: 4, ready: 6, end: 8, pull: [2, 4] },
  ] as const;

  const run = () => {
    const rows: unknown[] = [
      { t: iso(T0, -5), kind: 'collector-start', service: 'synthetic', targetDigest: 'sha256:d' },
    ];
    for (const s of samples) {
      const b = T0 + s.t * 1000;
      const pod = `synthetic-00001-deployment-${s.i}`;
      rows.push(
        {
          t: iso(b, 10),
          kind: 'k6pod',
          name: `k6-cold-${s.i}-xyz`,
          node: 'node-a',
          phase: 'Succeeded',
          created: iso(b, 0),
          startedAt: iso(b, 0),
          finishedAt: iso(b, s.end),
        },
        { t: iso(b, 10), kind: 'k6log', pod: `k6-cold-${s.i}-xyz`, log: k6log(s.dur) },
        {
          t: iso(b, 9),
          kind: 'pod',
          name: pod,
          uid: `uid-${s.i}`,
          revision: 'synthetic-00001',
          revisionUid: 'rev-uid',
          node: 'node-a',
          created: iso(b, 0),
          phase: 'Running',
          conditions: [
            { type: 'PodScheduled', status: 'True', at: iso(b, s.sched) },
            { type: 'Ready', status: 'True', at: iso(b, s.ready) },
          ],
          containers: [
            { name: 'user-container', ready: true, startedAt: iso(b, s.start) },
            { name: 'queue-proxy', ready: true, startedAt: iso(b, s.start) },
          ],
          probes: [
            { name: 'user-container', readinessProbe: { httpGet: { path: '/api/health' } } },
          ],
        },
        { t: iso(b, -1), kind: 'node', name: 'node-a', targetImageResident: true },
      );
      if (s.pull) {
        rows.push(
          {
            t: iso(b, 9),
            kind: 'event',
            pod,
            reason: 'Pulling',
            first: iso(b, s.pull[0]),
            message: 'Pulling image',
          },
          {
            t: iso(b, 9),
            kind: 'event',
            pod,
            reason: 'Pulled',
            first: iso(b, s.pull[1]),
            message: 'Successfully pulled image in 2s',
          },
        );
      }
    }
    const fixture = join(mkdtempSync(join(tmpdir(), 'coldattr-')), 'synthetic.jsonl');
    writeFileSync(fixture, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return execFileSync('node', [REPORT, fixture], { encoding: 'utf8' });
  };

  it('reports the sample UNATTRIBUTABLE instead of naming the largest fifth', () => {
    const out = run();
    expect(out).toMatch(/SLOW samples: 1/);
    expect(out).toMatch(/UNATTRIBUTABLE\s+1\/1/);
    expect(out).toMatch(/no single interval reaches the 50% floor/);
  });

  it('prints the ranked list and marks the two non-scoreable intervals as diagnostics', () => {
    const out = run().slice(run().indexOf('sample 2'));
    expect(out).toMatch(/create→scheduled[^\n]*20%/);
    expect(out).toMatch(/\[diagnostic\] ready→response/);
    expect(out).toMatch(/\[diagnostic\] pulling→pulled/);
  });
});
