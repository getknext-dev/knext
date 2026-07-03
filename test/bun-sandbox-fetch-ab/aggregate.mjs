#!/usr/bin/env node
/**
 * Aggregates the two per-runtime trial artifacts into the A/B hang-rate table
 * and applies THE DISCRIMINATION CRITERION from
 * docs/compat/upstream-bun-sandbox-fetch-bug.md:
 *
 *   File-worthy iff bun hangs at a MATERIALLY higher rate than node under
 *   identical local-echo conditions — operationalized as: some shape where
 *   bun's hang rate >= 50% while node's <= 5%. Otherwise the finding is
 *   environmental / Next-level, NOT a Bun bug, and must be recorded as such.
 *
 * Usage: node aggregate.mjs --node ab-results-node.json --bun ab-results-bun.json
 * Prints a markdown report to stdout (piped into $GITHUB_STEP_SUMMARY).
 */
import { readFileSync } from 'node:fs';

// The criterion constants (guard-tested — do not weaken silently).
export const BUN_MATERIAL_HANG_RATE = 0.5;
export const NODE_CLEAN_HANG_RATE = 0.05;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function load(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** shape -> { hangs, total } for one runtime's artifact. */
function hangCounts(data) {
  const byShape = new Map();
  for (const shape of data.shapes) byShape.set(shape, { hangs: 0, total: 0 });
  for (const trial of data.perTrial) {
    for (const r of trial.results) {
      const c = byShape.get(r.shape);
      c.total += 1;
      if (r.outcome === 'timeout') c.hangs += 1;
    }
  }
  return byShape;
}

function pct(hangs, total) {
  return total === 0 ? 'n/a' : `${hangs}/${total} (${Math.round((hangs / total) * 100)}%)`;
}

/**
 * Per-lane outcome tally across ALL probes (#197 gate follow-up): a lane whose
 * probes fail FAST (client-error, never reaching the 15s timeout) has a 0% hang
 * rate for the wrong reason — the breakdown makes that visible so the negative
 * verdict is never read as exoneration without checking WHAT the probes did.
 */
function outcomeCounts(data) {
  const counts = { resolved: 0, 'client-error': 0, timeout: 0, other: 0, total: 0 };
  for (const trial of data.perTrial) {
    for (const r of trial.results) {
      counts.total += 1;
      if (r.outcome in counts) counts[r.outcome] += 1;
      else counts.other += 1;
    }
  }
  return counts;
}

function main() {
  const node = load(arg('node'));
  const bun = load(arg('bun'));
  const nodeCounts = hangCounts(node);
  const bunCounts = hangCounts(bun);

  const lines = [];
  lines.push('## Bun sandbox fetch A/B — hang rates (local HTTPS echo, no WAN)');
  lines.push('');
  lines.push(
    `Runner: same class, both lanes. node ${node.runtimeVersion} vs bun ${bun.runtimeVersion}; ` +
      `${node.trials} node trials / ${bun.trials} bun trials, fresh server boot per trial, ` +
      `probe timeout ${node.probeTimeoutMs}ms, probe client + echo server always node.`,
  );
  lines.push('');
  lines.push('| Shape | node hangs | bun hangs |');
  lines.push('|---|---|---|');

  let discriminates = false;
  let totalNode = { hangs: 0, total: 0 };
  let totalBun = { hangs: 0, total: 0 };
  for (const shape of node.shapes) {
    const n = nodeCounts.get(shape);
    const b = bunCounts.get(shape) ?? { hangs: 0, total: 0 };
    totalNode = { hangs: totalNode.hangs + n.hangs, total: totalNode.total + n.total };
    totalBun = { hangs: totalBun.hangs + b.hangs, total: totalBun.total + b.total };
    const shapeDiscriminates =
      b.total > 0 &&
      n.total > 0 &&
      b.hangs / b.total >= BUN_MATERIAL_HANG_RATE &&
      n.hangs / n.total <= NODE_CLEAN_HANG_RATE;
    if (shapeDiscriminates) discriminates = true;
    lines.push(
      `| ${shape} | ${pct(n.hangs, n.total)} | ${pct(b.hangs, b.total)}${shapeDiscriminates ? ' **<- discriminates**' : ''} |`,
    );
  }
  lines.push(
    `| **ALL** | ${pct(totalNode.hangs, totalNode.total)} | ${pct(totalBun.hangs, totalBun.total)} |`,
  );
  lines.push('');

  // Per-lane outcome breakdown (#197 gate follow-up): the hang-rate table alone
  // can't distinguish "bun never hangs" from "bun's probes error out before they
  // could hang" — surface every outcome class per lane.
  const nodeOutcomes = outcomeCounts(node);
  const bunOutcomes = outcomeCounts(bun);
  lines.push('### Outcome breakdown (all probes, per lane)');
  lines.push('');
  lines.push('| Lane | resolved | client-error | timeout | other | total |');
  lines.push('|---|---|---|---|---|---|');
  for (const [lane, c] of [
    ['node', nodeOutcomes],
    ['bun', bunOutcomes],
  ]) {
    lines.push(
      `| ${lane} | ${c.resolved} | ${c['client-error']} | ${c.timeout} | ${c.other} | ${c.total} |`,
    );
  }
  lines.push('');
  lines.push('### Discrimination criterion');
  lines.push('');
  lines.push(
    `File-worthy iff bun hangs at a materially higher rate than node under identical ` +
      `local-echo conditions: some shape with bun >= ${BUN_MATERIAL_HANG_RATE * 100}% ` +
      `hangs while node <= ${NODE_CLEAN_HANG_RATE * 100}%. Otherwise the CI-lane divergence ` +
      `is environmental / Next-level, not a fileable Bun bug.`,
  );
  lines.push('');
  lines.push(
    discriminates
      ? '**VERDICT: DISCRIMINATES — bun-hangs/node-clean under controlled conditions. This transcript is the filing evidence (attach it to the [REQUIRED] slot in docs/compat/upstream-bun-sandbox-fetch-bug.md).**'
      : '**VERDICT: DOES NOT DISCRIMINATE — the repro does not attribute the hang to Bun under controlled conditions. Do NOT file; record the result honestly in docs/compat/upstream-bun-sandbox-fetch-bug.md and pursue path 2 (instrument a red CI shard).**',
  );
  // A negative verdict from a fast-failing lane is NOT exoneration: a probe that
  // errored in milliseconds never got the chance to hang, so its 0% hang rate
  // carries no evidence. Qualify the verdict whenever non-timeout errors exist.
  const errored = (c) => c['client-error'] + c.other;
  if (!discriminates && (errored(nodeOutcomes) > 0 || errored(bunOutcomes) > 0)) {
    lines.push('');
    lines.push(
      `**CAUTION: ${errored(nodeOutcomes)} node / ${errored(bunOutcomes)} bun probe(s) ` +
        'errored without reaching the hang timeout — a fast-failing lane can mask a hang. ' +
        'Inspect the outcome breakdown above before treating this verdict as exoneration.**',
    );
  }
  lines.push('');
  console.log(lines.join('\n'));
}

main();
