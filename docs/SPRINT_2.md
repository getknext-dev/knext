# Sprint 2 — make the compat window mean something

> Planned by the architect and system-designer gates under `.claude/rules/workflow.md`.
> Sources: `.claude/verdicts/sprint2-architect.md`, `.claude/verdicts/sprint2-sysdesign.md`.
> Plan: `docs/V1_ROADMAP.md`. Predecessor: `docs/SPRINT_1.md`.
> **Source manifest at the bottom** — every source section is reproduced or explicitly declined
> there. Sprint 1's synthesis silently dropped four sections; an absence must be visible.
> If this disagrees with the code, the code wins — say so.

## The fact that shapes the sprint

**The compat window is the 1.0 critical path, and as specified today it is unfalsifiable.**

The v1.0 definition of green is *14 consecutive scheduled node-lane runs with the harness unchanged*.
Nothing in the repo records what "unchanged" means or proves it held. The window would be policed by
a human reading a log they also wrote. Two mechanisms silently void it:

1. **No branch protection on `main` (#555).** Every CI gate is advisory, so a red PR can merge
   mid-window. Scheduled-run *verdicts* are unaffected — but what the scheduled run *builds* is
   whatever landed on `main` that day.
2. **The freeze scope was never defined.** Sprint 1 proves the hole: it scheduled Track E
   (`adapters/shutdown.ts`) and Track C1 (`src/cli/`) concurrently with opening the window, and
   `test-e2e-deploy.yml:189-192` builds and packs **`@getknext/lib` + `@getknext/db` +
   `@getknext/core`** as the adapter under test. Under any literal reading both tracks reset the
   clock. Sprint 1 did not notice.

**Verified, not assumed.** The compat *harness* is `test-e2e-deploy.yml` + `scripts/e2e-*.sh` +
`test/deploy-tests-manifest.knext.json` + the packed `@getknext/*` closure. `compat-smoke.mjs` is a
**different gate**, in `ci.yml`, app-side. That distinction decides most of this sprint's scope.

**Sprint 1 status:** landed T0 (#553), T11 partial (#556), the T10 amendment (#557). `docs/compat/`
contains no window log — **T3 never opened the window.** 3 of 17 tasks landed. Sprint 2 is mostly
carryover and is scoped that way deliberately.

## Tasks

| id | task | issue | track | owner-exclusive files |
|---|---|---|---|---|
| S1 | window fingerprint: prove the harness identical across 14 nights | #545 | G (gate-zero) | `test-e2e-deploy.yml`, new `tests/compat-window-*.ts`, fingerprint script |
| S2 | open + police the window to completion (no code) | #410 | G (lead) | `docs/compat/window-node-lane.md` |
| S3 | branch protection on `main` | #555 | G (**human**) | — |
| S4 | **DONE (#570)** — ADR-0017 amendment — CRD versioning at 1.0 | — | H | `docs/adr/0017-*`, `docs/PUBLIC_API.md` |
| S5 | ADR-0036 close-out — rejected for 1.0 (measured) | — | H | `docs/adr/0036-*` |
| S6 | **DONE (#567)** — upgrade order: operator/CRD first, then CLI | #548 | H | `docs/adr/0020-*`, `docs/RELEASING.md` |
| S7 | **DONE (#571)** — close the four unbacked matrix rows | — | I | `compat-smoke.mjs`, `ci.yml`, `docs/compat-matrix.md`, one app fixture route |
| S8 | benchmark provenance: same app, recorded endpoint, tied build flags | #551 | K | `benchmarks/scale-to-zero-oke/**` |
| S9 | the 1.0 cold-start statement — across sittings, stratified | #309 | K | `docs/benchmarks/scale-to-zero-oke.md` + OKE runs |
| S10 | **DONE (#572)** — prune preflight + generated CR/CRD artifacts (T5/T6/T7 carryover) | #314 | J | `src/cli/schema/*`, `deploy.ts`, `preview.ts`, `doctor.ts`, `scripts/gen-*` |
| S11 | webhook-down deploy freeze: skew + upgrade-under-load e2e | #314 | L | operator e2e, `config/webhook/**` |
| S12 | docs closure nightly RED | #465 | H | docs-site closure job |
| S13 | **DONE (#568)** — SIGTERM-during-revalidation + cache-handler failure injection | #448 | M (**merge-held**) | `adapters/shutdown.ts`, `adapters/cache-handler.js` |

**Critical path:** `S1 → S2 → 14 nights`, in parallel with `S8 → S9`. Both land near sprint end and
both are 1.0 gates.

**Deliberately out of scope** (recommend, do not carry): EKS #306 — carry the *credential request*,
not the work; `kn-next status --explain` — S9 must produce the data it joins before its shape is
decidable, and that surface is 1.0-committed, so building it now freezes the wrong thing; #528's
remaining workflow pins *except* `test-e2e-deploy.yml`, which S1 pins in the same edit so there is
exactly **one** pre-window touch of that file; all P2/P3.

## Dependency edges

An edge means B's exit criteria depend on A's *behaviour*.

- **S1 → S2.** S2's log is meaningful only if S1's fingerprint exists to populate it. Opening first
  and adding the fingerprint later means editing `test-e2e-deploy.yml` mid-window.
- **S1 → S10, S1 → S13.** S1's freeze scope decides whether each may merge during the window. Not
  conceptual — the merge gate literally reads S1's path list.
- **S8 → S9.** S9 cannot publish a 1.0 statement from runs whose endpoint and app identity are
  unrecorded. That is exactly the defect Run 26 exposed.
- **S4 → S10's `apiVersion` assertion.** S10 asserts the emitted `apiVersion` equals the
  ADR-declared one; there is no declared one until S4 is accepted.
- **S3 → nothing formally, but it protects everything.** No edge, maximum leverage.

**Not edges:** S7 ⊥ S1 (different gate, different workflow). S11 ⊥ S10 (operator-side vs CLI-side;
they fail differently and independently). S5 depends on nothing — holding it for another benchmark
is the failure mode it exists to end.

## The three decisions this sprint makes

### D-1 · Freeze scope — the decision that gates the sprint's capacity

**Freeze the adapter-executed surface, explicitly excluding `dist/cli/**`,** proven by a guard
asserting the adapter entry's transitive import closure contains no `dist/cli/` file.

Checked rather than assumed: `package.json` does export `./internal/cli-validate` and
`./internal/cli-shared` from `dist/cli/`, so the exclusion is not free. But `next-adapter.ts` imports
only node builtins, `next` types, and `./standalone-bun-exports` — the adapter closure genuinely does
not reach `dist/cli/`. The guard is what keeps that true, and it also catches future drift through
those two subpaths.

Without this exclusion, S10 — the largest remaining P1 item — cannot land until the window closes and
sprint 2 has almost no capacity.

**This needs an ADR.** What the 14-night guarantee covers, what resets it, and why `dist/cli/**` is
excluded, is a significant decision governing the north-star gate and currently exists only as prose.

### D-2 · ADR-0036 / bun-exec — close as *Rejected for 1.0 (measured)*

Not held open pending a same-app rerun. The comparability defect is real and plausibly biased
**toward node**, so a fair rerun could move toward bun — that is the strongest argument for keeping
it open, and it still loses:

- **It cannot fix the dominant risk.** The threat is the ~10.5 s regime, which fires in *both* arms
  within one pair of each other. It is cluster-level, not runtime-level. A target moving the fast
  mode by 0.07 s buys nothing against it.
- **The cost is structural** — a bespoke bun entry re-providing `RuntimeContract`, loss of
  `next/image` under vinext, and a bun compat lane that has never been green. `architecture.md` §4
  permits it only as an opt-in **compat-gated** target; it has no green gate, so it is not shippable
  regardless of the benchmark.
- **An indefinitely-open ADR is an attention tax** on a target nobody is authorised to ship.

Keep `examples/bun-exec` as an example, not a target. Publish a **named, falsifiable re-open
trigger**: a same-app, same-endpoint, provenance-verified interleaved A/B showing distribution
separation. The rerun is not sprint-2 work; the harness fix that would make it trustworthy (S8) is,
and earns its place independently.

### D-3 · S10's RBAC tension — resolved, not deferred

Sprint 1 recorded an apparent contradiction: the prune preflight must fail **hard** when the schema
read is denied, but reading the live CRD needs cluster-scoped `get customresourcedefinitions`, which
restricted kubeconfigs lack — implying a namespace-scoped user cannot deploy at all.

**The premise dissolves: the safety verdict does not require reading the CRD.** It requires knowing
whether *this* CR would be stored intact by *this* apiserver, and a **server-side `dryRun=All` apply
with `--validate=strict`** answers exactly that, using **precisely the permissions `deploy` already
needs**. This is measured, not hypothesised — it is how V1_ROADMAP §2.1's correction was established.

**Three-tier preflight. No new RBAC. No new CLI flag. Hard failure preserved.**

1. **Tier 1 — verdict.** `dryRun=All` + `--validate=strict` as the *first cluster-touching step*.
   Requires `create`/`patch` on `nextapps` in-namespace. No kubeconfig can deploy but not preflight,
   so hard failure costs nothing: it can only be denied where the deploy would also be denied.
2. **Tier 2 — diagnosis** (best-effort, no cluster-scoped RBAC). Read the structural schema from the
   aggregated **OpenAPI v3 discovery** document. **Must be verified against a real restricted
   kubeconfig — an explicit exit criterion, not an assumption.** If denied, degrade to parsing the
   apiserver's own `unknown field "…"` message, which already names the field.
3. **Tier 3 — enrichment.** `kubectl get crd` when permitted. `doctor` may skip; its skip is visible.

**Failure of tiers 2–3 degrades the message, never the verdict.** That is what makes "hard failure on
denial" and "namespace-scoped users can deploy" compatible rather than opposed.

## Contract statements — what a user may rely on, and what just broke

The section sprint 1's synthesis lost entirely. Every task changing a contract owes both halves.

| task | may now rely on | what just broke |
|---|---|---|
| S10 | **DONE (#572)** — a deploy either stores the CR intact or fails; no silent pruning | deploys that previously "succeeded" while losing fields now exit non-zero; a reserved exit code is added to `PUBLIC_API.md` |
| S10 | **DONE (#572)** — **no new RBAC** — preflight needs only what deploy needs | nothing; stated because the opposite was assumed |
| S4 | **DONE (#570)** — a declared CRD version policy for 1.0 | `apiVersion` is now asserted, so emitting an undeclared one fails |
| S6 | **DONE (#567)** — documented upgrade order: operator/CRD first, then CLI | upgrading CLI-first is now explicitly unsupported rather than undefined |
| S1 | "green" names a specific frozen artifact set | any change inside that set restarts the 14 nights |
| S7 | **DONE (#571)** — four capability rows backed by red-on-fail checks | apps relying on a row that only ever skipped may now fail CI |
| S13 | **DONE (#568)** — ISR revalidation is never torn by SIGTERM | shutdown may take longer; drain ordering becomes load-bearing |

### The contract nobody has written down

**`NetworkPolicy: True` — what does it assert?** `spec.security.networkPolicy` is default-on and the
operator reports success when the object is *created*. On a cluster whose CNI does not enforce
NetworkPolicy, the object exists, enforces nothing, and the CR still says `Ready=True`.

**Recommendation:** keep the condition meaning **created**, *rename it so it cannot be misread as
enforcement*, and make enforcement a **probed exit criterion per platform** in the platform matrix,
not a per-CR condition. A condition claiming enforcement it never verified is a new entry on the
silent-failure list — the list 1.0 exists to shorten.

## Silent failure modes — the "silently useless" list

For each task, the one way it is marked done and still protects nobody.

| task | silently useless if | required assertion |
|---|---|---|
| S1 | the fingerprint covers files nobody changes and misses the packed closure | mutate a packed `@getknext/*` file → fingerprint changes → window flagged |
| S2 | the log records runs but never proves the fingerprint held | each night's entry carries the fingerprint; a mismatch voids the window loudly |
| S7 | **DONE (#571)** — a row's check skips on the path that matters | delete the capability → the check goes **red**, not skipped |
| S8 | the harness records provenance but the arms still differ | arms assert identical app digest; run aborts otherwise |
| S9 | a statement is published from one sitting | refuse to publish without ≥2 sittings, stratified |
| S10 | **DONE (#572)** — the preflight warns instead of failing, or runs after assets upload | skew-inducing CRD → non-zero exit **and the bucket unchanged** |
| S11 | the e2e passes because the webhook was never actually down | assert the webhook is down, then assert deploy freezes |
| S13 | **DONE (#568)** — injection tests exercise only the clean-shutdown path | kill mid-write → cache entry is absent or whole, never partial |

### Two silent modes worth naming separately

- **Deploy ordering (verified).** `uploadAssets` at `deploy.ts:332`, `resolveDigest` at `:429`, apply
  at `:500`. Since #547 a skew-affected apply hard-fails **after** assets are in the bucket, leaving
  orphaned assets for a build that never became a revision. GC reclaims them, so this is waste not
  corruption — but the user's first experience of the new hard failure is "it failed *and* it wrote
  things." **S10 must run the preflight before `uploadAssets`**, asserted by "bucket unchanged."
- **Torn writes are the common path.** Under scale-to-zero, SIGTERM-mid-write is not a tail case —
  it is *correlated with the last request before idleness*, which is exactly when revalidation runs.
- **`roSecretRef` prune → `getDbRO()` falls back to the read-write credential.** A pruned field
  silently escalates database privilege. Make this the preflight's **named test case**.
- **Webhook-down is misdiagnosable as CLI/operator skew**, and webhook-defaulted fields can read as
  skew. S10 and S11 must distinguish them.

## Track D — measurement admissibility

Benchmark results here keep having to be withdrawn: a variance-collapse claim, a Fisher test, a
~470 ms delta. The framing that stops it is **admissibility** — a run missing these is *inadmissible*,
not merely weaker.

**D2 first — it affects every published run.**

| # | requirement |
|---|---|
| D1 | arms run the **same application** (assert identical digest) |
| D2 | the **requested endpoint** is recorded in the run's own section |
| D3 | arms **interleaved**, ABBA within pair |
| D4 | **sitting identity** recorded |
| D5 | **no pooling** across sittings |
| D6 | no bare median across a mode mixture |
| D7 | results **stratified** by mode |
| D8 | an explicit **unattributable** bucket |
| D9 | no tests assuming stationarity when a regime is present |
| D10 | **pre-registration** of the claim under test |
| D11 | a **confound register** |
| D12 | **exclusive** cluster access (queue of one) |
| D13 | no contesting controller reconciling the subject mid-run |
| D14 | **durable capture before teardown** (Run 26 lost 25 of 26 results files) |
| D15 | explicit **retraction discipline** |

Some of these the harness can enforce mechanically; the rest are write-up discipline. S8 should
mechanise what it can and name what it cannot.

## Parallelism, collisions, and the wall clocks

Two independent clocks on **different external resources**, so they run in parallel:

| clock | resource | forbids | tracks |
|---|---|---|---|
| 14-night compat window | GH Actions schedule | merges into the packed `@getknext/*` closure, `scripts/e2e-*.sh`, the manifest, `test-e2e-deploy.yml` | G |
| across-sittings cold start | the OKE cluster (**queue of one**) | any concurrent cluster traffic | K |

**Window-safe throughout:** all docs/ADR work (H), `src/cli/**` *if* D-1 excludes it, `compat-smoke`
and app-fixture work (I), benchmark harness (K), operator-only (L).

**Merge-held until window close:** anything under `packages/kn-next/src/adapters/**`,
`packages/lib/src/**`, `packages/db/src/**` — i.e. **S13 in full**. Develop and review in sprint 2,
**merge on close.** This is the sprint's biggest deliberate slowdown and it is a *correction to
sprint 1*, not a new constraint.

**Boundary notes.** The benchmark harness mutates the ksvc directly — an ADR-0001 exemption that
holds *only* while no operator is installed on that cluster, and **nothing checks that condition**.
If an operator is ever installed there, it will silently revert harness mutations mid-run. Also: a
diagnostic path must not share a failure budget with what it diagnoses.

## Expected escalations

- **S10** — public API / CLI surface (reserved exit code) and the CRD. Mechanically detected.
- **S4, S5, S6** — ADR changes. Mechanically detected.
- **S1** — a hard-rule contradiction with no tracked path: defining freeze scope decides what "gate
  every feature on the compatibility suite" means in practice. **Judgement, not detectable.**
- **S7** — closing skip-not-fail rows resolves a standing hard-rule contradiction; expect a row that
  cannot be made red without app changes.
- **S9** — highest risk of a **discovered-fact** escalation. It has already fired twice on this
  track.

## Open questions needing a human call

1. **#555 branch protection** — S3. Blocks nothing formally, protects everything. Highest-leverage
   human action in the sprint.
2. **EKS credentials/budget** (#306) — carried as a *request*; the work is out of scope until granted.
3. Whether the compat-window freeze ADR should also bind GitOps consumers, who do not assert strict
   validation.
4. Whether `NetworkPolicy` condition renaming is acceptable as a breaking status-field change.

## Anti-items — recorded so they are not re-proposed

- **Do not add `namespaceSelector` to the admission webhook** to make an upgrade e2e easier to write.
  It is a production admission-surface change wearing a test-convenience disguise and it narrows the
  blast radius of a security control. If the test is hard to write, that is a fact about the test.
- **Do not revive the probe-cadence hypothesis** for the ~11 s mode. Falsified on its premise:
  measured arms carry `periodSeconds: 1`, no `initialDelaySeconds`, and no operator exists on that
  cluster.
- **Do not narrow the strict-validation criterion** to make the GitOps residual disappear.
- **Do not build `status --explain` before S9.** Its shape depends on what S9 finds discriminates a
  regime, and the surface is 1.0-committed.

## Source manifest

Every source section, reproduced or explicitly declined.

**From `sprint2-architect.md`:** biggest thing ✓ · sprint 1 status ✓ · skip-not-fail rows vs the
window ✓ (S7) · ADR-0036 close-out ✓ (D-2) · sequencing vs wall clock ✓ · tasks ✓ · dependency edges
✓ · exit criteria — **partially declined**, kept as the silently-useless assertions rather than
duplicated in full; the source table remains authoritative · silently-useless list ✓ · parallelism &
collisions ✓ · expected escalations ✓ · scope recommendation ✓ · ADRs to write ✓.

**From `sprint2-sysdesign.md` (29-line manifest):** §0 work-item keys — **declined**, re-keyed onto
the architect's S-ids · §1 contract statements ✓ · §1.1 unwritten contract ✓ · §2 failure modes ✓
(condensed into the silently-useless table) · §2.1 webhook-down misdiagnosis ✓ · §2.4 harness/operator
revert ✓ · §2.5 EKS modes — **deferred with #306**, incl. the LB-idle-timeout 5xx outside knext's
telemetry · §3 data flow ✓ · §3.1 ADR-0001 exemption unchecked ✓ · §3.2 `roSecretRef` → RW fallback ✓
· §3.3 core-vs-app / diagnostic failure budget ✓ · §3.4 deploy ordering ✓ · §3.5 collisions ✓ · §4
scaling ✓ · §4.1 SIGTERM common path ✓ · §4.2 cold start — **partially declined**: the
single-variable experiment and burst-vs-cold probe cost stay in the source, S9 must read it · §4.3
cache under N pods — **declined here**, belongs to S13's design · §5 admissibility framing ✓ · §5.1
D1–D15 ✓ · §5.2 where it lives ✓ · §6 RBAC decision ✓ (D-3) · §6.2 dissolving premise ✓ · §6.3
recommendation ✓ · §6.4 rejected options — **declined**, see source · §6.5 residuals — **partially**:
GitOps kept as open question 3; kubectl shim and ≤1.24 stay in source · §6.6 obliged contract
statement ✓ · §7 anti-items ✓ · §8 open questions ✓ · §9 manifest — this section.

## Human-gated work — deferred here by decision (2026-07-28)

Everything an agent cannot do without a human is collected here rather than left scattered across
task rows, so the set is reviewable in one place and nothing silently blocks a track.

| item | why it needs a human | what it blocks |
|---|---|---|
| **S3 — branch protection on `main`** (#555) | a repository-settings change on the trunk; outward-facing permission change | nothing formally — but until it lands **every CI gate is advisory**, and the 14-night window can be voided by a red PR merging mid-window. Highest leverage item in the sprint. |
| **EKS credentials + budget** (#306, was T16) | provisioning an AWS account and committing spend | the second-cloud validation, and therefore the honesty of the multi-cloud claim. The *request* is carried, costed (~$75 bounded run); the work is out of scope until granted. |
| **T6 kind cluster teardown** | cluster/infra teardown is blocked by `block-dangerous-bash.sh` by design | nothing; it is cleanup owed from #572's live verification. |

**Why they are deferred rather than dropped.** Each has a real consequence and none is optional
long-term. Grouping them makes the *cost of not doing them* visible: two of the three directly
weaken claims the 1.0 will make (enforceable gates, multi-cloud portability), and stating that is
better than letting them expire quietly in a task row.

**What this changes about sprint 2's shape.** Every remaining track is agent-doable, so the sprint
does not stall on a human.

**Correction (2026-07-28, architect gate on #574).** An earlier version of this section claimed
**S2 cannot honestly complete without S3**, and that the window may not be *certified* until branch
protection exists. That is **stronger than the facts support**, and the gate tested it rather than
inheriting it.

Without branch protection a mid-window merge does not make the 14-night claim *false*. It changes
the harness fingerprint, the streak restarts, and the claim stays true of whatever artifact set it
names. **Detection is sufficient for truth; prevention is about schedulability** — the risk is an
unbounded number of restarts, not a false certificate. ADR-0039's framing — *falsifiability, not
prevention* — is the accurate one.

So: **S3 is not a logical precondition for certifying the window.** It remains **strongly
recommended before S2 opens it**, because once the sprint is in a real 14-night merge freeze, branch
protection is what stops "we'll just not count that merge" from being negotiable. That is a
discipline argument, not a correctness one, and the two should not be conflated.

## Reconciliation with sprint 1 (2026-07-28)

Sprint 1 overran into this plan and completed five of its tasks: **S4** (#570), **S6** (#567),
**S7** (#571), **S10** (#572), **S13** (#568). They are marked in the task table above.

Sprint 1 landed 13 of 17 — not the 3 of 17 the plan was drafted against — so this sprint is smaller
than scoped. The remaining agent-doable set is **S1, S5, S8, S9, S11, S12**, with S2 lead-owned and
gated on S3.

Two corrections owed to `docs/SPRINT_1.md`, recorded here so they are not lost:

- **T8's exit criterion is unsatisfiable as written.** It requires `docs/PUBLIC_API.md` to
  "cross-link" the ADR, but that file is guarded as user-facing and the guard forbids `ADR-\d{4}`,
  internal check ids, and issue numbers in it. The intent is satisfiable — a link whose text is
  user-facing and whose path carries no forbidden literal — but the criterion must say so.
- **Typecheck from the repo root, never from a worktree**, and for changes under `packages/*/src/**`
  run the **package** typecheck too. Three separate failures this sprint traced to a check measured
  in the wrong place reading green.
