#!/usr/bin/env node
/**
 * ready-flap — pure computation of the CUMULATIVE time a NextApp spent NOT
 * Ready during the operator upgrade-under-load e2e (#1668).
 *
 * The workflow polls `kubectl get nextapp <name> -o json` on an interval
 * across the whole upgrade window and appends each observed Ready condition
 * to a JSONL trace: `{ts: <ms epoch>, status: "True"|"False"|"Unknown"}`.
 * This module SUMS every not-Ready gap in that trace (the CUMULATIVE
 * duration across however many separate flaps occurred, not the longest
 * single one) and compares the total against a STATED bound, so the
 * assertion is never eyeballed from a log.
 *
 * Cumulative, deliberately, over "longest single flap": two short flaps that
 * individually clear a longest-flap bound can still add up to real user-
 * visible downtime across the upgrade window, and summing is what catches
 * that — a longest-flap measure would pass a NextApp that flapped five times
 * for 20s each while this correctly fails it at 100s against a 90s bound.
 * The cost is the one this file's own naming used to obscure: a single 91s
 * flap and five 20s flaps both fail the SAME 90s bound for different
 * reasons, so a failure here does not by itself say which shape occurred —
 * read the samples file to tell them apart.
 *
 * Pure (no fs/process) so it is unit-testable without a cluster — see
 * tests/upgrade-e2e-ready-flap.test.ts.
 */

/**
 * @param {{ts: number, status: string}[]} samples - Ready-condition samples,
 *   in chronological order (NOT necessarily deduplicated or evenly spaced —
 *   a poller records whatever it observed).
 * @returns {number} CUMULATIVE milliseconds spent with status !== "True",
 *   summed across EVERY gap between consecutive samples where that gap was
 *   not-Ready (the last sample's status is assumed to hold until the trace
 *   ends, contributing zero additional duration). This is a sum over
 *   possibly-many flaps, not the duration of the single longest one.
 */
export function cumulativeNotReadyMillis(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    // No samples at all means the poller never ran — that is NOT "always
    // Ready", it is "we never checked". Callers must treat this as a
    // failure via requireSamples below; this function alone stays a pure
    // fold and returns 0 for an empty input.
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  let total = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    const gap = next.ts - cur.ts;
    if (gap < 0) {
      throw new RangeError('samples must be non-decreasing in ts once sorted');
    }
    if (cur.status !== 'True') {
      total += gap;
    }
  }
  return total;
}

/**
 * @param {{ts: number, status: string}[]} samples
 * @param {number} boundMillis - the STATED maximum allowed CUMULATIVE
 *   not-Ready duration (sum across every flap in the window, not the
 *   longest single one — see the module docblock).
 * @returns {{ok: boolean, notReadyMillis: number, boundMillis: number, sampleCount: number}}
 */
export function evaluateReadyBound(samples, boundMillis) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { ok: false, notReadyMillis: -1, boundMillis, sampleCount: 0 };
  }
  const notReadyMillis = cumulativeNotReadyMillis(samples);
  return {
    ok: notReadyMillis <= boundMillis,
    notReadyMillis,
    boundMillis,
    sampleCount: samples.length,
  };
}

/**
 * CLI entry: `node ready-flap.mjs <samples.jsonl> <boundSeconds>`.
 */
async function main() {
  const { readFileSync } = await import('node:fs');
  const [, , samplesPath, boundSecondsArg] = process.argv;
  if (!samplesPath || !boundSecondsArg) {
    console.error('usage: ready-flap.mjs <samples.jsonl> <boundSeconds>');
    process.exit(2);
  }
  const boundMillis = Number(boundSecondsArg) * 1000;
  let lines;
  try {
    lines = readFileSync(samplesPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
  } catch {
    lines = [];
  }
  const samples = lines.map((l) => JSON.parse(l));
  const result = evaluateReadyBound(samples, boundMillis);
  console.log(JSON.stringify(result));
  if (!result.ok) {
    console.error(
      `ready-flap FAILED: ${result.notReadyMillis}ms CUMULATIVE not-Ready across ` +
        `${result.sampleCount} samples exceeds the ${boundMillis}ms bound`,
    );
    process.exit(1);
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
