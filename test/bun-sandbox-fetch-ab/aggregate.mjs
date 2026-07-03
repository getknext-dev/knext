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
  lines.push('');
  console.log(lines.join('\n'));
}

main();
