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
 *      narrative payload and are not registered key-by-key; rules 6d and 6e are
 *      the only things that reach into them, and they check a NAME and a VALUE
 *      SHAPE, not declarations.
 *   6b. A key whose NAME is relational (`gates`, `blocked_by`, `blocks_ship`,
 *      `superseded_*`, `concurrent_*`, `depends_*`, `requires_*`) may NOT be
 *      declared PROSE. Otherwise rule 6 is escapable by classifying the new
 *      relation as commentary — the same rename-the-status escape rule 3 had.
 *      Audited over the WHOLE registry — the literal table AND the key patterns —
 *      so it fails for everyone the moment the declaration is written, not only
 *      when a matching key appears in some gate file. This is a TEN-WORD
 *      VOCABULARY and it is NOT the guarantee: review walked through it with
 *      thirteen synonyms (`unblocks_phase`, `follows_phase`, `waits_for_phase`, …),
 *      none of which it matches. Rule 6e is the guarantee; 6b is the cheap pass.
 *   6c. A READ declaration must be BOUND, not merely labelled. `read(by)` must
 *      name rule ids this validator implements (`RULE_IDS`), and the key must
 *      actually be READ OFF THE GATE FILE during the run — recorded through the
 *      tracking Proxy in `track()` — or carry a generic-consumption marker
 *      (`phaseRef`, `phaseClaim`) whose table-driven loop is its consumer.
 *      Without this, rule 6's guarantee was FALSE: a third door stood open next
 *      to "checker" and "prose" — label the new relation `read('anything')`,
 *      write no checker, and it sailed through. That door was not hypothetical;
 *      this file shipped `evidence: read('12')` against a rule 12 that did not
 *      exist. A first attempt at closing it grepped this file's own source for a
 *      property access, and review defeated THAT too: fifteen names passed as
 *      bound with nothing reading them, because the source contains
 *      `phase[relation]`, `phase[note]` (local variables) and `entry.inverse`
 *      (a read on the registry, not on gate data). Recorded consumption cannot be
 *      satisfied that way. What 6c still does NOT prove: WHICH rule consumes the
 *      key. `read('9b')` is checked to name a real rule and the key is checked to
 *      be read by something; the two are never tied to each other.
 *   6d. No key NESTED inside a declared key may have a relational NAME (see 6b's
 *      caveat about vocabulary). `criterion.evidence.blocked_by_phase` is rule 6's
 *      defect wearing one more layer of nesting, and rule 6 does not see it
 *      because `evidence` itself is declared.
 *   6e. REFERENCE SHAPE, and this is where the guarantee actually lives. A key
 *      declared PROSE — at a structural level, or nested at any depth inside one,
 *      through OBJECT keys and ARRAY brackets alike — is a cross-phase relation,
 *      whatever it is called, when EITHER:
 *        - its VALUE is a non-empty list whose entries all resolve to declared
 *          phase ids (strings or numbers — ids are compared with `String()` here as
 *          they are everywhere else), or a scalar STRING that resolves; or
 *        - it is an OBJECT whose KEYS all resolve to declared phase ids. Round 4
 *          walked through the value-only version with a map FROM phase id TO prose:
 *          `attempt: { ordering: { "5": "must finish before this one" } }`; round 6
 *          then walked through the fix, because the key test was reachable only from
 *          the NESTED scan — depth 2 failed and `attempt: { "5": … }` at depth 1 did
 *          not. Both tests now run at the structural level too.
 *      ARRAY ELEMENTS are shape-tested, not merely descended into. `scanNested` used
 *      to ask the shape question only of an object KEY's value, so `attempt:
 *      [["5","3"]]` exited 0 while `["5","3"]` failed: one bracket was the whole
 *      hole. Scalar elements are deliberately exempt — the list they sit in is judged
 *      as a whole, and testing them one by one would report every legitimate
 *      `concurrent_with: ["2"]` entry.
 *      Three boundaries, each deliberate and each with its own test:
 *        - an EMPTY list is not a reference ("all zero elements resolve" is vacuous,
 *          and `gates: []` is the shape a discharged gate must take);
 *        - a bare SCALAR NUMBER is not a reference AT THE CRITERION LEVEL, and only
 *          there. That level is full of measurements which stringify to phase ids —
 *          `samples_lost: 1`, `server_modules_read_from_disk_on_cold_first_request:
 *          0` — so a lone number on a criterion is read as one. Nothing on a phase,
 *          a gate or an admissibility condition is a measurement, so at those levels
 *          a bare number IS a reference and `follows_phase: 5` fails. The exemption
 *          is scoped to the level that needs it, not applied everywhere for one
 *          level's reason. A LIST is always read as a reference list;
 *        - a scalar string equal to the phase's OWN id is a LABEL, not a relation:
 *          `{ phase: 'wb', name: 'wb' }` says nothing about another phase. Scalars
 *          only — a list is a reference list whatever it contains.
 *      Still NOT caught, and not catchable here: a relation asserted in an English
 *      SENTENCE ("phase 5 gates phase 1") inside a `$comment` or a `note`. The
 *      closed world is over keys, nested keys, and reference-shaped values. It is
 *      never over prose, and no wording in this file should suggest otherwise.
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
 *      must be in a blocked state AND must not have measured anything — in its
 *      PRECONDITIONS as well as its criteria, a field this check read past until
 *      round 4 (`(target.criteria ?? [])`), which left #753's own defect class
 *      restatable one field over; if X is DONE* it must not still be gating. CORROBORATION is table-driven, not
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
 *      UNORDERED one (`concurrent_with` — neither does). The ordered relation is a
 *      DIRECTED GRAPH, and BOTH questions are answered by walking it:
 *        - it must be ACYCLIC (every phase on a cycle must complete before itself);
 *        - a pair declared UNORDERED must not be REACHABLE either way in it.
 *      The graph is the point, and it took two rounds to apply it to both halves.
 *      Round 2: pairs were compared, so `xa gates xb, xb gates xc, xc gates xa`
 *      exited 0 while a 2-cycle failed — cycle LENGTH was the enumeration. Round 4:
 *      the acyclicity half walked but the unordered half was still a pair lookup, so
 *      `ta gates tb, tb gates tc, ta concurrent_with tc` exited 0 while the direct
 *      pair failed — PATH LENGTH was the enumeration. Both are now the same walk.
 *      Orientation comes from WHICH SIDE CORROBORATES: the non-corroborating key
 *      contributes `phase -> ref`, and its inverse contributes nothing because it
 *      states the mirror of an edge already present. `auditRegistry` requires
 *      exactly one side of an ordered pair to corroborate, which is what makes that
 *      a checked fact rather than a convention. (An `edge: forward|reverse` field
 *      used to declare orientation. It was DECORATION - `blocked_by` corroborates,
 *      so its reverse edge could only differ on a file corroboration had already
 *      reported, and deleting the reverse contribution outright left every test and
 *      every rebuilt contradiction green. It is gone.)
 *   1b. `kind: "derived"` exempts a criterion from rule 1's source requirement, and
 *      that exemption was a one-keystroke escape from the file's HEADLINE rule:
 *      relabel a criterion `derived` and a measured value with no provenance exits
 *      0 — the same rename shape as rule 3's `DONE_*`, on the rule the file exists
 *      for. A measured `derived` criterion must now carry `derived_from` naming
 *      declared criterion ids, which makes the exemption a checkable relation —
 *      and, since round 4, one subject to the SAME degeneracy checks rule 8 makes
 *      for phase references: it may not name ITSELF (provenance that is its own
 *      subject is no provenance, which is exactly what rule 1 forbids), may not
 *      name a criterion nobody has MEASURED, and may not list one twice.
 *
 * WHAT IS SCANNED AND WHAT IS ENUMERATED — read this before trusting a claim
 * above, and note what round-2 review established: a loop that genuinely scans can
 * still DECIDE with an enumerated predicate, and three findings walked through
 * exactly that gap. So the split is stated per RULE and per PREDICATE.
 *
 * SCANS, ranging over the registry or over every declared key of a kind, deciding
 * with a predicate that does not enumerate cases:
 *   6   every key at the five structural levels, against the registry
 *   6c  every READ, against rule ids and against RECORDED CONSUMPTION
 *   6e  every PROSE key, against "does its value or its key set resolve to phase
 *       ids" — at the structural levels and at any nesting depth
 *   8   every `phaseRef` key; corroboration derived from `entry.inverse`
 *   8c  every key pattern carrying a `phaseClaim`
 *   12  every phase that gates the current one
 *   13  the ordered relation as a directed graph — BOTH questions are walks: a
 *       cycle search, and a reachability test for every unordered pair
 *
 * SCANNED LOOP, ENUMERATED PREDICATE — honest about the hybrid:
 *   6b  ranges over the whole registry, but decides with a ten-word vocabulary.
 *       It is a cheap first pass; rule 6e is what makes the guarantee.
 *   6d  same vocabulary, applied to nested keys. Same caveat; 6e backs it up.
 *
 * ENUMERATED — they name one key and check it: 1, 1b, 2, 3, 3b, 3c, 4, 5, 7, 7a,
 * 8b, 9a, 9b, 9c, 9d, 10, 11. This is not fixable by more scanning: their content
 * is the SEMANTICS of one particular key — what `blocks_ship` means for an
 * irreversible phase, what `superseded_evidence` must contain — and semantics do
 * not come from a name. The scan's job is to make sure no key exists that no rule
 * reaches; it is not, and cannot be, a guarantee that every rule was written.
 *
 * A LOOP THAT SCANS CAN STILL DECIDE WITH AN ENUMERATED PREDICATE, and that is how
 * every defeat in rounds 2 and 4 got in: rule 13 ranged over every declared
 * `phaseRef` key while deciding with a pair lookup, and rule 1b ranged over every
 * `derived_from` entry while checking only that it resolved. When adding a rule
 * here, state which column it is in — the middle one is not a failure, but calling
 * a middle-column rule a scan is.
 *
 * Exit 1 on any violation. Read-only; it never edits the gate file.
 *
 * Usage:  node scripts/verify-phase-gates.mjs [--json] [--file <path>]
 *                        [--declare <level>.<key>=<json>]
 *                        [--declare-pattern <level>.<regex-source>=<json>]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A CRASH IS NOT A REPORT, and this validator says so in its exit code.
 *
 * Exit 0 = the file is consistent. Exit 1 = problems were REPORTED. Exit 2 = the
 * test seam was misused. Exit 3 = this validator threw.
 *
 * Without the last one an uncaught throw collapses onto 1 and becomes
 * indistinguishable from a report, which is what forced six mutation sites to be
 * excused as "removing this guard turns a report into a crash, and an exit-code
 * prover cannot tell them apart". That reasoning was wrong: the validator already
 * speaks a distinct-exit-code vocabulary, and nothing was mapping a throw into it.
 * Three lines here mean the prover keeps branching on exit codes ONLY and those six
 * guards become provable.
 */
process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(3);
});

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
  '1b',
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
  '6e',
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
    preconditions: read('1/3/3b/4/7/8/10/11'),
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
    kind: read('1/1b/4/5'),
    derived_from: read('1b'),
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

const PHASE_REF_KEYS = () =>
  Object.entries(KEY_REGISTRY.phase).filter(([, v]) => v.phaseRef !== undefined);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every literal identifier run in a pattern's regex, longest first. */
const patternNames = (re) =>
  (re.source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).sort((a, b) => b.length - a.length);

/**
 * The pattern's readable name — its longest identifier run.
 *
 * Rule 6b tests EVERY run, not just this one. Naming a pattern by its longest run
 * alone let a decorative suffix hide the relation:
 * `^gates_(.+)_supplementary_annotation_text$` declared PROSE passed, because
 * `RELATIONAL_NAME` never saw `gates`, while it matched keys like
 * `gates_5_supplementary_annotation_text`.
 */
const patternName = (re) => patternNames(re)[0] ?? re.source;

// ---------------------------------------------------------------------------
// Rule 6c's binding — RECORDED CONSUMPTION, not a grep.
//
// The previous round bound a declared key by searching this file's own source for
// a property access on that name. That was a textual coincidence, not a binding,
// and review defeated it: fifteen names passed as "bound" with nothing reading
// them, because the source contains `phase[relation]` and `phase[note]` (rule 8c's
// LOCAL VARIABLES, holding 'gates' and 'gates_note') and `entry.inverse` /
// `entry.by` (accesses on REGISTRY entries, not on gate-file data). `relation` and
// `inverse` are the names an author would actually reach for, and neither trips
// `RELATIONAL_NAME` — so round 1's third door was narrowed, not closed.
//
// The gate file is now handed to the rules through a Proxy that records every
// property read AT ITS LEVEL. Only reads on gate-file data can land in the set, so
// a local variable, a registry field or a message template cannot bind anything.
// The scan (`scanKeys`/`scanNested`) and the printer (`render`) deliberately work
// on the RAW object via `unwrap`, because reading a key in order to check that it
// is declared, or in order to print it, is not consuming it.
// ---------------------------------------------------------------------------

/** `<level>.<key>` for every key some rule actually read off the gate file. */
const CONSUMED = new Set();

/** Which child level a key's value belongs to. Anything else is payload. */
const LEVEL_EDGES = {
  gate: { phases: 'phase', admissibility: 'admissibility' },
  admissibility: { conditions: 'condition' },
  phase: { criteria: 'criterion', preconditions: 'criterion' },
};

const RAW = Symbol('raw');
const unwrap = (v) => (v !== null && typeof v === 'object' && v[RAW] ? v[RAW] : v);

/**
 * Wrap gate-file data so reads are recorded.
 *
 * Arrays are wrapped but record nothing: their keys are indices and method names,
 * and recording `map`/`length` would hand a free binding to any key named that.
 * A read of an ABSENT key still records — `phase.blocked_by` is consumed by rule 8
 * whether or not this particular file states it, and requiring the shipped data to
 * exercise a key would make the binding depend on the fixture rather than the code.
 */
function track(value, level) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return new Proxy(value, {
      get: (t, p, r) => (p === RAW ? t : track(Reflect.get(t, p, r), level)),
    });
  }
  return new Proxy(value, {
    get(t, p, r) {
      if (p === RAW) return t;
      if (typeof p !== 'string') return Reflect.get(t, p, r);
      if (level) CONSUMED.add(`${level}.${p}`);
      return track(Reflect.get(t, p, r), LEVEL_EDGES[level]?.[p] ?? null);
    },
  });
}

/**
 * Rules 6b + 6c — the registry audited against ITSELF and against what the rules
 * actually READ, so a bad declaration fails for everyone rather than only when some
 * gate file happens to use the key.
 *
 * Runs AFTER the gate files are verified, because rule 6c's binding is now recorded
 * consumption rather than a grep, and there is nothing to check until the rules have
 * run. Every declared entry — the literal table AND the key patterns — passes through
 * here: auditing only the table left the pattern half live but unreachable by any
 * test, which is the same decoration charge one half over.
 */
function auditRegistry(problems) {
  const entries = [];
  for (const [level, table] of Object.entries(KEY_REGISTRY)) {
    for (const [key, entry] of Object.entries(table)) {
      entries.push({ level, key, name: key, entry, bound: () => CONSUMED.has(`${level}.${key}`) });
    }
  }
  for (const [level, patterns] of Object.entries(KEY_PATTERNS)) {
    for (const { re, entry } of patterns) {
      entries.push({
        level,
        key: re.source,
        name: patternName(re),
        names: patternNames(re),
        entry,
        // A pattern matches many key names, so no single `<level>.<key>` can stand
        // for it — rule 8c drives it from this table via `phaseClaim`, the same
        // generic consumption `phaseRef` gets, and that marker is its binding.
        bound: () => false,
      });
    }
  }

  for (const { level, key, name, names, entry, bound } of entries) {
    // Rule 6b — a relation may not be filed as commentary. EVERY identifier run in
    // a pattern is tested, not only its longest: naming the pattern by the longest
    // run let a decorative suffix hide the relation.
    if (entry.prose) {
      if ((names ?? [name]).some((n) => RELATIONAL_NAME.test(n))) {
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
    // Every other READ must have been READ OFF THE GATE FILE during this run.
    const generic = entry.phaseRef !== undefined || entry.phaseClaim !== undefined;
    if (!generic && !bound()) {
      problems.push(
        `key registry: \`${level}.${key}\` is declared READ but no rule read it off the gate file. READ is not a label — it is a claim that code consumes the key, and an unbound READ is the third door beside "checker" and "prose": name the relation, write no checker, pass.`,
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
      // Rule 13 orients the ordered graph by WHICH SIDE CORROBORATES: the
      // non-corroborating side contributes the forward edge, its inverse
      // contributes none. That only works if exactly one side corroborates — with
      // both, no edge is ever contributed and the graph is empty; with neither,
      // both are, and every valid pair reads as a 2-cycle.
      if (entry.phaseRef === 'ordered' && entry.inverse !== key && inverse) {
        if (!!entry.mustCorroborate === !!inverse.mustCorroborate) {
          problems.push(
            entry.mustCorroborate
              ? `key registry: \`${level}.${key}\` and its inverse \`${entry.inverse}\` both declare \`mustCorroborate\` — exactly one side of an ordered pair must, or neither contributes an edge and rule 13's graph is empty.`
              : `key registry: \`${level}.${key}\` and its inverse \`${entry.inverse}\` — neither declares \`mustCorroborate\` — exactly one side of an ordered pair must, or both contribute an edge and every valid pair reads as a 2-cycle.`,
          );
        }
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

/**
 * Rule 6e — does this VALUE state a cross-phase relation, whatever it is called?
 *
 * `RELATIONAL_NAME` is a ten-word vocabulary, and review walked straight through
 * it: `unblocks_phase`, `follows_phase`, `precedes_phase`, `waits_for_phase`,
 * `prerequisite_phase`, `needs_phase`, `triggers_phase` — thirteen of thirteen
 * synonyms declared PROSE with a value naming a real phase, all exit 0. `unblocks`
 * is not exotic; the shipped file uses `UNBLOCKED_3d_DISCHARGED` as a status, and
 * `(^|_)blocked` cannot match the `blocked` inside `unblocked`.
 *
 * So the guarantee is moved off the name and onto the SHAPE: a value that resolves
 * to declared phase ids IS a phase reference, under any name anyone invents next
 * year. The vocabulary is kept as a cheap first pass, not as the guarantee.
 *
 * Three boundaries, each of which is a deliberate decision and not an oversight:
 *
 *  - An empty array is NOT a reference. "All zero elements resolve" is vacuous, and
 *    treating it as a relation would fail `gates: []`, the shape a discharged gate
 *    is supposed to take.
 *  - A LIST may hold numbers — ids are compared with `String()` here as they are
 *    everywhere else, so `[93]` is caught. A bare SCALAR number is NOT a reference,
 *    and that asymmetry is forced by the data: `samples_lost: 1` and
 *    `server_modules_read_from_disk_on_cold_first_request: 0` both stringify to
 *    declared phase ids. This file is full of measurements; a lone number is one.
 *  - A bare scalar STRING equal to the phase's OWN id is a label, not a relation —
 *    `{ phase: 'wb', name: 'wb' }` states nothing about another phase. The exemption
 *    is scalar-only on purpose: a LIST is a reference list whatever it contains.
 */
const statesPhaseReference = (value, phaseIds, selfId, allowBareNumber) => {
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    return value.every(
      (v) => (typeof v === 'string' || typeof v === 'number') && phaseIds.has(String(v)),
    );
  }
  if (typeof value === 'number') return allowBareNumber && phaseIds.has(String(value));
  if (typeof value !== 'string') return false;
  if (selfId !== undefined && value === String(selfId)) return false;
  return phaseIds.has(value);
};

/**
 * Rule 6e — and the same question asked of an object's KEYS.
 *
 * The closed world was over values only, so a map FROM phase id TO prose sailed
 * through: `attempt: { ordering: { "5": "must finish before this one" } }`.
 * `attempt` is PROSE, `ordering` is not a relational name, and the references are
 * the keys — which nothing inspected.
 */
const statesPhaseKeyMap = (value, phaseIds) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => phaseIds.has(k));
};

/**
 * Rule 6 — every key present must be declared.
 *
 * `raw` MUST be untracked gate data. There is exactly ONE unwrap point, in
 * `verify`, and it is deliberately not repeated here: two of them would each be
 * redundant, so neither could be mutation-killed — the harness proved precisely
 * that, surviving the removal of either while the other stood.
 */
function scanKeys(raw, level, at, problems, phaseIds, selfId) {
  // A bare scalar NUMBER is read as a phase reference everywhere EXCEPT on a
  // criterion. The exemption exists because measurements live on criteria and many
  // of them stringify to declared phase ids (`samples_lost: 1`,
  // `server_modules_read_from_disk_on_cold_first_request: 0`). Nothing on a phase,
  // a gate or an admissibility condition is a measurement, so scoping the exemption
  // to the level that needs it closes `phase 3: follows_phase = 5` rather than
  // leaving it open everywhere for one level's reason.
  const bareNum = level !== 'criterion';
  const table = KEY_REGISTRY[level] ?? {};
  const patterns = KEY_PATTERNS[level] ?? [];
  for (const key of Object.keys(raw)) {
    const entry = table[key] ?? patterns.find((p) => p.re.test(key))?.entry;
    if (!entry) {
      problems.push(
        `${at}: key \`${key}\` is not in the key registry. Every key must be declared READ (naming the rule that consumes it) or PROSE (asserting nothing about other data in this file) — an unread key is how the file came to state relations nothing checked.`,
      );
      continue;
    }
    // Rule 6e — the in-data half that rule 6b's registry audit CANNOT reach: 6b
    // decides from the name alone, and a name is a choice the author makes. This
    // decides from the value, and it needs the data, so it lives here.
    if (entry.prose && statesPhaseReference(raw[key], phaseIds, selfId, bareNum)) {
      problems.push(
        `${at}: key \`${key}\` is declared PROSE but its value resolves to declared phase ids (${JSON.stringify(raw[key])}). That is a cross-phase relation whatever it is named — give it a checker, or rule 6b is escapable by choosing a word its vocabulary does not know.`,
      );
    } else if (entry.prose && statesPhaseKeyMap(raw[key], phaseIds)) {
      // The KEY-map test used to be reachable only from `scanNested`, so the same
      // relation was caught one level down and not at the top: `attempt: { ordering:
      // { "5": … } }` failed while `attempt: { "5": … }` exited 0.
      problems.push(
        `${at}: key \`${key}\` is declared PROSE but its keys resolve to declared phase ids (${Object.keys(raw[key]).join(', ')}) — a relation stated by what it is KEYED BY is still a relation.`,
      );
    }
    if (!STRUCTURAL_KEYS.has(key))
      scanNested(raw[key], `${at} ${key}`, problems, phaseIds, selfId, bareNum);
  }
}

/**
 * Rules 6d + 6e — a relation nested inside a declared key.
 *
 * Rule 6 is a closed world over the five structural levels only; the inside of
 * `evidence` / `attempt` / `blast_radius` is narrative and is not registered
 * key-by-key. That left `criterion.evidence.blocked_by_phase = '99'` passing —
 * the same defect one layer down. This does not close the closed world over
 * nested keys (it does not require them to be declared); it forbids the two things
 * that must not hide there: a relational NAME (6d) and a value that resolves to
 * declared phase ids (6e). Both, because either alone was walked through — 6d's
 * name check misses `unblocks_phase`, and a relational name whose value is prose
 * ("gated_by: the founder") is caught by nothing else.
 */
function reportShape(value, what, at, problems, phaseIds, selfId, bareNum) {
  if (statesPhaseReference(value, phaseIds, selfId, bareNum)) {
    problems.push(
      `${at}: ${what} has a value that resolves to declared phase ids (${JSON.stringify(value)}) — a phase reference buried in a narrative block, which no rule reaches.`,
    );
    return;
  }
  if (statesPhaseKeyMap(value, phaseIds)) {
    problems.push(
      `${at}: ${what} has keys that resolve to declared phase ids (${Object.keys(value).join(', ')}) — a relation stated by what it is KEYED BY is still a relation, and no rule reaches it here.`,
    );
  }
}

function scanNested(value, at, problems, phaseIds, selfId, bareNum) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      // An element that is ITSELF a list or a map is a reference the object-key
      // branch below never sees, because it has no key. One array bracket was the
      // whole hole — `attempt: [["5","3"]]` exited 0 while `["5","3"]` failed — and
      // it was live code with no test: deleting the array recursion left the suite
      // green. Scalar elements are deliberately NOT tested here: the list they sit
      // in is judged as a whole, and testing them individually would report every
      // legitimate `concurrent_with: ["2"]` entry.
      if (v !== null && typeof v === 'object') {
        reportShape(v, `element [${i}]`, at, problems, phaseIds, selfId, bareNum);
      }
      scanNested(v, `${at}[${i}]`, problems, phaseIds, selfId, bareNum);
    });
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (RELATIONAL_NAME.test(key)) {
      problems.push(
        `${at}: nested key \`${key}\` has a relational name. A relation must be stated at a level a checker can reach — buried inside a narrative block, nothing reads it, which is #753 with one more layer of nesting.`,
      );
    } else {
      reportShape(v, `nested key \`${key}\``, at, problems, phaseIds, selfId, bareNum);
    }
    scanNested(v, `${at}.${key}`, problems, phaseIds, selfId, bareNum);
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

/**
 * Every condition a phase must satisfy — its PRECONDITIONS as well as its criteria.
 *
 * The status rules used to read `phase.criteria` alone, which made rules 3, 7a and
 * 8 restatable one field over: a strictly DONE phase whose only PRECONDITION was
 * measured false against a target of true exited 0, and so did `NOT_STARTED` with a
 * measured precondition — the phase-3d shape that caused the duplicated work, in a
 * field the rule could not see.
 */
const conditionsOf = (phase) => [...(phase.preconditions ?? []), ...(phase.criteria ?? [])];

/**
 * Every distinct cycle in the ordered-relation graph, as a list of `{from, via}`
 * steps. Iterative DFS with a grey/black colouring; a grey hit is a back edge, and
 * the cycle is the path from that node onward. Cycles are keyed by their sorted
 * node set so one cycle is reported once, not once per entry point.
 */
function findOrderedCycles(edges) {
  const found = new Map();
  const colour = new Map(); // node -> 'grey' | 'black'
  const path = [];

  const walk = (node) => {
    colour.set(node, 'grey');
    for (const [next, via] of edges.get(node) ?? []) {
      path.push({ from: node, via });
      if (colour.get(next) === 'grey') {
        const start = path.findIndex((s) => s.from === next);
        const cycle = path.slice(start);
        const key = [...new Set(cycle.map((s) => s.from))].sort().join('|');
        if (!found.has(key)) found.set(key, cycle);
      } else if (!colour.has(next)) {
        walk(next);
      }
      path.pop();
    }
    colour.set(node, 'black');
  };

  for (const node of edges.keys()) if (!colour.has(node)) walk(node);
  return [...found.values()];
}

/**
 * The shortest ordered path `from → … → to`, or null if `to` is not reachable.
 *
 * Rule 13 asks the graph TWO questions, and until round 4 it only walked for one of
 * them. Acyclicity was a walk; ordered-vs-unordered was still a lookup on a sorted
 * PAIR, so `ta gates tb`, `tb gates tc`, `ta concurrent_with tc` exited 0 while the
 * direct pair failed. Path length was the enumeration, exactly as cycle length had
 * been one round earlier.
 */
function orderedPath(edges, from, to) {
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const next of (edges.get(node) ?? new Map()).keys()) {
      if (prev.has(next)) continue;
      prev.set(next, node);
      if (next === to) {
        const path = [to];
        for (let n = node; n !== null; n = prev.get(n)) path.unshift(n);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/** Rule 3 — a DONE phase must actually be done. */
function checkDone(phase, at, problems) {
  const unmet = conditionsOf(phase).filter((c) => !meetsTarget(c));
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
  const measured = conditionsOf(phase).filter(isMeasured);
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
  const criteria = conditionsOf(phase);
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

  // Rule 6 runs on the RAW file, deliberately. Reading a key in order to check that
  // it is DECLARED is not consuming it, and if the scan's reads counted, every key
  // in the registry would bind itself the moment it appeared in any gate file —
  // which is the coincidence rule 6c exists to stop being a binding.
  const raw = unwrap(gate);
  const phaseIds = new Set((raw.phases ?? []).map((p) => String(p.phase)));

  scanKeys(raw, 'gate', label, problems, phaseIds);
  if (raw.admissibility && typeof raw.admissibility === 'object') {
    scanKeys(raw.admissibility, 'admissibility', `${label} admissibility`, problems, phaseIds);
    for (const cond of raw.admissibility.conditions ?? []) {
      scanKeys(cond, 'condition', `${label} admissibility ${cond.id}`, problems, phaseIds);
    }
  }
  for (const p of raw.phases ?? []) {
    // `selfId` lets rule 6e tell a LABEL from a RELATION: a scalar equal to the
    // phase's own id (`{ phase: 'wb', name: 'wb' }`) states nothing about another
    // phase, and flagging it cost the round-4 reviewer a fixture.
    const selfId = String(p.phase);
    scanKeys(p, 'phase', `${label} phase ${p.phase}`, problems, phaseIds, selfId);
    for (const c of [...(p.preconditions ?? []), ...(p.criteria ?? [])]) {
      scanKeys(c, 'criterion', `${label} phase ${p.phase} ${c.id}`, problems, phaseIds, selfId);
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
  const criterionIds = new Set(seenCrit.keys());
  const measuredCriterionIds = new Set(
    (raw.phases ?? []).flatMap((p) =>
      [...(p.preconditions ?? []), ...(p.criteria ?? [])].filter(isMeasured).map((c) => c.id),
    ),
  );

  const byId = new Map(gate.phases.map((p) => [String(p.phase), p]));
  const admissible = new Set((gate.admissibility?.conditions ?? []).map((c) => c.id));
  const gatersOf = (id) =>
    gate.phases
      .filter((p) => (p.gates ?? []).map(String).includes(String(id)))
      .map((p) => String(p.phase));
  const ctx = { byId, gatersOf };

  // Rule 13 — every pair some key declares UNORDERED, collected as the phaseRef
  // loop runs, so the contradiction below is derived from the registry rather than
  // from an intersection of two named fields.
  const concurrentPairs = new Map();

  // Rule 1b — `derived_from` as a DIRECTED GRAPH, walked by the same
  // `findOrderedCycles` rule 13 uses. A measured `derived` value whose provenance
  // leads back to itself has no provenance, at any path length.
  const derivedEdges = new Map();

  // Rule 13 — and the ORDERED relation as a DIRECTED GRAPH, not a bag of pairs.
  // Round 2 defeated the pair form: a `gates` cycle of length 3 (xa→xb→xc→xa)
  // exited 0, because the only ordering check was "does this pair point both
  // ways". Cycle length was the enumeration, and length 3 was the second case.
  const edges = new Map();

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

      // Rule 9b — evidence blocks are only meaningful on a measured criterion.
      if (c.evidence && !isMeasured(c)) {
        problems.push(`${at}: carries \`evidence\` but is unmeasured — evidence for what?`);
      }

      // Rule 1b — `derived` is exempt from rule 1's source requirement, and that
      // exemption was a one-keystroke escape from the file's HEADLINE rule: relabel
      // a criterion `kind: "derived"` and a measured value with no provenance exits
      // 0. The same rename shape as rule 3's `DONE_*`, on the rule the file exists
      // for. A derived value must now say what it is derived FROM, and those must
      // be declared criteria — which turns the exemption into a checkable relation.
      const derivedFrom = c.derived_from;
      if (c.kind === 'derived' && isMeasured(c)) {
        if (!Array.isArray(derivedFrom) || derivedFrom.length === 0) {
          problems.push(
            `${at}: \`kind: "derived"\` with a measured value and no \`derived_from\`. Derived is an exemption from rule 1's source requirement, so it must name the criteria it is computed from, or it is a number with no provenance wearing a label.`,
          );
        } else {
          // The SAME degeneracy checks rule 8 makes for phase references. Rule 1b
          // checked resolution and nothing else, so it reproduced the exact hole it
          // was written to close: `derived_from: ['P2-1']` on P2-1 is a measured
          // number whose entire provenance is ITSELF — rule 1's "number with no
          // provenance" wearing rule 1b's label — and a source nobody has run is
          // provenance that resolves to an absence.
          const seenSrc = new Set();
          for (const src of derivedFrom) {
            const s = String(src);
            // The provenance edge, for the cycle walk after this loop. Self-reference
            // is its length-1 case and has no branch of its own: round 5 closed
            // length 1 by hand and left length 2 open, which is the third time the
            // direct case was mistaken for the guarantee.
            const from = derivedEdges.get(String(c.id)) ?? new Map();
            derivedEdges.set(String(c.id), from);
            if (!from.has(s)) from.set(s, `${c.id}.derived_from`);
            if (!measuredCriterionIds.has(s) && criterionIds.has(s) && s !== String(c.id)) {
              problems.push(
                `${at}: \`derived_from\` names \`${s}\`, which is not measured — derived from something nobody has run`,
              );
            } else if (!criterionIds.has(s)) {
              problems.push(
                `${at}: \`derived_from\` names \`${s}\`, which is not a declared criterion id`,
              );
            }
            if (seenSrc.has(s)) problems.push(`${at}: \`derived_from\` lists \`${s}\` twice`);
            seenSrc.add(s);
          }
        }
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

        const self = String(phase.phase);

        // Rule 13 — record an UNORDERED pair. Only unordered: the ordered relation
        // is consulted as a graph below, not as a bag of pairs.
        if (entry.phaseRef === 'unordered') {
          const [a, b] = [self, r].sort();
          const rec = concurrentPairs.get(`${a} ↔ ${b}`) ?? { a, b, via: [] };
          rec.via.push(`${phase.phase}.${key}`);
          concurrentPairs.set(`${a} ↔ ${b}`, rec);
        }

        // ...and an ORDERED key contributes a DIRECTED edge `phase → ref`: it says
        // this phase comes first. Its inverse states the mirror of the same fact and
        // is required to corroborate it, so the corroborating side contributes
        // NOTHING — the edge is already there, and a second one would point the
        // other way and read every valid pair as a 2-cycle. `auditRegistry` requires
        // exactly one side of an ordered pair to corroborate, which is what makes
        // "the non-corroborating side is the forward one" a checked fact rather than
        // a convention. (An `edge: forward|reverse` field used to declare this. It
        // was DECORATION: `blocked_by` corroborates, so its reverse edge could only
        // ever differ on a file corroboration had already reported, and deleting the
        // reverse contribution outright left every test and contradiction green.)
        if (entry.phaseRef === 'ordered' && !entry.mustCorroborate) {
          const outbound = edges.get(self) ?? new Map();
          edges.set(self, outbound);
          if (!outbound.has(r)) outbound.set(r, `${phase.phase}.${key}`);
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
      const ran = conditionsOf(target).filter(isMeasured);
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
    // There is deliberately NO "declares `blocked_by` while not in a blocked state"
    // branch here. It read the same `blockable` flag as rule 8's gater check, so a
    // corroborated `blocked_by` on a non-blockable phase was always ALSO reported by
    // the gater side, and an uncorroborated one always ALSO by corroboration: three
    // problems in both cases, never one. A branch that can never be the sole
    // reporter is decoration by this repo's own standard — the same argument that
    // deleted `edge: 'reverse'` — and it is deleted rather than given a test that
    // could only ever pass for another rule's reason.

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

  // Rule 13 — a pair declared UNORDERED may not be connected by the ordered
  // relation, in either direction, AT ANY PATH LENGTH. Reachability, not a pair
  // lookup: "ta comes before tb, tb before tc" says ta comes before tc just as
  // plainly as a direct edge would, and the file cannot also say they are concurrent.
  for (const { a, b, via } of concurrentPairs.values()) {
    const path = orderedPath(edges, a, b) ?? orderedPath(edges, b, a);
    if (!path) continue;
    problems.push(
      `${label}: phases ${a} ↔ ${b} are declared concurrent by ${via.join(', ')} while the ordered relation makes ${path[path.length - 1]} reachable from ${path[0]} (${path.join(' → ')}) — one of the two is false`,
    );
  }

  // Rule 13 — and the ordered relation must be ACYCLIC. Every phase on a cycle
  // must complete before itself, so none of them can ever start. This walks the
  // graph rather than inspecting pairs: length 2 was the only case the previous
  // round caught, and by this file's own argument — an enumerated list of cases is
  // how the second one gets missed — cycle length was the enumeration.
  for (const cycle of findOrderedCycles(edges)) {
    problems.push(
      `${label}: the ordered relation contains a cycle — ${cycle.map((s) => s.via).join(', ')} assert ${cycle.map((s) => s.from).join(' → ')} → ${cycle[0].from}. Every phase on it must complete before itself, so none of them can start.`,
    );
  }

  // Rule 1b — circular provenance, at any length.
  for (const cycle of findOrderedCycles(derivedEdges)) {
    problems.push(
      `${label}: \`derived_from\` is circular — ${cycle.map((step) => step.from).join(' -> ')} -> ${cycle[0].from}. A measured value whose provenance leads back to itself has none, which is exactly what rule 1 forbids.`,
    );
  }

  // Rule 9c — while a ship blocker is open, the irreversible phase is not done.
  const openShipBlockers = gate.phases.flatMap((p) =>
    [...(p.preconditions ?? []), ...(p.criteria ?? [])]
      .filter((c) => c.blocks_ship === true && !meetsTarget(c))
      .map((c) => c.id),
  );
  // `reversible` is read for EVERY phase, not only when a blocker is open. Rule 6c
  // binds a declared key to the rules having actually read it, so a read hidden
  // behind a condition the fixture happens not to meet would make the binding a
  // property of the data rather than of the code.
  for (const p of gate.phases) {
    const irreversible = p.reversible === false;
    if (openShipBlockers.length > 0 && irreversible && String(p.status).startsWith('DONE')) {
      problems.push(
        `${label} phase ${p.phase}: is irreversible and ${p.status} while ${openShipBlockers.length} \`blocks_ship\` criterion/criteria are unmet (${openShipBlockers.join(', ')})`,
      );
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
          : // `JSON.stringify(undefined)` is the VALUE `undefined`, not a string, and an
            // absent `measured` key is how a criterion says "nobody has run it" by
            // omission. Slicing that threw — the printer crashed on data every other
            // rule handles.
            String(JSON.stringify(c.measured));
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

// `--declare <level>.<key>=<json>` and `--declare-pattern <level>.<regex>=<json>`
// inject ONE registry entry for this process. Rules 6b and 6c live in
// `auditRegistry`, so without a seam their only reachable input is the committed
// registry — and a guard whose failing case cannot be constructed is a guard with
// no test. The pattern form exists because the table form could not reach the
// KEY_PATTERNS half of the audit, which left live code that no test could red.
//
// The refusal is scoped to the REAL GATE FILES, not merely to the absence of
// `--file`. The previous wording claimed the seam "can never loosen rule 6 for the
// file it exists to protect", and that was false: naming the real path reached it.
// `realpathSync`, not `resolve`: the comparison is about WHICH FILE, and a path
// string is not a file. A symlink pointing at the shipped gate file reached it with
// a loosened registry while the refusal below claimed to be absolute.
// Identity by (device, inode), not by path string and not by realpath. A SYMLINK is
// a second path to the file and `realpathSync` collapses it; a HARD LINK is not a
// path at all, it is the same inode under another name, and realpath cannot see
// that. Round 4 narrowed this from "path string" to "realpath" and the claim was
// still one indirection too wide.
const fileIdentity = (f) => {
  try {
    const st = statSync(f);
    return `${st.dev}:${st.ino}`;
  } catch {
    return `path:${resolve(f)}`;
  }
};
const gateDirFiles = new Set(
  readdirSync(GATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => fileIdentity(join(GATE_DIR, f))),
);
const seamRefused = files.some((f) => gateDirFiles.has(fileIdentity(f)));

for (let i = 0; i < process.argv.length; i += 1) {
  const isPattern = process.argv[i] === '--declare-pattern';
  if (!isPattern && process.argv[i] !== '--declare') continue;
  if (seamRefused) {
    console.error(
      `${process.argv[i]} is a test seam and may not be used against a real gate file in ${GATE_DIR}; refusing to alter the registry.`,
    );
    process.exit(2);
  }
  const spec = process.argv[i + 1] ?? '';
  const m = /^([A-Za-z_]+)\.([^=]+)=(.*)$/s.exec(spec);
  if (!m) {
    console.error(`${process.argv[i]} expects <level>.<key>=<json>, got \`${spec}\``);
    process.exit(2);
  }
  if (isPattern) {
    const list = KEY_PATTERNS[m[1]] ?? [];
    KEY_PATTERNS[m[1]] = list;
    list.push({ re: new RegExp(m[2]), entry: JSON.parse(m[3]) });
  } else {
    const level = KEY_REGISTRY[m[1]] ?? {};
    KEY_REGISTRY[m[1]] = level;
    level[m[2]] = JSON.parse(m[3]);
  }
}

for (const f of files) {
  const gate = JSON.parse(readFileSync(f, 'utf8'));
  // The rules see a TRACKED copy so rule 6c can bind on what they actually read;
  // the printer sees the raw object, because printing a key is not consuming it.
  verify(track(gate, 'gate'), problems);
  all.push({ gate, rows: render(gate) });
}

// AFTER the gate files: rule 6c's binding is recorded consumption, so there is
// nothing to audit until the rules have run.
auditRegistry(problems);

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
