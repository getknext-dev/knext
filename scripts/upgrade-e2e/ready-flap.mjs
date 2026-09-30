#!/usr/bin/env node
/**
 * ready-flap — pure computation of how long a NextApp spent NOT Ready during
 * the operator upgrade-under-load e2e (#1668).
 *
 * The workflow polls `kubectl get nextapp <name> -o json` on an interval
 * across the whole upgrade window and appends each observed Ready condition
 * to a JSONL trace: `{ts: <ms epoch>, status: "True"|"False"|"Unknown"}`.
 * This module turns that trace into "total seconds spent not-Ready" and
 * compares it against a STATED bound, so the assertion is never eyeballed
 * from a log.
 *
 * Pure (no fs/process) so it is unit-testable without a cluster — see
 * tests/upgrade-e2e-ready-flap.test.ts.
 */

/**
 * @param {{ts: number, status: string}[]} samples - Ready-condition samples,
 *   in chronological order (NOT necessarily deduplicated or evenly spaced —
 *   a poller records whatever it observed).
 * @returns {number} total milliseconds spent with status !== "True", summed
 *   between consecutive samples (the last sample's status is assumed to hold
 *   until the trace ends, contributing zero additional duration).
 */
export function totalNotReadyMillis(samples) {
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
 * @param {number} boundMillis - the STATED maximum allowed not-Ready duration.
 * @returns {{ok: boolean, notReadyMillis: number, boundMillis: number, sampleCount: number}}
 */
export function evaluateReadyBound(samples, boundMillis) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { ok: false, notReadyMillis: -1, boundMillis, sampleCount: 0 };
  }
  const notReadyMillis = totalNotReadyMillis(samples);
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
      `ready-flap FAILED: ${result.notReadyMillis}ms not-Ready across ${result.sampleCount} ` +
        `samples exceeds the ${boundMillis}ms bound`,
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
