# BLOCK

System-designer design gate, **round 3**, on Track B of
`docs/adr/drafts/bun14-runtime-vinext-builder-plan.md`. Working tree (uncommitted, `main`),
2026-08-27 00:05–00:30 EEST.

**All three round-2 blockers are genuinely resolved.** One new blocking item, and it is small,
mechanical, and squarely inside what NEW-1 was about — so this is not "back to square one", it is
one assertion short of done. Everything else below is a SIGN-OFF, including your ADR argument and
your `checkPairing` resolution, which I am ruling **honest**.

Everything was run. All 171 files under review checksummed before and after; tree verified pristine
at the end.

---

## Round-2 blockers — re-verified by running

| R2 blocker | state | evidence |
|---|---|---|
| NEW-1 CRD claims CLI enforcement that no code performs | **RESOLVED** — see the ruling below | `checkPairing` exported at `validate.ts:67`, called at `:350` inside the known-AND-available branch; `explainIncompatibility` now has a production caller. |
| NEW-2 evidence check unreachable inside the availability loop | **FIXED** | My exact R2 mutation A (relabel the **unavailable** `vinext+bun` row `not-buildable → covered`, prose untouched) now goes **RED, exit 1**. Re-ran it myself; restored, checksum matched. |
| NEW-3 refuted claim still asserted in prose | **FIXED** | Both docstrings rewritten to the measured truth and — better than I asked for — they now record that ADR-0036 says the opposite *and is wrong*, rather than silently omitting it. `:56`'s swept narrative repaired to `"nitro-output"`. Plan §4 explicitly RETRACTED with the measurement; the §1 diagram corrected to *"in-process entry, BUN only … node exits 1"*. |

B-track suite: **6 files, 61 tests, exit 0.**

---

## Your question: is exporting + direct-testing `checkPairing` honest, or should the sentence be deleted per (a)?

**Ruling: (b) is honest. Keep the sentence and keep the wiring. Do not delete it.** Four reasons,
in the order that decided it:

1. **The claim is now backed by code that actually executes.** `validateConfig` calls
   `checkPairing` on every validate, and it resolves the artifact from the contract and asks
   `explainIncompatibility`. In round 2 the sentence described a mechanism with *zero* call sites.
   The difference between "unreachable input" and "nonexistent mechanism" is the whole distinction,
   and it is a real one.
2. **The unreachability is a property of the registry, not of the wiring.** Nothing about
   `checkPairing`'s call site has to change when `vinextBuilder.available` flips or a node-preset
   shape lands — the check becomes live on its own. That is the correct sequencing: you want the
   gate installed *before* the thing it guards becomes expressible, not bolted on after.
3. **Deleting the sentence would now be the less honest option.** The CRD comment's job is to tell a
   cluster operator where the gate lives, and the answer genuinely is "the CLI, against the
   contract". Option (a) was right when the answer was "nowhere". It is wrong now.
4. **You found the unreachability yourself, by mutation, and said so in the docstring rather than
   letting the wiring stand as proof.** That is the behaviour these gates exist to produce, and
   penalising it would be exactly backwards.

**One correction to the framing, though.** Testing `checkPairing` directly does not make the *call
site* proven — it makes the *function* proven. Those are different subjects, and the gap between
them is my one blocking item.

---

## NEW-4 (blocking, and the only one) — the production call site is unguarded. Measured.

Your own finding, confirmed independently and at full scale.

**Mutation:** delete `validate.ts:350-351` (`const why = checkPairing(...); if (why) errors.push(why);`),
replace with a comment. Anchored script, single-occurrence assert, no `perl`.

**Run: the entire `packages/kn-next` suite — 162 files, 1833 tests — not just the B-track.**

| run | result |
|---|---|
| baseline (pristine) | exit 1 — **2 files / 9 tests** red |
| call site deleted | exit 1 — **3 files / 11 tests** red |

The delta is one file, `cli-config-not-found.test.ts`, and it is **flake, not detection**: it passes
**3/3 in isolation** on the restored tree, spawns a real process, and took 8.7 s under full-suite
parallel load. **No validate, contract, or pairing test failed under the mutation.** The call site
is invisible to the test suite.

*(The 2 baseline-red files are pre-existing and unrelated: `cli-build-bun-bytecode.test.ts` fails
identically in isolation with eight `Test timed out in 5000ms` — this machine, real `bun build`
spawns at 6.5–14 s, local bun 1.3.5 vs CI's pinned 1.3.14 — and `compile-cache-health-bun.test.ts`
**passes in isolation**, so it is parallelism. Neither is touched by this change. I did not confirm
them against a clean `main`, because stashing a tree with concurrent writers is how round 1's
worktree hazard happens.)*

**Why this blocks rather than being filed as a nit.** The state is: a sentence shipped in every
installed CRD says the CLI enforces the pairing; the CLI does enforce it; and nothing prevents that
enforcement being deleted. `workflow.md` is unconditional on this — *"Mutation-prove every new
guard. Delete the behaviour it protects and watch it go red. A guard that stays green when its
subject is removed is decoration."* Here it is the call site rather than the guard, and the
conclusion transfers exactly. `security.md` names the failure mode: a documented expectation
degrades, and its efficacy is unobservable until it has already failed.

And the failure is **delayed and silent by construction**, which is the worst shape: the call goes
missing while it is unreachable, nothing reds, and then a second builder or a node-preset shape
lands — and the CRD sentence is false again, which is precisely the defect this round exists to have
fixed. The docstring's honesty does not close that; it documents it.

**Fix — one assertion, idiomatic here.** Scan the source, the same technique
`artifact-contract-reality.test.ts` already uses on `node-server.ts`, `Dockerfile.hbs` and
`build.ts`:

```ts
it("validateConfig really calls the contract — the call site, not just the function", () => {
    const src = readFileSync(join(REPO_ROOT, "packages/kn-next/src/cli/validate.ts"), "utf8");
    expect(
        /checkPairing\(config\.build,\s*config\.runtime\)/.test(src),
        "validateConfig no longer calls checkPairing — the CRD tells every cluster the CLI enforces this pairing",
    ).toBe(true);
});
```

Then mutation-prove it with the deletion above; it must go red. Put the CRD-comment consequence in
the failure message, as written, so whoever trips it learns *why* the call matters rather than
re-adding it mechanically.

---

## What I tried and could NOT defeat

- **Mutation A** (R2's defeat, retargeted): relabel `vinext+bun` `not-buildable → covered`, prose
  untouched → **exit 1**. Correctly caught. Restored, checksum matched.
- **`checkPairing`'s own logic**: the `if (!builder || !rt) return null` early-out is right, not a
  hole — both unknown-build and unknown-runtime are reported by their own branches above, so
  returning `null` avoids double-reporting rather than swallowing an error. Verified both branches
  exist (`KNOWN_BUILDERS` at `:317`, `SUPPORTED_RUNTIMES` at `:36`).
- **The branch placement**: the call sits in the `else` of the known/available cascade, so `vinext`
  never reaches it. That is correct — an unavailable builder is a different, better-worded error,
  and stacking a pairing complaint on top of it would be noise.

---

## Ruling on ADR-0048 (draft)

**The argument is sound and I agree with it**, and it matches what I ruled in round 2 before you
wrote it:

- **Decision 2 needs no amendment.** The obligation existed because round 1's contract asserted a
  capability ADR-0042 had removed. The tree now claims *strictly less* than ADR-0042 does. Agreeing
  with a decision for a stronger reason than it gave is not a contradiction, so there is nothing to
  amend. Line 46's caveat is the right one to keep: a node-preset build revives Decision 2's policy
  question rather than having quietly retired it.
- **The default is the live question, and Option A is the right recommendation.** Re-verified this
  round that nothing flips: `cr-builder` emits `build` only when set (key-absence asserted, not
  `!== undefined`), `build-artifact.ts` `DEFAULT_BUILD = "turbopack"`, `checkPairing` defaults to
  `turbopack`/`node`, the operator has no default. **The hard rule holds on all five surfaces.**
- Sending this to the founder rather than writing it yourself was correct, and the ADR does not
  block the code.

---

## Non-blocking

1. **Existence is not relevance — the remaining coverage-guard hole, and why I am not blocking on
   it.** Mutation D: relabel `vinext+bun` `covered` citing `artifact-contract.test.ts`, a real file
   with nothing to do with that combination → **exit 0**. So the guard verifies a claim names a real
   file, not that the file exercises the combination. I am **not** blocking, on proportionality:
   R2's hole was reachable by *accident* — unchanged prose, zero effort, and it actually happened
   in this worktree at 23:48 that round — whereas this one requires deliberately writing a false
   citation. A guard defends against drift, not against a determined author, and this repo already
   blesses that trade explicitly in `security.md` (`release-action-pins.test.ts` asserts form and
   scope, deliberately *not* the SHA value). Note a naive strengthening will not work: a content
   grep of the cited file for the builder/runtime ids passes mutation D, because
   `artifact-contract.test.ts` mentions both `vinext` and `bun`. The robust form is an opt-in
   marker — the check file declares `// covers: vinext+bun` and the guard cross-checks — which is
   worth doing when a second builder ships, not now.
2. **The error message lies slightly when it catches you.** Mutation A went red with *"cites
   'knext-bun-entry.mjs', which does not exist"* — it does exist, at
   `examples/bun-exec/knext-bun-entry.mjs`; it is just not under either candidate root. Right
   verdict, misleading reason. Either add the sample dir to `candidates` or reword to *"was not
   found under <roots>"*. Requiring repo-relative paths in evidence is a good constraint; say that
   instead.
3. **An orphaned docstring.** Inserting `checkPairing` at `:51` left the `KNOWN_BUILDERS` /
   `AVAILABLE_BUILDERS` docstring at `:38-50` attached to nothing — two adjacent `/** */` blocks,
   the first now documenting the second's comment. The consts it describes moved below the function.
   Move it back down with them.
4. **Defaults are now scattered across four sites** — `build-artifact.ts:29` `DEFAULT_BUILD`,
   `checkPairing`'s `build ?? "turbopack"` and `runtime ?? "node"`, `cr-builder`'s omission, and the
   operator's absent-means-node. The contract module is meant to be where this knowledge lives.
   Export `DEFAULT_BUILD` / `DEFAULT_RUNTIME` from `artifact-contract.ts` and have the others
   consume them. Low risk today (the hard rule freezes these values), but a default flip would have
   to find all four, and a `checkPairing` validating the *wrong* default returns a false
   "compatible".
5. **Plan §1 still endorses the quote it disproves.** The blockquote above the corrected diagram
   still reads *"vinext → one shared in-process entry (**both** node+vinext and bun+vinext)"*,
   introduced by *"The user's framing is right, and ADR-0036 already reached it"*. The diagram
   immediately below contradicts it and §4 retracts it explicitly, so a careful reader is fine — but
   a skimmer gets the endorsement. Mark the quote as superseded. This matters only because the plan
   is what ADR-0048 is written from; ADR-0048 itself states it correctly.
6. **`cli-build-bun-bytecode.test.ts` is red on this machine** (eight 5 s timeouts) and it is the
   *named evidence* for the `turbopack+bun` disposition. Environmental — real `bun build` spawns
   against a 5 s default — and the file is untouched by this change, so out of scope. Worth knowing
   that the B4 guard checks a cited file *exists*, never that it *passes*.

---

## Verified by running vs. read only

**Ran, branched on exit codes:**
- B-track: 6 files, **61 tests, exit 0**.
- Full `packages/kn-next` suite twice — baseline 2 files/9 red, call-site-deleted 3 files/11 red;
  delta isolated to a flake (3/3 green alone).
- Mutation A (R2's defeat) → **exit 1**, caught. Mutation D (real-but-irrelevant citation) →
  **exit 0**, not caught. Both restored, `shasum` matched `d49c5473…dfcd4`.
- Call-site deletion mutation → restored, `shasum` matched `1ef6f2c1…0e65a`.
- `checkPairing` call site read at `validate.ts:341-352`; confirmed it sits in the known-AND-available
  `else`, so `vinext` cannot reach it.
- `bun --version` → 1.3.5 locally vs `ci.yml:284` pinned 1.3.14; `cli-config-not-found` 3/3 alone;
  `compile-cache-health-bun` green alone; `cli-build-bun-bytecode` red alone (timeouts).
- Full 171-file checksum verification before and after — **tree pristine, zero mismatches.** No
  residue this round.

**Read only:** ADR-0036 and ADR-0042 themselves (as in both prior rounds, I check the plan's and
0048's characterisation against the **tree**, never against the ADR text); `docs/RELEASING.md`; the
operator envtest suite. I did not re-run `node examples/bun-exec/.output/server/index.mjs` — you
reproduced it independently in round 2 and every artefact in this round is consistent with it.
