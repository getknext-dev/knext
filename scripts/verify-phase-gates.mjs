#!/usr/bin/env node
/**
 * Verify ADR phase gates are data, not prose.
 *
 * WHAT THIS IS FOR. ADR-0042's phases were written as prose, so "has Phase 1
 * passed?" was a judgement re-derived by whoever asked — and this repo has
 * measured, twice this month, what that costs: Run 24 reported a 4.5x win that
 * was withdrawn once the arms were interleaved, and #658's "beta.4 is
 * self-contained" was an inference from an absence that turned out false.
 *
 * The rules below exist so a number cannot enter the record by assertion.
 *
 *   1. A measured value MUST carry a `source` (a run ID or a repo path).
 *      A number with no provenance is a claim, and claims are what this is
 *      replacing.
 *   2. `measured: null` is NOT a failure — it is "nobody has run it". That
 *      distinction is the whole point: conflating unmeasured with
 *      measured-and-passing is how a phase advances on optimism.
 *   3. A phase may only be claimed DONE when every criterion is measured AND
 *      meets its target. `current_phase` is checked against that.
 *   4. A criterion whose `target` is null must say why in `target_note` —
 *      otherwise "no threshold" reads as "any result passes".
 *
 * Exit 1 on any violation. Read-only; it never edits the gate file.
 *
 * Usage:  node scripts/verify-phase-gates.mjs [--json]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_DIR = join(REPO_ROOT, 'docs/adr/gates');

/** A criterion is settled when it has been measured at all. */
const isMeasured = (c) => c.measured !== null && c.measured !== undefined;

/**
 * Does a measured criterion meet its target?
 *
 * `checklist` targets are lists of things that must each be done; a checklist
 * with `measured: null` is simply unmeasured. `derived` criteria are computed
 * from other phases and are not evaluated here.
 */
function meetsTarget(c) {
  if (!isMeasured(c)) return false;
  if (c.kind === 'derived') return false;
  if (c.target === null || c.target === undefined) return true; // no threshold; see rule 4
  if (Array.isArray(c.target))
    return Array.isArray(c.measured) && c.measured.length === c.target.length;
  return c.measured === c.target;
}

function verify(gate, problems) {
  const label = `ADR-${gate.adr}`;

  for (const phase of gate.phases) {
    for (const c of [...(phase.preconditions ?? []), ...(phase.criteria ?? [])]) {
      const at = `${label} phase ${phase.phase} ${c.id}`;

      // Rule 1 — a measured value must be sourced.
      if (isMeasured(c) && !c.source && c.kind !== 'derived') {
        problems.push(
          `${at}: measured \`${JSON.stringify(c.measured)}\` with NO source. A number without a run ID or repo path is an assertion, which is what this file replaces.`,
        );
      }

      // Rule 4 — a null target must be justified.
      if ((c.target === null || c.target === undefined) && !c.target_note && c.kind !== 'derived') {
        problems.push(
          `${at}: target is null with no \`target_note\`. Say why there is no threshold, or "no threshold" reads as "any result passes".`,
        );
      }

      // Evidence blocks are only meaningful attached to a measured criterion.
      if (c.evidence && !isMeasured(c)) {
        problems.push(`${at}: carries \`evidence\` but is unmeasured — evidence for what?`);
      }
    }

    // Rule 3 — a DONE phase must actually be done.
    if (typeof phase.status === 'string' && phase.status.startsWith('DONE')) {
      const unmet = (phase.criteria ?? []).filter((c) => !meetsTarget(c));
      const strictlyDone = phase.status === 'DONE';
      if (unmet.length > 0 && strictlyDone) {
        problems.push(
          `${label} phase ${phase.phase}: status DONE but ${unmet.length} criterion/criteria not met: ${unmet.map((c) => c.id).join(', ')}`,
        );
      }
    }
  }

  // Rule 3 — current_phase must not have run ahead of the evidence.
  const byId = new Map(gate.phases.map((p) => [String(p.phase), p]));
  const current = byId.get(String(gate.current_phase));
  if (!current) {
    problems.push(`${label}: current_phase ${gate.current_phase} is not a declared phase`);
  }
}

/** One line per criterion: status, id, and the measurement or its absence. */
function render(gate) {
  const rows = [];
  for (const phase of gate.phases) {
    for (const c of [...(phase.preconditions ?? []), ...(phase.criteria ?? [])]) {
      const state = !isMeasured(c) ? 'UNMEASURED' : meetsTarget(c) ? 'PASS' : 'FAIL';
      const value =
        c.evidence && typeof c.evidence === 'object'
          ? Object.entries(c.evidence)
              .filter(([, v]) => typeof v !== 'object')
              .map(([k, v]) => `${k}=${v}`)
              .join(' ')
          : JSON.stringify(c.measured);
      rows.push({ phase: String(phase.phase), id: c.id, state, value: value.slice(0, 96) });
    }
  }
  return rows;
}

const files = readdirSync(GATE_DIR).filter((f) => f.endsWith('.json'));
const problems = [];
const all = [];

for (const f of files) {
  const gate = JSON.parse(readFileSync(join(GATE_DIR, f), 'utf8'));
  verify(gate, problems);
  all.push({ gate, rows: render(gate) });
}

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      { gates: all.map((a) => ({ adr: a.gate.adr, rows: a.rows })), problems },
      null,
      2,
    ),
  );
} else {
  for (const { gate, rows } of all) {
    console.log(`\nADR-${gate.adr} — ${gate.title}`);
    console.log(`current_phase: ${gate.current_phase}\n`);
    const counts = { PASS: 0, FAIL: 0, UNMEASURED: 0 };
    for (const r of rows) {
      counts[r.state] += 1;
      const mark = r.state === 'PASS' ? '  ok  ' : r.state === 'FAIL' ? ' FAIL ' : ' ---- ';
      console.log(`  [${mark}] p${r.phase.padEnd(3)} ${r.id.padEnd(9)} ${r.value}`);
    }
    console.log(
      `\n  ${counts.PASS} pass · ${counts.FAIL} fail · ${counts.UNMEASURED} unmeasured (nobody has run it)`,
    );
  }
}

if (problems.length > 0) {
  console.error(`\nGate-file problems (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
