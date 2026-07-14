# HANDOFF — scale-zero-pg (read this first)

Portable handoff for a **fresh Claude Code agent / another account** to resume this
project. You do **not** resume old chat sessions — the repo IS the memory. Clone the
repo, provision the credentials below, read this + `CLAUDE.md` + `docs/`, and continue.

_Last updated: 2026-07-14. Latest tag **v1.4.0**; a large post-v1.4.0 reliability arc
is merged-but-untagged (the **v1.4.x tag + blind-trio scorecard review is pending owner
approval** — see §3). Platform health: green, 0 open PRs, full test battery passed with
zero product regressions. **Code-documentation hardening arc complete** (#200–#205):
every control-plane Go binary now carries thorough godoc — gateway + wake, AppDatabase
operator, and the zone operator (ADR-0007) — plus `docs/ARCHITECTURE.md`, `docs/DRILLS.md`,
`docs/tuning-write-heavy.md` for the next agent. **Latest work (#206/#207, MERGED):** the
`ColdRestorable` recoverability condition (see §2) — one OKE `_verify-restore.sh` drill
pending to close its e2e loop._

## 1. What this project is
A **Knative-ecosystem scale-to-zero PostgreSQL platform** — idle databases cost zero
compute; a client TCP connection wakes the compute sub-second. Native Postgres compute
on **Neon's OSS disaggregated storage**, all on Kubernetes; the only thing we build is a
Go **wake-on-connect gateway** (`gateway/`). Consumer = the **knext** platform
(`~/alpheya/pocs/knext`), bound by one `DATABASE_URL` Secret. Full brief: `CLAUDE.md`
(repo root) — read it in full. Architecture is fixed; see the "Hard rules" there.

## 2. Current state (v1.4.0 + untagged reliability arc)
**All four scaling axes shipped + live** (`docs/SCALING.md`):
write=vertical, read=horizontal, tenant=horizontal (branch-per-app), zone=eventual.
Through v1.3.5 the zone axis + SCRAM auth + wake-budget shipped (history in git tags).

**Shipped SINCE v1.3.5 (each through the 3-sign-off gate; several deployed live):**
- **v1.4.0 — platform extensions (#179):** TimescaleDB + pgvector self-enable per app
  over its own `DATABASE_URL` (trusted, timeline-scoped, Apache-2 tier bound — no
  compression/continuous-aggregates on scale-to-zero). `docs/adr-0001` accepted.
- **Reliability arc (post-v1.4.0, untagged):** cold-boot settle-gate **#132** (deployed);
  janitor fail-safe **#144** (deployed); drift-gate hardening **#180**; deterministic
  `/status` cold-boot gate **#181** (opt-in, default-OFF; live-enable deferred → **#182**);
  role-prefix fail-fast + test-race + fail-closed test **#183**; wake-budget alert debounce
  **#184** (deployed + drilled); RO-staleness **#187**; bounded **wake-retry #190** +
  polish **#192** (both DEPLOYED to pggw-apps); operator **ownerReferences #122/#189**
  (deployed + live-verified — native cascade-GC); ADR-0008 **RATIFIED** + #158
  accept-and-document (**#193**); RO-staleness drill-verdict + honest deferral **#195/#188**;
  DATABASE_URL dbname doc **#196/#123**; drill-battery robustness **#198/#199**.
- **Recoverability observability — `ColdRestorable` condition (#206/#207, MERGED):** the
  appdb-operator now surfaces the sharpest DR limitation (runbook-dr.md §9d-bis, the
  post-provision ancestor-durability window) as a machine-readable AppDatabase status
  condition. Compares the template `remote_consistent_lsn` to each branch's persisted
  `.status.ancestorLsn`: `True`/AncestorDurable, `False`/AncestorWALNotYetDurable (requeues,
  self-heals), `Unknown` on a pageserver blip. Monotonic (stops polling once True), does
  NOT gate `Ready` (no provisioning-latency change), additive status-only (no DATABASE_URL
  contract change). Full 3-way sign-off (code review + architect + system-designer).
  **⚠ e2e still PENDING:** the OKE `_verify-restore.sh` drill (which already asserts the
  same ancestor-durability property) is the e2e validator and was NOT run (auth window) —
  unit-tested + fail-safe (a wrong field assumption resolves to `Unknown`, never a false
  durability claim). Run `_verify-restore.sh` on the next OKE window to close the loop, and
  confirm the pageserver timeline-detail JSON key is exactly `remote_consistent_lsn`.
- **Drizzle data SDK (`@knext/db`)** — complete on the **knext** side (getknext-dev/knext):
  `getDb`/`getDbRO`, writer-only `kn-next db migrate`, TimescaleDB/pgvector helpers, guide +
  `apps/db-demo`, SIGTERM RO-drain. ADR-0021.
- **Infra:** OCI-session **auto-refresh** installed (`~/.oci/knext-session-refresh.sh` +
  launchd `com.knext.oci-session-refresh`, every 25 min) — reduces manual re-auth during
  active use; a FULL expiry (overnight sleep) still needs one `oci session authenticate`.

**Full test battery run 2026-07-13** (load/scaling/observability): **ZERO product
regressions**; HPA read-scaling scale-up verified under real CPU load (1→2→1); 30-app
scale-ceiling linear (ADR-0003 holds); observability pager path honest end-to-end. Report
in the session transcript; drill-harness gaps fixed in #198/#199.

**⚠ Notable infra observation:** cold-wake latency is elevated on the live cluster
(**~14s mean / 19s max, p95 ~50s** under load) vs the historical ~2–5s — **NOT a code
regression** (node CPU *usage* 7–16%); it's scheduling/attach latency from the **2-node
cluster's CPU-REQUEST pressure** (allocatable ~1830m/node, ~88–93% reserved by the
resident platform; each compute requests 250m). Same 2-node ceiling **blocks clean
multi-compute drills** (co-scheduling writer+RO warm) — see #188/#197 dispositions. A
larger/roomier drill cluster restores ~2–5s wakes and unblocks those.

Repo clean (0 uncommitted, 0 open PRs). Scorecard history: `docs/SCORECARD.md`
(last tagged round v1.3.0 = 6.7 / 6.0 / 5.7).

**Public docs site** (getknext-dev/docs, Fumadocs) is LIVE + current at
`http://knext-docs.knext-docs.51.170.86.139.sslip.io` (Knative Service `knext-docs` in ns
`knext-docs`, rev `knext-docs-00002`), with the scale-zero-pg SDK/extensions/reliability
pages. **Pending publish:** the **write-heavy tuning guide** (docs PR **#14**, merged to
`main` 2026-07-14 — mirrors repo `docs/tuning-write-heavy.md`/#104) is NOT yet on the live
site; it goes live on the next docs redeploy (one `deploy/oke/README.md` rebuild-and-roll —
no code change, purely additive page). **Redeploy:** the docs-site OKE deploy artifacts are now committed to getknext-dev/docs
(`Dockerfile.oke`, `deploy/oke/docs-ksvc.yaml` [the authoritative Knative Service, digest-pinned],
`deploy/oke/README.md` with the steps) — a fresh machine can rebuild the site from the repo:
build `--platform linux/amd64`, push to OCIR `…/knext-docs`, ensure the `ocir-pull` secret in ns
`knext-docs`, apply the ksvc, serve via Kourier (no new LB). See that repo's `deploy/oke/README.md`.

## 3. OPEN DECISIONS for the owner (nothing else is autonomously blocked)
- **Tag `v1.4.x` + convene the blind-trio scorecard review** — the whole reliability arc
  above merged UNBLESSED since v1.3.0; the loop's own release-tag trigger review is overdue.
- **Docs site redeploy** — PR #11 (SDK/extensions/reliability) is merged + LIVE (rev
  `knext-docs-00002`). PR **#14** (write-heavy tuning guide) is merged to `main` but NOT yet
  live; trigger one docs rebuild-and-roll (`getknext-dev/docs` `deploy/oke/README.md`) to
  publish it — additive page, no code change. Low-risk; deferred autonomously only to avoid a
  half-deploy at the edge of an OKE auth window.
- **#182** — expose compute_ctl `:3080` + a JWT to **live-enable the `/status` gate**
  (also validates #158's closure; drill: assert first post-cold-wake conn = scram, never md5).
- **#118** — policy-capable CNI (makes `apps-compute-ingress` NetworkPolicy enforce);
  **infra-risk** (swaps CNI on the live 2-node cluster) — assess first.
- **`pggw`** (single-DB gateway, `10-gateway.yaml`) is **frozen on the v0.6.1 release**
  and has NOT received recent gateway hardening (settle-gate, SCRAM, wake-retry) — decide
  **maintain vs. declare legacy**. `pggw-apps` (the primary multi-tenant path) IS current.
- **Close stale v2.0.0-mistag artifacts** #148/#149/#150 + epic #139 (the zone axis shipped
  additively as v1.3.0; these imply a v2.0.0 review that isn't happening — v2.0.0 reserved
  for a genuine DATABASE_URL/cross-cluster breaking change).
- **Research candidate — `microsoft/pg_durable`** (in-DB durable execution): analysis now
  captured as **`docs/adr-0009-durable-execution-pg-durable.md`** (Status: PROPOSED — research
  note). On-strategy ("compute close to data", durable-by-Neon-for-free) but its
  **background-worker execution conflicts with scale-to-zero** (same class as
  pg_cron/continuous-aggregates). Recommendation: **do not adopt now**; the real prerequisite
  is a **wake-on-scheduled-step** primitive (repl-wake #139/#140 / #35 family), which would
  also unblock pg_cron + continuous aggregates. Owner to accept/reject the ADR.

## 4. Open backlog (github.com/getknext-dev/scale-zero-pg/issues)
Autonomously-doable (no owner decision, no cluster-capacity block):
- **#104** — docs: write-heavy tuning guide (batch/COPY, pooling, async commit, RO offload).
Owner-/infra-gated: **#182**, **#118** (see §3), **#185** (deferred /status live steps).
Feature/design (want owner steer): **#35** (wake-ahead: Knative-activation → gateway
pre-warm), **#7** (in-process CNPG hibernate driver).
Cluster-capacity-gated (need ≥3 nodes): a clean multi-compute `lag_s` re-run; the #197
discriminator experiment (closed as drill-artifact, reopen only if a clean repro appears).
Reference/stale: #163 (process record — #161 gate-bypass, memory-hardened), #148/#149/#150,
#139, #73.
Closed this arc: #122 #123 #132 #141 #144 #157 #158 #162 #166 #179 #180 #181 #183 #184
#186 #187 #188 #189 #190 #192 #193 #195 #196 #197 #198 (via their PRs).

## 5. The workflow (MANDATORY — owner-reaffirmed)
Every change: **plan (issue) → TDD (red→green) → test on the OKE cluster → code review →
architect SIGN-OFF + system-designer SIGN-OFF → merge**. Details in `CLAUDE.md` "loop
step 4/5". The lead runs the gate and merges; **an implementer lane NEVER merges or
self-spawns reviewers** — it opens the PR and STOPS; the lead merges only after all THREE
sign-off COMMENTS are posted on the PR (learned from #163). User docs + `BENCHMARKS.md`
ship in the same PR (rule 2b). After each workflow: shut the agent down, remove its
worktree, close its pane (loop step 6).

## 5b. Agent-team structure — HOW to run the improvement loop
This project is run by a **multi-agent team** (cmux — each named teammate opens in its own
split pane). A future LLM agent should reproduce this structure; the roles are:

- **Lead (orchestrator)** — you. Files issues, spawns lanes, runs the sign-off gate, merges,
  deploys, and keeps the handoff artifacts current. The lead does the coordination and the
  MERGE; it does NOT implement or self-approve.
- **Implementer lane** — ONE agent per issue, working in its OWN git worktree
  (`git worktree add -b feat/<n>-<slug> origin/main /path/KS-PG-wt-<slug>`). It does TDD
  (red→green), opens a PR that says "Closes #N", and **STOPS at the gate** — it never spawns
  reviewers, never merges, never enables auto-merge. Reports the PR number to the lead.
- **Per-PR gate reviewers** — THREE independent agents the LEAD spawns after CI is green:
  (1) **code-reviewer** (correctness/TDD/conventions), (2) **architect-signoff** (ADR/
  sequencing/kill-criteria), (3) **system-designer-signoff** (contracts/failure-modes/
  isolation). Each POSTS its verdict as a PR comment (`gh pr comment`) starting with e.g.
  `**CODE REVIEW: APPROVE**` / `**ARCHITECT: SIGN-OFF**` / `**SYSTEM-DESIGNER: SIGN-OFF**`.
  For scale-zero-pg use `general-purpose` agents with a scoped prompt; the knext repo has
  dedicated `knext-code-reviewer` / `knext-architect-signoff` / `knext-systemdesigner-signoff`.

**The loop, end to end:** lead files issue(s) → spawns an implementer lane per issue →
lane TDDs + opens PR + stops → lead waits for CI green → lead spawns the 3 gate reviewers →
each posts a sign-off comment → **lead merges ONLY when all 3 sign-off COMMENTS are posted**
(reconcile from the PR comments, don't trust a bare idle-notification) → if the change is a
manifest/image, lead does the **post-merge deploy** (CD builds on push to `gateway/**`; lead
pins the new `sha-<short>@sha256:<digest>` in the deploy manifest + `kubectl rollout`) →
lead tells the lane to run **loop step 6** (remove worktree + prune, delete branch, close
pane) → lead verifies cleanup and sends a `shutdown_request` to each finished agent.

**Hard rules (learned the hard way):**
- **#163 — lanes NEVER self-merge or self-spawn reviewers.** The gate bypass in #161 (a lane
  merged with 1/3 sign-offs) is why the lead owns the merge and requires 3 POSTED comments.
- **Deconfliction (agent-spawn-deconfliction):** unique worktree name per lane + DISJOINT
  issue/file ownership; check the roster before spawning; if two lanes collide, the
  furthest-along wins.
- **Pane/agent hygiene:** after a lane completes + cleans up, `shutdown_request` it; verify the
  pane closed (a wedged pane is killed via its captured pane id). Reviewers are retired the
  same way once their sign-off is posted.
- **Signal vs noise (drills/tests):** classify a test FAIL as product-REGRESSION (alarm) vs
  drill-timing / capacity / transient-infra artifact (expected on the 2-node cluster) — only a
  real regression blocks. NEVER scale down production to free drill capacity — park instead.
- **Honesty:** report coverage truthfully (offline vs live), never fabricate a green run; when
  the OKE API is flaky or the session lapses, say so and fall back to offline/code-traced proof.

## 6. Credentials / access a new agent must provision (NOT in the repo)
1. **GitHub**: `gh auth` with push to `getknext-dev/scale-zero-pg` (auto-merge +
   delete-branch enabled on the repo).
2. **OCI / OKE cluster**: kubeconfig context **`context-ckmva7v7zvq`**, namespace
   **`scale-zero-pg`**. Refresh a session with:
   `oci session authenticate --no-browser --profile-name knext --region me-abudhabi-1`
   (pipe from non-tty stdin). **kubectl wrapper quirk:** it errors on `--context` placed
   *before* the subcommand and self-resets to local `orbstack` — always run
   `kubectl config use-context context-ckmva7v7zvq` first, verify `current-context`, then
   plain `kubectl -n scale-zero-pg …`.
3. **OCIR registry** (gateway image build/push): `me-abudhabi-1.ocir.io/axfqznklsd2t/ks-pg/gateway`.
4. **Auto-memory**: copy `~/.claude/projects/-Users-banna-POC-KS-PG/memory/` into the new
   machine's matching project-memory dir (10 files incl. `MEMORY.md`, `signoff-gate.md`,
   `agent-spawn-deconfliction.md`, `agent-pane-hygiene.md`). This is recall context, not
   required to function — the repo carries the durable state.

## 7. What does NOT transfer (don't bother)
Old Claude Code session `.jsonl` transcripts (~155 MB, machine-path-hash-keyed), running
teammates, git worktrees, tmux panes, scheduled wake-ups, background tasks, and OCI
session tokens. All ephemeral/machine-local. A fresh agent rebuilds context from this
doc + `CLAUDE.md` + `docs/` + the issues/PRs/ADRs.

## 8. First moves for the new agent
1. `git clone` the repo; read **`docs/ARCHITECTURE.md` FIRST** — the code-map that tells you
   what lives where and how the wake flow / drivers / operator / security model actually work
   (verified accurate to file:line; the source packages carry thorough godoc). Then `CLAUDE.md`,
   `docs/SCALING.md`, `docs/SCORECARD.md`, `docs/BENCHMARKS.md`, and the ADR ledger
   `docs/adr-0001..0008` (0008 now **ACCEPTED**). To VERIFY the system or run a trigger-review
   battery, read **`docs/DRILLS.md`** (what each `deploy/_verify-*.sh` proves + how to run +
   how to read the results). A local graphify knowledge graph is at `graphify-out/` (gitignored;
   `graphify update` to refresh) for navigating the code. The gateway + operator source carry
   thorough godoc.
2. Provision the §6 credentials; verify cluster reachability
   (`kubectl config use-context context-ckmva7v7zvq && kubectl -n scale-zero-pg get deploy`).
   If the OCI session lapsed: `oci session authenticate --profile-name knext --region me-abudhabi-1`
   (browser SSO — human-only). The launchd auto-refresh keeps it alive during active use.
3. **Surface the §3 owner decisions** (v1.4.x tag + trio; docs #11 publish; #182; #118;
   pggw maintain-vs-legacy; close #148-150/#139). None is autonomously unblocked.
4. Meanwhile, the one clean autonomous item is **#104** (write-heavy tuning guide) — do it
   through the full sign-off gate (§5). Larger feature items (#35, #7) want owner steer.
5. **Working discipline (owner directive 2026-07-13):** after EACH step of work, update the
   relevant `docs/` AND this `HANDOFF.md` so the project handover to another agent stays
   current — the repo is the memory; keep it truthful and live.
