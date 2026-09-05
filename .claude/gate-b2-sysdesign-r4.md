# BLOCK

System-designer design gate, **round 4**, on Track B of
`docs/adr/drafts/bun14-runtime-vinext-builder-plan.md`. Working tree (uncommitted, `main`),
2026-08-27 00:22–00:40 EEST.

You asked: *"can you remove or neuter the enforcement in a way that keeps both scans satisfied? If
yes, that is a blocker and I want it."*

**Yes. Two ways, both proved by exit code, and neither requires adversarial intent — both are edits
an ordinary engineer makes on an ordinary day.** That is the block, and it is the only one. It is a
~4-line fix, specified below.

Your N1/N2/N3 mutations are real — I re-ran N1 myself and it goes **RED** with the right message.
The guard works against the deletion you tested. It does not survive the two adjacent edits.

---

## The defeat — ATTACK A′: keep the call site byte-identical, drop the reporting

The most realistic neutering, and it needs no residue or trickery. Someone decides an unreachable
error is noise:

```ts
const why = checkPairing(config.build, config.runtime);
if (why) {
    // deliberately not reported
}
```

The call site is **character-for-character identical** to today's. `checkPairing` is untouched and
still calls `explainIncompatibility(rt, builder.describeArtifact("."))`. **Both scans match.**
Enforcement is zero — `validateConfig` can no longer reject anything the contract refuses.

| check | result |
|---|---|
| B-track (6 files) | **exit 0** — 62 passed (62) |
| full `packages/kn-next` (162 files, 1834 tests) | **exit 1**, but only the 3 known machine-speed flakes you and I both characterised — `cli-build-bun-bytecode` (8 × `Test timed out in 5000ms`), `cli-config-not-found`, `compile-cache-health-bun`. **No test detected the mutation.** |
| `biome check --diagnostic-level=error validate.ts` | **exit 0** |
| `tsc --noEmit -p packages/kn-next` | **exit 0** |

`why` is still referenced by the `if`, so there is no unused-binding signal either. Nothing in the
repo notices.

## The defeat — ATTACK B: delete the call site, leave a TODO comment

Both halves are plain regexes over raw source with no comment stripping, so a comment satisfies
them. This is your own N1 mutation with the single most likely real-world residue attached:

```ts
// TODO(#XXX): re-enable checkPairing(config.build, config.runtime)
// once a second builder ships — no reachable config can trip it today.
```

`artifact-contract-reality.test.ts` + `validate-build-axis.test.ts` → **exit 0, 23 passed (23).**

N1 goes red when the call vanishes cleanly. It goes **green** when the person removing it leaves a
breadcrumb explaining why — which is what a conscientious engineer does. The guard is currently
better at catching carelessness than care.

**Restores verified byte-identical after every mutation** (`validate.ts` back to
`1ef6f2c1…a800e65a`), and the full 167-file snapshot re-checked at the end: **zero mismatches.**

---

## Why this blocks, and why it is the last one

You pre-committed to treating a successful defeat as a blocker, and I would hold it as one anyway —
but on the grounds of *likelihood*, not severity. In round 3 I explicitly declined to block on the
coverage guard's existence-vs-relevance hole because defeating it required knowingly writing a false
citation. **These two are different in kind:** leaving a TODO, or deciding an unreachable error is
noise, are things a well-meaning engineer does. A guard should defend against drift, and drift is
exactly what gets through.

The consequence is the same delayed-silent one I flagged in round 3: the enforcement disappears
while it is unreachable, nothing reds, and a sentence shipped in every installed CRD becomes false
again on the day a second builder lands.

**Fix — two changes, both to `artifact-contract-reality.test.ts`, neither novel:**

1. **Strip comments before scanning.** Kills attack B.
   ```ts
   const code = src
       .replace(/\/\*[\s\S]*?\*\//g, "")
       .replace(/^\s*\/\/.*$/gm, "");
   ```
   Then run both existing regexes against `code` rather than `src`.
2. **Anchor on the EFFECT, not the call.** Kills attack A′. Add a third presence check —
   `/errors\.push\(why\)/` — against the same stripped source. The guard's subject is *"the pairing
   verdict reaches `errors`"*, not *"the identifier appears"*, and asserting the call without the
   push is the same both-halves gap this repo keeps re-finding.

**Keep these as three independent presence checks, not one multi-line regex.** A single
`const why = …;\s*if \(why\) errors\.push\(why\);` pattern would be brittle to a formatter reflow,
and `security.md` documents where that leads: a guard that reds on correct changes becomes a guard
people edit to get green — which is exactly why `release-action-pins.test.ts` deliberately asserts
form and scope rather than the SHA value. Three independent, reflow-tolerant assertions get the
robustness without the brittleness.

Mutation-prove all three: N1 (clean delete), **attack B** (delete + TODO comment), **attack A′**
(call kept, push removed), plus your N2/N3. Five red, negative control green first. My mutation
scripts are in
`/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/086e874a-84f3-442c-8974-bfe240efc50b/scratchpad/`
(`mut_n4a.mjs`, `mut_n4b.mjs`, `mut_pair.mjs`) if you want the exact anchors.

---

## Everything else — SIGN-OFF

Re-verified this round, tree pristine, B-track **6 files / 62 tests / exit 0**:

- **The `checkPairing` resolution stands as honest.** My round-3 ruling is unchanged: option (b) was
  right, the CRD sentence stays, option (a) is not needed. The claim is backed by code that executes
  on every validate; the unreachability is a property of the builder registry, not the wiring; and
  the check becomes live with no further edit the moment a second builder or shape lands. Nothing in
  this round's defeats argues against the design — they are about the *guard on* the wiring, not the
  wiring.
- **The second half you added is the right instinct** and it does close N3. It is only the medium —
  raw-source regex — that leaks. The `explainIncompatibility(rt, builder.describeArtifact` anchor is
  well chosen; it survives comment-stripping unchanged.
- **Rounds 1–3 blockers all remain fixed**: shape carries its preset; `nodeRuntime.accepts` is
  `["next-standalone"]` with both halves asserted; the CRD enum is `turbopack` only in types *and*
  regenerated bundle; the B4 evidence check catches my round-2 mutation A; the refuted prose is
  corrected in both docstrings, at `:56`, and in plan §1/§4.
- **The hard rule holds on all five surfaces** — `cr-builder` omission (key-absence asserted),
  `build-artifact.ts` `DEFAULT_BUILD`, `checkPairing`'s defaults, validator, operator. No default
  moved.
- **The three full-suite reds are environmental and pre-existing**, exactly as characterised in
  round 3: `cli-build-bun-bytecode` fails identically in isolation with eight 5 s timeouts (real
  `bun build` spawns at 6.5–14 s on this laptop; local bun 1.3.5 vs CI's pinned 1.3.14), the other
  two pass in isolation. None is touched by this change. Your `go test ./...` exit 0, biome 0 and
  typecheck 0 are consistent with what I ran.

Still open from round 3, still **non-blocking**, unchanged: the coverage guard's
existence-vs-relevance gap (mutation D); the misleading *"does not exist"* message when a cited file
exists outside the two candidate roots; the orphaned `KNOWN_BUILDERS` docstring at `validate.ts:38-50`;
defaults duplicated across four sites; and plan §1's blockquote still endorsing the claim its own
diagram disproves.

---

## ADR-0048 (draft) — single answer for the founder

**Sign-off. The draft's argument is correct, its recommendation is the one I would make, and it does
not block the code.** Restated as one answer:

1. **ADR-0042 Decision 2 needs no amendment.** The obligation arose because an earlier version of
   this work asserted `node + vinext` was *capable but excluded by policy* — a capability claim
   ADR-0042 had removed. That was measured false: the only vinext artifact this repo builds is a
   **bun-preset** nitro output, and running it under node exits 1 before it serves anything. The
   code now claims **strictly less** than ADR-0042 does. Agreeing with a decision for a stronger
   reason than it gave is not a contradiction, so there is nothing to amend.
2. **Decision 2's rationale is understated, not wrong**, and the draft handles that correctly:
   the exclusion was recorded as scope, and the cell turns out not to be capable either. If
   something later builds a **node-preset** nitro output, that is a NEW artifact shape and
   Decision 2's policy question **revives** at that point — it has not been quietly retired. Worth
   recording as a dated measurement against ADR-0042 either way, so the next person does not
   re-derive it from prose, which is precisely how this defect entered.
3. **What genuinely needs a founder decision is the default, and only the default.** ADR-0042
   Phase 5 flips it to `bun + vinext`. **Recommend Option A: the default stays `node + turbopack`.**
   That keeps the hard rule — *"never make anything but the node/official-adapter target the
   default"* — **unamended** rather than amended, leaves the vinext path opt-in and compat-gated,
   and costs nothing Phase 5 could deliver today (no `kn-next build` vinext path exists, and the
   scaffolded Dockerfile cannot produce a runnable nitro image).
4. **Nothing in the current tree pre-empts that decision.** Re-verified this round on all five
   surfaces: no default moved, and the CRD publishes only `turbopack`, so no cluster can express the
   Phase-5 target even by hand.

**Bottom line for the founder: one decision to make — the default — and the recommendation is to
leave it where it is.** Everything else that looked like an ADR obligation dissolved under
measurement.

---

## Verified by running vs. read only

**Ran, branched on exit codes:**
- Attack A′ (call kept, push removed): B-track **exit 0** 62/62; full suite **only the 3 known
  flakes**; biome **exit 0**; tsc **exit 0**.
- Attack B (call deleted, TODO comment left): **exit 0**, 23/23.
- Your N1 re-run as negative control: **exit 1**, correct message — the guard does work against a
  clean deletion.
- Baseline B-track: **exit 0**, 6 files / 62 tests.
- `validate.ts` restored byte-identically after every mutation (`1ef6f2c1…a800e65a`); full 167-file
  checksum verification at the end → **zero mismatches, no residue.**

**Read only:** ADR-0036 and ADR-0042 themselves (as in all prior rounds, I check the plan's and
0048's characterisation against the **tree**, never against the ADR text); `docs/RELEASING.md`; the
Go operator suite (I did not re-run `go test ./...`; your exit 0 is consistent with the CRD state I
verified by reading types.go and the regenerated bundle).
