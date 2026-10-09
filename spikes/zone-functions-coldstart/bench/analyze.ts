// Summarise a Z2 results JSONL: per-cell n / median / IQR of end-to-end and of
// the zone's own timing of the function call, plus the comparisons the report
// needs, each as a median difference with a seeded bootstrap 95% CI and a
// two-sided Mann-Whitney p (normal approximation, tie-corrected).
//
// Usage: bun analyze.ts <results.jsonl> [more.jsonl ...] [--node-c=<settled.jsonl>] > summary.md
//
// --node-c replaces every shape-C Node-zone sample of the other files with the
// settled supplement's (run.ts c-node-settled): the main run's Node C cells
// were confounded with the re-wake stall (see the report, §C). The main run's
// raw file is left as it was recorded.
import { readFileSync } from 'node:fs';

type Rec = {
  shape: string;
  gw: string;
  lang: string;
  transport: string;
  fn: string;
  e2eMs: number;
  code: number;
  valid: boolean;
  body: {
    ok?: boolean;
    callMs?: number;
    zoneUptimeAtReqMs?: number;
    fnUptimeMs?: number;
    error?: string;
  };
};

const load = (f: string) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Rec);
const args = process.argv.slice(2);
const nodeC = args.find((a) => a.startsWith('--node-c='))?.slice('--node-c='.length);
const files = args.filter((a) => !a.startsWith('--'));
const all: Rec[] = files.flatMap(load);
if (nodeC) {
  const keep = all.filter((r) => !(r.shape === 'C' && r.gw === 'node'));
  all.length = 0;
  all.push(...keep, ...load(nodeC));
}
// A cold-zone sample whose zone process had been up > STALL_MS before the
// request reached its handler did not measure the chain: the request was held
// in front of an already-Ready zone pod (the Node-zone re-wake stall, see the
// report and stall-trace.ts). Those are reported separately, not pooled.
const STALL_MS = 5000;
const isStall = (r: Rec) =>
  ['C', 'D', 'E'].includes(r.shape) && (r.body.zoneUptimeAtReqMs ?? 0) > STALL_MS;
const passed = (r: Rec) => r.valid && r.code === 200 && r.body.ok;
const ok = all.filter((r) => passed(r) && !isStall(r));
const stalls = all.filter((r) => passed(r) && isStall(r));
const bad = all.filter((r) => !passed(r));

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const med = (xs: number[]) => q(xs, 0.5);
const r0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toString() : '–');

// Seeded RNG so the CI in the committed report is reproducible.
let seed = 0x5eed;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
function bootDiff(a: number[], b: number[], iters = 5000): [number, number] {
  const d: number[] = [];
  for (let i = 0; i < iters; i++) {
    const ra = a.map(() => a[Math.floor(rnd() * a.length)]);
    const rb = b.map(() => b[Math.floor(rnd() * b.length)]);
    d.push(med(ra) - med(rb));
  }
  return [q(d, 0.025), q(d, 0.975)];
}
function mannWhitneyP(a: number[], b: number[]): number {
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort(
    (x, y) => x.v - y.v,
  );
  const ranks = new Array(all.length).fill(0);
  let tie = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    const t = j - i + 1;
    tie += t ** 3 - t;
    i = j + 1;
  }
  const n1 = a.length;
  const n2 = b.length;
  const r1 = all.reduce((s, x, i) => s + (x.g === 0 ? ranks[i] : 0), 0);
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const n = n1 + n2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1))));
  if (sigma === 0) return 1;
  const z = (Math.abs(u - mu) - 0.5) / sigma;
  // two-sided p from the standard normal
  const erfc = (x: number) => {
    const t = 1 / (1 + 0.5 * x);
    const y =
      t *
      Math.exp(
        -x * x -
          1.26551223 +
          t *
            (1.00002368 +
              t *
                (0.37409196 +
                  t *
                    (0.09678418 +
                      t *
                        (-0.18628806 +
                          t *
                            (0.27886807 +
                              t *
                                (-1.13520398 +
                                  t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
      );
    return y;
  };
  return Math.min(1, erfc(Math.max(0, z) / Math.SQRT2));
}

const sel = (f: Partial<Rec>) =>
  ok.filter((r) =>
    Object.entries(f).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v),
  );
const e2e = (rs: Rec[]) => rs.map((r) => r.e2eMs);
const call = (rs: Rec[]) => rs.map((r) => r.body.callMs ?? Number.NaN).filter(Number.isFinite);

const SHAPES: [string, string][] = [
  ['A', 'warm zone → warm fn'],
  ['B', 'warm zone → cold fn'],
  ['C', 'cold zone → cold fn'],
  ['D', 'cold zone → warm fn'],
  ['E', 'cold zone → cold fn, wake-ahead'],
];
const GWS = ['node', 'bun'];
const LANGS = ['go', 'rust'];
const TRS = ['http1', 'h2c'];

const out: string[] = [];
out.push(
  `Samples: ${all.length} total, ${ok.length} pooled, ${stalls.length} zone re-wake stalls reported separately, ${bad.length} failed or precondition-violated.\n`,
);
out.push('### Raw cells (ms): end-to-end median [IQR] · zone→fn call median [IQR]\n');
out.push(
  '| shape | gateway | lang | transport | n | e2e median | e2e IQR | call median | call IQR |',
);
out.push('|---|---|---|---|---:|---:|---:|---:|---:|');
for (const [s] of SHAPES)
  for (const gw of GWS)
    for (const lang of LANGS)
      for (const tr of TRS) {
        const rs = sel({ shape: s, gw, lang, transport: tr });
        if (rs.length === 0) continue;
        const e = e2e(rs);
        const c = call(rs);
        out.push(
          `| ${s} | ${gw} | ${lang} | ${tr} | ${rs.length} | ${r0(med(e))} | ${r0(q(e, 0.25))}–${r0(q(e, 0.75))} | ${r0(med(c))} | ${r0(q(c, 0.25))}–${r0(q(c, 0.75))} |`,
        );
      }

function cmp(label: string, a: Rec[], b: Rec[], metric: (rs: Rec[]) => number[] = e2e) {
  const xa = metric(a);
  const xb = metric(b);
  if (xa.length < 3 || xb.length < 3) return `| ${label} | ${xa.length}/${xb.length} | – | – | – |`;
  const d = med(xa) - med(xb);
  const [lo, hi] = bootDiff(xa, xb);
  return `| ${label} | ${xa.length}/${xb.length} | ${r0(d)} | ${r0(lo)} … ${r0(hi)} | ${mannWhitneyP(xa, xb).toPrecision(2)} |`;
}

out.push('\n### Pooled over transport: end-to-end median (n) · zone→fn call median, ms\n');
out.push('| shape | node/go | node/rust | bun/go | bun/rust |');
out.push('|---|---:|---:|---:|---:|');
for (const [s, label] of SHAPES) {
  const cells = GWS.flatMap((gw) =>
    LANGS.map((lang) => {
      const rs = sel({ shape: s, gw, lang });
      return rs.length ? `${r0(med(e2e(rs)))} (${rs.length}) · ${r0(med(call(rs)))}` : '–';
    }),
  );
  out.push(`| ${s} ${label} | ${cells.join(' | ')} |`);
}

out.push('\n### Shape deltas, pooled over transport (end-to-end, ms)\n');
out.push('| comparison | n | Δ median | 95% CI | p (MW) |');
out.push('|---|---|---:|---:|---:|');
for (const gw of GWS)
  for (const lang of LANGS) {
    const S = (s: string) => sel({ shape: s, gw, lang });
    out.push(cmp(`${gw}/${lang}: C − D (cold fn on top of a cold zone)`, S('C'), S('D')));
    out.push(cmp(`${gw}/${lang}: B − A (cold fn behind a warm zone)`, S('B'), S('A')));
    out.push(cmp(`${gw}/${lang}: D − A (cold zone alone)`, S('D'), S('A')));
    out.push(cmp(`${gw}/${lang}: E − C (wake-ahead effect)`, S('E'), S('C')));
    out.push(cmp(`${gw}/${lang}: E − D (wake-ahead residual vs a warm fn)`, S('E'), S('D')));
  }

out.push(
  '\n### Transport: h2c − http1, per shape (zone→fn call time as timed inside the zone, ms)\n',
);
out.push('| comparison | n | Δ median | 95% CI | p (MW) |');
out.push('|---|---|---:|---:|---:|');
for (const [s] of SHAPES)
  for (const gw of GWS)
    for (const lang of LANGS)
      out.push(
        cmp(
          `${s} ${gw}/${lang}: h2c − http1`,
          sel({ shape: s, gw, lang, transport: 'h2c' }),
          sel({ shape: s, gw, lang, transport: 'http1' }),
          call,
        ),
      );

out.push(
  '\n### Language: rust − go, per shape (zone→fn call time, pooled over gateway and transport, ms)\n',
);
out.push('| comparison | n | Δ median | 95% CI | p (MW) |');
out.push('|---|---|---:|---:|---:|');
for (const [s] of SHAPES)
  out.push(
    cmp(`${s}: rust − go`, sel({ shape: s, lang: 'rust' }), sel({ shape: s, lang: 'go' }), call),
  );

out.push('\n### Gateway: bun − node, per shape (end-to-end, pooled over lang and transport, ms)\n');
out.push('| comparison | n | Δ median | 95% CI | p (MW) |');
out.push('|---|---|---:|---:|---:|');
for (const [s] of SHAPES)
  out.push(cmp(`${s}: bun − node`, sel({ shape: s, gw: 'bun' }), sel({ shape: s, gw: 'node' })));

// Wake-ahead timeline, zone process clock (ms since the zone process started):
// when the wake fired, when the user request reached the handler, and when the
// wake finished (i.e. the function had answered). Overlap = request − fired.
out.push('\n### Wake-ahead timeline (E samples, zone process clock, ms, medians)\n');
out.push(
  '| gateway | lang | n | wake fired | request reached handler | overlap | wake done | call |',
);
out.push('|---|---|---:|---:|---:|---:|---:|---:|');
type Wake = { entries?: { firedAtMs?: number; doneAtMs?: number }[] };
for (const gw of GWS)
  for (const lang of LANGS) {
    const rs = sel({ shape: 'E', gw, lang });
    if (!rs.length) continue;
    const w = (r: Rec) => ((r.body as unknown as { wake?: Wake }).wake?.entries ?? [])[0] ?? {};
    const fired = rs.map((r) => w(r).firedAtMs ?? Number.NaN).filter(Number.isFinite);
    const done = rs.map((r) => w(r).doneAtMs ?? Number.NaN).filter(Number.isFinite);
    const reqAt = rs.map((r) => r.body.zoneUptimeAtReqMs ?? Number.NaN).filter(Number.isFinite);
    const overlap = rs
      .map((r) => (r.body.zoneUptimeAtReqMs ?? Number.NaN) - (w(r).firedAtMs ?? Number.NaN))
      .filter(Number.isFinite);
    out.push(
      `| ${gw} | ${lang} | ${rs.length} | ${r0(med(fired))} | ${r0(med(reqAt))} | ${r0(med(overlap))} | ${r0(med(done))} | ${r0(med(call(rs)))} |`,
    );
  }

out.push(
  '\n### Zone boot: process uptime when the request reached the handler (cold-zone shapes, ms, median [IQR])\n',
);
out.push('| shape | gateway | n | median | IQR |');
out.push('|---|---|---:|---:|---:|');
for (const s of ['C', 'D', 'E'])
  for (const gw of GWS) {
    const xs = sel({ shape: s, gw })
      .map((r) => r.body.zoneUptimeAtReqMs ?? Number.NaN)
      .filter(Number.isFinite);
    if (xs.length)
      out.push(
        `| ${s} | ${gw} | ${xs.length} | ${r0(med(xs))} | ${r0(q(xs, 0.25))}–${r0(q(xs, 0.75))} |`,
      );
  }

if (stalls.length) {
  out.push(
    `\n### Zone re-wake stalls (zone up > ${STALL_MS} ms before the request reached it; not pooled above)\n`,
  );
  out.push('| shape | gateway | fn | e2e | zone uptime at handler | call |');
  out.push('|---|---|---|---:|---:|---:|');
  for (const r of stalls)
    out.push(
      `| ${r.shape} | ${r.gw} | ${r.fn} | ${r0(r.e2eMs)} | ${r0(r.body.zoneUptimeAtReqMs ?? Number.NaN)} | ${r0(r.body.callMs ?? Number.NaN)} |`,
    );
}

if (bad.length) {
  out.push('\n### Excluded samples\n');
  out.push('| shape | gateway | fn | code | valid | error |');
  out.push('|---|---|---|---:|---|---|');
  for (const r of bad)
    out.push(
      `| ${r.shape} | ${r.gw} | ${r.fn} | ${r.code} | ${r.valid} | ${String(r.body.error ?? '')
        .slice(0, 120)
        .replace(/\|/g, '/')} |`,
    );
}
console.log(out.join('\n'));
