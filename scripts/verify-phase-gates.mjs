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
 *      meets its target. A QUALIFIED done-status (`DONE_WITH_…`) is allowed —
 *      phase 0 is genuinely done-except-for-a-reopened-residual, and forcing it
 *      to lie in either direction would be worse — but it must carry a
 *      `status_note` naming what is outstanding. Otherwise the qualifier is a
 *      free pass obtainable by renaming the status, which is what it was:
 *      the strict check tested `status === 'DONE'`, so `DONE_WITH_REOPENED_RESIDUAL`
 *      skipped it entirely and the rule was inert against the shipped file.
 *   3b. `current_phase` must not name a phase whose own preconditions are unmet —
 *      "ran ahead of the evidence". This used to check only that `current_phase`
 *      was a DECLARED phase, so it could be set to a blocked phase and still pass.
 *   3c. `current_phase` must not name a STRICTLY-`DONE` phase. A qualified DONE is
 *      fine — phase 0 is current precisely because its residual reopened — but a
 *      phase with nothing outstanding cannot be the one in flight.
 *   4. A criterion whose `target` is null must say why in `target_note` —
 *      otherwise "no threshold" reads as "any result passes".
 *   5. An array target is compared ELEMENT-WISE. Comparing by length alone let a
 *      checklist of entirely wrong items satisfy its target.
 *
 * ---------------------------------------------------------------------------
 * #753 — RELATIONS. Rules 1–5 check each value against its own target. They do
 * not check the file against ITSELF, so the file could state a relation that no
 * checker read, contradict itself, and stay green. Phase `3d` read `NOT_STARTED`
 * while its own criteria carried measured values from 2026-08-08 to 2026-08-17;
 * rule 3 fires only on statuses starting with `DONE`, so nothing complained, a
 * reader trusted the ADR prose over the file, and an entire measurement phase was
 * re-run after it had already been completed by a better method.
 *
 * The fix below is deliberately a SCAN, not a rule per case. An enumerated list
 * of cases is how the second one gets missed — and there WAS a second one, found
 * by writing this: phase 2 shipped in the same `NOT_STARTED`-with-a-measured-
 * criterion shape, and neither rule proposed in #753 would have named it.
 *
 *   6. KEY REGISTRY (the scan). Every key at every level must be declared in
 *      `KEY_REGISTRY` as either READ (naming the rule that consumes it) or PROSE
 *      (human-readable, asserting nothing about other data in this file). An
 *      undeclared key FAILS. So a new relational field cannot be added to the
 *      JSON without either a checker or an explicit, reviewable "this asserts
 *      nothing" — which is the defect class itself, closed generatively.
 *   6b. A key whose NAME is relational (`gates`, `blocked_by`, `blocks_ship`,
 *      `superseded_*`, `concurrent_*`, `depends_*`, `requires_*`) may NOT be
 *      declared PROSE. Otherwise rule 6 is escapable by classifying the new
 *      relation as commentary — the same rename-the-status escape rule 3 had.
 *   7. STATUS VOCABULARY. Every `phase.status` must match exactly one declared
 *      class, and each class states what it implies about that phase's own
 *      measurements:
 *        NOT_STARTED  — no criterion may be measured  (#753's rule (a), the
 *                       exact inverse of rule 3; a qualified `NOT_STARTED_…`
 *                       is allowed on the same terms rule 3 allows `DONE_…`:
 *                       it needs a `status_note` AND something actually measured)
 *        PARTIAL      — something measured AND something unmet
 *        DONE*        — rule 3
 *        BLOCKED*     — some phase must declare it in `gates`
 *        UNBLOCKED*   — no phase may still declare it in `gates`
 *      An UNKNOWN status fails: previously a one-keystroke typo (`NOT_STARTD`,
 *      `DONNE`) silently disabled every status rule for that phase.
 *   8. GATING RELATION (#753's rule (b)). `gates` / `blocked_by` /
 *      `concurrent_with` must name declared phases, without self-reference or
 *      duplicates. If X gates Y then Y must be in a blocked state AND must not
 *      have measured anything; if X is DONE* it must not still be gating. If X
 *      declares `blocked_by: [Y]` then Y must declare `gates: [X]` — a relation
 *      stated on one side only is contradicted by its absence on the other.
 *   8b. `gates_note` annotates `gates`; it may not float free of the field.
 *   8c. `why_it_gated_phase_N` must name a declared phase, and once N has left
 *      `gates` the discharge must be recorded in `gates_note` — otherwise the
 *      claim outlives the relation it describes, which is what the prose did.
 *   9a. `done_on` is a completion date; a phase that is not DONE* may not carry one.
 *   9c. `blocks_ship` names ship. While any `blocks_ship` criterion is unmet, no
 *      `reversible: false` phase may be DONE*.
 *   9d. `superseded_evidence` must say it is withdrawn, say why, and sit on a
 *      criterion that HAS a replacement measurement.
 *   10. Checklist entries naming an admissibility condition (`A1`…) must resolve
 *      against `admissibility.conditions`.
 *   11. Phase ids and criterion ids must be unique. The lookup map keeps the last
 *      duplicate silently, so a second phase `3d` would shadow the first.
 *
 * Exit 1 on any violation. Read-only; it never edits the gate file.
 *
 * Usage:  node scripts/verify-phase-gates.mjs [--json] [--file <path>]
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
  // Element-wise, not length-only: a checklist of entirely wrong items used to
  // satisfy its target as long as it had the right number of entries.
  if (Array.isArray(c.target)) {
    if (!Array.isArray(c.measured) || c.measured.length !== c.target.length) return false;
    return c.target.every((t, i) => c.measured[i] === t);
  }
  return c.measured === c.target;
}

// ---------------------------------------------------------------------------
// Rule 6 — the key registry. This is the SCAN. Everything below it is a named
// consumer that the registry points at; nothing in the file may be neither.
// ---------------------------------------------------------------------------

/** Declared as consumed by a rule. `phaseRef` marks a cross-phase reference list. */
const read = (by, extra = {}) => ({ by, ...extra });
/** Declared as prose: human-readable, asserting nothing about other data here. */
const prose = (why) => ({ prose: why });

/**
 * A key whose NAME states a relation. Rule 6b forbids declaring one PROSE — the
 * point of the registry is that a relation gets a checker, not a label.
 */
const RELATIONAL_NAME =
  /(^|_)(gate|gates|gated|blocked|blocks|concurrent|supersed|depends|requires|precondition)/i;

const KEY_REGISTRY = {
  gate: {
    $comment: prose('file-level commentary'),
    adr: read('identity'),
    title: prose('human label for the ADR'),
    status: prose('the ADR-level acceptance sentence; free text, names no other field here'),
    current_phase: read('3b/3c'),
    admissibility: read('10'),
    phases: read('1/3/4/5/7/8/9/10/11'),
  },
  admissibility: {
    $comment: prose('commentary on the admissibility conditions'),
    conditions: read('10'),
  },
  condition: {
    id: read('10'),
    text: prose('the condition itself'),
    added_by: prose('which ADR introduced the condition; provenance, not a relation'),
    why: prose('rationale for the condition'),
  },
  phase: {
    phase: read('identity/11'),
    name: prose('human label for the phase'),
    status: read('3/7'),
    status_note: read('3/7'),
    done_on: read('9a'),
    criteria: read('1/3/4/5/7/10/11'),
    preconditions: read('1/3b/4/10/11'),
    gates: read('8', { phaseRef: true }),
    blocked_by: read('8', { phaseRef: true }),
    concurrent_with: read('8', { phaseRef: true }),
    gates_note: read('8b/8c'),
    reversible: read('9c'),
    arms: prose('names the two build arms compared; describes the experiment, not the file'),
  },
  criterion: {
    id: read('10/11'),
    text: prose('the criterion itself'),
    kind: read('1/4/5'),
    target: read('5/10'),
    measured: read('1/2/5/7/10'),
    source: read('1'),
    target_note: read('4'),
    evidence: read('12'),
    note: prose('commentary on the measurement'),
    method: prose('how it was measured'),
    unit: prose('what the number counts'),
    attempt: prose('a record of a measurement attempt and what it cost'),
    blast_radius: prose('what a failure costs downstream; narrative'),
    actor: prose('who must act; no referent inside this file'),
    superseded_evidence: read('9d'),
    blocks_ship: read('9c'),
  },
};

/** Dated variants of the same key — `residual_2026_08_17`, `rerun_2026_08_17`. */
const KEY_PATTERNS = {
  phase: [{ re: /^why_it_gated_phase_(.+)$/, entry: read('8c') }],
  criterion: [
    { re: /^residual(_\d{4}_\d{2}_\d{2})?$/, entry: prose('a dated caveat on the measurement') },
    { re: /^rerun(_\d{4}_\d{2}_\d{2})?$/, entry: prose('a dated record of a re-run') },
  ],
};

const PHASE_REF_KEYS = Object.entries(KEY_REGISTRY.phase)
  .filter(([, v]) => v.phaseRef)
  .map(([k]) => k);

/**
 * Rule 6b, checked against the registry itself so it fails for everyone the
 * moment someone tries to file a relation as commentary.
 */
function auditRegistry(problems) {
  for (const [level, table] of Object.entries(KEY_REGISTRY)) {
    for (const [key, entry] of Object.entries(table)) {
      if (entry.prose && RELATIONAL_NAME.test(key)) {
        problems.push(
          `key registry: \`${level}.${key}\` is declared PROSE but its name states a relation. A relation needs a checker, not a label — that is the whole of #753.`,
        );
      }
    }
  }
}

/** Rule 6 — every key present must be declared, and a relational key must be read. */
function scanKeys(obj, level, at, problems) {
  const table = KEY_REGISTRY[level] ?? {};
  const patterns = KEY_PATTERNS[level] ?? [];
  for (const key of Object.keys(obj)) {
    const entry = table[key] ?? patterns.find((p) => p.re.test(key))?.entry;
    if (!entry) {
      problems.push(
        `${at}: key \`${key}\` is not in the key registry. Every key must be declared READ (naming the rule that consumes it) or PROSE (asserting nothing about other data in this file) — an unread key is how the file came to state relations nothing checked.`,
      );
      continue;
    }
    if (entry.prose && RELATIONAL_NAME.test(key)) {
      problems.push(
        `${at}: key \`${key}\` is declared PROSE but its name states a relation — give it a checker.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 7 — the status vocabulary. Each class states what it implies about the
// phase's own measurements, so a status can no longer be a word with no
// consequence, and an unrecognised one fails instead of skipping every check.
// ---------------------------------------------------------------------------

const STATUS_CLASSES = [
  { id: 'DONE', match: (s) => s.startsWith('DONE'), blockable: false, check: checkDone },
  {
    id: 'NOT_STARTED',
    match: (s) => s.startsWith('NOT_STARTED'),
    blockable: true,
    check: checkNotStarted,
  },
  {
    id: 'UNBLOCKED',
    match: (s) => s.startsWith('UNBLOCKED'),
    blockable: false,
    check: checkUnblocked,
  },
  { id: 'BLOCKED', match: (s) => s.startsWith('BLOCKED'), blockable: true, check: checkBlocked },
  { id: 'PARTIAL', match: (s) => s === 'PARTIAL', blockable: false, check: checkPartial },
];

const classOf = (status) =>
  typeof status === 'string' ? STATUS_CLASSES.filter((c) => c.match(status)) : [];

/** Rule 3 — a DONE phase must actually be done. */
function checkDone(phase, at, problems) {
  const unmet = (phase.criteria ?? []).filter((c) => !meetsTarget(c));
  const strictlyDone = phase.status === 'DONE';
  if (unmet.length > 0 && strictlyDone) {
    problems.push(
      `${at}: status DONE but ${unmet.length} criterion/criteria not met: ${unmet.map((c) => c.id).join(', ')}`,
    );
  }
  // A QUALIFIED done-status must justify itself. Without this, the strict check
  // above is escapable by renaming the status — which is exactly the state this
  // file shipped in.
  if (!strictlyDone && unmet.length > 0 && !phase.status_note) {
    problems.push(
      `${at}: status ${phase.status} leaves ${unmet.length} criterion/criteria unmet (${unmet.map((c) => c.id).join(', ')}) and has no status_note explaining the qualification`,
    );
  }
  // ...and a qualified status with NOTHING outstanding is just DONE. Say so,
  // rather than carrying a caveat the evidence no longer supports.
  if (!strictlyDone && unmet.length === 0) {
    problems.push(`${at}: status ${phase.status} but every criterion is met — use DONE`);
  }
}

/**
 * Rule 7a (#753's rule (a)) — the exact inverse of rule 3, and the rule that
 * would have prevented the duplicated work. Symmetric with rule 3 in both
 * directions: a strict NOT_STARTED admits no measurement, a qualified one needs
 * a note AND an actual measurement to qualify.
 */
function checkNotStarted(phase, at, problems) {
  const measured = (phase.criteria ?? []).filter(isMeasured);
  const strict = phase.status === 'NOT_STARTED';
  if (strict && measured.length > 0) {
    problems.push(
      `${at}: status NOT_STARTED but ${measured.length} criteria/criterion already measured (${measured.map((c) => c.id).join(', ')}). This is the phase-3d state that survived nine days and cost a re-run: qualify the status and say what was measured.`,
    );
  }
  if (!strict && measured.length === 0) {
    problems.push(
      `${at}: status ${phase.status} but no criterion is measured — use NOT_STARTED rather than a qualifier the data does not earn`,
    );
  }
  if (!strict && !phase.status_note) {
    problems.push(
      `${at}: status ${phase.status} qualifies NOT_STARTED and has no status_note saying what has already been measured`,
    );
  }
}

/** Rule 7 — PARTIAL means partly: something measured, something still unmet. */
function checkPartial(phase, at, problems) {
  const criteria = phase.criteria ?? [];
  if (criteria.filter(isMeasured).length === 0) {
    problems.push(`${at}: status PARTIAL but no criterion is measured — that is NOT_STARTED`);
  }
  if (criteria.length > 0 && criteria.every((c) => meetsTarget(c))) {
    problems.push(`${at}: status PARTIAL but every criterion is met — that is DONE`);
  }
}

/** Rule 7 — a phase claiming to be blocked must be blocked BY something stated here. */
function checkBlocked(phase, at, problems, ctx) {
  if (ctx.gatersOf(phase.phase).length === 0) {
    problems.push(
      `${at}: status ${phase.status} but no phase declares it in \`gates\` — blocked by what? State the relation or drop the claim.`,
    );
  }
}

/** Rule 7 — and a phase claiming to be unblocked must not still be gated. */
function checkUnblocked(phase, at, problems, ctx) {
  if (!phase.status_note) {
    problems.push(
      `${at}: status ${phase.status} asserts a gate was discharged and has no status_note saying by what`,
    );
  }
  for (const gater of ctx.gatersOf(phase.phase)) {
    problems.push(
      `${at}: status ${phase.status} but phase ${gater} still declares it in \`gates\` — the file contradicts itself`,
    );
  }
}

// ---------------------------------------------------------------------------

function verify(gate, problems) {
  const label = `ADR-${gate.adr}`;

  // Rule 6 — the scan, before anything reads a value.
  scanKeys(gate, 'gate', label, problems);
  if (gate.admissibility && typeof gate.admissibility === 'object') {
    scanKeys(gate.admissibility, 'admissibility', `${label} admissibility`, problems);
    for (const cond of gate.admissibility.conditions ?? []) {
      scanKeys(cond, 'condition', `${label} admissibility ${cond.id}`, problems);
    }
  }
  for (const phase of gate.phases) {
    scanKeys(phase, 'phase', `${label} phase ${phase.phase}`, problems);
    for (const c of [...(phase.preconditions ?? []), ...(phase.criteria ?? [])]) {
      scanKeys(c, 'criterion', `${label} phase ${phase.phase} ${c.id}`, problems);
    }
  }

  // Rule 11 — duplicate ids. The lookup map below keeps the LAST silently, so a
  // shadowed phase is invisible: every relation would point at the wrong object.
  const seenPhase = new Map();
  const seenCrit = new Map();
  for (const phase of gate.phases) {
    const k = String(phase.phase);
    seenPhase.set(k, (seenPhase.get(k) ?? 0) + 1);
    for (const c of [...(phase.preconditions ?? []), ...(phase.criteria ?? [])]) {
      seenCrit.set(c.id, (seenCrit.get(c.id) ?? 0) + 1);
    }
  }
  for (const [k, n] of seenPhase) {
    if (n > 1) problems.push(`${label}: phase id \`${k}\` is declared ${n} times`);
  }
  for (const [k, n] of seenCrit) {
    if (n > 1) problems.push(`${label}: criterion id \`${k}\` is declared ${n} times`);
  }

  const byId = new Map(gate.phases.map((p) => [String(p.phase), p]));
  const admissible = new Set((gate.admissibility?.conditions ?? []).map((c) => c.id));
  const gatersOf = (id) =>
    gate.phases
      .filter((p) => (p.gates ?? []).map(String).includes(String(id)))
      .map((p) => String(p.phase));
  const ctx = { byId, gatersOf };

  for (const phase of gate.phases) {
    const phaseAt = `${label} phase ${phase.phase}`;

    for (const c of [...(phase.preconditions ?? []), ...(phase.criteria ?? [])]) {
      const at = `${phaseAt} ${c.id}`;

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

      // Rule 9d — a withdrawn claim must say it is withdrawn, say why, and have
      // been replaced. Parking one unlabelled is how Run 24's 4.5x kept reading
      // as a result.
      if (c.superseded_evidence !== undefined) {
        const se = c.superseded_evidence ?? {};
        if (!isMeasured(c)) {
          problems.push(
            `${at}: carries \`superseded_evidence\` but is itself unmeasured — superseded by what?`,
          );
        }
        if (!/^(WITHDRAWN|SUPERSEDED)$/.test(String(se.status ?? ''))) {
          problems.push(
            `${at}: \`superseded_evidence.status\` is \`${se.status ?? '(absent)'}\` — it must read WITHDRAWN or SUPERSEDED, or the block reads as current evidence`,
          );
        }
        if (!se.why) {
          problems.push(`${at}: \`superseded_evidence\` must say \`why\` it no longer stands`);
        }
      }

      // Rule 10 — a checklist entry shaped like an admissibility condition must
      // resolve to one. P1-1's whole meaning is "A1…A6 were satisfied".
      for (const list of [c.target, c.measured]) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (typeof item === 'string' && /^A\d+$/.test(item) && !admissible.has(item)) {
            problems.push(
              `${at}: \`${item}\` is not a declared admissibility condition (${[...admissible].join(', ') || 'none declared'})`,
            );
          }
        }
      }
    }

    // Rule 7 — the status must be classifiable, and its class must hold.
    const classes = classOf(phase.status);
    if (classes.length !== 1) {
      problems.push(
        classes.length === 0
          ? `${phaseAt}: status \`${phase.status}\` matches no declared status class (${STATUS_CLASSES.map((c) => c.id).join(', ')}). An unrecognised status skips every status rule silently.`
          : `${phaseAt}: status \`${phase.status}\` matches ${classes.length} status classes (${classes.map((c) => c.id).join(', ')}) — the vocabulary is ambiguous`,
      );
    } else {
      classes[0].check(phase, phaseAt, problems, ctx);
    }

    // Rule 9a — a completion date on something not complete.
    if (phase.done_on !== undefined && !String(phase.status).startsWith('DONE')) {
      problems.push(
        `${phaseAt}: carries \`done_on\` ${phase.done_on} but its status is ${phase.status}, which is not a DONE state`,
      );
    }

    // Rule 8 — cross-phase references must resolve, and must not be degenerate.
    for (const key of PHASE_REF_KEYS) {
      const refs = phase[key];
      if (refs === undefined) continue;
      if (!Array.isArray(refs)) {
        problems.push(`${phaseAt}: \`${key}\` must be an array of phase ids`);
        continue;
      }
      const seen = new Set();
      refs.forEach((ref, i) => {
        const r = String(ref);
        if (r === String(phase.phase)) {
          problems.push(`${phaseAt}: ${key}[${i}] refers to itself`);
        } else if (!byId.has(r)) {
          problems.push(`${phaseAt}: ${key}[${i}] \`${r}\` is not a declared phase`);
        }
        if (seen.has(r)) problems.push(`${phaseAt}: ${key}[${i}] \`${r}\` is listed twice`);
        seen.add(r);
      });
    }

    // Rule 8 — the gating relation's semantics (#753's rule (b)).
    for (const ref of phase.gates ?? []) {
      const target = byId.get(String(ref));
      if (!target || String(ref) === String(phase.phase)) continue; // already reported
      const targetClasses = classOf(target.status);
      if (targetClasses.length === 1 && !targetClasses[0].blockable) {
        problems.push(
          `${phaseAt}: gates phase ${ref}, whose status ${target.status} is not a blocked state — a phase cannot be gated and advanced at once`,
        );
      }
      const ran = (target.criteria ?? []).filter(isMeasured);
      if (ran.length > 0) {
        problems.push(
          `${label} phase ${ref}: is gated by phase ${phase.phase} but has already measured ${ran.map((c) => c.id).join(', ')} — it ran ahead of its own gate`,
        );
      }
    }
    if (String(phase.status).startsWith('DONE') && (phase.gates ?? []).length > 0) {
      problems.push(
        `${phaseAt}: status ${phase.status} but still declares \`gates\` [${(phase.gates ?? []).join(', ')}] — a discharged gate is not still gating`,
      );
    }

    // Rule 8 — `blocked_by` is the inverse of `gates`; stated on one side only,
    // it is contradicted by its absence on the other.
    for (const ref of phase.blocked_by ?? []) {
      const target = byId.get(String(ref));
      if (!target) continue; // already reported
      if (!(target.gates ?? []).map(String).includes(String(phase.phase))) {
        problems.push(
          `${phaseAt}: blocked_by [${ref}] but phase ${ref} does not declare \`gates\` [${phase.phase}] — the relation is stated once and denied on the other side`,
        );
      }
    }
    if ((phase.blocked_by ?? []).length > 0) {
      const own = classOf(phase.status);
      if (own.length === 1 && !own[0].blockable) {
        problems.push(
          `${phaseAt}: declares \`blocked_by\` while its own status ${phase.status} is not a blocked state`,
        );
      }
    }

    // Rule 8b — a note that annotates a field the phase does not have.
    if (phase.gates_note !== undefined && phase.gates === undefined) {
      problems.push(
        `${phaseAt}: carries \`gates_note\` but no \`gates\` field — the note annotates a relation that is not stated`,
      );
    }

    // Rule 8c — `why_it_gated_phase_N` outliving the relation it describes is
    // exactly the prose-over-data asymmetry that caused the 3d re-run.
    for (const key of Object.keys(phase)) {
      const m = /^why_it_gated_phase_(.+)$/.exec(key);
      if (!m) continue;
      const target = m[1];
      if (!byId.has(String(target))) {
        problems.push(`${phaseAt}: ${key} names phase ${target}, which is not declared`);
        continue;
      }
      if (!(phase.gates ?? []).map(String).includes(String(target)) && !phase.gates_note) {
        problems.push(
          `${phaseAt}: ${key} asserts it gated phase ${target}, but \`gates\` no longer lists it and there is no \`gates_note\` recording the discharge`,
        );
      }
    }
  }

  // Rule 9c — while a ship blocker is open, the irreversible phase is not done.
  const openShipBlockers = gate.phases.flatMap((p) =>
    [...(p.preconditions ?? []), ...(p.criteria ?? [])]
      .filter((c) => c.blocks_ship === true && !meetsTarget(c))
      .map((c) => c.id),
  );
  if (openShipBlockers.length > 0) {
    for (const p of gate.phases) {
      if (p.reversible === false && String(p.status).startsWith('DONE')) {
        problems.push(
          `${label} phase ${p.phase}: is irreversible and ${p.status} while ${openShipBlockers.length} \`blocks_ship\` criterion/criteria are unmet (${openShipBlockers.join(', ')})`,
        );
      }
    }
  }

  // Rules 3b/3c — current_phase must not have run ahead of the evidence.
  const current = byId.get(String(gate.current_phase));
  if (!current) {
    problems.push(`${label}: current_phase ${gate.current_phase} is not a declared phase`);
  } else {
    // Naming a declared phase was the ONLY thing checked here, so current_phase
    // could be set to a phase whose own preconditions were unmet and still pass.
    const unmetPre = (current.preconditions ?? []).filter((c) => !meetsTarget(c));
    if (unmetPre.length > 0) {
      problems.push(
        `${label}: current_phase ${gate.current_phase} has ${unmetPre.length} unmet precondition(s): ${unmetPre.map((c) => c.id).join(', ')}`,
      );
    }
    // Rule 3c — a QUALIFIED done phase may be current (phase 0 is, because its
    // residual reopened); a strictly done one has nothing left to be current for.
    if (current.status === 'DONE') {
      problems.push(
        `${label}: current_phase ${gate.current_phase} names phase ${current.phase}, whose status is DONE with nothing outstanding — advance it or qualify the status`,
      );
    }
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

// `--file <path>` points the validator at ONE gate file instead of the whole
// directory. It exists so the rules can be tested against deliberately-broken
// fixtures without writing them into the repo's real gate file — a rule with no
// failing case is indistinguishable from a rule that is not enforced, which is
// the state two of these were in.
const fileArgIdx = process.argv.indexOf('--file');
const files =
  fileArgIdx !== -1 && process.argv[fileArgIdx + 1]
    ? [process.argv[fileArgIdx + 1]]
    : readdirSync(GATE_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(GATE_DIR, f));

const problems = [];
const all = [];

auditRegistry(problems);

for (const f of files) {
  const gate = JSON.parse(readFileSync(f, 'utf8'));
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
