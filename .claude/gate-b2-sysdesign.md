# BLOCK

System-designer design gate on Track B (B1–B4) of
`docs/adr/drafts/bun14-runtime-vinext-builder-plan.md`, reviewed against the working tree
(uncommitted on `main`), 2026-08-26 ~23:05–23:30 EEST.

Three blocking findings. Two are measured by running, one is mutation-proved. The third
escalation trigger (the hard rule) I ruled **not violated**, and I verified that by running.

---

## Ruling on the three escalation triggers

| trigger | ruling |
|---|---|
| 1. amends ADR-0042 Decision 2 | **Not defensible as framed** — see BLOCK-1. The work reclassifies `node + vinext` from "excluded by scope" to "capable but not offered". Measured, the capability claim is **false**. This is a real ADR amendment and must be written as one, carrying the measurement. |
| 2. public API + config schema + CRD | **Approved except the enum value `vinext`** — see BLOCK-2. The additive-at-`v1alpha1` shape is right and the omission-on-the-wire behaviour is correct and tested. Shipping `vinext` in the CRD enum is not. |
| 3. hard rule — "never make anything but the node/official-adapter target the default" | **NOT violated. Verified by running.** `cr-builder.ts:269,298` emits `build` only when set, and `cr-builder-build-axis.test.ts` asserts `"build" in spec === false` (key-absence, not present-as-undefined) both with and without `runtime` set — that suite passes. `build-artifact.ts:29` `DEFAULT_BUILD = "turbopack"`. `validate.ts` accepts absence. The operator has no default for `Build` at all. No default was flipped, on any of the four surfaces. |

---

## BLOCK-1 — `nodeRuntime.accepts` includes a shape node cannot execute. Measured.

The contract's stated invariant is *"no runtime accepts a shape it cannot execute"*
(`artifact-contract.ts:117-123`). Its own two constants violate it, and the repo contains the
artifact that proves it.

**Reproduction (run, exit code):**

```
cd examples/bun-exec
PORT=34567 METRICS_PORT=34568 KNEXT_EAGER_WARM=0 node .output/server/index.mjs
# exit 1
# ReferenceError: Bun is not defined
#   at w.serve (.output/server/_libs/h3+rou3+srvx.mjs:4:2259)
#   at .output/server/index.mjs:3:996
```

`examples/bun-exec/.output/nitro.json` says it plainly: `"preset": "bun"`, and
`commands.preview: "bun run ./server/index.mjs"`. The built entry calls `Bun.serve(...)` at module
top level. `build.sh:101` names the preset in its own log line — *"vinext → Nitro bun preset"* — and
`build-node.sh` is **not** a vinext-on-node arm; it is the turbopack/standalone arm
(`build-node.sh:67` → `.next/standalone/…/server.js`).

So there is **no evidence anywhere in the tree** that `node .output/server/index.mjs` works, and
direct evidence that it does not.

Three things fall with it:

- `artifact-contract.ts:216-219` — `nodeRuntime.accepts: ["next-standalone", "nitro-output"]`.
- `artifact-contract.test.ts:176` — *"both runtimes accept the nitro shape — ADR-0036's shared
  entry"*. This asserts the false claim against a constant, with nothing binding it to reality. The
  reality file (`artifact-contract-reality.test.ts`) binds the turbopack entry and the vinext
  *path*, but never the vinext **runtime** claim — the one half that is wrong.
- Plan §1 (*"both vinext cells share one entry"*) and §4 (*"node+vinext costs nothing extra"*) —
  the load-bearing argument for why the axes separate.

**The design defect underneath, which is the part that belongs to this gate.** `ArtifactShape` is
preset-blind. A nitro `.output` is not one shape: it is one shape *per preset*, and the preset is
chosen **at build time from the target runtime**. That re-couples the two axes at exactly the point
the design claims they separate — `runtime` is an *input to the build*, not merely a parameter of
executing a finished artifact. The interface cannot express it: `BuilderAdapter.emits` is a single
`ArtifactShape`, and `describeArtifact(root)` takes no runtime.

`turbopack` genuinely is runtime-independent (one `.next/standalone`, two ways to exec it), which is
why the abstraction looked sound with one builder in it. The second builder breaks it. That is a
decision to make now, before B3, not after.

**One-line fix (honest, minimal):** drop `"nitro-output"` from `nodeRuntime.accepts`
(`artifact-contract.ts:218`). Consequence to apply with it: `vinext+node` stops being admissible, so
the `"vinext+node"` row in `build-runtime-combination-coverage.test.ts:56` must go too or the
stale-row test fails — that is the guard working, keep it.

**Fix I actually recommend:** split the shape — `"nitro-output-bun" | "nitro-output-node"` — and
give `describeArtifact` the runtime. That records the coupling in the type instead of denying it,
and keeps `isCompatible` total. Then ADR-0042 Decision 2 gets amended with the measurement above:
node+vinext is not "excluded by scope", it is **unbuilt** — no node-preset vinext artifact exists in
this repo.

---

## BLOCK-2 — the CRD admits `build: vinext` and nothing in the cluster rejects it.

`spec.build` ships with `+kubebuilder:validation:Enum=turbopack;vinext`
(`nextapp_types.go:138`). Verified by grep: **nothing in the operator reads `Spec.Build`** — zero
non-test references across `internal/`. It is not read by the reconciler, not by
`validation.ValidateNextAppSpec`, not by the webhook
(`internal/webhook/v1alpha1/nextapp_webhook.go` → `ValidateNextAppSpecCreate`), not by
`computeStatusVerdict`.

The CLI validator is not the gate here, and cannot be. ADR-0001 makes the **operator** the single
source of truth for cluster state, and `security.md`/`CLAUDE.md` §4 already record that GitOps
controllers (Argo CD, Flux) write CRs without going through `kn-next`. Such a user applies
`spec.build: vinext`, the apiserver accepts it, and the operator reconciles a Knative Service as if
the field were not there. With `runtime: bun` it is worse than inert: `nextapp_controller.go:993`
hardcodes `containerCommand = ["bun","run","server.js"]` — the **next-standalone** entry — against
an image built as a nitro output. Silent misconfiguration with no condition, no event, no refusal.

**Answering the brief's question directly: is "known but unavailable" a coherent public schema
state?** In the *CLI config* — yes, and it is well done. `validate.ts:284-311` keeps "unknown" and
"unavailable" as separate branches with different messages, derived from the contract registry
rather than restated; the reasoning in the comment is correct and the tests cover both. In the
*CRD* — **no.** A structural enum has exactly one verb, `admit`, and no way to say "real, but this
cluster cannot run it". The CLI can distinguish; the CRD cannot, so the CRD ends up asserting the
value is usable. Worse under #548: upgrade order is **operator/CRD first**, so a CRD whose enum
admits `vinext` lands in every cluster *before* any CLI that could ever emit it, and stays for that
CRD's life.

**One-line fix:** `+kubebuilder:validation:Enum=turbopack` (`nextapp_types.go:138`), regenerate the
bundle. Widen to `turbopack;vinext` in the same release the operator gains a vinext code path.
Widening an enum is backward-compatible; narrowing one later is not, and a stored object carrying
`build: vinext` would then fail on its next update.

**If the value must ship anyway**, the alternative single line is a rejection in
`validation.ValidateNextAppSpec` (`internal/validation/validate.go:161`) — that one call site covers
both the webhook and the reconcile-time check at `nextapp_controller.go:348`, so it is fail-closed
on both paths — plus a condition in `computeStatusVerdict` per `architecture.md` §4. What is not
acceptable is the current state: admitted everywhere, implemented nowhere, reported by no one.

### On the rest of #548, which the work gets right

`build` is emitted only when set, so a default config's CR is byte-identical to today and an older
CRD sees nothing new — asserted by the key-absence test, which is the correct assertion (`"build" in
spec`, not `!== undefined`, because strict decoding is what an older apiserver actually runs).
`preflightCRSchema` (`schema/preflight.ts:236`) dry-runs the **real** CR, so a user who *does* set
`build` against an old CRD is stopped before the build with the upgrade-order text. Adding
`spec.build` to `EMITTED_CR_FIELD_PATHS` makes `kn-next doctor` **fail** `crd-schema` for anyone
whose operator predates the field, whether or not they use it (`doctor.ts:842-861`) — that is the
honest #548 signal and I am not asking for it to change, but it is a **new red for every existing
install** and needs a release note. None of this is affected by BLOCK-2's fix.

---

## BLOCK-3 — the B4 coverage guard cannot tell a coverage claim from a coverage fact. Mutation-proved.

The brief asks: *can you make it pass while a real combination is uncovered?* Yes.

**Mutation** (anchored script, single-occurrence assert, no `perl`): in
`build-runtime-combination-coverage.test.ts`, change the `"vinext+node"` row from
`state: "not-buildable", why:` to `state: "covered", evidence:` — same prose, now presented as
evidence of a red-on-fail check that does not exist.

```
npx vitest run .../build-runtime-combination-coverage.test.ts
# exit 0 — 8 passed (8)
```

**Negative control**, to prove the harness can see red on this file: rename the `"vinext+bun"` key.

```
# exit 1 — 2 failed | 6 passed
```

Restored byte-identically both times; `shasum -a 256` back to
`2f5732e267280bf85f81d794b292985367b1e4d9d9a1b7113b768027a5b46d83`.

The hole: `evidence` is checked only for `length > 20` (line 119). The file's own docstring cites
`CLAUDE.md` on capability rows that "skipped rather than failed were treated as verified for
months", and then reproduces that class one layer up — a *free-text* claim of a check, with nothing
asserting the check exists. `state: "not-buildable"` has its inverse half (lines 125-137); `state:
"covered"` has none.

**One-line fix:** for each `covered` row, require the evidence to name at least one path that
`existsSync` resolves — the technique `artifact-contract-reality.test.ts:75-90` already uses. E.g.
extract `` /[\w./-]+\.(test\.ts|mjs)/g `` from `evidence` and assert ≥1 match exists on disk.

---

## Non-blocking, but on the record

1. **The tree moved under the gate.** My first `git status --porcelain` (23:05) did not list
   `packages/kn-next/src/cli/build.ts`. By 23:22 it was modified (mtime 23:21:57) and a new
   `packages/kn-next/src/cli/build-artifact.ts` (23:21:07) and
   `build-artifact-resolution.test.ts` had appeared. Someone is implementing in the same worktree
   during the review. `workflow.md` — *"disjoint blast radius is a hard requirement"*,
   *"`isolation: worktree` is mandatory for concurrent implementers"*. A sign-off against a moving
   tree is not a sign-off.
2. **The candidate is currently RED on its own guard.** Running the five named test files:
   `Tests 1 failed | 48 passed`, exit 1 —
   `artifact-contract-reality.test.ts` → *"build.ts now mentions vinext — if it can drive a vinext
   build, flip vinextBuilder.available"*. The new prose in `build.ts:108,126` trips the substring
   check. The guard is doing what it was designed to do; the point is that this work is **not
   green**, and the new `build.ts`/`build-artifact.ts` surface is B5-class work that is neither in
   the brief nor in the plan's §8 completion table.
3. **`build.ts` warns where it should fail.** The new missing-artifact check `log.warn`s and then
   proceeds to the upload/image steps — while citing #857 (*"a build that exits 0 while emitting a
   server nothing can find"*) as its reason for existing. A warning that still ships the image is
   the #857 ordering with better logging. Make it throw.
4. **`resolveBuildArtifact` resolves over `BUILDERS`, not `AVAILABLE_BUILDERS`**
   (`build-artifact.ts:50`), so with the validator bypassed an unavailable builder resolves cleanly
   and only warns. The comment argues the throw is a backstop for a bypassed validator — but the
   backstop is missing for the *unavailable* case, which is the one that exists today.
5. **An overclaimed comment**, which is this repo's named defect class.
   `validate-build-axis.test.ts:77-88` says *"Both halves. `not.toThrow()` alone would pass even if
   a coupling were reintroduced under a different message, so the absence of the coupling is
   asserted directly."* The body asserts only `thrown === undefined`. It is the same assertion as
   the test four lines above it. Either inspect the message or delete the claim.
6. **Nothing keeps the config union and the CRD enum in sync.** `config.ts` `build?: "turbopack" |
   "vinext"` and the kubebuilder enum are two hand-maintained lists of the same thing; the
   `cr-fields` artifacts cover field *paths*, not enum *values*. This is the drift the contract
   exists to end, reintroduced one level down.

---

## What I verified by running vs. by reading

**Ran (branched on exit codes):**
- `node .output/server/index.mjs` under the sample → exit 1, `ReferenceError: Bun is not defined`.
- `cat examples/bun-exec/.output/nitro.json` → `"preset": "bun"`, `"preview": "bun run ./server/index.mjs"`.
- The five named test files → exit 1, 1 failed / 48 passed.
- Coverage-guard mutation → exit 0 (the hole); negative control → exit 1 (harness sees red);
  both restored, checksum-verified.
- `git show HEAD:…/nextapp_types.go | grep -c vinext` → **0**, and only three `XValidation` rules
  exist, none touching `runtime`. **The plan's premise holds: there is no `bun ⇒ vinext` CEL rule.**
  The separation is not built on a false premise.
- `grep` for `Spec.Build` across the operator → zero non-test hits.
- `examples/bun-exec/package.json` → `vinext@1.0.0-beta.4`, `nitro@3.0.260610-beta`. The sample is
  real; the descriptor's *path* is real (`build.sh:66,101`). Only the **node** half of the claim is
  decorative.
- `.output/` is gitignored (`.gitignore:85-86`), so the reality file's strongest assertion — *"the
  entry EXISTS in the built output"* — **skips in CI** and only ever runs on a machine that built
  the sample. Honest about it in the comment, but worth knowing it is not a CI gate.

**Read only:** ADR-0036 and ADR-0042 themselves (I checked the plan's characterisation of them
against the *tree*, not against the ADR text); `docs/RELEASING.md`; the operator's envtest suite.
