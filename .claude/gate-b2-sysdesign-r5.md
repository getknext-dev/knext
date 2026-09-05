# SIGN-OFF

System-designer design gate, **round 5**, on Track B of
`docs/adr/drafts/bun14-runtime-vinext-builder-plan.md`. Working tree (uncommitted, `main`),
2026-08-27 00:22–00:55 EEST.

**Both round-4 defeats are closed, verified by running.** I attacked the new arrangement four more
ways. Two are refuted. Two survive — and I am ruling both **not blockers**, because they are not an
implementation gap: they are a logical limit of the domain, and I can show it rather than assert it.

The structural fix is the right one. Making the enforcement **reachable** rather than guarding an
unreachable call with a source scan is exactly the correction, and it is the first version of this
that a test can actually hold.

---

## The round-4 defeats, re-run

| attack | round 4 | round 5 |
|---|---|---|
| **A′** — call site byte-identical, reporting dropped (`if (pairingProblem) { /* not reported */ }`) | passed, exit 0 | **RED, exit 1** |
| **B** — call deleted, TODO comment left containing its text | passed, exit 0 | **RED, exit 1** |

Both now fail on `reports the pairing AND the availability problem`, which asserts
`/not available/i` **and** `/nitro-output-bun/` on the thrown message. That is the both-halves form,
and it is the half that matters: a naive `toThrow()` would have stayed green on the availability
error alone, which is precisely how attempt 1 survived.

I also re-ran your **E** independently — `nodeRuntime.accepts` silently re-admitting
`nitro-output-bun`: **RED, 5 tests across 3 files.** The blast radius is right; the contract, the
validator and the coverage enumeration all notice.

`validateConfig` is genuinely on the deploy path — `shared.ts:184`, inside the single config-loading
function every verb goes through (`cleanup.ts`, `gc.ts`, `rollback.ts` all name it as the single
source of truth). So the CRD's *"rejected by the CLI"* sentence is now true end to end, not just in
the module.

Baseline: **6 files, 65 tests, exit 0.** All restores byte-identical (`validate.ts` →
`d7640777…c54e3`, `artifact-contract.ts` → `7742cfd4…c1ac0`); 166-file snapshot re-verified at the
end with **zero mismatches** — no residue.

---

## Two attacks that survive, and why neither is a blocker

I want to be precise here, because "I found something that passes" is not automatically a blocker,
and treating it as one after four rounds would be the failure mode rather than the diligence.

**Attack F — overfit to the reachable case.** Keep everything, condition the push on the literal
pair:

```ts
if (pairingProblem && config.build === "vinext" && config.runtime === "node")
    errors.push(pairingProblem);
```
→ **exit 0.**

**Attack G — bypass the contract, keep the output.** Replace the `checkPairing` call with a
hardcoded ternary producing the same string for `vinext` + `node` → **exit 0.**

### Why this is a limit, not a gap

The config domain is `KNOWN_BUILDERS × SUPPORTED_RUNTIMES` = `{turbopack, vinext} × {node, bun}` =
**four expressible cells, of which exactly one is incompatible** (`vinext + node`). Both F and G
produce **identical observable behaviour to the correct implementation on all four cells**. They
diverge only on cells that do not exist.

So no behavioural test can separate them — and critically, *strengthening the test does not help*.
I checked the obvious strengthening: an exhaustive cross-product derived from the contract,
asserting `validateConfig` reports a pairing error **iff** `isCompatible` says incompatible. F and G
**pass that too**, because they are correct on every cell it can enumerate. With one incompatible
input in the domain, "handles the general rule" and "handles that one input" are observationally
identical. That is arithmetic, not a missing assertion.

The only thing that *could* separate them is a structural/source check on provenance — which is
exactly what round 4 proved leaky and what you correctly deleted. **Recommending it now would
regress the design to the version I already defeated twice.** I am not going to ask for that.

What each actually costs, stated plainly so it is on the record rather than dismissed:

- **F** loses *generality*, not current correctness. Every config a user can write today is still
  validated correctly. It would fail to reject a future incompatible pairing — and the day a fifth
  cell exists, the derived coverage guard (`build-runtime-combination-coverage.test.ts`, which
  enumerates from `BUILDERS × RUNTIMES` and fails on any combination without a disposition) fires on
  the same commit, which is the point at which someone is looking at this code anyway.
- **G** loses *provenance*, not enforcement. The user is protected identically; what is lost is
  "the contract is where compatibility lives". It also requires deliberately inlining a hardcoded
  refusal string — fabrication-class, the same category as round 3's mutation D, which I also
  declined to block on for the same reason.

Neither neuters the enforcement for any input a user can express. That was your bar, and neither
clears it.

---

## Non-blocking, and worth doing when convenient

1. **Derive the pairing tests' cross-product instead of writing the literals.** `checkPairing`'s
   "passes the two pairings a config can actually express today" (`:118`) and `validateConfig`'s
   "stays silent … for every config a user can ship today" (`:208`) both iterate hand-written
   `["node","bun"]` and a literal `turbopack`. Derive them from `BUILDERS × RUNTIMES` and assert the
   `iff` against `isCompatible`. It does not close F or G — nothing does — but it makes the tests
   **grow by themselves** when a third builder or runtime lands, instead of silently continuing to
   test the old world. This is the repo's own "prefer scanning to enumerating", and it is the one
   change that converts F from undetectable-forever into detectable-on-arrival.
2. **The pairing assertions key on `/nitro-output-bun/`**, i.e. on `explainIncompatibility`'s
   message text. Reasonable — the shape name is the load-bearing content — but a message rewording
   reds these tests for a non-defect. Worth a comment saying the shape name is deliberately part of
   the contract's user-facing output.
3. Carried forward from earlier rounds, still open, still non-blocking: the coverage guard's
   existence-vs-relevance gap (mutation D); the misleading *"does not exist"* message for a cited
   file outside the two candidate roots; the orphaned `KNOWN_BUILDERS` docstring at
   `validate.ts:38-50`; defaults duplicated across four sites; and plan §1's blockquote still
   endorsing the claim its own diagram disproves. The last of those is the only one I would fix
   before the ADR is written from that document.

---

## Confirmed unregressed this round

- CRD enum is `turbopack` only — one `+kubebuilder:validation:Enum=turbopack` in `nextapp_types.go`,
  and `enum: [turbopack]` in the regenerated bundle. The two still agree.
- The hard rule — *"never make anything but the node/official-adapter target the default"* — holds
  on all five surfaces: `cr-builder` omission (key-absence asserted, not `!== undefined`),
  `build-artifact.ts` `DEFAULT_BUILD`, `checkPairing`'s defaults, the validator, and the operator
  (which has no default at all). Nothing moved.
- Rounds 1–3 fixes all intact: shape carries its preset; `nodeRuntime.accepts` is
  `["next-standalone"]` with both halves asserted; the B4 evidence check still catches round-2's
  mutation A; the refuted prose stays corrected in both docstrings, at `:56`, and in plan §4.
- The 3 full-suite reds remain the environmental ones characterised in round 3
  (`cli-build-bun-bytecode` — eight 5 s timeouts against real `bun build` spawns at 6.5–14 s on this
  laptop, local bun 1.3.5 vs CI's pinned 1.3.14; the other two green in isolation). None is touched
  by this change. Your typecheck 0, biome 0 and `go test ./...` exit 0 are consistent with
  everything I ran.

---

## ADR-0048 (draft) — restated ruling, single answer for the founder

**Sign-off, unchanged from round 4. It does not block the code, and it never did.**

1. **ADR-0042 Decision 2 needs no amendment.** The obligation arose because an earlier version of
   this work asserted `node + vinext` was *capable but excluded by policy* — a capability claim
   ADR-0042 had removed. Measured, that is false: the only vinext artifact this repo builds is a
   **bun-preset** nitro output, and `node .output/server/index.mjs` exits 1 before serving anything.
   The code now claims **strictly less** than ADR-0042 does. Agreeing with a decision for a stronger
   reason than it gave is not a contradiction, so there is nothing to amend.
2. **Decision 2's rationale is understated, not wrong.** The exclusion was recorded as scope; the
   cell turns out not to be capable either. If something later builds a **node-preset** nitro
   output, that is a NEW artifact shape and Decision 2's policy question **revives** — it has not
   been quietly retired. Record the measurement as a dated note against ADR-0042 either way, so the
   next person does not re-derive it from prose. That is exactly how this defect entered.
3. **One thing genuinely needs a founder decision: the default, and only the default.** ADR-0042
   Phase 5 flips it to `bun + vinext`. **Recommend Option A — the default stays `node + turbopack`.**
   It keeps the hard rule **unamended** rather than amended, leaves the vinext path opt-in and
   compat-gated, and costs nothing Phase 5 could deliver today: `kn-next build` has no vinext path,
   and the scaffolded Dockerfile cannot produce a runnable nitro image.
4. **Nothing in the tree pre-empts that decision.** Re-verified this round on all five surfaces, and
   the CRD publishes only `turbopack`, so no cluster can express the Phase-5 target even by hand.

**Bottom line for the founder: one decision — the default — and the recommendation is to leave it
where it is.** Everything else that looked like an ADR obligation dissolved under measurement.

---

## Verified by running vs. read only

**Ran, branched on exit codes:**
- Attack A′ → **exit 1**; attack B → **exit 1** (both round-4 defeats now caught).
- Attack F (overfit to the literal pair) → **exit 0**; attack G (contract bypassed, output preserved)
  → **exit 0**. Ruled limits, not gaps, per the domain-size argument above.
- Your attack E, re-run independently → **exit 1**, 5 tests across 3 files.
- Baseline B-track → **exit 0**, 6 files / 65 tests.
- `validateConfig` call site traced to `shared.ts:184` — the single config-loading path.
- CRD enum verified in both `nextapp_types.go` and the regenerated bundle.
- `validate.ts` and `artifact-contract.ts` restored byte-identically after every mutation;
  166-file snapshot re-verified → **zero mismatches, no residue.**

**Read only:** ADR-0036 and ADR-0042 themselves (as in every round, I check the plan's and 0048's
characterisation against the **tree**, never against the ADR text); `docs/RELEASING.md`. I did not
re-run `go test ./...` or `tsc` this round for the pristine tree — your exit 0s are consistent with
the CRD state I verified directly, and I ran `tsc`/`biome` myself in round 4.

---

**Merge when you are ready.** From the system-design side this is done: the axes separate on a seam
that is now measured rather than asserted, the CRD publishes only what the operator can honour, and
the one invariant that matters is enforced on a path a user can actually reach.
