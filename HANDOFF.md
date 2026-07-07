# HANDOFF — scale-zero-pg (read this first)

Portable handoff for a **fresh Claude Code agent / another account** to resume this
project. You do **not** resume old chat sessions — the repo IS the memory. Clone the
repo, provision the credentials below, read this + `CLAUDE.md` + `docs/`, and continue.

_Last updated: 2026-07-07, at tag **v1.3.5**._

## 1. What this project is
A **Knative-ecosystem scale-to-zero PostgreSQL platform** — idle databases cost zero
compute; a client TCP connection wakes the compute sub-second. Native Postgres compute
on **Neon's OSS disaggregated storage**, all on Kubernetes; the only thing we build is a
Go **wake-on-connect gateway** (`gateway/`). Consumer = the **knext** platform
(`~/alpheya/pocs/knext`), bound by one `DATABASE_URL` Secret. Full brief: `CLAUDE.md`
(repo root) — read it in full. Architecture is fixed; see the "Hard rules" there.

## 2. Current state (as of v1.3.5)
**All four scaling axes shipped + live** (`docs/SCALING.md`):
write=vertical, read=horizontal, tenant=horizontal (branch-per-app), zone=eventual.

Release line this session (each through the sign-off gate):
- **v1.3.0** — Zone axis / SCS (ADR-0007): gateway-mediated replication-wake (#140),
  slot-aware janitor + 512MB WAL bound (#143), Zone CRD + operator (#145).
- **v1.3.1** — zone operator deployed live + janitor-disarm alert (#151/#142).
- **v1.3.2** — zone reliability: fail-closed single-writer, re-sync actuator, zone
  alerting (#146/#147/#154).
- **v1.3.3** — deploy-integrity: OCI-index-aware drift gate + Prometheus auto-reload
  (#153/#155/#156).
- **v1.3.4** — **md5 → SCRAM-SHA-256 auth**, live-enforced, zero-outage rollout
  (#117/#159/#160/#161).
- **v1.3.5** — per-app **wake budget** closing the unauthenticated wake side-channel
  (#116) + **ADR-0008** (PROPOSED).

Repo is clean (0 uncommitted). Blind-trio scorecard history: `docs/SCORECARD.md`
(v1.3.0 round = 6.7 / 6.0 / 5.7; architect SIGN-OFF).

## 3. OPEN DECISION for the owner
- **ADR-0008 (`docs/adr-0008-wake-primitive-security.md`) is PROPOSED, awaiting owner
  ratification.** It rules the wake primitive a bounded shared-plane property (rate-limit
  now + NetworkPolicy via #118) rather than adding gateway pre-auth. Ratify (→ ACCEPTED)
  or request full pre-auth. Gates further wake-hardening work.

## 4. Open backlog (github.com/getknext-dev/scale-zero-pg/issues)
Security tail (next up):
- **#118** (p3) policy-capable CNI → makes `apps-compute-ingress` NetworkPolicy enforce.
  **Infra-risk** (swaps flannel on the live 2-node cluster) — assess before touching.
  This is the "Option C" pairing for ADR-0008.
- **#164** (p2) RO/warm computes lack the scram pg_hba + #112 `cloud_admin` reject
  (defense-in-depth; strong password still holds — assessed NOT p1, see the issue).
- **#158** cold-wake md5 downgrade window (a `compute_ctl` limitation; rule-5-bounded).

Follow-ups / hygiene: #166, #162, #157, #144, #141, #132, #123, #122, #104, #35, #7.
Process audit: **#163** (a lane self-merged #161 before the gate completed — see §6).
`#139` = the v2 zone epic (tracking, effectively delivered). `#148-150` = v1.3.0 blind
reviews (keep for reference).

## 5. The workflow (MANDATORY — owner-reaffirmed)
Every change: **plan (issue) → TDD (red→green) → test on the OKE cluster → code review →
architect SIGN-OFF + system-designer SIGN-OFF → merge**. Details in `CLAUDE.md` "loop
step 4/5". The lead runs the gate and merges; **an implementer lane NEVER merges or
self-spawns reviewers** — it opens the PR and STOPS; the lead merges only after all THREE
sign-off COMMENTS are posted on the PR (learned from #163). User docs + `BENCHMARKS.md`
ship in the same PR (rule 2b). After each workflow: shut the agent down, remove its
worktree, close its pane (loop step 6).

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
1. `git clone` the repo; read `CLAUDE.md`, `docs/SCALING.md`, `docs/SCORECARD.md`, and the
   ADR ledger `docs/adr-0001..0008`.
2. Provision the §6 credentials; verify cluster reachability
   (`kubectl config use-context context-ckmva7v7zvq && kubectl -n scale-zero-pg get deploy`).
3. Ask the owner to ratify **ADR-0008** (§3).
4. Continue the security tail: **#118** (assess infra risk first), **#164**, then the
   hygiene backlog — each through the full sign-off gate (§5).
