# CLAUDE.md — kickoff brief for this MVP

## Status: v1.0.0 GA (2026-07-05); latest tag **v1.4.0** + untagged reliability arc — open-ended post-1.0 loop
_Current state, open owner-decisions, and full backlog live in **`HANDOFF.md`** (kept current after each step). Since GA: all 4 scaling axes, SCRAM auth, wake-budget, zones (v1.3.x), platform extensions (v1.4.0), the Drizzle SDK, and a large reliability arc (wake-retry/#190, /status gate, operator ownerReferences, ADR-0008 ratified, drill-harness robustness). A v1.4.x tag + blind-trio review is pending owner approval._
**v1.0.0 GA released.** All 10 ratified GA criteria met (#73): declarative provisioning
(AppDatabase CRD + reconcile operator, ADR-0004), per-app restore executed, tenant quotas,
read-replica-pool GA, storage-plane upgrade executed, KC5 real-knext-use, independent security
review (a cross-tenant bypass was found + fixed pre-tag, #112/#115), scale ceiling demonstrated
(30 apps, linear), observability parity, configurable object storage (ADR-0005: OCI/S3/on-prem,
MinIO optional). The improvement loop is GRADUATED + now OPEN-ENDED (owner: "continue looping
until I stop"): trigger-gated reviews + owner-directed post-1.0 work.

## Product vision: UNIFIED knext platform (app layer + database layer)
**scale-zero-pg and knext are ONE platform, two layers.** knext scales the *applications*
(Next.js on Knative, HTTP activator); scale-zero-pg scales their *databases* (TCP wake-on-connect
gateway — deliberately non-Knative, because Knative's activator is HTTP-only). Same cluster,
both scale-to-zero, joined by a single `DATABASE_URL` Secret (`NextApp.spec.secrets.envMap`).
The unified pitch: an app and its database sleep at zero and wake together on one visitor request.
Unified-platform docs live in the knext doc site (getknext-dev/knext `docs/`), positioning
scale-zero-pg as the knext platform's database layer.

## Original goal (met)
Ship a **Knative-ecosystem scale-to-zero PostgreSQL**: databases easy to host, maintain, reliable.
Idle DB → zero compute; a client connection wakes it sub-second(ish). Reuse Neon OSS below the
wire; build only the glue. Multi-tenancy shipped as **branch-per-app** (DB-per-app, tens/low-
hundreds of apps on one shared plane; each app a Neon branch + its own 0↔1 compute, now
provisioned by the **AppDatabase CRD operator**, `provision-app.sh` retained as break-glass).
Read-scaling axis shipped (`compute-ro` / `DATABASE_URL_RO`). **SCS multi-SYSTEM / full
data-sovereignty-zone multi-tenancy remains parked / out of scope.**

## Consumer
The **knext** platform (`~/alpheya/pocs/knext`) — a scale-to-zero Next.js framework on
Knative (Go operator, `NextApp` CRD). knext binds databases only via a `DATABASE_URL` Secret
(`NextApp.spec.secrets.envMap`) and deliberately builds no DB machinery itself. KS-PG ships as
cluster infrastructure **alongside** knext; integration = one Secret pointing at our gateway.
Research notes: `docs/knext-research.md`.

## Architecture (fixed)
Native Postgres compute on Neon's OSS storage stack, all **on Kubernetes** (no docker-compose):
- **Storage plane (reused, StatefulSets):** safekeeper (durable WAL, single-writer authority),
  pageserver (pages + S3/MinIO offload), storage broker, MinIO. Never scaled to zero.
- **Compute plane:** one stateless Neon compute (`neondatabase/compute-node-v17`) as a Deployment,
  `replicas: 0` at rest, scaled 0↔1. Cold start = attach + lazy page fetch; no restore.
- **Routing plane (we build, Go):** `gateway/` — wake-on-connect Postgres proxy. Parses the
  startup packet, declines SSL, scales the compute Deployment via the API server (client-go),
  replays startup, pipes bytes, and scales back to 0 after `GW_IDLE_MS` with no connections.

## Hard rules
1. **Go for everything Kubernetes-native. No JS/TS unless necessary.**
2. **TDD commits**: test/verification commit first (red), implementation commit second (green).
2b. **User docs ship WITH the change.** Any change that alters user-visible behavior,
   config, drills, or measured numbers updates docs/ (getting-started, connecting,
   operations) in the same commit or the same PR-sized batch. Doc drift found in
   review counts as a defect.
3. Single-writer is intrinsic to Neon — no lease/fencing layer. Compute uses `Recreate` strategy.
4. Storage plane never on Knative, never scale-to-zero. Compute scaling is TCP-triggered
   (gateway/KEDA), not Knative Serving — the activator is HTTP-only.
5. Don't rebuild what Neon gives free: WAL durability, replication, branching, PITR.
6. Everything runs on the cluster (`orbstack` context locally). No compose files.

## Repo map
- `gateway/`  — Go wake-on-connect proxy (client-go). Tests in package; `go test ./...`.
- `deploy/`   — all k8s manifests: 00 namespace, 10 gateway, 20 compute (replicas:0),
                30 knext Secret, 40 KEDA (optional), 5X storage plane + init Job.
                `_validate.sh` (manifest contracts), `_verify-storage.sh` (survival test).
- `docs/`     — knext research, recipes.

## The improvement loop (GitHub-native, owner-defined)
Repo: github.com/getknext-dev/scale-zero-pg (auto-merge + delete-branch enabled).

**Cadence: GRADUATED (2026-07-03, unanimous iteration-7 trio ruling, issue #36).**
Per-iteration review rounds have ended. A fresh blind trio re-convenes only on
TRIGGERS: (a) a release tag, (b) an ADR change or a knext-side change to the
DATABASE_URL contract, (c) any kill-criterion tripwire firing (mapping:
docs/operations.md "Kill-criteria tripwires"), (d) `_rehearse-upgrade.sh`
exit ≠ 0, (e) the dated KC5 review (issue #65, due 2026-10-03). Steps 1–6 below
still govern any implementation work; only the review cadence changed.
1. **Plan** = GitHub issues (one per work item, acceptance criteria in the body).
2. **Implement** on a branch per issue, TDD commits, PR references the issue
   ("Closes #N"). User docs + BENCHMARKS.md ship in the same PR (rule 2b).
3. **Test**: full drill battery on the OKE cluster (context context-ckmva7v7zvq,
   ns scale-zero-pg) before requesting review.
4. **Review + SIGN-OFF (per-PR gate, owner-reaffirmed 2026-07-06).** Every PR,
   after its OKE battery is green, passes an explicit gate BEFORE merge:
   (a) **code review** (correctness, TDD adherence, conventions);
   (b) **architect SIGN-OFF** — no ADR/sequencing/kill-criterion violation;
   (c) **system-designer SIGN-OFF** — contracts, failure modes, isolation, scaling.
   BOTH sign-offs are required; a BLOCK/request-changes stops the merge until fixed.
   Findings are PR comments; on trigger events (release tag / ADR change / tripwire)
   the full blind trio also convenes with the 1–10 scorecard (docs/SCORECARD.md).
   The lead does NOT merge on its own verification alone — sign-off is the gate.
5. **Merge**: only after code review passes AND architect + system-designer sign
   off. Issues close; new findings become the next iteration's issues.
6. **Cleanup (mandatory, after every successful workflow)**: the finished agent is
   shut down, its git worktree removed (`git worktree remove` + `prune`), and its
   cmux/tmux pane closed — verified, not assumed (wedged panes get killed after
   identification via `tmux capture-pane`). Safe because the repo is the memory:
   all agent output lives in merged PRs/issues/docs before cleanup starts.

## Definition of done (MVP)
On a local k8s cluster, with a one-table test DB:
1. Compute at 0 → `psql` through the gateway → compute wakes → rows return. Wake time recorded.
2. Idle window passes → compute back to 0 (verified, no phantom keepalives).
3. Reconnect wakes it again; data intact (storage plane owns durability).
4. knext integration documented: Secret + pool-idle-below-GW_IDLE_MS sizing note.

**Shipped beyond the single-DB DoD (v0.6.0, see `docs/adr-0003-multi-tenancy.md`):**
5. **Multi-tenant axis** — branch-per-app: N apps as Neon branches on one shared plane, each with
   its own 0↔1 `compute-<app>`, provisioned by `deploy/provision-app.sh`, routed by the
   apps-gateway (`template` wake mode). Scope bound + deferred CRD operator per the Goal above.
6. **Read-scaling axis** — read-replica pool `compute-ro` (0↔N) via `DATABASE_URL_RO`, optional
   warm tier and HPA.

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
