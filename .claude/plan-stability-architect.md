# Sprint plan — STABILITY (architect half)

> Sprint theme, founder-directed: **reliability, security, tech-debt identification.**
> Performance is CLOSED (ADR-0048 Amendment 3, PR #890). This document owns **strategy,
> sequencing, ADR coherence**. The system designer owns contracts, failure modes, scaling.
> Produced per `.claude/rules/workflow.md` "Sprint planning (once, both gates, Opus)".

---

## 0. The fact that reshapes the plan — read this before the scope table

**The listed reliability issues are not eleven independent tasks. Eight of them are the red gates
of one unmerged 510-file stack.**

```
main ← #883 (agent/bun-toolchain, 510 files vs main) ← #890 (agent/vinext-only-builder, tip = HEAD)
```

`gh pr checks 890` today: **8 FAILURE**, and they map one-to-one onto the brief's issue list.

| red check on #890 | issue |
|---|---|
| `Seam-alive artifact gate (file-manager)` | #885 |
| `SIGTERM drain (shipped bundle gate)` | #887 |
| `knext adapter smoke … (node)` + `(bun)` | #886 |
| `Lint & Test` | #884 |
| `SBOM + Trivy (+ cosign sign on main)` | supply chain, see T7 |
| `Prod image next/image optimization (strict, …)` | ADR-0048 Am.3's own proof |
| `Escalation triggers acknowledged` | the stack trips triggers unacknowledged |

This is a **discovered fact that invalidates the plan's premise** — the trigger `workflow.md`
calls "the most important, and the one most likely to be rationalised away". Stating it rather
than adjusting quietly:

1. **There is no "parallel teams on main" sprint available.** Any team branching from `main`
   works against a tree 510 files out of date that is about to be replaced. Blast-radius disjointness
   has to be computed against the **stack**, not against `main`.
2. **Nothing downstream of the stack can be exit-criteria-verified until it lands.** #892, #893,
   #894, #891 all live in `packages/kn-next/src/cli/`, which the stack rewrites.
3. **The sprint's spine is landing the stack green.** That is unglamorous and it is correct.
   A stability sprint whose centrepiece is a 510-file unmerged branch sitting red is not a
   stability sprint; it is the thing a stability sprint exists to prevent.

---

## 1. What the project itself names biggest

Not my judgement — the project's own words, in three places that agree:

- **ADR-0048 consequence #2:** *"The official Next.js compatibility suite no longer covers the
  shipped path. The north star — verified-adapter status — is unreachable until a vinext-axis
  suite is green. **This is the largest cost and it is strategic, not technical.**"*
- **ADR-0048 action item 6: STILL OPEN.** Verified today — `.github/workflows/test-e2e-deploy.yml`
  contains **zero** occurrences of `vinext`; its only shape references are `standalone`. The stack
  touches that file by 4 lines and adds no axis.
- **CLAUDE.md §2:** verified-adapter status is *"the north-star credibility lever"*, and §10 makes
  *"gate every parity claim on the official compatibility suite"* a hard rule.

### The acute form of it, which nobody has filed

`docs/compat-matrix.md:49` carries a **✅** for the official suite. Its evidence is run
28702729595 — 778 passed / 0 failed — on the **Node standalone** lane. Under the merged stack the
validator **rejects `build: 'turbopack'`** and the artifact contract rejects `runtime: 'node'`
(#891's own context paragraph). So the row is a green credential for a path **no user can select**.

That is not stale prose. It is the project's single credibility asset, and it now describes an
artifact that does not ship. `docs/compat-matrix.md`'s own header rule — *"no row may claim
verified while unverified"* — is being violated by the row that matters most. `compat-matrix.md`
is **not** in the stack diff, so merging #890 ships that contradiction to `main`.

**This is the sprint's centrepiece.** Not because it is the biggest engineering task — it is not —
but because it is the only item on the list where continuing to say nothing is itself the failure.

### The same problem, seen a second time: #850

#850 measures that the 14-night node-lane window is unreachable by construction — 27 nights,
11 fingerprints, 10 restarts, longest streak 7. Read against ADR-0048, #850 stops being a CI
scheduling problem and becomes confirmation: the project is spending nightly compute to
accumulate a credential **for a retired artifact**, on a clock that cannot finish. Both halves are
wrong. Do not fix #850 as written. Fold it into the founder decision in §4.1.

---

## 2. Scope — IN, in dependency order

Five lanes. Lanes A and B are the spine and are serialised. C, D, E are genuinely disjoint and
run concurrently from sprint open.

```
          ┌── A: land the stack green (A1..A5, serialised on one stack, sub-branches per task)
sprint ───┤
 open     ├── B: the credential lane (B1, B2) ── needs A green for a buildable app; starts at A3
          ├── C: operator observability (C1) ── disjoint radius, no dependency
          ├── D: platform hygiene (D1, D2) ── disjoint radius, no dependency
          └── E: rules + ADR housekeeping (E1..E3) ── maintainer-gated, no code radius

post-A ── F: cli-surface hardening (F1, F2) ── blocked on A merging, starts mid-sprint
```

### Lane A — land the stack green

**Worktree discipline is mandatory and non-obvious here.** `workflow.md` says one branch, one
worktree, and disjoint radius is a hard requirement. The stack is one branch. Resolution:
**each A-task gets its own branch stacked on `agent/vinext-only-builder`, its own worktree, and a
file set that does not overlap any sibling.** They merge into the stack tip in the order below.
They do **not** share a worktree, and no two A-tasks touch the same file.

| id | task | issue | why in a stability sprint |
|---|---|---|---|
| A1 | ISR is never cached under vinext | #886 | **Highest severity on the whole list.** A silent data-plane correctness failure: every ISR route re-renders on every request, reports 200, and looks fine. This is exactly `V1_ROADMAP.md`'s thesis — "every one of those reports success". |
| A2 | Seam guard inoperable | #885 | Contradicts a **named hard rule** (`architecture.md` §4 names the file and the artifact path). Cannot be repointed silently. |
| A3 | SIGTERM drain gates assert a dead bundle | #887 | Graceful shutdown is a `security.md` runtime-hardening invariant. Its gate currently proves nothing. |
| A4 | Coverage gate measures 3/338 | #884 (+#871 enabler) | The gate that guards everything is itself unguarded. Same class as #527. |
| A5 | Residual red: SBOM+Trivy, prod-image-optimization, escalation-triggers ack | — | The remaining three red checks. A5 also **acknowledges the stack's triggers** (that job is red because a CRD+CLI+ADR change is unacknowledged — this sprint plan IS the acknowledgement, plus the `design-gate:cleared` label with a signature). |

### Lane B — the credential lane (the centrepiece)

| id | task | issue | scope |
|---|---|---|---|
| B1 | **Stand up the vinext-axis compat lane.** A lane that RUNS, red or green. | ADR-0048 AI-6, #710 | Add a `build: vinext` axis to `test-e2e-deploy.yml` driving the same `test/deploy-tests-manifest.knext.json` corpus against the compiled executable. **Retire the bun-standalone weekly (#710) into it** — that lane tests bun-running-standalone, a cell ADR-0048 consequence #5 proves cannot exist. Same compute budget, redirected at the shipped path. |
| B2 | **Make `compat-matrix.md` honest about the shipped path.** | — | The Node ✅ row is re-scoped with an explicit `(lane: node-standalone — RETIRED TARGET)` marker, or flipped, per `tests/compat-matrix.test.ts`'s evidence contract. A new vinext row starts at ❌ and cites B1's first run. **Non-negotiable and must land in the same sprint as A**, because merging the stack without it ships a false credential to `main`. |

### Lane C — operator observability (disjoint)

| id | task | issue |
|---|---|---|
| C1 | NetworkPolicy unobservably inert on flannel — surface a condition/event/doctor check | #744 |

Verified disjoint: the stack touches only 6 operator files (`nextapp_types.go`, the CRD manifest,
`nextapp_controller.go`, 2 tests, 1 doc). The NetworkPolicy reconciler is untouched. C1 must land
its verdict through `computeStatusVerdict` (`status_verdict.go`) per `architecture.md` §4 — never
a new `Reconcile` branch.

### Lane D — platform hygiene (disjoint)

| id | task | issue | note |
|---|---|---|---|
| D1 | Docs closure nightly RED | #888 | Docs are dogfooded; a red docs gate is a shipped-docs risk. |
| D2 | Live Prometheus ran 5-week-stale config | #792 | A monitoring plane that silently diverged from its committed config is the "control reports success while inert" class again — the same shape as C1 and as the compat row. Three instances in one sprint is a **pattern worth naming in the sprint-close review**. |

### Lane E — rules + ADR housekeeping (maintainer-gated, see §5)

### Lane F — CLI-surface hardening (starts after A merges)

| id | task | issue | scope cut |
|---|---|---|---|
| F1 | Post-compile RuntimeContract smoke | #894 | **Full scope.** Converts "the binary may not serve the health path the operator probes" from a cluster-time silent failure into a build-time loud one. Highest-leverage new guard available. |
| F2 | Stale-binary stamp | #893 | **Half scope.** Ship the stamp + deploy-refuses-on-mismatch. **Cut the `--arch` flag** — arm64 is a feature, not stability, and it widens the CLI surface (a trigger) for no reliability gain this sprint. |

---

## 3. Explicitly OUT, with the reason

| out | why |
|---|---|
| **#872 re-measure compiled-vs-uncompiled** | **Premise is dead. Recommend closing it.** #872 exists to reprice ADR-0048 Amendment 2's trade — "image optimization works uncompiled, not compiled". Amendment 3 resolved that by disproving the claim: image opt works *inside* the binary (`sharp-addon-dlopen.mjs`, CI-verified 200 `image/avif`). There is no trade left to reprice, and re-opening a measurement on a founder-closed axis invites relitigating a settled decision. |
| **#892 asset GC cannot reap vinext builds** | Real, but the chosen failure mode is **fail-safe** (unmarked prefixes are never reaped). Cost is monotonic storage growth — money, not correctness, nothing 404s. Next sprint. Say this out loud rather than letting it read as forgotten. |
| **#891 delete legacy standalone machinery** | Its own trigger is "a green vinext-axis suite lane". B1 stands the lane up; green is not this sprint (§4.2). Deleting the standalone machinery while it is still the only green credential would destroy the fallback before the replacement exists. Blocked, correctly. |
| **#743 Option C byte cap — the BUILD** | Not built this sprint. But its **expiry must be re-anchored this sprint** — see §4.3. Building a byte cap is a week; noticing its deadline can no longer fire is free and matters more. |
| **#853 npm token, #198/#707 GHCR visibility** | Human-only credential actions. Named in §4.6, not scheduled. |
| **#306 second cloud, #441 wrapper overhead, #387–389, gRPC, zones/PWA/MFE** | `docs/V1_ROADMAP.md` §6 already cuts these from the 1.0 path. Nothing this sprint changes that. |
| **#893's `--arch` half** | See F2. |
| **Anything that expands the CLI or CRD surface** | The stack already carries a CRD enum widening and a CLI default change. Adding a second surface change in the same sprint makes the upgrade-order hazard (#548, ADR-0048 Am.3) compound. This is why #794 (imagePullSecrets) is deferred — it edits `nextapp_types.go`, which the stack holds. |

---

## 4. Decisions that need the FOUNDER

Stated as questions, each with a recommendation. Items 1–3 are blocking; 4–6 are cheap.

### 4.1 #608 — what is the acceptance bar that replaces the official suite?

The founder has said he is willing to accept *"vinext's own coverage pass"*. #608's own text
answers itself: *"Whatever replaces it must be at least as falsifiable, or the project has quietly
traded a gate for a claim."*

**Recommendation: knext keeps the corpus and changes only the axis.** Run
`test/deploy-tests-manifest.knext.json` — the same 778-test upstream-derived selection, the same
harness, the same red-on-fail ledger — against the **compiled vinext executable**. Do not adopt
vinext's own coverage pass as the bar.

Why: the corpus is the falsifiable part and knext already paid for it (16 shards, an evidence
ledger, a quarantine-growth clause designed specifically to make the gate unpurchasable).
Adopting an upstream project's self-reported coverage forfeits all of that and makes knext's
compatibility claim a **restatement of someone else's claim about a pre-1.0 dependency**.

External credibility signal to replace "listed in the Next.js docs": a **published, reproducible,
red-on-fail number against upstream's own test corpus, on an artifact anyone can build.** That is
a stronger claim than a directory listing, and no competitor to knext currently makes it.

**Also folds in #850.** The 14-night window definition (`V1_ROADMAP.md` §3) was written for the
node lane and is unreachable there. It must be rewritten for the vinext axis in the same decision
— and #850's measurement (the fingerprint moves on packed tarballs, and 2 of 10 moves were
harness-only) is the input for choosing a reachable definition. Do not carry the number 14 across
unexamined.

### 4.2 Is the vinext suite lane THIS sprint's centrepiece?

**Recommendation: yes for standing it up, no for making it green.**

Standing up a lane that *runs* — B1 — is a two-to-three-day task and it is what unblocks #891,
#608's evidence, and the whole credibility story. Requiring it **green** this sprint is not
schedulable: #850 shows a green window is a multi-sprint proposition even on a mature lane, and
the vinext axis has never been run once.

The sprint's honest commitment is: **a vinext-axis lane exists, runs on a schedule, is red-on-fail,
and `compat-matrix.md` states its real number.** Not "verified".

### 4.3 #743 — the byte cap's expiry can no longer fire. Re-anchor it to what?

**This is the finding I most want in front of the founder, because nobody filed it.**

`security.md` and `CLAUDE.md` §7 defer ADR-0044 Option C on *"a dated exception with a hard expiry
at **Tier-A exit or v1.0**"*. `ROADMAP.md` defines Tier-A exit as *"compat suite green"* — and
`ROADMAP.md` line 80 says explicitly that the Phase↔Tier mapping exists **precisely so that this
deferral's expiry is checkable**.

ADR-0048 made compat-suite-green unreachable. **Therefore the expiry condition on a live security
exception is now one that can never occur.** A dated exception with an unreachable date is a
permanent exception wearing a deadline. That is the exact degradation `security.md` warns about
("a documented expectation degrades and its efficacy is unobservable until it has already failed"),
and it happened as a *side effect* of a performance decision — which is why it needs a human call
rather than a quiet edit.

The consequence is not theoretical: today one oversized body OOMKills a pod, and OOM is SIGKILL,
so the graceful drain, `after()`, and the DB-pool drain are all skipped — taking up to 19
co-resident in-flight requests with it (#743).

**Recommendation:** re-anchor to an event that can occur — **"the sprint close following the first
vinext-axis suite run, green or red"** — and record it as an amendment to ADR-0044 Decision 4.
The founder picks the anchor; the architect will not silently re-date a security exception.

### 4.4 Retire the bun-standalone weekly (#710)?

**Recommendation: yes, into B1.** That weekly tests bun running the standalone bundle. ADR-0048
consequence #5 measured that node+vinext exits 1, and the validator now rejects turbopack — so the
lane's subject is a cell that cannot be selected. Its 4-of-4 deterministic red is real information
about a target nobody ships. Redirect the budget.

### 4.5 The #605–#611 map is stale — rescope or close?

#605 asks for a **go/no-go on vinext**. The go already happened, by founder direction, in
ADR-0048 (Accepted 2026-08-27) and Amendment 3 (2026-09-03). A map whose destination is a decision
already taken will produce a document nobody can act on.

**Recommendation:** #608 (acceptance bar) and #610 (reversibility / early-warning signal) survive
as live questions and move into this sprint's decision set. #609 (price tag) and #611 (the go/no-go
ADR) collapse into a single **ADR-0048 Amendment 4** written at sprint close — the price tag stated
retrospectively and honestly, which is what #609 actually asks for. Close #605 as superseded.

**#610 is the one I would not drop.** "What early signal tells us the bet is going wrong while
reversing is still cheap?" has a concrete answer available this sprint and no other: **the vinext
axis's first suite number.** If it lands far below 778/778, that is the early signal, and B1
produces it. That alone justifies B1's position as centrepiece.

### 4.6 Human-only, blocking nothing in this sprint but worth stating

- **#853** — the release lane works end to end; publishing stops on a rejected `NPM_TOKEN`.
  Maintainer rotation.
- **#198 / #707** — GHCR package visibility toggle; the documented install path is broken for
  anonymous users until someone clicks it.

---

## 5. ADR + rules housekeeping owed

`.claude/rules/` is not an agent's file to edit. Everything in this section is **maintainer work**,
and the first item is now a *process* blocker, not tidiness.

| # | owed | status |
|---|---|---|
| E1 | **`architecture.md` §4 — the official-adapter-default rule.** ADR-0048 action item 7, **STILL OPEN.** The rule says *"never make anything but the node/official-adapter target the default"*; ADR-0048 sets that target aside entirely. **Every task in this sprint contradicts a live hard rule until this is amended** — which means the escalation-triggers job and every architect gate this sprint must hand-wave the same contradiction. Highest priority. |
| E2 | **`architecture.md` §4 — the ADR-0027 seam-guard clause.** It names `apps/file-manager/standalone-seam-alive.test.ts` and `.next/standalone` **by name and as mandatory**. A2 (#885) must decide what the guard *means* under vinext before the rule is rewritten — and the honest possibility is that its subject is **gone**: webpack-layer duplication of `@getknext/lib` is a webpack phenomenon, and vinext builds with vite/rollup. If the mechanism cannot occur, the rule should say the guard is retired **and why**, not be repointed at a new path so it keeps passing. Repointing a guard whose subject no longer exists is `workflow.md`'s definition of decoration. |
| E3 | **ADR-0007 (compat suite)** — an amendment recording that its subject is no longer the shipped path, and **ADR-0039 (compat window freeze scope)** — amended or superseded alongside the §4.1 decision, since #850 measures its scope insufficient to reach 14. |
| E4 | **`CLAUDE.md` §3, §9** — §3 still says *"Runtime = a real Next.js Deployment Adapter on the official API (16.2+)"*; §9 still calls `node-server.ts` the runtime entry. Both retired by ADR-0048. §10's hard-rule list needs the same pass. |
| E5 | **`ROADMAP.md` Tier-A exit** — *"compat suite green"* now names a retired lane, and line 80 makes that definition load-bearing for #743's expiry (§4.3). These two edits are the same edit. |
| E6 | **ADR-0036 / ADR-0042 front-matter.** `workflow.md` step 9 records that the graph collapses `supersedes`/`amends` into `references`, so **supersession is only readable from front-matter**. ADR-0048 amends ADR-0042 Decisions 1/2/5 and ADR-0036's matrix — verify both carry it in front-matter, not only in ADR-0048's prose. |
| E7 | **ADR-0017 / the CRD-version question.** The stack widened `spec.build`'s enum on `v1alpha1` — precisely the breaking change ADR-0017 permits *because* it is alpha. `V1_ROADMAP.md` §1 flags this as an open founder decision. Record the enum widening as the worked example in the ADR-0017 amendment. |
| E8 | **#639 — the half-scan rules amendment.** Six instances in one session, all caught only adversarially. This sprint writes **many** new guards (A1–A5, B1, C1, F1). Producing the proposed rule text *before* they are written is worth more than producing it after. Agent produces a draft; maintainer applies. |

---

## 6. Per-task detail — exit criteria, triggers, blast radius

Exit criteria are **red-on-fail checks**, per `V1_ROADMAP.md` §5's standard ("every exit criterion
is a red-on-fail check, not a document"). Triggers are the ones the task is **expected** to touch,
per `workflow.md`'s requirement that the plan name them explicitly.

### A1 — ISR is never cached under vinext (#886)

- **Exit:** `compat-smoke` check **k** passes on both matrix legs; the cache event log shows ≥1
  `SET` on `app:…:/knext-smoke/isr:html` and a `HIT` on the second request. A test asserts the
  `SET`, so deleting the cache registration reds it (mutation-proved by exit code, not output-grep).
- **Triggers:** *discovered-fact* — likely. The cause is not yet known; if it is a vinext upstream
  limitation rather than a knext wiring bug, that is a fact about the sole supported runtime's
  data-plane correctness and it invalidates more than this task. **Escalate immediately if so.**
- **Radius:** `apps/file-manager/src/app/knext-smoke/isr/`, the cache-handler registration path,
  `apps/file-manager/knext-bun-entry.mjs`, `apps/file-manager/scripts/compat-smoke.mjs`.

### A2 — Seam guard inoperable (#885)

- **Exit:** either (a) a guard that reds when the seam is removed under the **vinext** build, or
  (b) a written finding that the duplication mechanism cannot occur under vite/rollup, backed by a
  test that would red if it *could* — plus the E2 rules amendment. Not a path repoint.
- **Triggers:** **ADR/hard-rule — certain.** `architecture.md` §4 names this file. Design gate is
  summoned for this task, not optional.
- **Radius:** `apps/file-manager/standalone-seam-alive.test.ts`, `packages/lib` seam anchoring,
  `apps/file-manager/vite.config.ts`. **Must not touch** `serverExternalPackages`.

### A3 — SIGTERM drain gates (#887)

- **Exit:** both drain e2e tests run against the **compiled binary** (or a documented host-arch
  equivalent) and red when the drain handler is removed from the nitro entry.
- **Triggers:** *security invariant* — graceful shutdown is a `security.md` runtime-hardening rule.
- **Radius:** `apps/file-manager/sigterm-drain-e2e.test.ts`, `sigterm-hardcap-e2e.test.ts`,
  `apps/file-manager/knext-bun-entry.mjs`. **Overlaps A1 on the entry file — A1 lands first, A3
  rebases.** This is the one unavoidable overlap in lane A; assign both to the same team if the
  schedule permits.

### A4 — Coverage gate denominator (#884, enabled by #871)

- **Exit:** the coverage denominator is ≥ 300 of 338 files and the ratcheted thresholds
  (77/70/74/77 global, 90 lines for `packages/kn-next/src/**`) pass at that denominator, or are
  re-ratcheted **downward with a dated, justified entry** — never silently. The `Run tests` step
  runs the real suite, not 12 tests.
- **Triggers:** none expected.
- **Radius:** `vitest.config.ts`, `scripts/bun-test.mjs`, `docs/benchmarks/bun-test-remaining.txt`,
  and the 74 test files in #871's list. **Largest file count in the sprint but zero source overlap
  with A1–A3.**

### A5 — Residual red + trigger acknowledgement

- **Exit:** all `gh pr checks 890` non-skipped checks SUCCESS; the `design-gate:cleared` label is
  applied **with this plan cited** as the acknowledgement.
- **Triggers:** *ADR/hard-rule, CRD/config/CLI* — all already tripped by the stack. This task's job
  is to acknowledge them, not to discover them.
- **Radius:** `.github/workflows/ci.yml`, `security/*-allowlist.json`.

### B1 — vinext-axis compat lane

- **Exit:** a scheduled workflow runs `test/deploy-tests-manifest.knext.json` against the compiled
  executable; every shard emits a summary carrying an axis label; a red shard fails the job and
  opens its own issue (never the node credential's). **A first number exists and is published.**
- **Triggers:** **ADR/hard-rule — certain** (ADR-0007, ADR-0039, `CLAUDE.md` §10's compat-suite
  rule). Design gate required.
- **Radius:** `.github/workflows/test-e2e-deploy.yml`, `scripts/e2e-*.sh`,
  `scripts/compat-window-*.mjs`. **Owned exclusively by team B** — the stack's 4-line edit to that
  workflow lands first, then B takes the file.

### B2 — compat-matrix honesty

- **Exit:** `tests/compat-matrix.test.ts` passes with the official-suite row either lane-scoped to
  the retired target or flipped, and a vinext row present at ❌ citing B1's run. Mutation: reverting
  the row to an unqualified ✅ reds the guard.
- **Triggers:** **ADR/hard-rule.** Same gate as B1; run them together.
- **Radius:** `docs/compat-matrix.md`, `tests/compat-matrix.test.ts`, `docs/compat/`.

### C1 — NetworkPolicy inertness observable (#744)

- **Exit:** a `NextApp` status condition (or event) reports policy-not-enforced on a CNI with no
  NetworkPolicy controller, **emitted from `computeStatusVerdict`**; `kn-next doctor` reports it;
  proved on kind+flannel and kind+Calico — the condition appears on one and not the other.
- **Triggers:** *security invariant* — the honesty of a shipped isolation control.
- **Radius:** `packages/kn-next-operator/internal/controller/{networkpolicy*,status_verdict}.go`,
  `packages/kn-next/src/cli/doctor.ts`. ⚠️ `doctor.ts` is in the stack — **C1 takes it after A merges,
  or confines itself to the operator half.** Prefer the latter to keep C fully parallel.

### D1 / D2 — docs closure nightly (#888), Prometheus config drift (#792)

- **Exit (D1):** nightly green, and a mutation proving it reds on a genuinely broken link.
- **Exit (D2):** a check that fails when the live Prometheus config diverges from the committed
  one — the fix is the *detector*, not the one-time reload. A five-week silent divergence recurs
  unless something watches.
- **Triggers:** none expected.
- **Radius (D1):** `.github/workflows/docs-closure-nightly.yml`, `apps/docs/content/`.
  **Radius (D2):** `.github/workflows/scale-zero-pg.yml`, cluster monitoring manifests.
  ⚠️ D1 overlaps the stack in `apps/docs/` — sequence D1 after A, or scope it to the workflow only.

### F1 — post-compile RuntimeContract smoke (#894)

- **Exit:** removing the drain or the health route from a scaffolded app's entry **fails the
  build**, naming the missing obligation. The skip flag is explicit and LOUD.
- **Triggers:** **CLI surface** — adds a build-time failure mode and a flag. Detectable, will fire.
- **Radius:** `packages/kn-next/src/cli/{build,vinext-build}.ts`, `templates/app/`. Blocked on A.

### F2 — stale-binary stamp (#893, half scope)

- **Exit:** deploying with a binary whose stamp does not match the current build fails, naming the
  fix; covered by a test.
- **Triggers:** **CLI surface.**
- **Radius:** `packages/kn-next/src/cli/{build,vinext-build,deploy}.ts`, `templates/app/Dockerfile.hbs`.
  **Overlaps F1 — same team, F1 then F2.**

---

## 7. Security items and where they sit

- **Verified today, and worth filing:** `ci.yml:1266` runs
  `node scripts/precompile-closure-audit.mjs --closure examples/bun-exec` — **the only invocation.**
  The compiled binary is Trivy-opaque (image scanning sees the Alpine base, not the ~70 MB embedded
  JS closure), so the pre-compile closure audit is the *whole* supply-chain surface for application
  dependencies — and it covers one example, not the reference production app. **User apps compile
  unscanned.** Recommend folding an `apps/file-manager` closure into A5's radius this sprint; a
  general "every app's closure" rule is next sprint's design work, not a patch.
- **#785 (cosign-attest the SBOM onto the vinext image digest)** stays open and correctly so — there
  is no vinext publish lane, so there is no digest to attest to. Do not schedule it before a publish
  lane exists.
- **#743** — see §4.3. The expiry, not the build.

---

## 8. What this plan trades, stated rather than suppressed

- **A stability sprint whose spine is merging one branch looks like no progress.** It is the
  correct call and it will read badly at sprint close. Recorded here so it is not re-litigated then.
- **A1's cause is unknown.** If #886 turns out to be a vinext data-plane limitation rather than a
  knext bug, this sprint's scope is wrong and the escalation trigger fires on day one. That is the
  single largest schedule risk and there is no way to price it before someone looks.
- **Lane A's sub-branch stacking is fragile.** Four branches on one stack tip is more worktree
  discipline than this repo has previously sustained, and `workflow.md` records that stale worktrees
  have already nearly reverted a fix here. If it proves unworkable, collapse lane A into one
  serialised team and accept the slower spine — do not run two teams in one worktree.
- **Three items this sprint are the same defect class** — a control that reports success while
  inert (C1's NetworkPolicy, D2's Prometheus, B2's compat row). None trips a mechanical trigger.
  Recommend the sprint-close review examines whether that class needs a standing check, and note
  that `V1_ROADMAP.md`'s thesis already named it as the 1.0 gap and it has not been closed.
