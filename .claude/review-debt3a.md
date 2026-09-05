# ISSUES_FOUND

Adversarial review of `fix/gate-file-unread-relations` @ `f10bb76` vs `origin/main`
(worktree `/Users/banna/alpheya/pocs/knext-wt/gate-relations`). Every claim below was run, not read.

---

## Verdict in one line

Rule 6's closed-world scan over **undeclared** keys is genuine and generative. The relational-semantics
layer built on top of it (7/8/8b/8c/9a/9c/9d/10/11) is **enumeration**, and I defeated it with two new
contradictions built entirely from registered keys. Worse, rule 6's own headline guarantee has a
one-line bypass that **the shipped tree already exercises**, and rule 6b — the guard that is supposed to
close that bypass — is **decoration**: I deleted all three of its halves and the suite stayed green.

---

## Blocking

### B1 — `read('<any label>')` is a third door; rule 6's stated guarantee is false

Rule 6 claims (docblock :56, report §2): *"a new relational field cannot enter the JSON without either a
checker or an explicit, reviewable 'this asserts nothing'."* There is a third option, and it is the
**easiest** one because it avoids the 6b tripwire entirely — label it `read(...)` and write no checker.

Demonstrated on a copy of the committed script:

```
registry:  phase.requires_phase: read('8')        // relationally named, no consumer
data:      phase 5  requires_phase: ["99","99","5"]
result:    exit 0 — no problems reported
```

That reference is unresolved (`99` is not a phase), duplicated, **and** self-referential. Rule 6b does
not fire (it only forbids `prose`). Rule 8 does not see it (`PHASE_REF_KEYS` filters on `phaseRef: true`,
which the entry simply omits). Nothing else reads it. This is #753's defect class, reachable in one line.

It is not hypothetical: **`scripts/verify-phase-gates.mjs:190` ships `evidence: read('12')`, and there is
no rule 12** — not in the docblock, not in the code, not in the tests (`grep -n "12" ` over all three
files returns that one line). The registry's READ side is a self-reported label that nothing validates,
and an unvalidated label already slipped past authorship and review inside this very PR.

**Fix:** declare a `RULE_IDS` set and make `read(by)` fail at startup when `by` is not in it; and require
a `RELATIONAL_NAME` key to be *bound* to a consumer (`phaseRef: true`, or an explicit consumer flag), not
merely labelled. Both are startup-time checks in `auditRegistry`, a few lines each.

### B2 — Rule 6b is untested, and its mutation kill is confounded

Independent mutation run (exit-code branched, anchor asserted exactly once with abort, restore verified
byte-identical, baseline proven green first):

```
baseline ................................................. GREEN
SURVIVED  auditRegistry (the startup half) is a no-op
SURVIVED  the in-data half of 6b never fires (rule 6 left intact)
SURVIVED  RELATIONAL_NAME matches nothing (BOTH halves of 6b dead)
KILLED    CONTROL: rule 7a deleted   <- the harness can see red
```

By this repo's own standard — *"a guard that stays green when its subject is removed is decoration"* —
rule 6b is decoration. **No test covers it**; `grep -n "6b\|RELATIONAL\|auditRegistry\|declared PROSE"`
over `tests/verify-phase-gates.test.ts` returns nothing.

The report's harness case `rule 6b — registry self-audit` mutates the registry **data**
(`concurrent_with: read('8', {phaseRef:true})` → `prose('who cares')`), not the rule. I ran that exact
mutation and captured which tests fell:

```
× the shipped gate file passes
× rule 4 exempts derived criteria, and that exemption is deliberate
× rule 8: concurrent_with naming an undeclared phase fails
```

Three tests, none of them about 6b — the kill came from removing `concurrent_with` from `PHASE_REF_KEYS`.
This is precisely the confound §3 of the report identifies and applies to its *tests* ("a fixture built
to break rule N can be certified by rule M firing") — but not to its *harness*. The 28/28 headline
therefore overstates by one: **27 proven, 1 confounded.**

**Fix:** add a test asserting a relationally-named key declared `prose(...)` fails with the 6b message
(needs a seam — export `auditRegistry`, or a `--registry-override`), and re-anchor the harness case on
6b's code rather than on registry data.

---

## Attack 1 — SCAN vs ENUMERATION: two NEW contradictions, neither in R1–R13

Both use only registered keys, so rule 6 is satisfied. Both pass, exit 0.

**N1 — `gates` and `concurrent_with` may name the same phase.** Phase 3 with `gates: ['5']` **and**
`concurrent_with: ['5']`: "5 is blocked by 3" and "3 runs alongside 5" cannot both hold. Rule 8 validates
each phaseRef list *independently*; nothing intersects them. The report explicitly scopes `concurrent_with`
to "reference resolution only" (§1), so this contradiction is outside the R-list by construction. One line
to close.

**N2 — rule 8c's discharge check accepts *any* `gates_note`, so the prose still outlives the relation.**
Adding `why_it_gated_phase_5` to phase `3d` passes, because 3d carries a `gates_note` — about phase **1**.
The check is `!gates.includes(target) && !phase.gates_note`, so any note discharges any claim. This is a
fresh instance of the exact "prose outliving the relation" defect 8c was written to close, reachable in
the real file's current shape. Fix: require the note to name the phase.

Also passing, lower severity:

- **N3** `current_phase` may name a **gated** phase (`phase 3 gates 5` + `current_phase: 5` → exit 0).
  Rule 3b checks preconditions only, and phase 5 has none.
- **N4** rule 9a is a half-guard: `done_on` on a non-DONE phase fails, but a `DONE*` phase with **no**
  `done_on` passes — phase `3d` is in that state today. Given this repo's guards-must-assert-both-halves
  record, state the asymmetry as deliberate in the docblock or close it.

**Honest scoring:** this is *not* purely the signature defect wearing a fix's clothes. Rule 6 genuinely
generalises over "someone adds a key nobody declared" — I could not defeat that at the scanned levels,
and it is properly tested at all three. It does **not** generalise over "someone states a relation nobody
checks," which is #753's actual title. B1 + N1 + N2 are that gap.

---

## Attack 2 — the "declared PROSE" carve-out: yes, a real contradiction hides there

- `$comment: "Phase 5 gates phase 1: phase 1 MUST NOT begin until phase 5 is DONE."` → **exit 0**, while
  phase 1 reads `UNBLOCKED_3d_DISCHARGED` and has measured all three criteria.
- `criterion.note: "This criterion gates phase 1 and blocks its UNBLOCKED status."` → **exit 0**.

Both are disclosed in report §6 ("closed world over keys, not over values"), so they are an acknowledged
limit rather than a hidden defect, and I do not block on them.

**But the docblock overclaims and §6 does not cover this variant:** line 56 says *"Every key at every
level must be declared"*. Only five levels are scanned (`gate`, `admissibility`, `condition`, `phase`,
`criterion`). Nested objects under a registered key are **not** scanned at all —
`criterion.evidence.blocked_by_phase = '99'` → **exit 0**. A relationally-*named*, undeclared key inside
`evidence` / `blast_radius` / `attempt` sails through the scan the docblock says covers it. Either recurse
or narrow the sentence.

---

## Attack 3 — mutations re-run independently

Their harness (`.claude/mutate-gate-rules.mjs`) reproduces exactly: baseline GREEN, **28/28 killed, 0
survived**. Its discipline is real, not claimed — exit-code branching, exactly-once anchor assertion with
abort, byte-identical restore verification, and a must-be-green baseline. The anchor-abort fired on my own
first run (a 4-space anchor matched a 6-space line as a substring), which is the guard working.

My own mutations are in B2. Worktree verified clean afterwards: `git status --porcelain` shows only the
two intended untracked `.claude/` files; `grep -n "if (false\|if (1) return\|zzzz_no_such"` over both
changed source files → no residue.

## Attack 4 — was any existing rule weakened? No.

`git diff origin/main...HEAD` removed-lines-only over the validator shows **nothing but** rule 3's three
branches relocated verbatim into `checkDone`, plus the `byId` hoist. Rules 1, 4, 5, 3b, `meetsTarget`,
`isMeasured` and the evidence check are byte-identical. One behavioural change, and it is a
**strengthening**: main guarded rule 3 with `typeof phase.status === 'string'` and silently skipped a
non-string status; `classOf` now returns `[]` for one and rule 7 fails it.

## Attack 5 — the second live instance is genuine, and the fix closes it

`git show origin/main:docs/adr/gates/adr-0042-gates.json` — phase 2: `status: "NOT_STARTED"`,
`status_note` **absent**, `P2-4 measured: false, source: apps/file-manager/scripts/compat-smoke.mjs:48`.
Live on main before any edit; not an artifact.

Running the branch's committed validator against **main's untouched JSON** yields exactly one problem:

```
ADR-0042 phase 2: status NOT_STARTED but 1 criteria/criterion already measured (P2-4). …
```

The data edit is minimal and honest: `status` + `status_note` + a `$comment` paragraph. No measurement,
target, source or evidence value moved. Report §0 states the AC deviation plainly rather than burying it —
correct handling.

## Attack 6 — suite and lint

- `npx vitest run tests/verify-phase-gates.test.ts` → **40 passed**, exit 0.
- `npx biome check --diagnostic-level=error` on all three changed files → exit 0, clean.
- `node scripts/verify-phase-gates.mjs` (real gate dir) → exit 0.

I did not re-derive the full-suite baseline; report §5's arithmetic (30 pre-existing + 5 gpg = 35) is
internally consistent and the 13 build-artifact failures are a known unbuilt-worktree condition.

---

## What must change before this merges

1. **B1** — validate `read(by)` against a declared rule-id set, and require relationally-named keys to be
   bound to a consumer rather than labelled. Fix `evidence: read('12')` while there.
2. **B2** — give rule 6b a test, and re-anchor its mutation case on the rule instead of the registry data.
   Correct the report's 28/28 to 27 proven + 1 confounded.
3. **N2** — tie 8c's discharge to a `gates_note` that names the phase.
4. **N1** — intersect `gates` with `concurrent_with`.
5. Narrow the "every key at every level" sentence at :56, or recurse into nested objects.

N3 and N4 are optional; if left, say so in the docblock rather than leaving them silent.
