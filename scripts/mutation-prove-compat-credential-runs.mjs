#!/usr/bin/env node
/**
 * Mutation proof for ADR-0056 Amendment 5 — the credential is 14 consecutive
 * green independent RUNS per cell, not 14 nights. Both halves of every rule the
 * founder named are proved by exit code, against the specs that assert them:
 *
 *   * a run closer than the spacing floor does not count (and does not reset);
 *     spacing is measured on actual start times, from the previous COUNTED run;
 *   * a red run resets the count;
 *   * a dispatch never counts;
 *   * 14 spaced green runs on one fingerprint = MET (and 13 is not);
 *   * the per-fire calendar: a dropped fire resets, an over-long delay fails
 *     closed (missing + duplicate), never inflating a streak;
 *   * v1.0 and v1.3 stay separated (each audit lists only its own workflow, the
 *     two lines share no fire, an off-line tag never banks);
 *   * a red run inside the spacing floor still resets (spacing never shields
 *     a failure);
 *   * the late-slot watchdog checks only DUE fires, every one of them since its
 *     previous run (jittered starts never skip or repeat a fire), never counts
 *     an early-warning run, and alerts a coverage gap;
 *   * only a watchdog run that EVALUATED its window anchors the next one: the
 *     CLI exits 0 once it evaluated and reports the alert through an output
 *     the alert job keys on, and a crashed, timed-out or in-progress run is
 *     skipped, its window re-checked; a crash names the window it missed;
 *   * fresh caches: a credential run restores no cache, on both lines.
 *
 * ATTRIBUTION — each mutation names the ONE test (`expect`) in its `spec` that
 * it must turn red. Per mutation: apply it, run that spec through the shared
 * runner with a JUnit report (`--junit-dir`), read the per-test outcome from
 * that STRUCTURED report (never console text), and score it caught only if the
 * exit code is non-zero AND its target test is reported FAILED. Green is
 * DECORATIVE; red via other tests only is MISATTRIBUTED; red with no report (a
 * load error) is UNATTRIBUTED. All three fail the prover.
 *
 * Shared harness, same rules as every prover here:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell 15-of-16 from 16;
 *   * the `{ subject, anchor }` table shape the prover lane's static
 *     anchor-liveness audit reads (scripts/lib/prover-lane.mjs);
 *   * baseline green first (every target present and passing), and green again
 *     after every restore.
 *
 * None of these specs checks the v1.3 workflow's guard digests, so (unlike
 * mutation-prove-compat-credential-line.mjs) nothing is regenerated: a mutation
 * of a guard-closure file reaches only the assertion it targets.
 *
 * Usage:  node scripts/mutation-prove-compat-credential-runs.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_SPEC = 'tests/compat-credential-runs.test.ts';
const WATCHDOG_SPEC = 'tests/credential-slot-watchdog.test.ts';

/** The files the mutations land in, repo-relative. */
const PROOF = {
  subjects: {
    audit: 'scripts/compat-window-audit.mjs',
    lineTracker: 'scripts/compat-line-tracker.mjs',
    v13workflow: '.github/workflows/compat-credential-v1.3.yml',
    v10workflow: '.github/workflows/test-e2e-deploy.yml',
    lineWorkflow: 'scripts/compat-line-workflow.mjs',
    watchdog: 'scripts/credential-slot-watchdog.mjs',
    watchdogLib: 'scripts/lib/credential-slot-watchdog.mjs',
    watchdogWorkflow: '.github/workflows/credential-slot-watchdog.yml',
  },
};

const MUTATIONS = [
  // ── spacing: a run closer than the floor does not count ──────────────────
  {
    label: 'spacing check removed: a run 1 h after the previous counted run counts',
    spec: RUNS_SPEC,
    expect:
      'a run that started 1 h after the previous counted run is NOT counted (13 of 14 count -> NOT MET)',
    subject: 'audit',
    anchor:
      '        if (!Number.isFinite(gapMs) || gapMs < MIN_RUN_SPACING_HOURS * 60 * 60 * 1000) {',
    replacement: '        if (false) {',
  },
  {
    label: 'spacing measured on the creation (cron-slot) time, not the actual start',
    spec: RUNS_SPEC,
    expect: 'spacing is measured on the ACTUAL start time, not on the creation (cron-slot) time',
    subject: 'audit',
    anchor: '    startedAt: ledger?.startedAt ?? ledger?.scheduledAt ?? null,',
    replacement: '    startedAt: ledger?.scheduledAt ?? null,',
  },
  {
    label: 'spacing measured from the previous run, counted or not',
    spec: RUNS_SPEC,
    expect:
      'spacing is measured from the previous COUNTED run, never from a run that was itself not counted',
    subject: 'audit',
    anchor:
      '            gapMinutes: Number.isFinite(gapMs) ? Math.round(gapMs / 60000) : null,\n          });\n          continue;',
    replacement:
      '            gapMinutes: Number.isFinite(gapMs) ? Math.round(gapMs / 60000) : null,\n          });\n          openLastStartMs = startMs;\n          continue;',
  },
  {
    label: 'a too-close green run RESETS the streak instead of being skipped',
    spec: RUNS_SPEC,
    expect: 'a too-close run does NOT reset the streak: the runs either side stay one streak',
    subject: 'audit',
    anchor:
      '            gapMinutes: Number.isFinite(gapMs) ? Math.round(gapMs / 60000) : null,\n          });\n          continue;',
    replacement:
      '            gapMinutes: Number.isFinite(gapMs) ? Math.round(gapMs / 60000) : null,\n          });\n          open = null;\n          continue;',
  },
  {
    label: 'an unreadable start time is counted (fail open) instead of refused',
    spec: RUNS_SPEC,
    expect:
      'a run with no start timestamp cannot prove its spacing, so it is not counted (fail closed)',
    subject: 'audit',
    anchor:
      "      if (scope === 'credential' && (night.startedAt === null || openLastStart === null)) {",
    replacement:
      "      if (scope === 'credential' && (night.startedAt === null || openLastStart === null || Number.isNaN(startMs))) {",
  },
  {
    label: 'fetchLedgers stops threading the actual start time',
    spec: RUNS_SPEC,
    expect: 'threads gh run list startedAt onto every fetched ledger',
    subject: 'audit',
    anchor: '    for (const l of fetched) out.push({ ...l, scheduledAt, startedAt });',
    replacement: '    for (const l of fetched) out.push({ ...l, scheduledAt });',
  },

  // ── a red run resets; a dispatch never counts; 14 = MET ──────────────────
  {
    label: 'a disqualified (red) run no longer resets the open streak',
    spec: RUNS_SPEC,
    expect: 'a red run RESETS the count (7 green + 1 red + 7 green is NOT MET)',
    subject: 'audit',
    anchor:
      "          : night.unresolved\n            ? 'night-unresolved'\n            : 'night-disqualified';\n      open = null;\n      continue;",
    replacement:
      "          : night.unresolved\n            ? 'night-unresolved'\n            : 'night-disqualified';\n      if (!night.unresolved) continue;\n      open = null;\n      continue;",
  },
  {
    label: 'a workflow_dispatch run is selected into the credential window',
    spec: RUNS_SPEC,
    expect: 'a dispatch never counts — and the slot it does not fill is a missing run that resets',
    subject: 'audit',
    anchor:
      "      (l) => l?.event === 'schedule' && (l?.lane === lane || (isUnresolved(l) && l?.lane == null)),",
    replacement: '      (l) => l?.lane === lane || (isUnresolved(l) && l?.lane == null),',
  },
  {
    label: 'the bar moves off fourteen runs',
    spec: RUNS_SPEC,
    expect: '14 spaced green runs on one fingerprint = MET, in under five days',
    subject: 'audit',
    anchor: 'export const WINDOW_REQUIRED_RUNS = 14;',
    replacement: 'export const WINDOW_REQUIRED_RUNS = 15;',
  },

  // ── the per-fire calendar ────────────────────────────────────────────────
  {
    label: 'a multi-fire cron collapses to its first hour (one slot a day)',
    spec: RUNS_SPEC,
    expect:
      'a fire with no run at all (dropped or deleted) breaks the streak on a multi-fire calendar',
    subject: 'audit',
    anchor: '  return { minute: m, hours: [...hours].sort((a, b) => a - b) };',
    replacement: '  return { minute: m, hours: [Math.min(...hours)] };',
  },
  {
    label: 'two runs in one fire slot are no longer both disqualified',
    spec: RUNS_SPEC,
    expect:
      'a delay longer than the gap between fires fails CLOSED (missing + duplicate), never inflates',
    subject: 'audit',
    anchor: '      if (perSlot.get(n.date) > 1) {',
    replacement: '      if (false) {',
  },

  // ── v1.0 and v1.3 stay separated ─────────────────────────────────────────
  {
    label: 'the v1.0 audit lists the v1.3 workflow',
    spec: RUNS_SPEC,
    expect: 'each audit lists only its own workflow’s runs',
    subject: 'audit',
    anchor: "const WORKFLOW = 'test-e2e-deploy.yml';",
    replacement: "const WORKFLOW = 'compat-credential-v1.3.yml';",
  },
  {
    label: 'the v1.3 audit lists the v1.0 workflow (no rewrite)',
    spec: RUNS_SPEC,
    expect: 'each audit lists only its own workflow’s runs',
    subject: 'lineTracker',
    anchor: '      out[at[0] + 1] = spec.workflowFile;',
    replacement: '      void out;',
  },
  {
    label: 'a v1.0-tag run banks in the v1.3 window',
    spec: RUNS_SPEC,
    expect: 'a v1.0-tag run never banks in the v1.3 window, even fourteen spaced green ones',
    subject: 'lineTracker',
    anchor: '    cells[lane] = { ...a, offLineNights, met: a.met && offLineNights.length === 0 };',
    replacement: '    cells[lane] = { ...a, offLineNights, met: a.met };',
  },
  {
    label: 'a v1.3 fire lands on a v1.0 fire (the derived schedule)',
    spec: RUNS_SPEC,
    expect:
      'the two lines never share a fire (every credential cron of one against every cron of the other)',
    subject: 'v13workflow',
    anchor: "    - cron: '32 0,8,16 * * *'",
    replacement: "    - cron: '17 1,9,17 * * *'",
  },

  // ── spacing never shields a failure (round 2) ───────────────────────────
  {
    label: 'a red run inside the spacing floor is skipped instead of resetting (the escape)',
    spec: RUNS_SPEC,
    expect: 'a RED run that STARTED < 2 h after the previous counted run still RESETS the streak',
    subject: 'audit',
    anchor: '    if (!night.eligible) {\n',
    replacement:
      '    if (!night.eligible) {\n' +
      "      if (scope === 'credential' && open && Date.parse(String(night.startedAt ?? '')) - openLastStartMs < MIN_RUN_SPACING_HOURS * 60 * 60 * 1000) continue;\n",
  },

  // ── the late-slot watchdog (round 2: every due fire since the previous run) ─
  {
    label:
      "the watchdog's window ends at NOW, not at the due point (checks fires before they are due)",
    spec: WATCHDOG_SPEC,
    expect: 'every verdict names the fire it checked',
    subject: 'watchdogLib',
    anchor: '  const end = checkMs - graceMs;',
    replacement: '  const end = checkMs;',
  },
  {
    label: 'the watchdog checks only each lane latest due fire (the round-1 design)',
    spec: WATCHDOG_SPEC,
    expect:
      "the reviewer's reproduction, end to end: a missing bun-webpack 15:47 run alerts exactly once",
    subject: 'watchdog',
    anchor:
      '  const fireTimes = [\n    ...new Set(dueFiresInWindow(laneDefs, window).map((f) => f.fire.toISOString())),\n  ];',
    replacement:
      '  const fireTimes = [\n    ...new Set(computeExpectedSlots(laneDefs, window.end).map((l) => l.expectedSlotTime)),\n  ];',
  },
  {
    label: 'the window assumes the nominal 8 h period instead of the previous run',
    spec: WATCHDOG_SPEC,
    expect:
      "the reviewer's reproduction: delays 6.6 h, 4.9 h, 6.6 h skip nothing and repeat nothing",
    subject: 'watchdogLib',
    anchor: '  const start = prevMs - graceMs;',
    replacement: '  const start = end - 8 * HOUR_MS;',
  },
  {
    label: 'a cancelled previous watchdog run anchors the window',
    spec: WATCHDOG_SPEC,
    expect:
      'skips a cancelled previous run (it may not have evaluated), reaching back to the one before',
    subject: 'watchdog',
    anchor: "    if (r.status !== 'completed' || r.conclusion !== 'success') continue;",
    replacement:
      "    if (r.status !== 'completed' || !['success', 'cancelled'].includes(r.conclusion)) continue;",
  },
  {
    label: 'an early-warning run is credited to a credential lane again',
    spec: WATCHDOG_SPEC,
    expect:
      'the seed-203 shape: two late early-warning runs cannot cover a missing node-webpack run',
    subject: 'watchdogLib',
    anchor: '    if (run.earlyWarning) continue;',
    replacement: '    void run.earlyWarning;',
  },
  {
    label: 'a watchdog silent for longer than the maximum window raises no coverage gap',
    spec: WATCHDOG_SPEC,
    expect:
      'evaluateWatchdog alerts a coverage gap when its previous run is older than the maximum window',
    subject: 'watchdogLib',
    anchor: '    gap: start < earliest,',
    replacement: '    gap: false,',
  },

  // ── round 3: only a run that evaluated its window anchors the next one ──
  {
    label: 'a crashed (failure) previous watchdog run anchors the window again (the round-2 rule)',
    spec: WATCHDOG_SPEC,
    expect:
      'a crashed previous run (failure) is skipped: the window widens back to the last success',
    subject: 'watchdog',
    anchor: "    if (r.status !== 'completed' || r.conclusion !== 'success') continue;",
    replacement:
      "    if (r.status !== 'completed' || !['success', 'failure'].includes(r.conclusion)) continue;",
  },
  {
    label: 'a previous watchdog run still in progress anchors the window',
    spec: WATCHDOG_SPEC,
    expect: 'a previous run still in progress is skipped (it has not finished evaluating)',
    subject: 'watchdog',
    anchor: "    if (r.status !== 'completed' || r.conclusion !== 'success') continue;",
    replacement: "    if (r.status === 'completed' && r.conclusion !== 'success') continue;",
  },
  {
    label: 'no successful run in view: fall back to the plain lookback, missing the crashed runs',
    spec: WATCHDOG_SPEC,
    expect: 'no successful run in view: the window reaches back past the oldest run it can see',
    subject: 'watchdog',
    anchor: '  if (!previous && oldestEarlier) {',
    replacement: '  if (false) {',
  },
  {
    label: 'the CLI reports an alert through its exit code again (an alerting run is no anchor)',
    spec: WATCHDOG_SPEC,
    expect: 'an alerting window exits 0 and reports alert=true and the window it checked',
    subject: 'watchdog',
    anchor: '    return 0;\n  } catch (err) {',
    replacement: '    return alerting.length > 0 ? 1 : 0;\n  } catch (err) {',
  },
  {
    label: 'an alert with no output to carry it exits 0 (fails open)',
    spec: WATCHDOG_SPEC,
    expect: 'an alert with nowhere to report it fails closed (exit 1), never a silent exit 0',
    subject: 'watchdog',
    anchor: '    if (!reported && alerting.length > 0) {',
    replacement: '    if (false) {',
  },
  {
    label: 'a crash no longer names the window it did not check',
    spec: WATCHDOG_SPEC,
    expect:
      'a crash before evaluating (both run listings down) exits 1 and names the window it did not check',
    subject: 'watchdog',
    anchor: "    const where = window ?? 'its window (it stopped before computing it)';",
    replacement: "    const where = 'its window';",
  },
  {
    label: 'the alert job ignores the check job alert output',
    spec: WATCHDOG_SPEC,
    expect: 'fires on alert=true from a check that succeeded, and on a failed or cancelled check',
    subject: 'watchdogWorkflow',
    anchor:
      "      (needs.check-credential-slots.outputs.alert == 'true' || needs.check-credential-slots.result == 'failure'",
    replacement: "      (needs.check-credential-slots.result == 'failure'",
  },
  {
    label: 'the check job stops exposing the alert output',
    spec: WATCHDOG_SPEC,
    expect: 'the check step exposes `alert` and `window` as job outputs',
    subject: 'watchdogWorkflow',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow text, not an interpolation
    anchor: '      alert: ${{ steps.check.outputs.alert }}\n',
    replacement: '',
  },
  {
    label: 'the alert issue stops naming the window a crashed check did not check',
    spec: WATCHDOG_SPEC,
    expect: 'the issue body names the window a check that did not finish left unchecked',
    subject: 'watchdogWorkflow',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow text, not an interpolation
    anchor: '          WINDOW: ${{ needs.check-credential-slots.outputs.window }}\n',
    replacement: '',
  },

  // ── fresh caches: a credential run restores no cache (round 2) ──────────
  {
    label: 'v1.0: the pnpm-store cache restores on a credential run',
    spec: RUNS_SPEC,
    expect: 'v1.0: no step of test-e2e-deploy.yml restores a cache on a credential run',
    subject: 'v10workflow',
    anchor:
      "      - name: Cache next.js pnpm store\n        if: env.KNEXT_COMPAT_MODE != 'credential'\n",
    replacement: '      - name: Cache next.js pnpm store\n',
  },
  {
    label: 'v1.0: setup-bun restores the Bun binary from the cache on a credential run',
    spec: RUNS_SPEC,
    expect: 'v1.0: no step of test-e2e-deploy.yml restores a cache on a credential run',
    subject: 'v10workflow',
    anchor:
      "          no-cache: ${{ env.KNEXT_COMPAT_MODE == 'credential' }}\n          bun-version: '1.4.2'\n",
    replacement: "          bun-version: '1.4.2'\n",
  },
  {
    label: 'v1.0: the Prepare job warms Playwright on a credential run',
    spec: RUNS_SPEC,
    expect:
      'the Prepare job does not warm the Playwright cache on a credential run (nothing would save it)',
    subject: 'v10workflow',
    anchor:
      "        if: steps.pw-cache.outputs.cache-hit != 'true' && env.KNEXT_COMPAT_MODE != 'credential'\n",
    replacement: "        if: steps.pw-cache.outputs.cache-hit != 'true'\n",
  },
  {
    label: 'v1.3: the derived Playwright cache restores on a credential run',
    spec: RUNS_SPEC,
    expect:
      'v1.3: no step of the derived compat-credential-v1.3.yml restores a cache on a credential run',
    subject: 'v13workflow',
    anchor:
      "        id: pw-cache\n        if: env.KNEXT_COMPAT_MODE != 'credential'\n        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n        with:\n          path: ~/.cache/ms-playwright\n          key: playwright-chromium-${{ runner.os }}-${{ steps.pw.outputs.version }}\n          restore-keys: |\n",
    replacement:
      '        id: pw-cache\n        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n        with:\n          path: ~/.cache/ms-playwright\n          key: playwright-chromium-${{ runner.os }}-${{ steps.pw.outputs.version }}\n          restore-keys: |\n',
  },
  {
    label: 'the v1.3 derivation drops the cold-cache rule for a pre-amendment tag',
    spec: RUNS_SPEC,
    expect:
      'the v1.3 derivation applies the cold-cache rule to a tag that predates it (rc.9, `nights` shape)',
    subject: 'lineWorkflow',
    anchor: '    ...sourceShape.coldCaches,',
    replacement: '    ...[],',
  },
];

declareMutations(36);

if (MUTATIONS.length !== 36) {
  console.error(`FATAL: declared 36 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'prove-credential-runs-'));
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }));
const JUNIT_DIR = join(SCRATCH, 'junit');

/**
 * A spec's per-test outcome, from bun's JUnit report — STRUCTURED output,
 * never the console text. `cases` is null when the run wrote no report (the
 * file failed to load): that is "no test outcome", never proof of anything.
 *
 * @param {string} spec
 * @returns {{ status: number | null, cases: Map<string, boolean> | null }}
 *   `cases`: test name → true when that test FAILED.
 */
function runSpec(spec) {
  const runner = resolveSpecRunner(REPO_ROOT, spec);
  rmSync(JUNIT_DIR, { recursive: true, force: true });
  mkdirSync(JUNIT_DIR, { recursive: true });
  const r = spawnSync(
    runner.command,
    [...runner.args, `--junit-dir=${JUNIT_DIR}`, ...runner.runArgs(spec)],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const reports = readdirSync(JUNIT_DIR).filter((f) => f.endsWith('.xml'));
  if (reports.length !== 1) return { status: r.status, cases: null };
  const xml = readFileSync(join(JUNIT_DIR, reports[0]), 'utf8');
  /** @type {Map<string, boolean>} */
  const cases = new Map();
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? '');
    const failed = m[2] !== undefined && /<(?:failure|error)\b/.test(m[2]);
    cases.set(name, (cases.get(name) ?? false) || failed);
  }
  return { status: r.status, cases };
}

/** @param {string} s */
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') {
      return String.fromCodePoint(
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
  });
}

console.log('Baseline: every spec must be GREEN, with every targeted test present and passing.');
for (const spec of new Set(MUTATIONS.map((m) => m.spec))) {
  const base = runSpec(spec);
  if (base.status !== 0 || base.cases === null) {
    console.error(`FATAL: ${spec} is not green to begin with (or wrote no JUnit report)`);
    process.exit(1);
  }
  for (const m of MUTATIONS.filter((x) => x.spec === spec)) {
    if (!base.cases.has(m.expect) || base.cases.get(m.expect)) {
      console.error(`FATAL: "${m.label}" targets a test the baseline does not pass: ${m.expect}`);
      process.exit(1);
    }
  }
  console.log(`   ok ${spec} green (${base.cases.size} tests)`);
}
console.log('');

const bad = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  console.log(`   target: ${m.spec} › ${m.expect}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    const r = runSpec(m.spec);
    let verdict;
    if (r.status === 0) {
      verdict = 'DECORATIVE: the spec stayed GREEN with the behaviour removed';
    } else if (r.cases === null) {
      verdict = 'UNATTRIBUTED: red, but no test outcome was reported (the spec failed to load)';
    } else if (r.cases.get(m.expect) !== true) {
      const others = [...r.cases].filter(([, f]) => f).map(([n]) => n);
      verdict = `MISATTRIBUTED: red, but not via its target (failed: ${others.join(' | ') || 'none'})`;
    }
    if (verdict) {
      console.log(`   x ${verdict}`);
      bad.push(`${m.label} — ${verdict}`);
    } else {
      const also = [...r.cases].filter(([n, f]) => f && n !== m.expect).length;
      console.log(`   ok its target went RED${also ? ` (+${also} other test(s))` : ''}`);
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (runSpec(m.spec).status !== 0) {
    console.error(`   FATAL: ${m.spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(
  `\n${MUTATIONS.length - bad.length} attributed, ${bad.length} not, of ${MUTATIONS.length}.`,
);
if (bad.length > 0) {
  for (const line of bad) console.error(line);
  process.exit(1);
}
