# BLOCK

System-designer design gate, **round 2**, on Track B of
`docs/adr/drafts/bun14-runtime-vinext-builder-plan.md`. Working tree (uncommitted, `main`),
2026-08-26 23:45–23:52 EEST.

**Round 1's three blockers: two fully fixed, one fixed in the wrong place.** The fixes are good and
the reasoning behind them is better than what it replaced. Three new blocking items, all
implementer-owned, all small. **The ADR-0042 amendment is explicitly ruled NOT a blocker** — see the
ruling at the end, which is the answer to your direct question.

Everything below was **run**. Checksums recorded before and after every mutation.

---

## Round-1 blockers — re-verified

| R1 blocker | state | how I verified |
|---|---|---|
| BLOCK-1 `nodeRuntime` accepts a shape node cannot execute | **FIXED** | `ArtifactShape = "next-standalone" \| "nitro-output-bun"` (:51); `nodeRuntime.accepts: ["next-standalone"]` (:247); `bunRuntime` keeps both (:262). `artifact-contract.test.ts:176` now asserts **both halves** — bun accepts it *and* `isCompatible(nodeRuntime, artifact)` is `false`, with the reason on the assertion. `vinext+node` gone from the dispositions; vacuity floor moved 4→3 with the measurement in the comment. All 56 tests across the six B-track files pass, **exit 0**. |
| BLOCK-2 CRD publishes `vinext` with nothing cluster-side to reject it | **FIXED** | `+kubebuilder:validation:Enum=turbopack` (`nextapp_types.go:157`), and the regenerated bundle carries `enum: [turbopack]` only. The comment is accurate and self-aware — it names the three places that *don't* reject (webhook, `internal/validation`, the controller's standalone-hardcoded branch) rather than hand-waving, and it states the one-way-door correctly: removing a value from a shipped enum rejects stored CRs. |
| BLOCK-3 B4 evidence check is defeatable | **NOT FIXED — the same defeat still works.** | See NEW-2. The check was added but placed where it cannot see the rows that need it. |

Also re-verified good: the `build.ts`-mentions-vinext tripwire that was red in round 1 has been
**re-anchored, not weakened**. It now keys on the scaffolded `Dockerfile.hbs` not handling `.output`
— with both halves (`.output` absent **and** `.next/standalone` present) — which is a truer proxy
for "available end to end" than a word-grep on `build.ts`. Good call, and the comment explaining why
the old proxy was wrong is correct.

---

## NEW-1 (blocking) — the CRD tells every cluster the CLI enforces something no code does

`nextapp_types.go:124-126`, verbatim in the shipped CRD's `description`
(`apps.kn-next.dev_nextapps.yaml:77`):

> "a builder/runtime pairing that cannot work is **rejected by the CLI against the artifact
> contract**, before a CR is ever emitted."

**Measured — `isCompatible` and `explainIncompatibility` have ZERO production call sites:**

```
grep -rn "isCompatible\|explainIncompatibility" packages/kn-next/src | grep -v __tests__
→ only their own definitions in artifact-contract.ts (:143, :155, :159) and two comments.
```

`validateConfig` checks that `config.build` is a *known* and *available* builder id. It never builds
an artifact, never reads `config.runtime` alongside it, never calls `isCompatible`. The invariant
the module is named for — *"no runtime accepts a shape it cannot execute"* — is enforced **nowhere
in the shipped path**. `build-artifact.ts` doesn't call it either; the only consumer is the B4
coverage enumeration, which is a test.

This is not a stale sentence inherited from an ADR. It is a **new claim, authored in this change,
about this change's own enforcement, and it is false** — written into the artifact that is hardest
to correct later, since it becomes the field description in every installed CRD. The paragraph three
lines above it explains that ADR-0036's `bun ⇒ vinext` CEL rule "was never implemented". Committing
the same defect in the same field's doc comment, while explaining why the first instance was bad, is
the reason this is blocking rather than a nit.

It is not *exploitable* today — `build` can only be `turbopack`, both runtimes accept
`next-standalone`, so no incompatible pairing is expressible. That is exactly why it will not be
caught later: nothing will ever go red on it.

**Fix — pick one, I recommend (b):**

- **(a)** Delete the clause. One line, and it makes the CRD honest.
- **(b)** Make it true, ~6 lines in `validateConfig`, and better design: after the builder checks,
  `const { artifact } = resolveBuildArtifact(config, cwd)`, resolve the runtime adapter from
  `config.runtime ?? "node"`, and `const why = explainIncompatibility(rt, artifact); if (why)
  errors.push(why)`. That gives `isCompatible` a production caller and turns the contract from a
  description into the seam the plan says it is. **A contract nobody calls is an enumerated table
  with better typing** — which is the thing B1 exists to replace.

---

## NEW-2 (blocking) — R1's BLOCK-3 is not closed; the defeat moved, it did not die. Proved.

The evidence check now regex-extracts filenames and asserts they exist — and it **works where it
runs**. Negative control, an available row citing a bogus file:

```
"cli-build-bun-bytecode.test.ts" → "no-such-file-anywhere.test.ts"
npx vitest run …/build-runtime-combination-coverage.test.ts
→ exit 1  "turbopack+bun cites 'no-such-file-anywhere.test.ts', which does not exist"
```

But it is inside `for (const c of combos.filter((x) => x.available))` (line 118). Only **available**
builders reach it — and available builders are precisely the rows that are genuinely covered. Every
row where a fabricated coverage claim would actually matter is unreachable:

- `"has a declared disposition"` — passes, it is defined.
- `"every AVAILABLE combination is covered"` — skips it, `vinext.available === false`.
- `"'not-buildable' is only claimed for unavailable builders"` — skips it, the row is no longer
  `not-buildable`.
- `"no disposition for a non-admissible combination"` — passes, `vinext+bun` is admissible.

**Mutation A** — relabel `vinext+bun` `not-buildable → covered`, prose untouched (the same defeat I
ran in round 1, retargeted to the row that still exists):

```
exit 0 — 7 passed (7)
```

**Mutation B** — the strong form, to show the evidence check is genuinely unreachable, not merely
satisfied by the prose's incidental `knext-bun-entry.mjs`:

```
"vinext+bun": { state: "covered", evidence: "fully covered, trust me, no file cited whatsoever" }
exit 0 — 7 passed (7)
```

Both restored byte-identically (`shasum -a 256` → `20ae6094…82f6…b0b0`), negative control confirms
the harness sees red on this file.

**Fix (one move):** hoist the cited-file assertion out of the availability loop. Iterate
`Object.entries(DISPOSITIONS)` and apply it to **every** row with `state: "covered"`, regardless of
`available`. The availability filter still belongs on the *"must be covered"* rule — an unavailable
combination may legitimately be `not-buildable` — but it must not gate the *"a coverage claim must
name a real check"* rule. Those are different assertions and only one of them is about availability.

---

## NEW-3 (blocking) — the refuted claim is still asserted, in prose, on the constants that refute it

`artifact-contract.ts` fixes the code and leaves the disproven text sitting on it:

- **`vinextBuilder` docstring, :199-203** — *"The entry is nitro's **node-server preset** output.
  ADR-0036 records that BOTH vinext cells share this one entry — `node .output/server/index.mjs` for
  node, the `--compile`d binary for bun — which is exactly why the runtime is a parameter of
  executing this shape…"* This is the exact false claim, verbatim, on the constant whose value is
  now `nitro-output-bun`.
- **`nodeRuntime` docstring, :225-233** — *"Node executes **both shapes**: … the nitro output runs
  directly under `node .output/server/index.mjs`. ADR-0042 Decision 2 *excluded* node+vinext, but
  that was a scope reduction, **not a capability finding**…"* Directly contradicted by the inline
  comment **four lines below it** and by `accepts: ["next-standalone"]`. The file states both
  positions within ten lines.
- **:56, a botched global rename** — *"An earlier version of this type had a preset-blind
  `"nitro-output-bun"`"*. The earlier version was preset-blind `"nitro-output"`; the replace swept
  the historical narrative, so the paragraph explaining the fix now describes a shape that never
  existed.
- **The draft plan, unchanged since 23:14** — §1 *"vinext → one shared in-process entry (**both**
  node+vinext and bun+vinext)"* and §4 *"**`node + vinext` costs nothing extra.** … so admitting
  node+vinext is a parameter, not an implementation."*

This module's own header says it exists because *"ADR-0036 and ADR-0042 confidently describe a CRD
field, a CEL rule and a config axis that do not exist, and nothing noticed because no test compared
the prose to the tree."* Leaving the refuted prose on the very constants that refute it reproduces
the defect inside the module built to end it, and `CLAUDE.md` §9's standing instruction on stale
claims is *fix, don't propagate*.

The draft plan matters most, and it connects to your ADR question: **it is the document from which
the ADR amendment will be written, and the founder is being asked to rule using §4's refuted
premise.** Correcting it is yours, not theirs.

**Fix:** rewrite the two docstrings to match the constants, repair :56, and correct plan §1/§4 to
state the measurement (`preset: bun`; `node …/index.mjs` exits 1). Mechanical, no code change.

---

## Your direct question: does the ADR-0042 amendment have to land first?

**No. The code can proceed with it outstanding. It is not a merge blocker, and I do not think it is
an amendment at all any more.** Reasoning, in order:

1. **The contradiction that created the obligation no longer exists in the code.** The amendment was
   owed because round 1's contract *reclassified* `node + vinext` from "excluded by scope" to
   "capable but not offered" — asserting a capability ADR-0042 had removed. The current tree asserts
   the opposite: `node` accepts only `next-standalone`, `vinext+node` is not an admissible
   combination, the CRD publishes only `turbopack`, and the config value is rejected at validate
   time. **The tree now claims strictly less than ADR-0042 does, not more.** An ADR amendment is
   owed when code contradicts a decision. Agreeing with a decision for a stronger reason than it
   gave is not a contradiction.
2. **The default-flip half was never engaged.** ADR-0042 Phase 5 flips the default to `bun + vinext`;
   this change flips nothing and does not advance Phase 5. Re-verified this round: `cr-builder.ts`
   emits `build` only when set (the key-absence test passes, and it correctly asserts `"build" in
   spec === false` rather than `!== undefined`, which is what strict decoding actually sees);
   `build-artifact.ts:29` `DEFAULT_BUILD = "turbopack"`; the operator has no default at all. **The
   hard rule — "never make anything but the node/official-adapter target the default" — remains
   intact on all four surfaces.** Nothing here needs a founder decision.
3. **What is owed to the founder is a finding, not an amendment — and it is not yours to withhold
   either.** ADR-0042 Decision 2's rationale ("a scope reduction, not a capability finding") is now
   known to be *understated*: node+vinext is additionally **unbuilt and unverified** against the only
   vinext artifact this repo produces, measured. That makes the founder's decision more right, not
   less. Recording a measurement against an ADR is not amending it, and it does not require anyone's
   permission. You have surfaced it, which is the correct call on the amendment; the measurement
   itself should go in as a dated note either way so the next person does not re-derive it from
   prose, exactly as this round did.

**So: ship the code when NEW-1..3 are fixed; let the ADR follow at the founder's pace.** The one
thing that must not follow later is NEW-3's plan correction — a founder asked to rule on `node +
vinext` while §4 still reads *"costs nothing extra"* is being asked the wrong question.

---

## Non-blocking, on the record

1. **Nothing binds the shape name to the sample's actual preset.** The entire round-1 fix rests on
   `.output/nitro.json` → `"preset": "bun"`, and the only record of that in the tree is a comment.
   Flip `examples/bun-exec` to nitro's node-server preset and `emits: "nitro-output-bun"` silently
   ossifies. The failure direction is conservative (over-restrictive, not crash-on-boot), so this is
   not a safety hole — but the durable guard is cheap and runs in CI, unlike the `.output`-gated
   one: assert `build.sh` names the bun preset (it does, `build.sh:101` — *"vinext → Nitro bun
   preset"*), mirroring how the turbopack half is anchored on `node-server.ts` source. That converts
   the measurement from a comment into a check.
2. **A second CRD of record drifts.** `packages/scale-zero-pg/demo/operator/kn-next-operator-install.yaml`
   embeds a hand-committed CRD copy with no `build`. **Pre-existing, not introduced here** — it is
   already missing `warmSchedule` and `database` (last touched in #638). Installing from it and then
   setting `build` fails closed with a named field, so it is correct-if-noisy. Worth a separate
   issue: either generate it or delete it.
3. **A leftover sentence in the CRD comment.** *"Any value of Build is admissible with any value of
   Runtime"* describes a two-valued field that no longer exists on the wire. Harmless, but it is the
   half of the paragraph that survived the narrowing; fold it into the NEW-1 edit.
4. **`resolveBuildArtifact` resolves over `BUILDERS`, not `AVAILABLE_BUILDERS`** — unchanged from
   round 1. Its comment argues the throw is a backstop for a bypassed validator, but the backstop
   covers only the *unknown* case, not the *unavailable* one, which is the case that exists today.
   NEW-1's fix (b) would naturally close this.
5. **`build.ts` still warns where it should fail** — unchanged from round 1. The missing-artifact
   check `log.warn`s and proceeds to the upload/image steps, while citing #857 (*"a build that exits
   0 while emitting a server nothing can find"*) as its reason for existing.

---

## Process: the tree moved again, and it briefly held a fabricated coverage claim

Round 1 recorded files being written mid-gate. It happened again, and this time it is worth stating
precisely because of *what* the tree contained.

I checksummed all 169 files under review at 23:45 before touching anything. At **23:48:12** — after
my last verified restore — `build-runtime-combination-coverage.test.ts` was found at
`f461c000…`, holding **mutation-A content**: `vinext+bun` relabelled `state: "covered"` with the
not-buildable prose as its evidence. I detected it by checksum, restored at 23:51:30, and re-verified
the **entire** 169-file snapshot: zero mismatches, guard green at exit 0.

I cannot attribute it with certainty — an external writer in the shared worktree, or a race with my
own restore. I am not claiming it was someone else. What I will say is the part that generalises:
the file is **untracked**, so `git status` and `git diff` are blind to residue in it, and only the
checksum caught it. Had it merged, `vinext+bun` would ship **declared covered** by a sentence that
is actually an explanation of why it is *not* buildable — the exact fabricated-coverage state
NEW-2 says the guard cannot detect, arriving by accident rather than by intent. Round 1's
`workflow.md` finding stands: **a gate cannot sign a tree that is moving under it**, and concurrent
implementers need `isolation: "worktree"`.

---

## Verified by running vs. read only

**Ran, branched on exit codes:**
- Six B-track test files → **exit 0**, 56/56.
- Mutation A (relabel `vinext+bun` → covered) → **exit 0**, 7/7. Restored, checksum-verified.
- Mutation B (covered, zero files cited) → **exit 0**, 7/7. Restored, checksum-verified.
- Negative control (available row cites a bogus file) → **exit 1**, correct message. Restored.
- `grep` for `isCompatible|explainIncompatibility` outside `__tests__` → definitions only, **no
  production caller**.
- `Enum=turbopack` in `nextapp_types.go:157` **and** `enum: [turbopack]` in the regenerated bundle —
  the two agree.
- The false CLI-enforcement sentence present verbatim in the bundle at
  `apps.kn-next.dev_nextapps.yaml:77`.
- Repo-wide search for CRD copies → three files; the demo bundle's pre-existing drift confirmed by
  field-presence counts.
- Full 169-file checksum verification, twice.

**Read only:** ADR-0036 and ADR-0042 themselves (as in round 1, I check the plan's characterisation
of them against the **tree**, never against the ADR text); `docs/RELEASING.md`; the operator envtest
suite. I did **not** re-run `node examples/bun-exec/.output/server/index.mjs` this round — you
reproduced it independently and the fix is consistent with it.
