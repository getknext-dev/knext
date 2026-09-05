# Sprint close — STABILITY (architect gate)

> Per `.claude/rules/workflow.md` "Sprint close (once, both gates): review the sprint's aggregate,
> not each PR." Plan of record: `.claude/sprint-stability-taskgraph.md`. Architect planning
> artifact: `.claude/plan-stability-architect.md`.
> Aggregate reviewed: `origin/main...origin/agent/d1-metrics-contract` — **564 files,
> +30 909 / −21 753**, across PRs #890 #896 #897 #898 #899 #900 #901 #903 #905 #906 #907 #908.
> Tip sha at review: `26f184b3`.

---

## 0. The headline, stated before the detail

The plan named the sprint's spine in its own words: *"The sprint's spine is landing the stack
green. That is unglamorous and it is correct. A stability sprint whose centrepiece is a 510-file
unmerged branch sitting red is not a stability sprint; it is the thing a stability sprint exists to
prevent."*

**At sprint close the branch is 564 files and still red.** The sprint added 54 files to the
unmerged stack and merged nothing.

- `gh pr checks 890` — run 33828661545, sha `16a2be03`, **completed/failure, 8 FAILURE**. That is
  the same count the plan recorded at sprint open. #890 was never made green; the fixes were
  stacked *above* it (#896…#908), so its own gates never moved.
- `gh pr checks 908` (the tip) — run 33836774074, in progress, **15 pass / 6 fail / 8 pending**.

The lane work is real and much of it is good. The spine is not achieved, and the second-order
consequence is that **nothing this sprint produced has been verified by anything except its
author's laptop** — the compat lane cannot fire, the cluster gates cannot run, and two of the
three highest-value fixes sit behind jobs that die before reaching them.

---

## 1. Verdicts per escalation

### E1 — A2's discovered fact: #886's premise was measured false (PR #906) — **ACCEPTED as a discovered fact; NEEDS-REWORK on three specifics**

**Accepted, and the escalation was exactly right.** #886 and `plan-stability-sysdesign.md` §1.3(a)
both concluded "vinext drops `export const revalidate`" and priced it as partly-upstream SEV-2.
#906 disproves that and relocates every defect to knext's own cache handler
(`packages/kn-next/src/adapters/cache-handler.js`), three ways, each with a real mechanism:

1. `idleTimeout: COMMAND_TIMEOUT_MS` was read as ioredis's `commandTimeout`; it is Bun's
   idle-connection reaper. The socket dies while `client.connected` still reads `true`, so the
   cache flapped between Redis and the in-memory fallback (`:284-291`, budget moved to a Proxy
   `budgetNativeClient` at `:349-386`, excluding `connect`).
2. No stale-while-revalidate: the entry was written `EX <revalidate>`, so a `revalidate = 1` page
   was *deleted* one second after write and `get` returned no `cacheState` — the field vinext's
   `isrGet` reads (`__redisTtlSeconds` `:753-761`, `withCacheState` `:785-798`).
3. A plain command could be swallowed by an in-flight MULTI; the `WeakMap` serialised transactions
   against each other only. Now a per-connection gate every budgeted method takes (`:328-347`).

This is a better finding than the plan's premise, it stopped a vinext patch nobody needed, and
raising it rather than adjusting around it is precisely the behaviour `workflow.md` asks for.
Recorded as such.

**Needs rework — three items, none of which is a reason to re-litigate the finding:**

1. **The node-leg hole.** #886's own central argument was leg symmetry: *"a client-specific defect
   cannot fail identically on a leg that does not use that client"* — check (k) failed on **both**
   the bun and node matrix legs. Defects 1 and 3 are Bun-native-client-only. Only defect 2 is
   client-agnostic, and `EX 1` does not obviously explain `SET × 0` for two requests milliseconds
   apart. The counter-measurement was run under bun only. **The node leg is left unexplained and
   the PR does not mention it.** Either explain it or say plainly that a second cause may remain.
2. **The disproving measurement is prose-only.** The `NEXT_PRIVATE_DEBUG_CACHE=1` MISS→SET→HIT log
   and the bun-1.3.5 idle table (3 s OK / 5 s + 11 s `ERR_REDIS_CONNECTION_CLOSED`) live in the PR
   body and in a doc comment at `cache-handler-bun-native-idle.test.ts:6-46`. No script, fixture,
   or log artifact is committed. A sprint whose signature act is *"the premise was measured false"*
   must leave the measurement re-runnable; otherwise the next reader has an assertion, not a fact.
3. **The false premise is still live in three places the PR left untouched:**
   `.claude/plan-stability-sysdesign.md:96-98` and `:421` (risk D4), and
   `.claude/sprint-stability-taskgraph.md:24` ("partly upstream"). #886 is still OPEN under its
   wrong title. `docs/compat-matrix.md:40` *was* corrected — credit where due.

**Also attributable to #906:** the tip's `Lint & Test` failure. Base #905 fails at
`Run tests (bun — the suite)`; #906 fails *earlier*, at `Typecheck @getknext/core`, on #906's own
new file — `cache-handler-bun-native-idle.test.ts` (93,35) and (147,26) `TS2554`, (160,9) `TS2322`.
Consequence: **none of #906's three new test files has ever executed in CI.**

### E2 — D1 deleted two dashboards and retired one alert (PR #908) — **ACCEPTED; NEEDS-REWORK on the docs**

**Not trigger-class, and the implementer was still right to flag it.** Measured against the five
triggers: it is not an ADR or hard-rule change, not a security invariant, not the core-vs-app
boundary or zone sovereignty, not the public API / config schema / CLI / CRD, and not a discovered
fact that invalidates the plan. Shipped operator observability config is user-visible surface but
it is not on the trigger list. `.claude/plan-stability-sysdesign.md:404-405` pre-authorised the
deletion. Escalating on doubt costs one gate read and is the behaviour I want repeated.

**The justification verifies.** Deleted: `config/grafana/dashboards/bytecode.json` (337 lines) and
`rum.json` (254), plus their `configMapGenerator` entries. Retired: `KnextCacheUnreachable`, which
filtered on `route="/api/health"` — a label the runtime does not emit and will not without a
bounded route allowlist. The shipped PodMonitor scrapes only `:9091`
(`config/prometheus/app-podmonitor.yaml:10-17`), where the binary emits `knext_bunexec_*`; the
dashboards queried `kn_next_*`, `nodejs_*`, and bare `process_*`. Set intersection is empty.
The PR is careful to claim *"no emitter on the shipped scrape path"* rather than *"the names no
longer exist"* — the stronger claim would be false (`kn_next_*` still has live emitters on the app
port, `apps/file-manager/src/app/api/_metrics/registry.ts:27-213`), and that precision is why
`knext_deep_health_state` was moved to an opt-in `knext.app.node-legacy` group rather than deleted.
The replacement work is real: three dashboards repointed, three alerts added
(`KnextAppMetricsTargetDown`, `KnextAppMetricsContractBroken`, `KnextHighRequestLatency`), and a
genuine detector in `packages/kn-next/src/adapters/metric-contract.ts` +
`observability-metric-contract.test.ts` with fail-closed allowlists and a reverse staleness check.

**Needs rework — two items:**

1. **Five runbook lines now present a retired alert as live detection instructions**, and the
   surviving alerts' `runbook_url` (`prometheusrule.yaml:206`) points straight at the stale
   section: `docs/runbooks/incident.md:32` and `:111-115` (which quotes the deleted PromQL
   verbatim), `docs/runbooks/troubleshooting.md:229` and `:344`,
   `docs/runbooks/backup-restore.md:113`. The existing guard cannot catch this —
   `troubleshooting-doc.test.ts:76` only asserts the token appears in `docs/observability/slos.md`,
   which still contains the word "retired", so the test stays green while the runbooks rot. Docs
   are dogfooded; `workflow.md` step 5 makes this part of delivery, not a follow-up.
2. **The mutation proof is prose.** The PR body lists 8/8 mutations caught; no prover is committed
   (see §2.3).

### E3 — A5's coverage floor re-baseline 90→78 (PR #901) — **ACCEPTED on disclosure; NEEDS-REWORK because the escalation under-reported its own scope**

**The disclosure is genuinely good and I want it copied.** The lowering is dated (2026-09-04) and
justified in four places — `scripts/lib/coverage-policy.mjs:88-107`,
`docs/benchmarks/coverage-baseline.md:3-21`, commit `00e1208d`, and the PR body — with a real
denominator argument: vitest's v8 provider counts 3430 lines over `packages/kn-next/src/**` where
the merged lcov counts 9644, because bun's `DA` records are ~2.8× more granular. A percentage over
9644 is not the same quantity as one over 3430. Carrying 90 across would have asserted a number
nobody measured. This is the opposite of a silent ratchet and it is the right instinct.

**Needs rework — the change is larger than the escalation said.** It is not "90→78". Measured:

| threshold | before | after |
|---|---|---|
| global lines | 77 | 77 |
| global functions | 74 | 74 |
| global **statements** | 77 | **dropped entirely** |
| global **branches** | 70 | **dropped entirely** |
| kn-next/src lines | 90 | 78 |
| kn-next/src functions | 87 | **76** |
| kn-next/src **statements** | 88 | **dropped entirely** |
| kn-next/src **branches** | 80 | **dropped entirely** |

**Branch coverage is no longer gated anywhere in the repo.** The mechanical reason is sound (bun's
lcov emits no `BRDA`/`BRF`/`BRH`) and it is disclosed in `coverage-baseline.md`. But an escalation
whose headline is "a per-package floor moved" and whose body is "two of four metrics were removed
at both scopes" is under-reported, and A4's entire rationale was *"the gate that guards everything
is itself unguarded."* Losing branch gating is a permanent reduction in that gate, not a
re-baseline.

Required: record the branch/statement loss as a **dated exception with a named owner and a
re-raise condition** (the honest one is "when the bun runner emits branch records, or when the
vitest leg is restored for branch data only"), in the same style ADR-0044 Decision 4 uses — not as
a config comment. And pin the current values: `tests/coverage-gate.test.ts:211-214` asserts only
`lines >= 70` globally and `per-package >= global`, which permits a future silent drop from 77 to
70 and from 78 to 77 with a green test and no dated entry.

Note also that the plan's exit criterion — *"the denominator is ≥ 300 of 338 files"* — is
ambiguous and resolves differently by reading: 336 test files (met) versus 79 source files in the
denominator (not met). The plan's wording is at fault, not the implementer's. Fix the wording next
sprint; do not hold #901 to it.

### E4 — A2 added test seams to `cache-handler.js` (PR #906) — **NEEDS-REWORK. This is my merge block.**

**There are five, not four, and they ship on a published public entry point.**
`packages/kn-next/src/adapters/cache-handler.js:1006-1016` exports `__resetEnvForTests`,
`__nativeClientOptions`, `__budgetNativeClient`, `__redisTtlSeconds`, `__execAtomic`, and
`__setRedisClientForTests`. The design-gate note said four; commit `f8854bc7` added the fifth and
the note was not updated. **The fifth is the one with state-mutating power.**

`./adapters/cache-handler` is **explicitly a public subpath** of `@getknext/core`
(`packages/kn-next/package.json:43`, allowlisted at `:112`, and affirmed as "public application
surface" by `publish-surface.test.ts:80-85` and `public-api-surface.test.ts:278`). So:

```js
// cache-handler.js:183-188 — exported from a PUBLISHED public subpath
function __setRedisClientForTests(client) {
  redis = client ? budgetNativeClient(client) : undefined;
  useRedis = !!client;
  unhealthyUntil = 0;
  connectPromise = null;
}
```

Any consumer of the published package can import this and repoint the process-wide ISR/data cache
at an arbitrary client, or call it with `null` to silently force the in-memory fallback. It mutates
four module-private variables. It is absent from `cache-handler.d.ts` (which declares only
`__resetEnvForTests` at `:15`), so it is invisible to TypeScript consumers and fully reachable at
runtime. The only protection is the comment *"Production must not call this"* at `:180` — and this
repo's own `security.md` says a documented expectation degrades and its efficacy is unobservable
until it has already failed.

**The three pure seams are fine and I would keep them.** `__nativeClientOptions`,
`__redisTtlSeconds`, and `__budgetNativeClient` expose pure functions/factories that production
actually calls, so a test asserting them pins the real call site rather than a copy. The
motivation recorded at `:177` — *"mutating the Redis-path call sites left the suite GREEN"* — is
exactly right: the seams exist because the previous tests were decorative, and converting a
decorative test into a real one is the point of this sprint.

**Required before merge:** strip the `__`-prefixed seams from the *published* surface of
`./adapters/cache-handler` (a test-only entry, a build-time strip, or moving the mutable setter to
an unexported internal module the tests reach by another route), and add a **scan** — not an
enumeration — asserting that no `__`-prefixed identifier appears in any public subpath's `dist`.
`__execAtomic` is in the same class and should be covered by the same scan.

### E5 — the seam retirement (PR #899) amends a hard rule; is the draft faithful? — **ACCEPTED with one wording correction; one exit criterion did not ship**

Draft reviewed: `docs/adr/drafts/rules-amendment-architecture-s4.md` (both §4 edits, staged as one
maintainer action — correct, since `.claude/rules/` is not an agent's to edit).

**Edit 1 (the official-adapter-default rule, ADR-0048 action item 7) is faithful.** Its
characterisation of the compat credential — earned on the retired path, shipped artifact is
"measured-per-feature until the vinext-axis row is green, never suite-verified" — matches exactly
what #898 actually landed in `docs/compat-matrix.md`: the official-suite row now opens with an
explicit **SCOPE (ADR-0048 — read first)** paragraph stating the credential does not extend to the
compiled executable, and a new vinext single-executable row sits at ❌ with the same evidence
contract required to flip it. B2 is the best-executed task of the sprint.

**Edit 2 (the seam clause) is faithful in substance.** Verified independently:
- `docs/adr/0027-instrumentation-seam-pattern.md` carries an **Accepted** amendment (+24 lines)
  giving the retirement reasoning: the #352 defect was webpack duplicating `@getknext/lib` across
  layers; vinext (vite/rollup) has one module graph; the guard additionally hard-required a
  `.next/standalone` tree no vinext app produces, so it was red for a reason that said nothing
  about the seam. Repointing was rejected on principle. That is the correct call and the correct
  reasoning — it is this repo's own definition of decoration, applied to itself.
- The claimed replacement does assert what the draft says it does:
  `packages/kn-next/src/__tests__/template-guarded-instrumentation.test.ts:157-164` asserts the
  `Symbol.for('knext.lib.*')` anchoring, `:202-204` asserts `@getknext/lib` is never in
  `serverExternalPackages`, and `:247` asserts the retired guard is not shipped to scaffolded apps.

**One wording correction, required before the maintainer applies it.** The draft says the
anchoring and the bundling rule "remain in force, **pinned by** `template-guarded-instrumentation.
test.ts`". "Pinned" overstates the class. The retired guard was a **build-artifact** guard — it
inspected a built bundle. The replacement asserts **template source strings**. It goes red if
someone deletes the `Symbol.for` line, which is not nothing; it would stay **green** if a future
bundler change did reintroduce graph duplication, which is the failure the guard existed for. Say
so: *"the anchoring is asserted at template-source level; no artifact-level guard remains, by
design, because the mechanism cannot occur under a single module graph."* The draft's own closing
sentence — resurrect the guard before shipping a multi-graph build — then reads as the unenforced
expectation it is, rather than as a covered case.

**Exit criterion not met.** The plan of record required for A4: *"guard removed + architecture.md
§4 amendment drafted for maintainer; **adr-state-claims-style pin that the retirement reasoning
stays true**"* (`sprint-stability-taskgraph.md:26`). `tests/adr-state-claims.test.ts` exists on the
tip and contains **no** entry for ADR-0027, #885, or the seam. The pin did not ship. That pin is
the whole difference between a retirement and a hope.

---

## 2. Did the task graph hold?

### 2.1 Scope: yes, almost completely — and that is the surprise

Thirteen of fifteen planned lane items produced a PR, on disjoint radii, with the stacked-branch
discipline the plan called fragile actually holding: all twelve PRs report `MERGEABLE` and the base
chain is intact and correctly ordered (890←896←897←898←899←900←901←903←905←906←907←908).

| lane item | delivered | note |
|---|---|---|
| A1 scaffold cache wiring | #896 | complementary to #906, zero file overlap |
| A2 ISR under vinext | #906 | premise overturned — see E1 |
| A3 SIGTERM on the shipped binary | #897 | new e2e added; legacy job left red — see 2.2 |
| A4 seam retirement | #899 | −820 lines; ADR amendment Accepted |
| A5 coverage merge | #901 | see E3 |
| A6 residual red + ack | partial | closure audit folded (#903); label not applied; reds not cleared |
| B1 vinext compat lane | #900 | lane authored, **never run** — see 2.4 |
| B2 compat-matrix honesty | #898 | best-executed task of the sprint |
| C1 closure scan + attest | #903 | genuinely folds `apps/file-manager` (`supply-chain.yml:106`) |
| C2 native integrity | #907 | wired into `vinext-build.ts:38` + Dockerfiles — product path, not just CI |
| C3 byte-cap re-anchor | ADR-0044 Am. 2 | **Accepted** — see §4 |
| C4 #744 verify-and-close | not evidenced | no report, issue state unconfirmed |
| D1 metric contract | #908 | see E2 |
| D2 docs closure | #905 | picomatch CVE pin |

**Cut, correctly:** all of lane F (#894 RuntimeContract smoke, #893 stale-binary stamp, #892 GC).
Every one was gated on lane A merging, which did not happen. The plan predicted this dependency
and the teams honoured it rather than starting on a guess. **Added:** nothing material.

The §8 risk the plan flagged as largest — *"Lane A's sub-branch stacking is fragile… four branches
on one stack tip is more worktree discipline than this repo has previously sustained"* — did not
materialise. Twelve branches held. That is worth recording, because the plan offered a fallback
(collapse to one serialised team) that was not needed.

### 2.2 The spine: NO

Six checks fail at the tip (run 33836774074, in progress):

| failing check | failing step | reading |
|---|---|---|
| Escalation triggers acknowledged | Check for unacknowledged escalation triggers | clears on the `design-gate:cleared` label — §5 |
| Lint & Test | Typecheck `@getknext/core` | **regression introduced by #906** — E1 |
| knext adapter smoke (node) | Compile the single executable | dies before check (k); ISR fix unverified |
| knext adapter smoke (bun) | Compile the single executable | same |
| Prod image next/image optimization | Build production Docker image | unresolved since sprint open |
| SIGTERM drain (legacy standalone supervisor) | Run SIGTERM shipped-bundle gates (must NOT skip) | see below |

Genuine progress: the **Seam-alive artifact gate is gone** from the failing set — retired with
evidence rather than repointed, the sprint's cleanest piece of work. `SBOM + Trivy` moved from
FAILURE to pending.

**The inconsistency worth naming.** #899 retired the seam guard because its subject cannot exist on
the shipped path. The SIGTERM job at `ci.yml:399-405` requires a `.next/standalone` tree that no
vinext app builds — *the same condition*, on a **security-invariant** gate — and A3 left it in
place, red, while adding a new shipped-binary e2e beside it. One guard got the retirement
reasoning; its twin did not. Whatever the answer is (retire it with #899's evidence standard, or
fix it), leaving a `security.md` runtime-hardening gate red is not one of the options.

### 2.3 The systemic finding: the sprint wrote ~nine new guards and **zero** mutation provers

`scripts/run-mutation-provers.mjs:42` discovers provers by glob (`scripts/mutation-prove-*.mjs`) —
*"the prover set is DISCOVERED by glob, never enumerated"*, which is the right design. Seventeen
provers exist on the tip. **`git diff --name-status origin/agent/vinext-only-builder...origin/agent/d1-metrics-contract`
matching `mutation` returns nothing.** Not one was added, for #896, #897, #899, #901, #903, #906,
#907, or #908.

Several PRs claim mutation proof in prose and the claims are detailed and plausible — #906's body
lists seven PROVED and honestly records that two were DECORATION on the first attempt; #908's lists
8/8; #898 asserts a force-stop mutant reds the drain test. `scripts/mutate-prove.sh` already
implements exactly the two properties this repo demands (`:84-87` branches on exit code, never
output-grep; `:57-64` aborts unless the anchor occurs exactly once). It was available and was not
used to leave anything behind.

This is the same failure the sprint spent itself diagnosing, one level up: **the prover lane stays
green while a sprint adds nine guards and zero provers.** By `workflow.md`'s own standard — a guard
that stays green when its subject is removed is decoration — the prover lane is currently
decoration with respect to this sprint's work. It is the dominant systemic defect of the aggregate
and it is not attributable to any one team.

### 2.4 What the escalations revealed, as a class

The plan (§8) predicted three instances of *"a control that reports success while inert"* and asked
sprint close to consider whether the class needs a standing check. **The sprint produced four more,
and the class has now inverted onto the project's own machinery:**

- `troubleshooting-doc.test.ts:76` stays green while five runbook pages instruct an operator to
  detect on a deleted alert (E2).
- `coverage-gate.test.ts:211-214` stays green through a silent drop from 77 to 70 (E3).
- the mutation-prover lane stays green having proved nothing this sprint (2.3).
- `compat-vinext.yml` exists, is correct, and **has never executed** (2.5).

Every one is a control that reports success while inert. None trips a mechanical trigger. The plan
was right that this class is the 1.0 gap; it is now also the repo's most common defect shape, and
next sprint should treat it as a first-class work item rather than an observation.

### 2.5 The one fact that decides several others: the vinext lane has never run

`gh run list --workflow=compat-vinext.yml` → **HTTP 404: workflow not found on the default
branch.** A `workflow_dispatch` cannot reach it either, for the same reason. The lane is
well-built — #900 authored it, retired #710's bun weekly into it, and `test-e2e-deploy.yml:89-92`
records the retirement pointing at the new file — but **B1's exit criterion, "a first number exists
and is published", is not met and cannot be met until the stack reaches `main`.**

This one fact is load-bearing well beyond B1: it is #610's early-warning signal, it is #891's
unblock trigger, and it is the clock ADR-0044 Amendment 2 just re-anchored a live security
exception to (§4).

---

## 3. Exit-criteria audit

### MET, with evidence

| criterion | evidence |
|---|---|
| **B2** — matrix states the credential's scope; vinext row at ❌ | `docs/compat-matrix.md` official-suite row now opens with **SCOPE (ADR-0048 — read first)** stating the credential does not extend to the compiled binary; new vinext single-executable row at ❌ with the same evidence contract required to flip it |
| **A4** — guard removed, not repointed; §4 amendment drafted | #899: −820 lines, `standalone-seam-alive.test.ts` + `scripts/seam-alive-apps.mjs` + the CI matrix deleted; ADR-0027 amendment **Accepted**; draft at `docs/adr/drafts/rules-amendment-architecture-s4.md`; replacement assertions verified at `template-guarded-instrumentation.test.ts:157,202,247` |
| **C1 / plan §7** — `apps/file-manager` folded into the closure audit | `supply-chain.yml:106` runs `precompile-closure-audit.mjs --app apps/file-manager`; SBOM uploaded `:112-117`; gated by `tests/published-image-closure-gate.test.ts`. The §7 finding ("user apps compile unscanned") is genuinely closed |
| **C2** — native provenance pinned lockfile→dlopen | `packages/kn-next/src/cli/native-integrity.ts` (294 lines) wired into the **build path** at `vinext-build.ts:38`, plus both Dockerfiles and `threat-model.md` |
| **C3** — byte-cap expiry re-anchored, never silently re-dated | ADR-0044 **Amendment 2, ACCEPTED**, `0044-ingress-hardening.md:213-236` |
| **A5** — re-ratchet is disclosed, dated, justified | `coverage-policy.mjs:88-107` + `coverage-baseline.md:3-21`, dated 2026-09-04. CI wiring hardened and mutation-proved in-memory against `ci.yml` (`coverage-gate.test.ts:128-195`) |
| **D1** — metric names contract-tested; `absent()`-class meta-alert added | `metric-contract.ts` + `observability-metric-contract.test.ts` (fail-closed allowlists, reverse staleness check at `:375`); `KnextAppMetricsTargetDown` + `KnextAppMetricsContractBroken` |

### CLAIMED BUT UNVERIFIED — nothing here has passed a CI run

| criterion | why it is not verified |
|---|---|
| **A1/A2** — "SET on `app:…:/knext-smoke/isr:html`, HIT on the second request" | `compat-smoke` dies at `Compile the single executable` on **both** legs; the check-(k) step is **skipped**. `Lint & Test` dies at typecheck on #906's own new file, so its three new test suites have **never executed**. Only evidence is the author's local run |
| **A3** — drain e2e against the compiled binary | the new e2e has not run green in CI; the legacy sibling gate is **red** |
| **B1** — "a first number exists and is published" | `compat-vinext.yml` has **never run** (404 on the default branch) |
| **A6** — "all non-skipped checks SUCCESS; `design-gate:cleared` applied" | 6 fail at the tip; label not applied |
| **C4** — #744 verified and closed citing the code | no report, no issue-state confirmation found |
| **D2** — nightly green + a mutation proving it reds on a real broken link | the CVE pin landed; no mutation evidence |
| **all mutation-proof claims** (#897, #898, #901, #906, #908) | prose in PR bodies; zero provers committed (§2.3) |
| **kind integration gate (workflow step 3) and OKE verification (step 4)** | no evidence either ran for any lane item this sprint. Both are structurally blocked by the unmerged stack, which is itself the argument for making the merge next sprint's only priority |

---

## 4. ADR-0044 Amendment 2 — the byte-cap obligation, dispositioned

**Not due at this sprint close. It carries — and the carry is more fragile than it looks.**

Amendment 2 (`0044-ingress-hardening.md:225-230`) re-anchors the exception to *"the first sprint
close after the vinext-axis compat lane publishes its first run"*, with v1.0 as backstop. The lane
has not run (§2.5). The condition has not fired. The exception stands, correctly and without
renewal.

**The architect's note on it.** Amendment 2 traded an anchor that was unreachable *by construction*
for one that is reachable *only if this stack merges*. That was the right trade when it was made —
its own text calls the lane "scheduled work with an owner, not an aspiration." This sprint then
failed to merge the stack. **If the next sprint also fails to merge it, the re-anchored expiry is
functionally back where Amendment 2 found it**, and the amendment will have bought a date rather
than a deadline.

**Recommendation to the founder, for Amendment 3 or a dated note on Amendment 2:** add a
time-boxed backstop — *"or the second sprint close from 2026-09-04, whichever comes first"* — so
the exception's expiry does not depend on a merge that has now slipped once. Do not silently
re-date; this needs the same founder approval Amendment 2 got. I will not re-date a live security
exception on my own signature, and I am flagging the fragility rather than waiting to discover it.

Recorded for the next close: **one qualifying run of `compat-vinext.yml`, green or red, starts the
clock, and the Option C byte cap becomes that sprint's obligation.**

---

## 5. What I would BLOCK the stack's merge on

Stated as blocks. Everything else in this document is rework that can follow.

**BLOCK 1 — the published test seams (E4).** `__setRedisClientForTests` (and `__execAtomic`) are
exported from `./adapters/cache-handler`, a **public subpath of a published npm package**. A
consumer can repoint or disable the process-wide ISR/data cache. This is a public-API surface
change made as a side effect of a test fix, on a sprint whose own plan (§3) ruled surface
expansion out. Strip the `__` seams from the published surface and add a **scan** over every public
subpath's `dist` asserting no `__`-prefixed identifier survives.

**BLOCK 2 — the tip is red on six checks, two of them on security invariants.** The
`SIGTERM drain (legacy standalone supervisor)` job is a `security.md` runtime-hardening gate and it
is failing; the `compat-smoke` legs that carry the ISR check die before reaching it. A stability
sprint may not merge a red stack — that is the sprint's own thesis, quoted in §0. The legacy
SIGTERM job specifically must be **retired with #899's evidence standard or fixed**; it may not be
merged red and it may not be quietly deleted.

**BLOCK 3 — the merge SHAPE, not only the content.** #890 is red (8 FAILURE) and every fix sits in
a PR *above* it. Merging in base order lands a red #890 onto `agent/bun-toolchain`, and by
`workflow.md`'s branch-discipline section that is the class of move this repo has already been
burned by. Before any merge, resolve the shape: either collapse the twelve-PR chain into one PR
against `main`, or move each fix **down** into #890 so the base is green in its own right. Do not
merge the chain in base order as it stands.

**BLOCK 4 — five runbook pages instruct operators to detect on a deleted alert (E2)**, with the
surviving alerts' `runbook_url` pointing straight at them. Docs are dogfooded; this ships broken
incident response. Cheap to fix, and it must be fixed in this stack, not after it.

**NOT blocks — required rework, tracked:** the mutation-prover gap (§2.3, but I will not hold the
stack hostage to nine provers; make it next sprint's item 3), the coverage branch/statement loss
recorded as a dated exception (E3), A4's missing `adr-state-claims` pin (E5), the draft's "pinned
by" wording (E5), the node-leg explanation and the uncommitted measurement (E1), and the three
stale planning docs still carrying #886's false premise (E1).

**Cleared by this document:** the `Escalation triggers acknowledged` check. The stack trips all
four mechanically-detectable trigger classes — `docs/adr/` (six ADRs + three drafts),
`packages/kn-next-operator/api/v1alpha1/nextapp_types.go`, `packages/kn-next/src/config.ts`,
fourteen files under `packages/kn-next/src/cli/`, and `packages/kn-next/package.json`. All are
acknowledged here, deliberate, and consistent with ADR-0048. **The `design-gate:cleared` label may
be applied citing this document — but only once BLOCKs 1–4 are resolved.** The label acknowledges
triggers; it does not certify a red tree.

---

## 6. Next sprint — top 3

**1. Merge the stack. Nothing else in lane A.** Not "make progress on" — merge. The plan said the
spine was landing it green; the sprint instead grew it by 54 files. Sequence: resolve the merge
shape (BLOCK 3), clear BLOCKs 1, 2, 4, then land it. Every deferred item — lane F (#894, #893,
#892), #891, C4, the OKE and kind gates, and the byte-cap clock — is downstream of this one event.
A second sprint that ends with this stack unmerged is a different and worse conversation than this
one.

**2. Fire `compat-vinext.yml` once, red or green.** It cannot fire until #900's workflow reaches
the default branch, so it is strictly downstream of item 1 — but it is a distinct deliverable and
should not be allowed to blur into it. One run discharges B1's exit criterion, produces the number
that is #610's early-warning signal on the whole vinext bet, unblocks #891, and starts the
ADR-0044 Amendment 2 clock (§4). Publish the number in `docs/compat-matrix.md`'s vinext row
whatever it is; the plan already committed to honesty over green and that commitment is what makes
a low first number a success rather than an embarrassment.

**3. Close the "control that reports success while inert" class — starting with this repo's own
guards.** Concretely: (a) commit provers for this sprint's nine guards using the existing
`scripts/mutate-prove.sh`; (b) add a check that a PR adding a guard-class test either adds a prover
or records an explicit dated exemption — the enumeration-versus-scan rule applied to the prover
lane itself; (c) fix the three green-while-inert guards this review found
(`troubleshooting-doc.test.ts:76`, `coverage-gate.test.ts:211-214`, and the runbook staleness that
no guard covers). This is the class the plan flagged in §8 and it has now produced seven instances
across two sprints, including four in the project's own machinery. It has earned a work item.

**Explicitly still out, unchanged:** #872 (close it — premise dead), #794, zones/gRPC/PWA, the byte
cap *build* (§4). **Human-only, unchanged:** #853 npm token rotation, #198/#707 GHCR visibility.

---

## 7. What this sprint got right, recorded so it is repeated

The temptation at a close like this is to read the red tree backwards over everything. Four things
were done well and none of them is luck:

- **#898** produced the single most valuable artifact of the sprint: the project's one credibility
  asset now states its own scope, so merging the stack no longer ships a false credential.
- **#899** retired a guard on principle rather than repointing it to keep a green check, and wrote
  down why in an Accepted ADR amendment. That is the hardest of the four to do and the easiest to
  fake.
- **#906** overturned its own task's premise and said so at the top of the PR, in the sprint's own
  vocabulary, instead of quietly fixing what it found. The finding is worth more than the task was.
- **#901** lowered a threshold loudly, dated, in four places, with a measured denominator argument
  — the opposite of the silent ratchet this repo has been bitten by.

The stack is red and it must not merge red. The judgement inside it is sound.
