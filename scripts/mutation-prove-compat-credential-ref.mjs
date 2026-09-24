#!/usr/bin/env node
/**
 * Mutation proof for `tests/compat-credential-ref.test.ts` — the three guards
 * ADR-0056 (#850) names, plus the wiring that makes them true in CI:
 *
 *   1. a `main`-ref night NEVER increments a credential window;
 *   2. a fingerprint change for cell X restarts X's window and not cell Y's;
 *   3. the credential lane REFUSES to run with no RC ref resolvable — never a
 *      silent fallback to `main`.
 *
 * A guard that stays green when the behaviour it protects is removed is
 * decoration. Each mutation below deletes one piece of behaviour and requires
 * the spec to go RED, then GREEN again after restore — both directions,
 * because a spec that never recovers proves the restore is broken, not the
 * guard.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise —
 *     a silently-failed substitution would certify a decorative guard green;
 *   * `declareMutations`/`recordMutation` — the lane can tell 15-of-16 from
 *     16-of-16;
 *   * the `{ subject, anchor }` table shape, which the prover lane's static
 *     anchor-liveness audit reads (scripts/lib/prover-lane.mjs), so a stale
 *     anchor is a PR-time finding, not a nightly surprise;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-compat-credential-ref.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-credential-ref.test.ts';

/** The files the mutations land in, repo-relative. */
const PROOF = {
  subjects: {
    audit: 'scripts/compat-window-audit.mjs',
    resolver: 'scripts/compat-credential-ref.mjs',
    ledger: 'scripts/compat-run-ledger.mjs',
    fingerprint: 'scripts/compat-window-fingerprint.mjs',
    workflow: '.github/workflows/test-e2e-deploy.yml',
  },
};

const MUTATIONS = [
  // ── Guard 1: a main-ref night never advances a credential count ───────────
  {
    label: 'guard 1: stop excluding main nights from the credential window',
    subject: 'audit',
    anchor:
      "  return scope === 'credential' ? claimsCredential(ledger) : !claimsCredential(ledger);",
    replacement: '  return true;',
  },
  {
    label: 'guard 1: stop disqualifying a credential claim on a non-RC ref',
    subject: 'audit',
    anchor: "  if (scope === 'credential') {\n    if (!isRcRef(ledger?.knextRef)) {",
    replacement: '  if (false) {\n    if (!isRcRef(ledger?.knextRef)) {',
  },
  {
    label: 'guard 1: let an early-warning (main) streak report the gate met',
    subject: 'audit',
    anchor: "    met: scope === 'credential' && longest.nights >= requiredNights,",
    replacement: '    met: longest.nights >= requiredNights,',
  },
  {
    label: 'guard 1: the ledger stops refusing a credential-mode night on main',
    subject: 'ledger',
    anchor: "  if (compatMode === 'credential' && !isRcRef(knextRef)) {",
    replacement: '  if (false) {',
  },
  {
    label: 'guard 1: map every non-credential trigger (dispatch included) to credential mode',
    subject: 'workflow',
    anchor: "|| (github.event.schedule == '47 23 * * *' && 'credential') || 'early-warning' }}",
    replacement: "|| (github.event.schedule == '47 23 * * *' && 'credential') || 'credential' }}",
  },

  {
    // Review round 1 (PR #1222): the realistic false credential. A credential
    // night that RAN but left no ledger must restart the streak; dropping it
    // would join the nights either side into a longer streak than reality.
    label: 'guard 1: drop a LOST credential night instead of restarting on it',
    subject: 'audit',
    anchor: "    return scope === 'credential' ? mode === 'credential' : mode === 'early-warning';",
    replacement: "    return scope !== 'credential';",
  },
  {
    label: 'guard 1: the ledger stops refusing a credential night with no knext sha',
    subject: 'ledger',
    anchor:
      "  if (compatMode === 'credential' && !/^[0-9a-f]{40}$/.test(String(knextSha ?? ''))) {",
    replacement: '  if (false) {',
  },

  // ── Guard 2: one window per cell, keyed on the cell's own fingerprint ─────
  {
    label: 'guard 2: stop restarting a streak on a fingerprint change',
    subject: 'audit',
    anchor: '    if (open && open.fingerprint === night.fingerprint) {',
    replacement: '    if (open) {',
  },
  {
    label: 'guard 2: audit every cell from one shared lane',
    subject: 'audit',
    anchor: "    out[lane] = auditWindow(ledgers, {\n      lane,\n      scope: 'credential',",
    replacement:
      "    out[lane] = auditWindow(ledgers, {\n      lane: cells[0],\n      scope: 'credential',",
  },
  {
    label: 'guard 2: let ANY met cell satisfy the whole matrix',
    subject: 'audit',
    anchor: '    allMet: cells.length > 0 && cells.every((lane) => out[lane].met),',
    replacement: '    allMet: cells.length > 0 && cells.some((lane) => out[lane].met),',
  },

  // ── Guard 3: no RC ref resolvable → refuse, never fall back to main ───────
  {
    label: 'guard 3: fall back to main when no RC has been cut',
    subject: 'resolver',
    anchor: '  if (pin.rcTag === null) {',
    replacement:
      "  if (pin.rcTag === null) {\n    return { ok: true, state: 'resolved', credential: true, checkoutRef: githubRef ?? null, checkoutSha: githubSha, tag: null };",
  },
  {
    label: 'guard 3: fall back to main when the pin file is missing',
    subject: 'resolver',
    anchor: '  if (pinText === null || pinText === undefined) {',
    replacement:
      "  if (pinText === null || pinText === undefined) {\n    return { ok: true, state: 'resolved', credential: true, checkoutRef: githubRef ?? null, checkoutSha: githubSha, tag: null };",
  },
  {
    label: 'guard 3: the CLI exits 0 on a refusal',
    subject: 'resolver',
    anchor: '  if (!result.ok) {',
    replacement: '  if (false) {',
  },
  {
    label: 'guard 3: build-next checks out the default ref instead of the resolved sha',
    subject: 'workflow',
    anchor:
      '          path: knext\n          ref: ${{ needs.credential-ref.outputs.checkout_sha }}\n\n      # ADR-0039 Amendment 1',
    replacement: '          path: knext\n\n      # ADR-0039 Amendment 1',
  },

  {
    label:
      'guard 3: shard-ledger stops refusing an unresolved sha (would check out the default branch)',
    subject: 'workflow',
    anchor: '        run: test -n "${CHECKOUT_SHA}"',
    replacement: "        run: 'true'",
  },

  // ── ADR-0039 Amendment 1: the workflow entry is the workflow that ran ─────
  {
    label: 'amendment 1: ignore --workflow-file and hash the checkout copy',
    subject: 'fingerprint',
    anchor: 'opts.workflowFile ? resolve(opts.workflowFile) : null;',
    replacement: 'null;',
  },
];

declareMutations(16);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 16) {
  console.error(`FATAL: declared 16 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(
  `\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative, of ${MUTATIONS.length}.`,
);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
