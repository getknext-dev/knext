# SIGN-OFF

Architect design gate, round 2 — Track B (B1–B4) of
`docs/adr/drafts/bun14-runtime-vinext-builder-plan.md`. Re-reviewed the current working tree on
`main` (uncommitted). Nothing committed or pushed; every mutation restored byte-identically and
verified by checksum.

Both round-1 blockers are discharged. **Blocker 2 does not block the code** — ruling and reasoning
below. Sign-off carries **two merge conditions**, both two-line documentation edits with no design
content, and **three advisories**.

---

## Round-1 findings — re-verified by running

### Blocker 1 (CRD over-publishes `vinext`) — **RESOLVED**

Extracted from the *generated* bundle, not read off the marker:

```
CRD spec.build enum: [ 'turbopack' ]
```

`nextapp_types.go:157` carries `+kubebuilder:validation:Enum=turbopack`; the three remaining `vinext`
strings in the CRD are description prose, not admission. `go build ./...` → **exit 0**;
`go test ./internal/validation/... ./api/... ./internal/webhook/...` → **exit 0**. A GitOps writer can
no longer store a CR the operator would reconcile into a spawn command for an in-process artifact.

### Blocker 2 (ADR-0042) — **first half resolved by the shape fix; second half ruled below**

My round-1 concern was that ADR-0042 Decision 2's `node + vinext` exclusion had been silently dropped
and would become selectable the day `available` flipped. That is now **structurally impossible**:
`nodeRuntime.accepts` is `["next-standalone"]`, `isCompatible(node, nitro-output-bun)` is `false`, and
the combination is no longer admissible at all. The exclusion is not merely preserved — it is now
enforced for a **stronger and better-evidenced reason** than the ADR's own (measured incapability, not
"produces no bytecode"). There is nothing left to amend on Decision 2.

Worth recording for a later reader: the code and the ADR now agree on the *outcome* via different
*reasons*. If vinext ever ships a **node** nitro preset, `node+vinext` becomes capable and ADR-0042
Decision 2 becomes the only thing excluding it — and the amendment question returns. The typed seam
makes that a compile-visible event (a new `ArtifactShape` member forces every `accepts` list to be
revisited), so it will not arrive silently. Future trigger, not a present block.

---

## The shape fix — independently reproduced, not taken on your word

```
.output/nitro.json → "preset": "bun",  commands.preview: "bun run ./server/in…"
node examples/bun-exec/.output/server/index.mjs → exit 1
  ReferenceError: Bun is not defined
```

This is the most valuable thing in round 2, and it is worth being explicit about why: the old
assertion and the old code were wrong *in the same direction*, both derived from ADR-0036 prose
("vinext runs on either runtime"). A test bound to a constant that the constant's author also wrote
cannot catch that. Running the artifact could, and did. `artifact-contract.test.ts:176` now asserts
**both halves** — bun accepts it **and** node must not — with the reasoning inline. Correct fix,
correctly guarded.

`ArtifactShape` carrying the preset (`nitro-output-bun`) rather than the toolchain is the right
modelling call: the preset is what determines executability, so it belongs in the compatibility key.

---

## Attacking the new evidence check

Negative control first — guard green at **exit 0** before any mutation, per the harness rule.

**Mutation A — the exact round-1 defeat. Now caught.** Parked the real subject
`cli-build-bun-bytecode.test.ts` out of the tree, re-ran:

```
MUTATION_A_EXIT=1
  turbopack+bun cites 'cli-build-bun-bytecode.test.ts', which does not exist
```

Restored; subject present. **Your claim 4 holds, proved by running.** The decay failure mode — a
guard that stays green when its subject is removed — is genuinely fixed.

I also mutation-proved the **re-anchored availability tripwire**, since it is now the load-bearing one:
adding a `.output` line to `templates/app/Dockerfile.hbs` → **exit 1**. Restored, sha256 identical,
`git status` clean. Re-anchoring that guard from "does `build.ts` mention vinext" to "does the
scaffolded Dockerfile handle `.output`" was the right move — the old anchor was a path literal that
fired on a refactor, the new one is the narrowest thing actually still missing — and it carries its
inverse half (`.next/standalone` must still be present), so it is a statement about the template
rather than an accident of grepping.

**Two residual holes remain. Both are advisory, and both are the same class one level down.**

**Mutation B — substitution.** Existence is not relevance. Repointed `turbopack+bun`'s evidence at
`cli-node-runtime.test.ts` — a real file that has nothing to do with bun bytecode:

```
MUTATION_B_EXIT=0   ← not caught
```

**Mutation C — the unavailable row.** `every AVAILABLE combination is covered` iterates
`combos.filter(x => x.available)`, and the `not-buildable` inverse test only inspects rows *labelled*
`not-buildable`. So relabelling the unavailable `vinext+bun` row to `covered`, prose untouched, is
checked by nothing:

```
MUTATION_C_EXIT=0   ← not caught
```

Both restored byte-identically (`f461c000fbeb706e…` before and after).

Neither blocks. B requires someone to actively author a false citation — a much higher bar than the
passive decay A represented, and outside what a guard of this kind can reasonably reach without
executing the cited test. C is a false claim about a combination nobody can build. Cheap hardening if
you want it: run the `cited`/`existsSync` check over **every** `covered` row rather than only
available ones (closes C outright, ~2 lines), and consider citing `file::test name` so a
substitution has to name a test that also exists. I would take C; B is optional.

---

## Ruling on Blocker 2: **the code may proceed with the ADR outstanding**

You asked for this explicitly, so here it is unhedged. Four reasons, in order of weight:

1. **ADR-0042 authorises exactly this.** Decision 5: *"The default flip lands at Phase 5, gated on its
   exit criteria. **Phases 0–4 are authorised now.**"* B2 sits squarely inside that authorisation.
   Shipping it with the default unchanged is **compliance with ADR-0042 as written**, not a deviation
   requiring an amendment first.
2. **The code flips nothing, re-verified this round.** `cr-builder-build-axis.test.ts` asserts absence
   on both halves — no `spec.build` for a default config, and none even when `runtime` *is* set, with
   the rest of the spec byte-equal. `build-artifact.ts:50` defaults to `turbopack`. The operator reads
   `Spec.Build` **nowhere** (`grep` exit 1). There is no default to amend an ADR about.
3. **The obligation is not yours to discharge.** ADR-0042 is marked *"Accepted — founder decision"*.
   An ADR amending a founder decision is authored by the founder. `workflow.md`'s escalation model
   asks a team that hits a trigger to **stop and escalate rather than decide for itself** — which is
   precisely what happened. Blocking code on an artifact the implementer is not authorised to write
   converts an escalation into a deadlock, and would punish the exact behaviour the rule wants.
4. **The risk it guards against is a future event, and it has its own gate.** The ADR must land before
   anything actually moves the default — i.e. before Phase 5 — not before B2. Nothing merging here
   brings that moment closer.

**The one thing that must not merge** is any text reading as though the question were settled — that
is Merge Condition 2 below. This whole track exists because ADRs confidently described a matrix,
a CEL rule and a config axis the code never had. A plan draft carrying a bare **"Recommendation:
default stays `node + turbopack`"** against an accepted founder decision is the same failure in
miniature: the next reader takes it as the position. Record the open question; do not answer it.

---

## Merge conditions (2) — verifiable in a diff, no re-review needed

**MC-1 — two stale sentences in the *published* CRD description.** `kubectl explain
nextapp.spec.build` prints this, and a user reads top-down:

- `…nextapps.yaml:71` — *"Valid values: `turbopack` (default) or `vinext`."* The enum three lines
  below admits only `turbopack`. The description contradicts its own schema.
- `…nextapps.yaml:76` — *"Any value of Build is admissible with any value of Runtime."* Now false:
  that is exactly the claim round 2 disproved by running `node .output/server/index.mjs`.

Fix both in `nextapp_types.go` and re-run `make manifests`. The rest of that description block is
genuinely good and self-corrects further down — these two lines just did not get re-read against the
tree after the narrowing, which is the specific thing `workflow.md` warns about.

**MC-2 — mark the default-flip recommendation as escalated and undecided.** Plan §3 line 132. One
line: note that it contradicts ADR-0042 Decisions 1 and 5, that ADR-0042 is an accepted founder
decision, and that it is surfaced to the founder and **not** settled by this track.

---

## Advisories (do not block)

**A1 — `resolveBuildArtifact` does not check `available`, while its docstring claims to backstop a
bypassed validator.** `build-artifact.ts:50-62` throws on an *unknown* builder but resolves an
*unavailable* one happily; `build-artifact-resolution.test.ts:40` asserts that behaviour and no test
covers availability. So the "backstop for a bypassed validator" is half a backstop — this repo's
most-common defect, in a module whose own comment claims the guarantee. Contained, not urgent:
the CR can never carry `vinext` (validator *and* CRD enum both refuse), and the local failure is loud
at build time, not the #857 silent-exit-0 shape. Two lines to make the docstring true — throw
`UsageError` on `!builder.available` — plus the test.

**A2 / A3 — Mutations B and C above.**

**A4 (carried from round 1, still open) — `BuildArtifact` cannot express the bun+vinext runnable.**
One `entry` + `root`, but `build.sh` ships a `--compile`d binary *plus* `.output/public` anchored on
the executable's own directory. B3's design will need a static-asset root and a post-compile entry.
Flagging so it is a design step, not a `docker run` discovery.

---

## What I verified by running vs. only read

**Ran** (exit codes throughout, never output-greps): 6 test files → **exit 0, 56 passed, 0 skipped**;
`go build ./...` → **exit 0**; operator validation + api + webhook tests → **exit 0**;
`node examples/bun-exec/.output/server/index.mjs` → **exit 1, `ReferenceError: Bun is not defined`**;
`nitro.json` preset read; CRD enum extracted from the generated bundle via a node parser; four
mutations (A red, B green, C green, D red) each with a negative control and a checksum-verified
restore; `grep` exit codes for `Spec.Build`, `config.build` and `.available` consumers; residue check
(`git status` shows no `.parked`/`.orig`, guard and Dockerfile sha256 identical to pre-mutation).

**Read only:** ADR-0036 and ADR-0042 prose; `nextapp_controller.go` beyond the container-command
block; the plan document.

**Did not verify:** live-cluster behaviour. I applied nothing anywhere —`workflow.md` makes cluster
work a queue of one, and both blockers were decidable from the schema and the artifact. The OKE stage
should still confirm the narrowed enum round-trips under `--validate=strict` before release.

---

## Verdict

**SIGN-OFF** on B1–B4 as they stand, subject to MC-1 and MC-2. The ADR-0042 default-flip amendment is
a **founder-owned deliverable due before Phase 5, not before this merge** — escalating it rather than
writing it was the correct call.

Round 2 fixed a real capability error that round 1 only suspected, and it fixed it by running the
artifact instead of re-reading the prose. That is the right instinct and it is what this gate is for.

— architect
