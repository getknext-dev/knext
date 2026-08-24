#!/usr/bin/env node
// <<< NOT-A-CONSUMER — documentation. Rule 6c binds a declared key to code that
// actually reads it, so naming a key in a comment must not count as reading it.
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
 *   6. KEY REGISTRY (the scan). Every key at the five STRUCTURAL levels — `gate`,
 *      `admissibility`, `condition`, `phase`, `criterion` — must be declared in
 *      `KEY_REGISTRY` as either READ (naming the rule that consumes it) or PROSE
 *      (human-readable, asserting nothing about other data in this file). An
 *      undeclared key FAILS. So a new relational field cannot be added to the
 *      JSON without either a checker or an explicit, reviewable "this asserts
 *      nothing" — which is the defect class itself, closed generatively.
 *      SCOPE, stated rather than overclaimed: this scan is over the five levels
 *      above, NOT over values nested inside a declared key. The contents of
 *      `evidence` / `attempt` / `blast_radius` / `superseded_evidence` are
 *      narrative payload and are not registered key-by-key; rule 6d is the only
 *      thing that reaches into them, and it checks NAMES, not declarations.
 *   6b. A key whose NAME is relational (`gates`, `blocked_by`, `blocks_ship`,
 *      `superseded_*`, `concurrent_*`, `depends_*`, `requires_*`) may NOT be
 *      declared PROSE. Otherwise rule 6 is escapable by classifying the new
 *      relation as commentary — the same rename-the-status escape rule 3 had.
 *      Audited over the WHOLE registry — the literal table AND the key patterns —
 *      at startup, so it fails for everyone the moment the declaration is written,
 *      not only when a matching key appears in some gate file.
 *   6c. A READ declaration must be BOUND, not merely labelled. `read(by)` must
 *      name rule ids that this validator actually implements (`RULE_IDS`), and
 *      the key must be reachable from code: either `phaseRef` (consumed
 *      generically by rules 8/13) or its name must appear as a PROPERTY ACCESS
 *      outside the declaration and documentation regions — for a key pattern, its
 *      regex source must appear there verbatim. Without this, rule 6's guarantee
 *      was FALSE: a third door stood open next to "checker" and "prose" — label
 *      the new relation `read('anything')`, write no checker, and it sailed
 *      through. That door was not hypothetical; this file itself shipped
 *      `evidence: read('12')` when there was no rule 12, and the label passed
 *      authorship and review. What 6c proves is EXISTENCE of a consumer, not
 *      WHICH rule consumes it: `read('9b')` is checked to name a real rule and
 *      the key is checked to be read somewhere, but the two are not tied to each
 *      other. It states exactly that much and no more.
 *   6d. No key NESTED inside a declared key may have a relational NAME. A
 *      relation belongs at a structural level where a checker can reach it;
 *      `criterion.evidence.blocked_by_phase` is the same defect wearing one more
 *      layer of nesting, and rule 6 does not see it because `evidence` itself is
 *      declared. This is a NAME check only — a relation stated in the VALUE of a
 *      prose key (a `$comment` sentence, a `note`) is still not caught, and that
 *      limit is real: the closed world is over keys, never over English.
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
 *   8. GATING RELATION (#753's rule (b)). Every key declared `phaseRef` must name
 *      declared phases, without self-reference or duplicates. If X gates Y then Y
 *      must be in a blocked state AND must not have measured anything; if X is
 *      DONE* it must not still be gating. CORROBORATION is table-driven, not
 *      per-key: an entry declaring `inverse` and `mustCorroborate` requires the
 *      other side to state the same relation back, so `blocked_by: [Y]` needs
 *      `gates: [X]` on Y and `concurrent_with: [Y]` needs `concurrent_with: [X]`
 *      on Y. A relation stated on one side only is contradicted by its absence on
 *      the other, and that is now a property of the TABLE — a new phaseRef key
 *      inherits it by declaring an inverse rather than by someone remembering to
 *      write a branch for it.
 *   8b. `gates_note` annotates `gates`; it may not float free of the field.
 *   8c. `why_it_gated_phase_N` must name a declared phase, and once N has left
 *      `gates` the discharge must be recorded in a `gates_note` that NAMES PHASE
 *      N — otherwise the claim outlives the relation it describes, which is what
 *      the prose did, and "any note discharges any claim" is that same defect
 *      one level up. Generic over key patterns carrying a `phaseClaim`.
 *   9a. `done_on` is a completion date. BOTH halves: a phase that is not DONE* may
 *      not carry one, and a STRICTLY-`DONE` phase must. A qualified DONE is
 *      deliberately exempt from the second half — it is done EXCEPT for something,
 *      so there is no date on which it completed, and demanding one would make the
 *      file assert a completion that did not happen.
 *   9b. `evidence` records how a number was obtained; it may only sit on a
 *      criterion that HAS a number. (This check always existed and was unnumbered,
 *      which is how the registry came to cite a rule 12 that did not exist.)
 *   9c. `blocks_ship` names ship. While any `blocks_ship` criterion is unmet, no
 *      `reversible: false` phase may be DONE*.
 *   9d. `superseded_evidence` must say it is withdrawn, say why, and sit on a
 *      criterion that HAS a replacement measurement.
 *   10. Checklist entries naming an admissibility condition (`A1`…) must resolve
 *      against `admissibility.conditions`.
 *   11. Phase ids and criterion ids must be unique. The lookup map keeps the last
 *      duplicate silently, so a second phase `3d` would shadow the first.
 *   12. `current_phase` may not name a phase some other phase still `gates`. Rule
 *      3b checks the phase's own preconditions, which a gated phase can satisfy
 *      trivially by having none — so "the phase in flight is one the file says is
 *      blocked" was statable and green.
 *   13. RELATION ORDERING. Every `phaseRef` key declares whether it asserts an
 *      ORDERED relation (`gates`, `blocked_by` — one side comes first) or an
 *      UNORDERED one (`concurrent_with` — neither does). Two phases may not stand
 *      in both at once, and an ordered relation may not run both ways between the
 *      same pair. This is derived from the table rather than written as an
 *      intersection of two named fields: a new phaseRef key must pick an ordering,
 *      and its conflicts with every existing key are then checked without anyone
 *      enumerating the pair.
 *
 * WHAT IS SCANNED AND WHAT IS ENUMERATED — read this before trusting a claim
 * above. Rules 6/6b/6c/6d, 8, 12 and 13 are SCANS: they range over the registry
 * or over every declared phaseRef key, so a field nobody anticipated is still
 * covered. Rules 1–5, 7, 8b, 8c, 9a, 9b, 9c, 9d, 10 and 11 are ENUMERATED — they
 * name a specific key (`done_on`, `blocks_ship`, `superseded_evidence`, …) and
 * check it. They cannot be generalised, because their content is the SEMANTICS of
 * that particular key, and semantics do not come from a name. The scan's job is to
 * make sure no key exists that no rule reaches; it is not, and cannot be, a
 * guarantee that every rule was written.
 *
 * Exit 1 on any violation. Read-only; it never edits the gate file.
 *
 * Usage:  node scripts/verify-phase-gates.mjs [--json] [--file <path>]
 *                                             [--declare <level>.<key>=<json>]
 */
// NOT-A-CONSUMER >>>

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

/**
 * Every rule id this validator implements. Rule 6c rejects a READ naming anything
 * else, which is what `evidence: read('12')` was: a rule number that never existed,
 * written by an author and passed by a reviewer because nothing checked it.
 */
const RULE_IDS = new Set([
  'identity',
  '1',
  '2',
  '3',
  '3b',
  '3c',
  '4',
  '5',
  '6',
  '6b',
  '6c',
  '6d',
  '7',
  '7a',
  '8',
  '8b',
  '8c',
  '9a',
  '9b',
  '9c',
  '9d',
  '10',
  '11',
  '12',
  '13',
]);

/** The ordering a `phaseRef` key asserts between the two phases. See rule 13. */
const ORDERINGS = new Set(['ordered', 'unordered']);

// <<< NOT-A-CONSUMER — key DECLARATIONS. Writing a key name here is DECLARING it,
// not READING it, so this region is excluded from rule 6c's consumer search. That
// exclusion is the whole mechanism: without it, every key would "prove" it had a
// consumer by appearing in its own declaration.
const KEY_REGISTRY = {
  gate: {
    $comment: prose('file-level commentary'),
    adr: read('identity'),
    title: prose('human label for the ADR'),
    status: prose('the ADR-level acceptance sentence; free text, names no other field here'),
    current_phase: read('3b/3c/12'),
    admissibility: read('10'),
    phases: read('1/3/4/5/7/8/9a/9c/9d/10/11/12/13'),
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
    gates: read('8/13', { phaseRef: 'ordered', inverse: 'blocked_by' }),
    blocked_by: read('8/13', { phaseRef: 'ordered', inverse: 'gates', mustCorroborate: true }),
    concurrent_with: read('8/13', {
      phaseRef: 'unordered',
      inverse: 'concurrent_with',
      mustCorroborate: true,
    }),
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
    evidence: read('9b'),
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

/**
 * Dated variants of the same key — `residual_2026_08_17`, `rerun_2026_08_17`.
 *
 * `phaseClaim` makes rule 8c generic: the pattern's first capture group is a phase
 * id, `relation` is the phaseRef key that would still be asserting it, and `note`
 * is the field that must record the discharge AND name the phase.
 */
const KEY_PATTERNS = {
  phase: [
    {
      re: /^why_it_gated_phase_(.+)$/,
      entry: read('8c', { phaseClaim: { relation: 'gates', note: 'gates_note' } }),
    },
  ],
  criterion: [
    { re: /^residual(_\d{4}_\d{2}_\d{2})?$/, entry: prose('a dated caveat on the measurement') },
    { re: /^rerun(_\d{4}_\d{2}_\d{2})?$/, entry: prose('a dated record of a re-run') },
  ],
};
// NOT-A-CONSUMER >>>

const PHASE_REF_KEYS = () =>
  Object.entries(KEY_REGISTRY.phase).filter(([, v]) => v.phaseRef !== undefined);

/**
 * This validator's own source, minus the regions that DECLARE or DESCRIBE keys
 * rather than read them. Rule 6c searches what is left. Excluding the declaration
 * and documentation regions is the entire mechanism — a key that "proves" it has a
 * consumer by appearing in its own declaration proves nothing at all.
 */
const CONSUMER_SOURCE = readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(
  /\/\/ <<< NOT-A-CONSUMER[\s\S]*?\/\/ NOT-A-CONSUMER >>>/g,
  '',
);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Is a declared key actually reachable from code?
 *
 * A PROPERTY ACCESS (`phase.gates_note`, `c.blocks_ship`) counts; a mention inside
 * a message template does not, which is why the pattern anchors on `.`/`[`. This
 * proves a consumer EXISTS. It does not prove WHICH rule consumes it — that tie is
 * not checked and the docblock says so rather than implying more.
 */
const isAccessedInCode = (key) =>
  new RegExp(`[.\\[]\\s*['"]?${escapeRe(key)}\\b`).test(CONSUMER_SOURCE);

/** The longest literal identifier run in a pattern's regex — its readable name. */
const patternName = (re) =>
  (re.source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).sort((a, b) => b.length - a.length)[0] ??
  re.source;

/**
 * Rules 6b + 6c — the registry audited against ITSELF and against this file's own
 * code, at startup, so a bad declaration fails for everyone the moment it is
 * written rather than when some gate file happens to use it.
 *
 * Every declared entry — the literal table AND the key patterns — passes through
 * here. That matters: auditing only the table left the patterns reachable solely
 * by an in-data check, which could never fire on anything the table half had not
 * already reported, i.e. it was unkillable by construction.
 */
function auditRegistry(problems) {
  const entries = [];
  for (const [level, table] of Object.entries(KEY_REGISTRY)) {
    for (const [key, entry] of Object.entries(table)) {
      entries.push({ level, key, name: key, entry, bound: () => isAccessedInCode(key) });
    }
  }
  for (const [level, patterns] of Object.entries(KEY_PATTERNS)) {
    for (const { re, entry } of patterns) {
      entries.push({
        level,
        key: re.source,
        name: patternName(re),
        entry,
        // A pattern has no property access to find — rule 8c drives it from this
        // table via `phaseClaim`, the same generic consumption `phaseRef` gets.
        bound: () => CONSUMER_SOURCE.includes(re.source),
      });
    }
  }

  for (const { level, key, name, entry, bound } of entries) {
    // Rule 6b — a relation may not be filed as commentary.
    if (entry.prose) {
      if (RELATIONAL_NAME.test(name)) {
        problems.push(
          `key registry: \`${level}.${key}\` is declared PROSE but its name states a relation. A relation needs a checker, not a label — that is the whole of #753.`,
        );
      }
      continue;
    }

    // Rule 6c — a READ declaration must name real rules and be bound to code.
    for (const id of String(entry.by ?? '').split('/')) {
      if (!RULE_IDS.has(id)) {
        problems.push(
          `key registry: \`${level}.${key}\` is declared READ by rule \`${id}\`, which is not a rule this validator implements (${[...RULE_IDS].join(', ')}). A rule id nobody validated is how \`evidence: read('12')\` shipped against a rule 12 that never existed.`,
        );
      }
    }
    // `phaseRef` and `phaseClaim` ARE the binding: rules 8/13 and 8c range over
    // every entry carrying one, so the consumer is the table-driven loop itself.
    // Every other READ must be found in code by name.
    const generic = entry.phaseRef !== undefined || entry.phaseClaim !== undefined;
    if (!generic && !bound()) {
      problems.push(
        `key registry: \`${level}.${key}\` is declared READ but nothing in this validator reads it. READ is not a label — it is a claim that code consumes the key, and an unbound READ is the third door beside "checker" and "prose": name the relation, write no checker, pass.`,
      );
    }

    // Rule 8c — a `phaseClaim` must point at relations and notes that exist, or
    // the generic consumer above silently reads nothing.
    if (entry.phaseClaim) {
      const { relation, note } = entry.phaseClaim;
      if ((KEY_REGISTRY[level] ?? {})[relation]?.phaseRef === undefined) {
        problems.push(
          `key registry: \`${level}.${key}\` declares \`phaseClaim.relation: ${JSON.stringify(relation)}\`, which is not a phaseRef key at this level`,
        );
      }
      if (!(KEY_REGISTRY[level] ?? {})[note]) {
        problems.push(
          `key registry: \`${level}.${key}\` declares \`phaseClaim.note: ${JSON.stringify(note)}\`, which is not a declared key at this level`,
        );
      }
    }

    // Rules 8/13 — a phaseRef key must declare a well-formed ordering and inverse.
    if (entry.phaseRef !== undefined) {
      if (!ORDERINGS.has(entry.phaseRef)) {
        problems.push(
          `key registry: \`${level}.${key}\` declares \`phaseRef: ${JSON.stringify(entry.phaseRef)}\` — it must be ${[...ORDERINGS].join(' or ')}, because rule 13 decides contradictions from the ordering a relation asserts.`,
        );
      }
      const inverse = (KEY_REGISTRY[level] ?? {})[entry.inverse];
      if (!inverse || inverse.inverse !== key) {
        problems.push(
          `key registry: \`${level}.${key}\` declares \`inverse: ${JSON.stringify(entry.inverse)}\`, which is not a phaseRef key at this level declaring \`${key}\` back. Corroboration is table-driven; an inverse that does not point home cannot be checked.`,
        );
      }
    }
  }
}

/** Keys whose values are scanned at another level, not as nested payload. */
const STRUCTURAL_KEYS = new Set([
  'phases',
  'admissibility',
  'conditions',
  'criteria',
  'preconditions',
]);

/** Rule 6 — every key present must be declared. */
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
    // There is deliberately NO in-data repeat of rule 6b here. A key declared
    // PROSE with a relational name is reported by `auditRegistry` unconditionally,
    // so an in-data copy could only fire on something already reported — green
    // when deleted, and therefore decoration by this repo's own standard.
    if (!STRUCTURAL_KEYS.has(key)) scanNested(obj[key], `${at} ${key}`, problems);
  }
}

/**
 * Rule 6d — a relational NAME nested inside a declared key.
 *
 * Rule 6 is a closed world over the five structural levels only; the inside of
 * `evidence` / `attempt` / `blast_radius` is narrative and is not registered
 * key-by-key. That left `criterion.evidence.blocked_by_phase = '99'` passing —
 * the same defect one layer down. This does not close the closed world over
 * nested keys (it does not require them to be declared); it forbids the one thing
 * that must not hide there, which is a stated relation.
 */
function scanNested(value, at, problems) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      scanNested(v, `${at}[${i}]`, problems);
    });
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (RELATIONAL_NAME.test(key)) {
      problems.push(
        `${at}: nested key \`${key}\` has a relational name. A relation must be stated at a level a checker can reach — buried inside a narrative block, nothing reads it, which is #753 with one more layer of nesting.`,
      );
    }
    scanNested(v, `${at}.${key}`, problems);
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

  // Rule 13 — every phase pair, filed under the ORDERING its relation asserts.
  // Collected as the phaseRef loop runs, so the contradiction below is derived
  // from the registry rather than from an intersection of two named fields.
  const relationPairs = {};

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

    // Rule 9a — BOTH halves. A completion date on something not complete, and a
    // strict DONE with no completion date. A QUALIFIED done is exempt from the
    // second: it is done EXCEPT for something, so there is no date it completed on.
    if (phase.done_on !== undefined && !String(phase.status).startsWith('DONE')) {
      problems.push(
        `${phaseAt}: carries \`done_on\` ${phase.done_on} but its status is ${phase.status}, which is not a DONE state`,
      );
    }
    if (phase.status === 'DONE' && phase.done_on === undefined) {
      problems.push(
        `${phaseAt}: status DONE with no \`done_on\` — an unqualified completion claim must say WHEN it completed. (A qualified DONE_* is deliberately exempt: it has not completed.)`,
      );
    }

    // Rule 8 — cross-phase references must resolve, and must not be degenerate.
    // Ranges over whatever the registry declares `phaseRef`, so a new reference
    // list is covered by declaring it rather than by editing this loop.
    for (const [key, entry] of PHASE_REF_KEYS()) {
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

        const other = byId.get(r);
        if (!other || r === String(phase.phase)) return;

        // Rule 8 — corroboration, from the table. A relation stated on one side
        // and absent on the other is contradicted by that absence.
        if (entry.mustCorroborate) {
          const back = (other[entry.inverse] ?? []).map(String);
          if (!back.includes(String(phase.phase))) {
            problems.push(
              `${phaseAt}: ${key} [${r}] but phase ${r} does not declare \`${entry.inverse}\` [${phase.phase}] — the relation is stated once and denied on the other side`,
            );
          }
        }

        // Rule 13 — record the pair under the ordering this key asserts.
        const pair = [String(phase.phase), r].sort().join(' ↔ ');
        const byOrdering = relationPairs[entry.phaseRef] ?? new Map();
        relationPairs[entry.phaseRef] = byOrdering;
        byOrdering.set(pair, [...(byOrdering.get(pair) ?? []), `${phase.phase}.${key}`]);
        // ...and an ORDERED relation may not run both ways between one pair.
        if (
          entry.phaseRef === 'ordered' &&
          (other[key] ?? []).map(String).includes(String(phase.phase))
        ) {
          problems.push(
            `${phaseAt}: ${key} [${r}] while phase ${r} also declares \`${key}\` [${phase.phase}] — \`${key}\` asserts an order, and a pair cannot come first in both directions`,
          );
        }
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

    // `blocked_by` is the inverse of `gates` — but that check is NOT written here
    // any more. It is the table-driven corroboration in the phaseRef loop above,
    // which produces the identical message from `entry.inverse`, so a second
    // phaseRef key gets the same guarantee by declaring an inverse rather than by
    // someone remembering to copy this block. Duplicating it here would be a
    // branch no mutation could kill — the generic one would keep the suite green.
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

    // Rule 8c — a claim about a relation outliving the relation it describes is
    // exactly the prose-over-data asymmetry that caused the 3d re-run. Driven by
    // the pattern's `phaseClaim`, so a second such key is covered by declaring it.
    for (const { re, entry } of KEY_PATTERNS.phase ?? []) {
      if (!entry.phaseClaim) continue;
      const { relation, note } = entry.phaseClaim;
      for (const key of Object.keys(phase)) {
        const m = re.exec(key);
        if (!m) continue;
        const target = m[1];
        if (!byId.has(String(target))) {
          problems.push(`${phaseAt}: ${key} names phase ${target}, which is not declared`);
          continue;
        }
        if ((phase[relation] ?? []).map(String).includes(String(target))) continue;
        // The relation is gone, so the note must record its discharge — AND name
        // the phase. `!phase[note]` alone let ANY note discharge ANY claim, which
        // is the same prose-outlives-the-relation defect this rule exists to close.
        if (!phase[note]) {
          problems.push(
            `${phaseAt}: ${key} asserts it gated phase ${target}, but \`${relation}\` no longer lists it and there is no \`${note}\` recording the discharge`,
          );
        } else if (!new RegExp(`phase[\\s_-]*${escapeRe(target)}\\b`, 'i').test(phase[note])) {
          problems.push(
            `${phaseAt}: ${key} asserts it gated phase ${target}, \`${relation}\` no longer lists it, and \`${note}\` does not name phase ${target} — a note about some other phase does not discharge this claim`,
          );
        }
      }
    }
  }

  // Rule 13 — a pair cannot stand in an ORDERED and an UNORDERED relation at once.
  for (const [pair, ordered] of relationPairs.ordered ?? []) {
    const unordered = relationPairs.unordered?.get(pair);
    if (!unordered) continue;
    problems.push(
      `${label}: phases ${pair} are related by ${ordered.join(', ')} (which asserts an order) AND by ${unordered.join(', ')} (which asserts none) — one of the two is false`,
    );
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
    // Rule 12 — and it must not be a phase the file itself says is gated. Rule 3b
    // above reads the phase's OWN preconditions, which a gated phase satisfies
    // trivially by having none, so "in flight while blocked" was statable and green.
    for (const gater of gatersOf(current.phase)) {
      problems.push(
        `${label}: current_phase ${gate.current_phase} is still gated by phase ${gater}, which declares it in \`gates\` — the file cannot say a phase is blocked and in flight at once`,
      );
    }
  }
}

// <<< NOT-A-CONSUMER — presentation. `render` prints keys; printing a key is not
// checking it, so touching one here must not satisfy rule 6c's binding.
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
// NOT-A-CONSUMER >>>

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

// `--declare <level>.<key>=<json>` injects ONE registry entry for this process.
// Rules 6b and 6c live in `auditRegistry`, so without a seam their only reachable
// input is the committed registry — and a guard whose failing case cannot be
// constructed is a guard with no test. It is REFUSED without `--file`: a seam that
// could add declarations to a run over the real gate directory would loosen rule 6
// for the file it exists to protect.
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] !== '--declare') continue;
  if (fileArgIdx === -1) {
    console.error('--declare is a test seam and requires --file; refusing to alter the registry.');
    process.exit(2);
  }
  const spec = process.argv[i + 1] ?? '';
  const m = /^([A-Za-z_]+)\.([^=]+)=(.*)$/s.exec(spec);
  if (!m) {
    console.error(`--declare expects <level>.<key>=<json>, got \`${spec}\``);
    process.exit(2);
  }
  const level = KEY_REGISTRY[m[1]] ?? {};
  KEY_REGISTRY[m[1]] = level;
  level[m[2]] = JSON.parse(m[3]);
}

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
