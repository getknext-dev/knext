#!/usr/bin/env node
// Stratified report over results.jsonl: never pools the arms, never reports a median alone.
import { readFileSync } from 'node:fs';

import { unusableReason } from './lib.mjs';

const rows = readFileSync(
  process.argv[2] ?? new URL('./results/results.jsonl', import.meta.url).pathname,
  'utf8',
)
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

// A row without a boolean `pulling` is NOT usable. It used to be: `ok` only
// required a cold TTFB, and the Pulling tally below is `filter(r => r.pulling)`
// — so a replicate whose events query failed, or whose pod could not be found,
// counted as "no Pulling event". On the no-prewarm arm that silently turns
// 10/10 into 9/10, in the direction of the desired conclusion. Absent
// observations are reported as absent.
const ok = rows.filter((r) => unusableReason(r) === null);
const failed = rows.filter((r) => unusableReason(r) !== null);

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return +(s[lo] + (s[hi] - s[lo]) * (i - lo)).toFixed(1);
};
const stats = (xs) => ({
  n: xs.length,
  min: q(xs, 0),
  p25: q(xs, 0.25),
  median: q(xs, 0.5),
  p75: q(xs, 0.75),
  max: q(xs, 1),
  mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1),
  sd: +Math.sqrt(
    xs.reduce((a, b) => a + (b - xs.reduce((c, d) => c + d, 0) / xs.length) ** 2, 0) /
      (xs.length - 1 || 1),
  ).toFixed(1),
});

const arms = { on: ok.filter((r) => r.mode === 'on'), off: ok.filter((r) => r.mode === 'off') };
const label = {
  on: 'imagePrewarm=true  (image already on node)',
  off: 'imagePrewarm=false (kubelet must pull)',
};

console.log('# image-prewarm OKE measurement\n');
console.log(`replicates: ${rows.length} attempted, ${ok.length} usable, ${failed.length} unusable`);
for (const f of failed) {
  console.log(`  UNUSABLE idx=${f.idx} mode=${f.mode}: ${unusableReason(f)}`);
}
console.log(`image:    ${ok[0]?.image}`);
console.log(`endpoint: ${ok[0]?.endpoint}`);
console.log(`revision: ${ok[0]?.revision}\n`);

for (const [mode, rs] of Object.entries(arms)) {
  console.log(`## ${label[mode]}  — n=${rs.length}`);
  console.log(`cold TTFB ms      ${JSON.stringify(stats(rs.map((r) => r.cold_ttfb_ms)))}`);
  console.log(`warm TTFB ms      ${JSON.stringify(stats(rs.map((r) => r.warm_ttfb_ms)))}`);
  console.log(
    `cold-minus-warm   ${JSON.stringify(stats(rs.map((r) => +(r.cold_ttfb_ms - r.warm_ttfb_ms).toFixed(1))))}`,
  );
  const pulling = rs.filter((r) => r.pulling).length;
  console.log(`Pulling events    ${pulling}/${rs.length} replicates`);
  const pulls = rs
    .flatMap((r) => r.pulledMsgs ?? [])
    .map((m) => m.match(/in ([\d.]+)s/))
    .filter(Boolean)
    .map((m) => Number(m[1]) * 1000);
  if (pulls.length) console.log(`kubelet pull ms   ${JSON.stringify(stats(pulls))}`);
  const size = rs.flatMap((r) => r.pulledMsgs ?? []).find((m) => /Image size: (\d+)/.test(m));
  if (size) console.log(`image size        ${size.match(/Image size: (\d+)/)[1]} bytes`);
  console.log(`nodes             ${JSON.stringify([...new Set(rs.map((r) => r.node))])}`);
  // Both of these are per-ARM on purpose: the `off` arm alone runs privileged
  // eviction Jobs on every node, so an asymmetry in either is an alternative
  // explanation for that arm's tail and must be visible, not inferred.
  console.log(
    `settle (quiet) s  ${JSON.stringify(stats(rs.map((r) => Math.round(r.settle_ms / 1000))))}`,
  );
  const pre = rs.filter((r) => typeof r.precondition_ms === 'number');
  if (pre.length) {
    console.log(
      `node work s       ${JSON.stringify(stats(pre.map((r) => Math.round(r.precondition_ms / 1000))))}`,
    );
  }
  // WHICH symmetry the floor buys, stated rather than left derivable. The floor
  // starts after the precondition work, so QUIET is equal across arms — and
  // therefore TOTAL time at zero is NOT: the `off` arm's eviction Jobs run
  // inside that window, so it sits at zero ~60 s longer. Both quantities cannot
  // be equal at once; this is the one that was traded away, so it is printed.
  const az = rs.filter((r) => typeof r.at_zero_ms === 'number');
  if (az.length) {
    console.log(
      `time at zero s    ${JSON.stringify(stats(az.map((r) => Math.round(r.at_zero_ms / 1000))))}`,
    );
  }
  console.log(`cold samples      ${JSON.stringify(rs.map((r) => r.cold_ttfb_ms))}\n`);
}

console.log('## per-pair (ABBA) — mean of each arm within the pair');
const pairs = [...new Set(ok.map((r) => r.pair))].sort();
for (const p of pairs) {
  const on = ok.filter((r) => r.pair === p && r.mode === 'on').map((r) => r.cold_ttfb_ms);
  const off = ok.filter((r) => r.pair === p && r.mode === 'off').map((r) => r.cold_ttfb_ms);
  const m = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : null);
  console.log(
    `pair ${p}: prewarm=${JSON.stringify(on)} mean=${m(on)} | no-prewarm=${JSON.stringify(off)} mean=${m(off)} | delta=${
      m(on) != null && m(off) != null ? +(m(off) - m(on)).toFixed(1) : 'n/a'
    }`,
  );
}

const onC = arms.on.map((r) => r.cold_ttfb_ms);
const offC = arms.off.map((r) => r.cold_ttfb_ms);
if (onC.length && offC.length) {
  console.log(
    `\noverlap: max(prewarm)=${Math.max(...onC)}  min(no-prewarm)=${Math.min(...offC)} -> ${
      Math.max(...onC) < Math.min(...offC)
        ? 'DISTRIBUTIONS DO NOT OVERLAP'
        : 'distributions overlap'
    }`,
  );
  console.log(`median delta (no-prewarm − prewarm): ${(q(offC, 0.5) - q(onC, 0.5)).toFixed(1)} ms`);
}
