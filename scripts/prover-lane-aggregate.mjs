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

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFindings, KNOWN_RED_PROVERS } from './lib/known-red-provers.mjs';
import { aggregateReports, reportFileName } from './lib/prover-shard.mjs';

/** Job outputs are capped; the alert needs the gist, the job log has the rest. */
const SUMMARY_CAP = 20_000;

/**
 * The markdown the alert issue embeds: FRESH findings first (what a reader must
 * act on), then the KNOWN-red ones (still failing, tracked elsewhere).
 */
function summaryMarkdown({ fresh, known, unionVerified, partialRefs, expectedCount }) {
  const out = [`Legs expected: ${expectedCount}.`];
  out.push(
    unionVerified.length > 0
      ? `Shard union == discovered set: verified for ${unionVerified.map((r) => `\`${r}\``).join(', ')}.`
      : 'Shard union == discovered set: NOT verified for any ref (see the findings).',
  );
  for (const ref of partialRefs) out.push(`\`${ref}\`: partial run, union not asserted.`);
  out.push('', `**New red findings (not on the known-red list): ${fresh.length}**`);
  for (const f of fresh) out.push(`- ${f}`);
  out.push('', `**Known red findings (tracked, still failing): ${known.length}**`);
  for (const k of known) out.push(`- (#${k.issue}) ${k.finding}`);
  const text = out.join('\n');
  return text.length > SUMMARY_CAP
    ? `${text.slice(0, SUMMARY_CAP)}\n... (truncated; the aggregate job log has the rest)`
    : text;
}

/** Write a multi-line job output with a delimiter that cannot appear in the value. */
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  let delim = 'EOF_SUMMARY';
  while (value.includes(delim)) delim += '_X';
  appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
}

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
  const { findings, partialRefs, unionVerified } = aggregateReports({ expected, reports });
  // Classification LABELS findings for the alert only. It never removes one: every
  // finding below still fails the lane, known or not.
  // KNEXT_LANE_KNOWN_RED_JSON is a test seam: a JSON array standing in for the list.
  const list = process.env.KNEXT_LANE_KNOWN_RED_JSON
    ? JSON.parse(process.env.KNEXT_LANE_KNOWN_RED_JSON)
    : KNOWN_RED_PROVERS;
  const { known, fresh } = classifyFindings(findings, list);
  setOutput(
    'summary',
    summaryMarkdown({
      fresh,
      known,
      unionVerified,
      partialRefs,
      expectedCount: expected.length,
    }),
  );

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
  for (const ref of unionVerified) {
    console.log(`union == discovered set: verified for ${ref}`);
  }
  if (findings.length > 0) {
    console.error(
      `\n${findings.length} finding(s): ${fresh.length} new, ${known.length} known-red (still failing):`,
    );
    for (const f of fresh) console.error(`::error::${f}`);
    for (const k of known) console.error(`::error::(known #${k.issue}) ${k.finding}`);
    process.exit(1);
  }
  // Only claim what was checked: on a partial run the union is NOT asserted.
  const refsExpected = new Set(expected.map((leg) => leg.ref));
  const unionChecked = [...refsExpected].every((ref) => unionVerified.includes(ref));
  console.log(
    unionChecked
      ? '\nevery expected leg reported; declared == run for every prover; union == discovered set'
      : '\nevery expected leg reported; declared == run for every prover; PARTIAL run, union == discovered set was NOT checked',
  );
}

main();
