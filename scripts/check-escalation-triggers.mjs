#!/usr/bin/env node
/**
 * Detect the MECHANICALLY DETECTABLE escalation triggers from
 * `.claude/rules/workflow.md`, so a trigger-class change cannot reach `main` on
 * an agent's self-report.
 *
 * WHY THIS EXISTS. The sprint model moved the architect + system-designer gates
 * from per-PR to per-sprint, and pulled them back only on five triggers. The rules
 * file is explicit that three of those are detectable and that leaving them to
 * self-reporting is the failure mode to watch:
 *
 *   "Three of these are mechanically detectable, so detect them rather than
 *    relying on someone to self-report against their own interest."
 *
 * It was never implemented. On 2026-08-11 a breaking CRD + CLI change (#715)
 * merged with no design gate and no per-PR review; the retroactive review found
 * two HIGH defects, one of them in a safety control. Nothing flagged it as
 * trigger-class because nothing was looking.
 *
 * WHAT IT DOES NOT DO. It does not decide whether the change is correct, and it
 * does not block one. It asserts that a trigger-class change was ACKNOWLEDGED —
 * that someone summoned the gate the rules require. The remaining two triggers (a
 * discovered fact that invalidates the sprint plan; a hard-rule contradiction that
 * touches no tracked path) are judgement and stay unenforced, by the rules' own
 * admission. This closes three of five, not five of five.
 *
 * Usage:
 *   node scripts/check-escalation-triggers.mjs --base <ref> [--head <ref>]
 *                                              [--labels "a,b"] [--body "<text>"] [--json]
 *
 * Exit 0 = no trigger, or triggered and acknowledged. Exit 1 = triggered, unacknowledged.
 *
 * ACKNOWLEDGEMENT, not gate-clear (workflow.md amendment, 2026-09-22): a trigger-class
 * PR no longer needs a design gate to sign off before merge — it needs a human/agent to
 * have CONSCIOUSLY NOTED the trigger, so sprint close can collect it as a tech-debt
 * backlog item. Any of the following counts:
 *   - the `trigger:acknowledged` label (or, backward compatible, the older
 *     `design-gate:cleared` label from when this WAS a gate);
 *   - a line in the PR body matching `Escalation trigger acknowledged: <...>` — this
 *     also records WHICH trigger and WHY inline, where sprint close can read it without
 *     needing GitHub timeline/label history.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** The label that records "a human/agent consciously noted this trigger". */
export const ACK_LABEL = 'trigger:acknowledged';

/** Kept for backward compatibility: this repo used `design-gate:cleared` while the
 * check still required a gate sign-off. Still accepted as an acknowledgement. */
export const LEGACY_ACK_LABEL = 'design-gate:cleared';

/**
 * A PR-body line that records the acknowledgement inline, e.g.:
 *   "Escalation trigger acknowledged: CLI surface — adds a flag, no behaviour change."
 * Case-insensitive; tolerates leading/trailing whitespace.
 */
export const ACK_BODY_PATTERN = /Escalation trigger acknowledged:/i;

/**
 * Path rules, verbatim from workflow.md's list, with two deliberate refinements
 * noted on each. A guard that cries wolf gets worked around — this repo has
 * measured that — so precision here is not fussiness, it is what keeps the guard
 * trusted enough to be obeyed.
 */
export const TRIGGERS = [
  {
    id: 'adr',
    label: 'an ADR',
    // REFINEMENT: only a MODIFIED or DELETED ADR triggers. Adding a new ADR is the
    // OUTPUT of an escalation, not a reason to demand one — firing on it would tax
    // the exact behaviour the rules are trying to encourage. `docs/adr/gates/` is
    // measurement DATA, updated whenever someone runs a benchmark, and is excluded
    // for the same reason.
    match: (p, status) =>
      p.startsWith('docs/adr/') && !p.startsWith('docs/adr/gates/') && status !== 'A',
    why: 'changes or removes an existing ADR — workflow.md: a change that contradicts or would require amending an ADR',
  },
  {
    id: 'crd',
    label: 'the NextApp CRD',
    match: (p) => p === 'packages/kn-next-operator/api/v1alpha1/nextapp_types.go',
    why: 'changes the CRD type, which is the operator/CLI compatibility surface (upgrade order is load-bearing: operator/CRD first, then CLI)',
  },
  {
    id: 'config-schema',
    label: 'the knext.config.ts schema',
    match: (p) => p === 'packages/kn-next/src/config.ts',
    why: 'changes the public config schema every consuming app is written against',
  },
  {
    id: 'cli-surface',
    label: 'the CLI surface',
    match: (p) => p.startsWith('packages/kn-next/src/cli/'),
    why: 'changes the CLI, which is the published entry point (`kn-next`)',
  },
];

/** Parse `git diff --name-status` output into {status, path} records. */
export function parseNameStatus(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      // rename/copy lines carry two paths; the DESTINATION is what matters here
      return { status: status[0], path: rest[rest.length - 1] };
    });
}

/**
 * Did the PUBLIC surface of a package manifest change?
 *
 * package.json is edited constantly — version bumps, dependency updates, script
 * tweaks — so treating any change to it as a trigger would fire on almost every
 * PR and train everyone to reach for the ack label reflexively. Only the keys that
 * define what consumers can import are compared.
 */
export const PUBLIC_MANIFEST_KEYS = ['exports', 'bin', 'files', 'main', 'types', 'typesVersions'];

export function publicSurfaceChanged(before, after) {
  const pick = (o) =>
    JSON.stringify(Object.fromEntries(PUBLIC_MANIFEST_KEYS.map((k) => [k, o?.[k] ?? null])));
  return pick(before) !== pick(after);
}

/** Classify changed files into fired triggers. Pure — the tests drive this directly. */
export function classify(changes) {
  const fired = [];
  for (const t of TRIGGERS) {
    const hits = changes.filter((c) => t.match(c.path, c.status)).map((c) => c.path);
    if (hits.length > 0) fired.push({ id: t.id, label: t.label, why: t.why, paths: hits });
  }
  return fired;
}

export function isAcknowledged(labels, body) {
  const labelHit = labels.some((l) => {
    const normalized = l.trim().toLowerCase();
    return normalized === ACK_LABEL || normalized === LEGACY_ACK_LABEL;
  });
  if (labelHit) return true;
  return typeof body === 'string' && ACK_BODY_PATTERN.test(body);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function showJson(ref, path) {
  try {
    return JSON.parse(git(['show', `${ref}:${path}`]));
  } catch {
    return null; // absent on that side is a legitimate answer
  }
}

/**
 * Append the detected triggers to the job summary so sprint close can collect them
 * without re-deriving the diff. Best-effort: `GITHUB_STEP_SUMMARY` is unset outside
 * Actions (e.g. running this script locally), and a missing/unwritable path must not
 * fail the check it is only decorating.
 */
function writeJobSummary(fired, acked) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || fired.length === 0) return;
  try {
    const lines = [
      '## Escalation triggers acknowledged',
      '',
      `Acknowledgement: ${acked ? 'yes' : 'no'}`,
      '',
      ...fired.flatMap((f) => [
        `- **${f.label}** — ${f.why}`,
        ...f.paths.map((p) => `  - \`${p}\``),
      ]),
      '',
    ];
    appendFileSync(summaryPath, `${lines.join('\n')}\n`);
  } catch {
    // Decoration, not the gate — never fail the check over a summary write.
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = arg('base');
  const head = arg('head', 'HEAD');
  if (!base) {
    console.error(
      'usage: check-escalation-triggers.mjs --base <ref> [--head <ref>] [--labels a,b]',
    );
    process.exit(2);
  }

  const changes = parseNameStatus(git(['diff', '--name-status', `${base}...${head}`]));
  const fired = classify(changes);

  // The public-API trigger needs content, not just a path.
  const MANIFEST = 'packages/kn-next/package.json';
  if (changes.some((c) => c.path === MANIFEST)) {
    if (publicSurfaceChanged(showJson(base, MANIFEST), showJson(head, MANIFEST))) {
      fired.push({
        id: 'public-api',
        label: 'the published package surface',
        why: `changes ${PUBLIC_MANIFEST_KEYS.join('/')} in ${MANIFEST} — what consumers can import`,
        paths: [MANIFEST],
      });
    }
  }

  const labels = (arg('labels', '') || '').split(',').filter(Boolean);
  const body = arg('body', '') || '';
  const acked = isAcknowledged(labels, body);

  // `--json` prints JSON and NOTHING else, so a caller can parse stdout directly.
  // It used to print the JSON *and* the human report, which made stdout unparseable —
  // and the first attempt to measure this guard's false-positive rate against 40
  // commits silently returned "fired on 0 of 40" because every parse threw and was
  // swallowed. A measurement that cannot fail loudly is worth nothing.
  if (process.argv.includes('--json')) {
    writeJobSummary(fired, acked);
    console.log(JSON.stringify({ fired, acked, ackLabel: ACK_LABEL }, null, 2));
    process.exit(fired.length > 0 && !acked ? 1 : 0);
  }

  if (fired.length === 0) {
    console.log('No mechanically-detectable escalation trigger in this diff.');
    process.exit(0);
  }

  console.log(`Escalation trigger(s) detected (${fired.length}):\n`);
  for (const f of fired) {
    console.log(`  • ${f.label} — ${f.why}`);
    for (const p of f.paths.slice(0, 8)) console.log(`      ${p}`);
    if (f.paths.length > 8) console.log(`      …and ${f.paths.length - 8} more`);
  }

  if (acked) {
    writeJobSummary(fired, acked);
    console.log(
      `\nAcknowledged (\`${ACK_LABEL}\` label, \`${LEGACY_ACK_LABEL}\` label, or a` +
        `\n"Escalation trigger acknowledged: ..." line in the PR body). Passing — logged to` +
        `\nthe job summary for sprint close to collect.`,
    );
    process.exit(0);
  }

  console.error(
    `\nThis PR touches a trigger-class surface and is NOT acknowledged.\n` +
      `\n.claude/rules/workflow.md (2026-09-22 amendment) does not require a design-gate` +
      `\nsign-off per PR for this — it requires that the trigger was CONSCIOUSLY NOTED, so` +
      `\nsprint close can pick it up as tech debt. Acknowledge by either:` +
      `\n  - adding the \`${ACK_LABEL}\` label, or` +
      `\n  - adding a line to the PR body: "Escalation trigger acknowledged: <trigger> — <reason>"` +
      `\n\nThis check does not judge the change and does not require a gate to clear it — it` +
      `\nasserts the trigger was not skipped by default. If it fired on something genuinely` +
      `\nroutine, say so on the PR and narrow the rule; a guard that cries wolf gets worked` +
      `\naround, which is worse than no guard.`,
  );
  process.exit(1);
}
