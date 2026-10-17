#!/usr/bin/env node
/**
 * Aggregate the legs of the sharded mutation-prover lane (#2499 / #2208).
 *
 * Reads the plan's `expected` legs and the report each leg uploaded, and FAILS
 * unless: every expected leg reported; every leg proved the sha the plan pinned;
 * the shards' union is the discovered set exactly once; and declared == run for
 * every prover. A leg with no report (cancelled, crashed, artifact lost) is a
 * finding — never a skip.
 *
 * Inputs are ENV: EXPECTED_LEGS = the plan's JSON array; REPORT_DIR = the
 * directory the report artifacts were downloaded into.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateReports, reportFileName } from './lib/prover-shard.mjs';

function findReport(dir, leg) {
  const name = reportFileName(leg);
  // `actions/download-artifact` with `merge-multiple` lands files flat; without
  // it, each artifact gets its own directory. Accept both, nothing else.
  const candidates = [join(dir, name)];
  if (existsSync(dir)) {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) candidates.push(join(dir, d.name, name));
    }
  }
  const path = candidates.find((p) => existsSync(p));
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function die(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function main() {
  const raw = process.env.EXPECTED_LEGS;
  const dir = process.env.REPORT_DIR;
  if (!raw || !dir) die('EXPECTED_LEGS and REPORT_DIR are required');
  let expected;
  try {
    expected = JSON.parse(raw);
  } catch {
    die('EXPECTED_LEGS is not JSON — the plan job produced nothing usable');
  }
  if (!Array.isArray(expected)) die('EXPECTED_LEGS is not an array');

  const reports = expected.map((leg) => findReport(dir, leg));
  const { findings, partialRefs } = aggregateReports({ expected, reports });

  console.log(`LANE AGGREGATE — ${expected.length} expected leg(s)`);
  for (const [i, leg] of expected.entries()) {
    const r = reports[i];
    const n = r?.results?.length ?? 0;
    const bad = (r?.results ?? []).filter((x) => x.findings?.length).length;
    const mark = r ? (bad ? 'FAIL' : 'ok  ') : 'MISS';
    console.log(`${mark} ${leg.ref} ${leg.shard}/${leg.shards}  ${n} prover(s), ${bad} failing`);
  }
  for (const ref of partialRefs) {
    console.log(
      `NOTE ${ref}: PARTIAL run (fewer legs than shards, a manual dispatch) — the union was not asserted`,
    );
  }
  if (findings.length > 0) {
    console.error(`\n${findings.length} finding(s):`);
    for (const f of findings) console.error(`::error::${f}`);
    process.exit(1);
  }
  console.log(
    '\nevery expected leg reported; declared == run for every prover; union == discovered set',
  );
}

main();
