# ADR-0007 Amendment 5 (DRAFT): the 14-night compat window — what it measures, what restarts it, and which axis it certifies

- **Status:** **DRAFT.** Proposed 2026-09-05. Acceptance is the maintainer's; nothing in this
  document is in force until its status line says `Accepted`.
- **Amends:** ADR-0007 (the official-suite compat gate) and, where stated, ADR-0039 (the freeze
  scope). It does **not** reverse either.
- **Depends on measurement:** `docs/benchmarks/compat-window-ledger-measurement.md` (the full run
  ledger, 44 retained runs) and `docs/benchmarks/core-build-bimodality.md` (the mechanism). Both
  are decision-free measurements taken specifically so this amendment could be written against
  numbers rather than assumptions.
- **Governs:** the hard rule "gate every parity claim on the official compatibility suite"
  (`CLAUDE.md` §10) and the v1.0 release gate in `docs/V1_ROADMAP.md` §3.

---

## Context

v1.0 is gated on **14 consecutive scheduled runs of the official Next.js compatibility suite,
green, with nothing in the frozen set changing**. ADR-0039 defined the frozen set (harness +
every packed `@getknext/*` tarball, hashed by extracted contents) and made each night's identity
recordable. What ADR-0039 did **not** record is whether that window is *reachable*, or what
exactly a completed window would entitle the project to claim. Three facts, all measured in the
last week, settle both questions — and neither answer is the comfortable one.

### Fact 1 — the anchor is already content-based; the remedy originally proposed is moot

The fingerprint has never hashed tarball bytes. `scripts/compat-window-fingerprint.mjs` extracts
each tarball and digests `path + executable bit + sha256(content)` per file, deliberately, because
gzip embeds an mtime. Three independent packs — one of them after a full clean rebuild — produce
the identical packed digest. A durable both-halves regression test now pins this (two
byte-different tarballs, one digest, with a mutation prover).

So "re-anchor the fingerprint on content" was already the state of the code. The open question was
never the anchor's *kind*; it is the anchor's *stability*.

### Fact 2 — the window is unreachable, and a merge freeze does not fix it

`main` did not move for nine consecutive scheduled nights (2026-08-27 → 2026-09-04): same commit,
same runner image, same Node toolcache, same frozen lockfile, same (never-modified) fingerprint
script. The packed digest nonetheless **alternated between exactly two values, flipping 4 times in
8 transitions.**

Over the full retained history the picture is the same shape: 38 fingerprinted nights, 37
transitions, **17 restarts (46 % of transitions)**, longest streak ever **7**, standing today
**2 of 14**. Five of the 17 restarts (29 %) had **no source change of any kind** behind them.

At the measured frozen-commit flip rate, the chance of the 13 consecutive stable transitions a
14-night window requires is on the order of **1 in 8,000 — with nothing merging at all.** This is
not a scheduling problem that a branch freeze or better discipline can solve. As specified, the
window cannot be completed.

It is worth being equally clear about what is *not* wrong: **the suite passes.** Across all 38
fingerprinted nights the summed shard failure count is **zero**, with zero re-runs in 44 of 44
retained ledgers. The single non-green night is a missing shard summary (evidence
incompleteness), already fixed. The obstacle to the credential is the anchor's instability, not
the adapter's correctness.

### Fact 3 — the instability is semantically empty, and its mechanism is now known

The flip was traced to a single file: the packed `package.json` of `@getknext/core`. The built
output is deterministic — ten clean rebuilds produce a byte-identical `dist/`. The nondeterminism
is introduced at **pack time**: the package manager rewrites `workspace:` dependency ranges
concurrently and re-inserts them into the `dependencies` object in *promise-completion* order.
Each workspace dependency performs filesystem I/O to resolve the real version, so the two
workspace deps of `@getknext/core` complete in a racy order — two orderings, roughly 50/50, one
bimodal digest. The sibling packages corroborate the mechanism by construction: `@getknext/lib`
has zero workspace deps and is byte-stable; `@getknext/db` has one and is byte-stable.

The difference between the two variants is the **order of two keys in a JSON object**. It has no
meaning to npm, to any resolver, or to any consumer. Every byte of shipped code is identical. The
window is being reset by a fact about JSON serialization.

### What changed underneath the window

ADR-0048 removed the node-standalone target from user selection. The nightly window runs on the
**node axis**. A completed node-axis window would therefore certify an artifact **no user can
select**, while the axis users do get — the compiled single-executable path — has published
**zero** compat runs to date. Amending the restart rule without stating this would produce a
technically correct window backing a materially misleading claim.

---

## Decision

Three sub-decisions, deliberately separated: two are settled by the measurements above, and the
third is a judgement about what may be claimed once they land.

### Sub-decision 1 — the window's claim is scoped per axis, and this is honesty, not reachability

**Decision:** a compat window is **scoped to the build/runtime axis that produced it**, named
explicitly wherever it is cited. A node-axis window may not back a v1.0 claim, a compatibility
matrix row, or any public parity statement about the shipped compiled path. Each axis carries its
own window, and an axis with no published runs has **no** window — not an inherited one.

**Say plainly what this buys, because the measurement is unflattering.** Under the lane reading of
"axis", per-axis scoping avoids **0 of 17 restarts (0 %)**. Every measured restart is a
fingerprint change on the node lane itself; scoping the *claim* per axis changes what a window
certifies, never when it restarts. This sub-decision contributes **nothing** to reachability, and
presenting it as part of the fix would be a misrepresentation.

What it buys instead is that the credential means what it says. The project's north star is
verified-adapter status, and the hard rule is that unverified parity is not "done". A window that
certifies an unselectable target, cited without its axis, is precisely the unverified-parity claim
that rule forbids — the more so once the window is finally reachable and the temptation to cite it
broadly arrives.

**One trap to close explicitly.** The word "axis" has a second, tempting reading: a separate clock
per *fingerprint component* (harness / packed). Under that reading a harness-only clock avoids
12 of 17 restarts (71 %) and stands at 15 nights **today** — already past 14. That is a
reachability remedy wearing this sub-decision's vocabulary, and adopting it here would smuggle a
substantial weakening of the guarantee in under a word. Per-component clocks are considered, and
rejected, in sub-decision 3 where they belong.

### Sub-decision 2 — canonicalize the packed manifest inside the fingerprint

**Decision:** before digesting, the fingerprint **canonicalizes the packed `package.json` of each
package** — parse, sort object keys deterministically at every level, re-serialize in a fixed
form, hash that. Every other file in the packed tree continues to be hashed **byte-for-byte**,
including its executable bit, exactly as today.

The canonicalization is narrow by construction and must stay so:

- it applies to the packed `package.json` **only** — not to other JSON files, not to any file
  under `dist/`;
- it normalizes **key order** only. Any change to a key, a value, a dependency range, a version, a
  script, or the `files` allowlist changes the digest, as it must;
- it does not touch the packed **file set** or file modes. A file appearing, vanishing, or losing
  `+x` still restarts the window.

**Recommended over the alternatives** (full table below) because the fingerprint is ours: the
change is local, deterministic, testable, and mutation-provable, and it does not alter a single
byte of what is shipped or installed. The competing fixes all locate the remedy in a third party's
internal behaviour or in the artifact under test — a worse place for a correctness anchor to live.

**Both halves must be proved, and the second half is the one that matters.** The regression test
must show (a) two manifests differing only in dependency **key order** produce the **same** digest,
and (b) two manifests differing in a dependency **version** produce **different** digests. A
canonicalizer that flattens (b) has not stabilized the anchor; it has removed it. Each half gets a
mutation prover that fails when the behaviour it protects is deleted.

**What this does not establish.** Canonicalization removes the one mechanism that has been
*identified*. It does not prove the pack and build are otherwise deterministic. One measured
restart (2026-08-19) moved the packed digest with zero packed inputs and zero harness inputs
touched; it is *consistent* with the same mechanism but was not reproduced, and the artifacts
needed to confirm it have expired. The correct posture after this lands is therefore **observe,
then claim** — see sub-decision 3.

### Sub-decision 3 — restart semantics stay as they are, and the clock starts at zero

**Decision, in three parts.**

**(a) The restart rule is unchanged.** Any change inside the frozen set restarts the 14 nights, as
ADR-0039 states. The window is **not** narrowed to a per-component clock and **not** reshaped to
"14 of N" or a rolling count. With sub-decision 2 in place the anchor's known instability is gone,
which removes the justification for weakening the rule: the rule was never the defect.

**(b) The clock starts at zero when canonicalization lands, and no prior night is credited.**
Changing how the fingerprint is computed changes what the digest means; nights recorded under the
old definition are not comparable to nights recorded under the new one. Day 1 is the first
scheduled night after the change merges.

**(c) No streak is credited retroactively by redefining the axis.** The ledger shows two models
that already stand at ≥14 today — a harness-only clock at 15, and a green-only clock (fingerprint
recorded but never fatal) at 32. Adopting either **now**, after the fact, would produce a "14
consecutive nights" claim assembled from nights the current rule never certified. In the
harness-only case those 15 nights contain **12 packed-component restarts** — nights that installed
materially different shipped bytes into the fixtures. A streak redefined backwards until it
reaches the target is exactly the unverified parity the hard rules forbid claiming, and it would
not survive the first outside reviewer who read the ledger. **Reject it.**

**Where the clock stands once (b) lands.** At zero, with 14 nights to run. Honest reachability
after that: the residual restart drivers are genuine shipping activity into the frozen set (7 of
17 restarts were merge-attributable, an upper bound) plus one unexplained flip. Fourteen
consecutive nights therefore still requires roughly two weeks in which nothing lands in the
harness or in `packages/{kn-next,lib,db}`. That is a **schedulable** requirement rather than an
impossible one — which is the whole gain from sub-decision 2 — but it does not happen by accident.
It should be opened deliberately as a declared window at a sprint boundary, with the freeze on
those paths agreed in advance.

**And the window that matters is not this one.** Under sub-decision 1, the node-axis window cannot
carry the v1.0 compat claim for the shipped compiled path. The clock that gates v1.0 is the
**compiled-axis** clock, and it has not started, because that lane has never published a run. The
same is true of the two other clocks anchored here: ADR-0044 Amendment 2's expiry and ADR-0048's
compat action item both hang on the compiled-axis lane publishing a number, and **nothing in this
amendment starts either of them.** Recorded explicitly so that a green node-axis window is not
later mistaken for having fired them.

---

## Options considered

### For sub-decision 2 — where to fix the nondeterministic manifest

| option | for | against | verdict |
|---|---|---|---|
| **Canonicalize the packed `package.json` inside the fingerprint** | local to code we own; deterministic and directly testable; mutation-provable both halves; changes nothing about what is built, packed, or installed; survives a package-manager upgrade, a downgrade, or a switch | widens the fingerprint's "normalization" surface, which must be kept narrow by discipline and by test; masks *any* future key-order-only manifest change, including one someone intended to be meaningful (no such change is meaningful) | **chosen** |
| Switch the packer (e.g. `bun pm pack`) | removes the race at source; no fingerprint change | changes the artifact under test for a reason unrelated to correctness, and would itself restart the window; the compat lane's install path is a load-bearing part of what the suite verifies; trades a known, understood race for an unmeasured packer's unknown ordering behaviour | rejected |
| Sort dependencies in a prepack step in the repo | small; keeps the fix in our tree | fixes the *symptom* on our packages only, and only for as long as nobody adds a workspace dep elsewhere; still mutates the shipped manifest; a prepack hook is easy to bypass and hard to prove ran | rejected as the primary fix |
| Pin the package-manager version and wait for upstream | zero code; correct in principle | the ordering is an internal implementation detail no version pin can promise to preserve — a pin freezes today's behaviour by luck, not by contract; leaves v1.0's release gate blocked on a third party's schedule; and pins decay | rejected as the primary fix; a version bump that happens to fix it upstream is welcome but must not be load-bearing |
| Do nothing; accept the flip | no work | the window stays unreachable at ~1 in 8,000; an unreachable anchor is the exact defect ADR-0044 Amendment 2 had to be written to repair, and repeating it knowingly is worse than having stumbled into it | rejected |

The two rejected-as-primary rows are worth keeping as **complementary** hygiene: sorting
dependencies at source, or landing on a package manager that serializes deterministically, both
reduce the blast radius. Neither may be the thing the guarantee rests on.

### For sub-decision 3 — the restart rule

| option | for | against | verdict |
|---|---|---|---|
| **Keep "any frozen-set change restarts", start the clock at zero** | strongest sentence available and the one already published; no guard weakened; with the anchor stabilized the rule is achievable under a declared freeze | requires a deliberately scheduled two-week freeze on the harness and the three packages; the window still cannot be reached by chance | **chosen** |
| Per-component clocks (harness / packed tracked separately) | avoids 12 of 17 restarts; the harness clock stands at 15 nights today | a green harness clock says the *harness* was stable, which is not the claim anyone wants to read; the packed component is the adapter under test, and it moved on 15 of 17 restart nights; it also delivers "≥14 today" only by counting nights under a rule that did not exist then | rejected |
| Reshape to 14-of-N, or a rolling window | tolerant of legitimate shipping activity; reachable without a freeze | a materially weaker sentence than "14 consecutive"; invites an unbounded N; discards the property the window exists to demonstrate — that a *single, fixed* artifact set passed repeatedly | rejected |
| Narrow the packed component to the adapter package alone | intuitively targets what matters | buys **nothing**: `@getknext/core` is the component that always moves — it accounts for every solo packed restart, five of them with no source change | rejected on the measurement |
| Credit the standing harness-axis (15) or green-only (32) streak now | v1.0's compat gate clears immediately | a retroactively redefined streak certifies nights the rule never certified — 12 of the harness-axis's 15 nights shipped different bytes. This is the unverified-parity claim the project's hard rules forbid, and it is the single most damaging thing this amendment could do to the credential it exists to protect | **rejected, emphatically** |

---

## Consequences

**May be relied upon once this is accepted and implemented:**

- The compat window's anchor is stable against semantically-null manifest serialization, and that
  property is enforced by a both-halves test with mutation provers rather than by observation.
- Every citation of a completed window names its axis. A reader can tell which build target the
  credential covers without reconstructing it from an ADR trail.
- The restart rule is unchanged, so no previously published statement about the window becomes
  weaker or needs re-explaining.

**What this costs, stated rather than buried:**

- **The clock resets to zero.** The nominal "2 of 14" standing today is discarded along with the
  old digest definition. Nothing is lost in substance — 2 of 14 was never going to reach 14 — but
  the calendar cost is real and should not be discovered later.
- **A completed node-axis window does not clear v1.0's compat gate.** Under sub-decision 1 the
  gate belongs to the compiled axis, whose lane has published nothing. This amendment makes the
  node clock reachable; it does not shorten the path to v1.0, and anyone reading it as good news
  for the release date has read it wrong.
- **Fourteen consecutive nights still requires a deliberate freeze** on the harness and on
  `packages/{kn-next,lib,db}` — roughly a two-week hold on the packages under most active
  development. That is a sprint-planning commitment, not a background process.
- **The fingerprint now contains a normalization rule**, and every normalization is a place where
  a real difference could hide. The narrowness of this one is a standing review obligation: any
  proposal to normalize a second thing should be treated as an amendment to this amendment, not as
  a tidy-up.

**Residual gaps, unchanged by this amendment:**

- Cross-run comparison is still not implemented (ADR-0039's open action item). Until it is, the
  fingerprint is *evidence* a window was or was not continuous, not an *alarm* when it breaks. A
  window opened before that lands is policed by whoever reads the ledger.
- The runner environment (image, Node patch version) can still move under a stable digest.
- Suite provenance remains recorded, not frozen — deliberately, per ADR-0039.
- The 2026-08-19 restart remains unexplained. If a comparable flip recurs after canonicalization
  lands, the mechanism hunt reopens and this sub-decision 2 is incomplete.

---

## Action items

Each item below is decision-free once this amendment is accepted; none require re-summoning a
design gate.

- [ ] **A. Canonicalize the packed manifest** in `scripts/compat-window-fingerprint.mjs`
      (`collectPacked`), scoped to `package.json` and to key order only.
- [ ] **B. Both-halves regression test + mutation provers** in
      `tests/compat-window-fingerprint.test.ts`: key-order-only difference → identical digest;
      dependency-version difference → different digest. Each half must be proved to go red when
      the behaviour it protects is removed.
- [ ] **C. Guard the narrowness**: a test asserting the canonicalizer is not applied to any file
      other than the packed `package.json`, so a later widening cannot land silently.
- [ ] **D. Reset and re-open the window** with a declared start date, scheduled at a sprint
      boundary together with the freeze on the harness and `packages/{kn-next,lib,db}` that a
      14-night run requires. Record the start in `docs/compat/window-node-lane.md`.
- [ ] **E. Record the axis scoping** in `docs/compat-matrix.md` — the v1.0 window row and the
      official-suite row both name the axis their evidence covers, and the compiled axis is marked
      as having no window rather than inheriting one.
- [ ] **F. Land cross-run comparison** (carried forward from ADR-0039): the ledger job reads the
      previous scheduled run's fingerprint and fails loudly on a mid-window mismatch. Only then is
      "a mismatch voids the window loudly" a true sentence.
- [ ] **G. Complementary hygiene, explicitly not load-bearing**: sort `dependencies` at source in
      the workspace manifests, and re-evaluate if a package-manager release makes publish-manifest
      serialization deterministic. Neither may become the thing the guarantee rests on.
- [ ] **H. Watch for a post-canonicalization flip.** If the packed digest moves again with no
      packed input touched, reopen the mechanism investigation — with a same-night reproduction,
      since the tarball-bearing artifact expires within a day.

---

## Notes for the accepting maintainer

Two judgement calls in this draft are deliberately conservative and are the ones worth
challenging before acceptance:

1. **Refusing the standing 15-night harness-axis streak** (sub-decision 3c) costs roughly two
   weeks of calendar on a credential the project wants. The argument for refusing is that the
   streak only reaches 14 by applying a rule invented after the nights it counts, and that 12 of
   those nights shipped different bytes. If that argument is wrong, the fastest path to a
   defensible v1.0 compat claim is being discarded for nothing.
2. **Scoping the window per axis** (sub-decision 1) makes the node-lane work stop counting toward
   the v1.0 gate. That is the honest reading of ADR-0048's effect on target selection, but it
   relocates the release gate onto a lane that has never published a run — so accepting this
   amendment should be paired with a decision about that lane, not taken as a substitute for one.
