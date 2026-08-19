#!/usr/bin/env node
// abba-analyze.mjs — turn one ABBA sitting's results files into the A/B verdict.
//
//   ./abba-analyze.mjs <sitting> [resultsDir]
//
// WHY THIS IS COMMITTED. `abba.sh` produces one results file per cold sample and
// stops there; every comparison so far was assembled by hand. That is the same
// defect that made the 2026-08-17 bytecode dataset unreproducible — the probe was
// committed, the 40-lifetime driver that produced the published table was not, so
// "committed script" was true per-sample and false of the result. Reviewers
// caught it. The analysis is part of the measurement, so it lives here.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not decide whether a run is
// admissible. ADR-0036's re-open conditions and ADR-0042's sixth condition are
// judgements about provenance and cluster state, not arithmetic. This prints the
// evidence a human uses to make that call — including the facts that argue
// against the result — and refuses to print a verdict sentence.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , sitting, dirArg] = process.argv;
if (!sitting) {
  console.error('usage: abba-analyze.mjs <sitting> [resultsDir]');
  process.exit(2);
}
const dir = dirArg ?? join(import.meta.dirname, 'results');

/** k6 prints `http_req_duration.....: avg=1.82s med=1.82s ...`; we want med. */
function medianLatencyMs(log) {
  const m = /http_req_duration[.\s]*:\s*avg=\S+\s+med=(\S+?)\s/.exec(log);
  if (!m) return null;
  const v = m[1];
  const num = Number.parseFloat(v);
  if (!Number.isFinite(num)) return null;
  if (v.endsWith('ms')) return num;
  if (v.endsWith('µs') || v.endsWith('us')) return num / 1000;
  if (v.endsWith('s')) return num * 1000;
  return null;
}

// One cold sample per file. A file that ran but produced no rep still exists —
// that is the silent-loss mode abba.sh's own header documents — so an
// unparseable file is COUNTED AND REPORTED, never quietly skipped.
const arms = new Map();
const lost = [];
const inFlight = [];
for (const f of readdirSync(dir)
  .filter((f) => f.endsWith('.txt'))
  .sort()) {
  const log = readFileSync(join(dir, f), 'utf8');
  if (!log.includes(`sitting=${sitting}`)) continue;
  const arm =
    /=== knext scale-to-zero benchmark — service=(\S+)/.exec(log)?.[1] ?? f.split('-2026')[0];
  const ms = medianLatencyMs(log);
  if (ms === null) {
    // A sample still RUNNING has no latency line yet and is not a loss. Counting
    // it as one inflates the loss figure, which is the number a reader uses to
    // decide whether the dataset can be published at all — so the two are
    // distinguished by whether the run reached its own DONE marker.
    if (!log.includes('=== DONE (results')) inFlight.push(f);
    else
      lost.push(
        `${f} (${/REFUSING TO START/.test(log) ? 'refused: pending restore' : 'completed but no http_req_duration'})`,
      );
    continue;
  }
  if (!arms.has(arm)) arms.set(arm, []);
  arms.get(arm).push({ file: f, ms });
}

const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : +(s[lo] + (s[hi] - s[lo]) * (i - lo)).toFixed(1);
};
const erf = (x) => {
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return s * y;
};
/** Rank test, not a t-test: cold-start distributions have heavy right tails. */
function mwu(a, b) {
  const all = [...a.map((v) => [v, 0]), ...b.map((v) => [v, 1])].sort((x, y) => x[0] - y[0]);
  const ranks = new Array(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = r;
    i = j + 1;
  }
  let R1 = 0;
  all.forEach((e, idx) => {
    if (e[1] === 0) R1 += ranks[idx];
  });
  const n1 = a.length;
  const n2 = b.length;
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U = Math.min(U1, n1 * n2 - U1);
  const sd = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const z = (U - (n1 * n2) / 2) / sd;
  return {
    U,
    z: +z.toFixed(3),
    p: +(2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)))).toPrecision(3),
  };
}
/** Hodges-Lehmann shift — the estimand that matches the rank test. */
const hl = (a, b) => {
  const d = [];
  for (const x of a) for (const y of b) d.push(x - y);
  return q(d, 0.5);
};

const names = [...arms.keys()].sort();
console.log(`\n=== ABBA sitting ${sitting} — ${dir} ===`);
if (lost.length) {
  console.log(`\nLOST SAMPLES (${lost.length}) — reported, not dropped:`);
  for (const l of lost) console.log(`  ${l}`);
}
if (inFlight.length) {
  console.log(
    `\nIN FLIGHT (${inFlight.length}) — the run is not finished; these are NOT losses and the`,
  );
  console.log('numbers below are PARTIAL. Do not publish them as the result of this sitting:');
  for (const f of inFlight) console.log(`  ${f}`);
}
for (const n of names) {
  const v = arms.get(n).map((x) => x.ms);
  console.log(
    `\n${n}  n=${v.length}  median ${q(v, 0.5)} ms  IQR [${q(v, 0.25)}, ${q(v, 0.75)}]  range ${Math.min(...v)}–${Math.max(...v)}`,
  );
  console.log(`  samples: ${v.map((x) => x.toFixed(0)).join(' ')}`);
}
if (names.length === 2) {
  const [A, B] = names.map((n) => arms.get(n).map((x) => x.ms));
  const [nA, nB] = names;
  const m = mwu(A, B);
  console.log(`\n--- ${nA} vs ${nB} ---`);
  console.log(
    `  median difference : ${(q(A, 0.5) - q(B, 0.5)).toFixed(1)} ms  (negative = ${nA} faster)`,
  );
  console.log(`  Hodges-Lehmann    : ${hl(A, B).toFixed(1)} ms`);
  console.log(`  Mann-Whitney      : U=${m.U} z=${m.z} p=${m.p}`);
  // ADR-0036's bar is DISTRIBUTION SEPARATION, not a median difference with
  // overlapping ranges. Run 24 was withdrawn for exactly that conflation, so the
  // stricter test is printed alongside rather than left for a reader to assume.
  const sep = Math.max(...A) < Math.min(...B) || Math.max(...B) < Math.min(...A);
  console.log(
    `  distribution separation (ADR-0036's actual bar): ${sep ? 'YES' : 'NO — ranges overlap'}`,
  );
  if (!sep) {
    console.log(
      '    A median difference with overlapping ranges does NOT clear ADR-0036. Report it as a',
    );
    console.log('    shift with an interval, never as "N times faster".');
  }
}
console.log(
  '\nNOT decided here: admissibility. Same-app, prewarm state, exclusive cluster access and',
);
console.log(
  'sitting boundaries are provenance judgements — read the results files, not this summary.\n',
);
