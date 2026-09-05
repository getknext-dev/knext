# BLOCK

Architect design gate — Track B (B1–B4) of `docs/adr/drafts/bun14-runtime-vinext-builder-plan.md`.
Reviewed the working tree on `main` (uncommitted), per the brief. Nothing was modified, committed or
pushed.

The separation is the right idea and its central premise checks out. It is blocked on **one wire-surface
defect** and **one undischarged ADR obligation**, both cheap now and expensive after a CRD ships.

---

## Ruling on the three escalation triggers

### Trigger 1 — amends ADR-0042 Decision 2. **FIRES. Not discharged.**

The capability-vs-policy framing is **defensible and correct**, and I re-derived it rather than
accepting the plan's word. ADR-0042 (`0042-…md:65-67`) says in its own voice:

> **`node + vinext` is NOT a supported cell under this ADR.** It carries most of vinext's boot win,
> and it is still rejected, because it produces no bytecode.

That is a purpose-based exclusion of a cell the ADR concedes *works* (it even quotes its ~317 ms
measurement). So `nodeRuntime.accepts` including `nitro-output` is not a contradiction of ADR-0042 —
the contract describes capability, the ADR expressed policy. Good.

**But B2 was the designated place to record the policy, and it recorded nothing.** The contract's own
doc comment (`artifact-contract.ts:211-214`) says: *"Whether the pairing is offered to users is a
separate, policy question that belongs with the config key in B2, not here."* B2 is here. Searched:
nothing in `validate.ts`, the CRD, the webhook, or `internal/validation/validate.go` carries the
ADR-0042 exclusion, and `build-runtime-combination-coverage.test.ts:57-60` dispositions
`vinext+node` as `not-buildable` — a **capability** statement — where ADR-0042's reason is
**policy**. Today the exclusion is masked because `available: false`. The day that flag flips,
`node + vinext` becomes selectable and no ADR was ever amended.

Second, unflagged, half of this trigger: the plan's §3 recommendation that *"default stays
`node + turbopack`"* directly contradicts **ADR-0042 Decision 1 and Decision 5** (adopt
vinext + `--compile --bytecode` as the default; flip at Phase 5). The **code** flips nothing — see
Trigger 3 — so this is a documentation obligation, not a code defect. But adopting that
recommendation *is* an ADR-0042 amendment and there is no ADR recording it. A plan draft is not an
ADR (`architecture.md` §3).

ADR-0042 **Decision 3** ("one config surface, one CRD, one operator, one `RuntimeContract`… if the
vinext path ever needs its own CRD, operator, or config, this decision is invalid") is **not**
violated: this is one added field on the same CRD, not a second one. Checked explicitly.

### Trigger 2 — public API + config schema + CRD. **FIRES.**

- **Config key** (`config.ts:290`) — additive, optional, absence = `turbopack`, documented, and
  tested on both halves. **Clean.**
- **CRD field** (`nextapp_types.go:139`, generated into the bundle) — additive and optional, but the
  **enum over-publishes**. See Blocker 1. This is the part I am blocking on.

### Trigger 3 — *"never make anything but the node/official-adapter target the default."* **NOT VIOLATED. Claim upheld.**

Verified by running, not by reading:

- `cr-builder-build-axis.test.ts` asserts `"build" in spec === false` for a default config, **and**
  the inverse half — absent even when `runtime` *is* set (`:49`), and the rest of the spec byte-equal
  (`:79-85`). 49/49 green, exit 0.
- `grep -n "config\.build"` over `cli/build.ts` and `cli/deploy.ts` → **no hits**. Nothing in the
  build or deploy path reads the key.
- `grep -n "\.Build\b"` over `internal/` → hits only in unrelated `fake.NewClientBuilder().Build()`.
  The operator applies no default.

No default was flipped, in code or on the wire.

---

## The premise the whole separation rests on — **VERIFIED TRUE**

The brief's sharpest question: if a `bun ⇒ vinext` CEL rule exists, the separation is built on a
false premise. It does not exist.

```
git show HEAD:…/apps.kn-next.dev_nextapps.yaml | grep -c vinext   → 0   (exit 1)
```

The only `XValidation` markers in `nextapp_types.go` are on `env` (C_IDENTIFIER, reserved names) and
`database` (`roSecretRef` requires `secretRef`). ADR-0036's "enforced fail-closed by CEL admission"
describes a rule that was designed and never written. The plan's §0 correction table is accurate.

`examples/bun-exec` is **not** decorative either — also verified by running: `vinext@1.0.0-beta.4` is
a real dependency, `.output/server/index.mjs` exists **on disk**, `build.sh` names it, and
`knext-bun-entry.mjs` exists and matches `/nitro/i`. The `.skipIf` in
`artifact-contract-reality.test.ts:75` did **not** skip here (49 passed, 0 skipped) — the strongest
form of that assertion actually ran.

---

## Blocker 1 — the CRD publishes `vinext` cluster-side with no consumer, no refusal, and shape-blind execution

**Reproduction** (all steps confirmed mechanically, exit codes not output-greps):

1. The bundled CRD admits it. Extracted from the generated schema, not read off the marker:
   `spec.build enum admitted by the CRD: [ 'turbopack', 'vinext' ]`, with no
   `x-kubernetes-validations` on or near the field.
2. Nothing rejects it cluster-side. `internal/validation/validate.go` — `grep -c Build` → **exit 1,
   zero hits**. The webhook (`nextapp_webhook.go:59-80`) validates only the ADR-0019 `DATABASE_URL`
   collision rule.
3. Nothing consumes it. Outside `nextapp_types.go` and the CRD bundle, the string `vinext` appears in
   the entire operator exactly **once** — inside a Go comment. No controller code, no
   `computeStatusVerdict` branch, no test.
4. And the operator's only shape-aware logic is **hardcoded to the standalone shape**:

   ```go
   // nextapp_controller.go:991-995
   if nextApp.Spec.Runtime == "bun" {
       containerCommand = []string{"bun", "run", "server.js"}
   }
   ```

So a `NextApp` carrying `build: vinext` + `runtime: bun` is **stored and reconciled into
`bun run server.js`** — a spawn command for an artifact the contract itself declares
`execution: "in-process"` with entry `.output/server/index.mjs`. No condition, no event, no refusal.

The defence "the CLI validator rejects `vinext`" does not hold here, and this repo has already ruled
on why: `CLAUDE.md` §4 states plainly that **GitOps controllers (Argo CD, Flux) do not assert strict
validation** and that a client-side guarantee is not the platform's guarantee. `architecture.md` §4
makes the operator the single source of truth for cluster state. A validator living in a TypeScript
module in the CLI is precisely the enforcement that section says is insufficient.

This is also the direct answer to the brief's availability-split question. **"Known but unavailable"
is coherent in the TS config type and incoherent on the wire.** In `validate.ts` the distinction is
carried by two genuinely different error messages — that is good UX and I would keep it verbatim. In
a CRD enum there is no validator to carry it: the enum *is* the whole statement, and it currently
says "the platform accepts this," which is false.

**One-line fix:** narrow the CRD marker to what the platform can execute —

```go
// nextapp_types.go:138
- // +kubebuilder:validation:Enum=turbopack;vinext
+ // +kubebuilder:validation:Enum=turbopack
```

then `make manifests` and refresh `docs/compat/cr-fields.*`. Leave `config.ts` and the artifact
contract exactly as they are: the TS type keeps `vinext`, the validator keeps the two-message
distinction, and the value never reaches the wire. Widen the enum in B3, in the same change that
teaches the operator the shape.

Do this **now, not in B3**: removing an enum value from a shipped CRD rejects CRs that were
previously storable — a breaking change at `v1alpha1`. Adding one later is additive and free. The
asymmetry decides the ordering.

## Blocker 2 — ADR-0042's `node + vinext` exclusion is dropped without an amendment

Per Trigger 1. **Fix (one of two, your call, and it is a real decision not a formality):**

- **(a)** Amend ADR-0042 — a dated amendment recording that Decision 2's exclusion is retired because
  the contract shows the cell is capable, and that Decision 1/5's default flip is superseded by
  "default stays `node + turbopack`"; **or**
- **(b)** Keep the exclusion and record it where it can be enforced — re-word the `vinext+node`
  disposition from `not-buildable` to an explicit policy state citing ADR-0042 Decision 2, so the day
  `available` flips the guard fails and forces the decision rather than silently granting it.

Either is fine. Silence is not: the exclusion currently survives only as an accident of
`available: false`.

---

## Advisory (not blocking)

**A1 — the combination-coverage guard's `covered` evidence is unverified prose. It cannot go red when
its subject is deleted.** `build-runtime-combination-coverage.test.ts` imports only `vitest` and
`../adapters/artifact-contract` — **no `fs`** — so `expect(d.evidence.length).toBeGreaterThan(20)`
is a check on *characters*, not on coverage. Delete `cli-build-bun-bytecode.test.ts` and this guard
stays green while `turbopack+bun` is genuinely uncovered. That is this repo's named defect class
(`workflow.md`: "a guard that stays green when its subject is removed is decoration"). I did not
mutate to prove it — the absence of an `fs` import is a stronger, static proof, and the brief forbids
touching the tree. *(I confirmed all six named evidence files exist today; the guard just isn't what
establishes that.)* **Fix:** make `evidence` a `readonly string[]` of repo-relative paths and assert
`existsSync` on each. Mutation-prove by renaming one path.

The rest of that guard is genuinely good: it enumerates from the contract, has an explicit
anti-vacuity assertion (`:95`), and — unusually for this repo — carries the **inverse half** at
`:125` (a `not-buildable` claim fails if the builder is available) and the **staleness half** at
`:139`. Only the evidence link is weak.

**A2 — `BuildArtifact` cannot express the bun+vinext path's real runnable.** The descriptor models one
`entry` + `root`. But `examples/bun-exec/build.sh` shows the shipped artifact is a `--compile`d
binary **plus `.output/public` anchored on the executable's own directory, not the cwd** — and
`RUNTIME_BASENAMES` in `runtime-contract.mjs` classifies by basename. The contract has no static-asset
root and no post-compile entry, so B3 will discover this at `docker run`, which is exactly the #857
ordering the module's own header cites. Extend the interface in B3's design, not its implementation.

**A3 — `doctor` will now fail `crd-schema` for every CLI-first upgrader who sets nothing.**
`doctor.ts:853-860` diffs the *static* `EMITTED_CR_FIELD_PATHS` against the live CRD, so adding
`spec.build` reds that check on an older operator regardless of config. I checked whether this leaks
into `deploy`: it does **not** — `preflight.ts:236` decides the verdict from the **real** server-side
dry-run and only uses the static list to *name* fields after a failure. So a default config still
deploys clean. The doctor red is correct per #548 and its remediation text already says
"upgrade the OPERATOR/CRD FIRST" — just make sure the release notes say it too, or it reads as a
regression.

---

## What I verified by running vs. only read

**Ran** (exit codes, per the brief's discipline): the five new test files — `vitest run … --reporter=dot`
→ **exit 0, 5 files, 49 passed, 0 skipped**; `go build ./...` → **exit 0**;
`go test ./internal/validation/... ./api/...` → **exit 0**; `git show HEAD:<crd> | grep -c vinext`
→ **0 (exit 1)**; `grep -c Build internal/validation/validate.go` → **exit 1**; enum extraction from
the generated CRD via a node parser; existence checks on all six named evidence files and on
`examples/bun-exec/.output/server/index.mjs`; `node -e` read of the sample's `vinext` dependency
version.

**Read only:** ADR-0036 and ADR-0042 prose; `node-server.ts`'s supervisor internals; the plan
document; `nextapp_controller.go` beyond the container-command block.

**Did not verify:** behaviour against a live cluster. I did not apply the modified CRD anywhere —
`workflow.md` makes cluster work a queue of one, and Blocker 1 is decidable from the schema. Before
merge, the OKE stage should confirm the narrowed enum round-trips under `--validate=strict`.

---

## What to do

Fix Blocker 1 (one marker + `make manifests` + regenerate `docs/compat/cr-fields.*`), resolve
Blocker 2 (a) or (b), and return for a re-read. A1 and A2 can ride along or land in B3; A3 is a
release-note line. B1, B3 and B4 are otherwise sound work and I would sign those off as they stand —
the block is scoped to B2's wire surface and the ADR record.

— architect
