# Proposed `.claude/rules/workflow.md` diff — name the platform-e2e stage (#1205 / P5)

**Status:** PROPOSAL ONLY. Rules files are not an agent's to edit — this is written for the
maintainer to apply (or reject) at sprint close. It extends the T1 proposed diff
(`.claude/research/1197-workflow-md-proposed-diff.md`), which named the per-PR process round;
this one names the **platform** leg above it.

## Why

The file-manager e2e effort now has three distinct legs with three different triggers, and only
the first is named in `workflow.md`'s pipeline. Without a written scoping rule, "did the e2e run?"
has no single answer — a PR-green tree can be nightly-red, and nobody owns noticing. This diff
names the stage, states which leg runs when, and is honest about which legs are proven versus
planned.

The three legs, as they exist today:

- **T1 process round (per-PR gate, shipped)** — the `file-manager-e2e-round` aggregator on `ci.yml`:
  build → compile → compat-smoke (serve + routes + ISR over real HTTP) → prod-image. Path-scoped at
  the aggregator via merge-base diff (never via `paths:` on the workflow — #673). This is and
  remains **the only per-PR gate**; nothing below gates a PR.
- **Profile A — compute scale-to-zero (nightly, PROVEN green)** — `operator-e2e-nightly.yml` job
  `scale-to-zero-cache` (Go suite tag `e2e_scale`, `scale_from_zero_test.go`): the operator deploys
  the signed file-manager image to Knative on kind, the app scales to zero, wakes on a request, and
  the WOKEN pod serves the real app — GET `/` (200 + real-render marker), a force-dynamic route
  (200, SSR per request), and authenticated ISR invalidation (`POST /api/cache/invalidate` → 401
  without the Bearer token / 200 with it / content revalidated, with a pod-recycle-proof control)
  (#1202). Trigger: nightly cron + on-demand `workflow_dispatch`. **Not** a per-PR gate.
- **Profile B — DB scale-to-zero (lead-local/OKE, PLANNED — not shipped)** — deploy `db-demo` with a
  scale-zero-pg Postgres, idle BOTH compute and DB to zero, verify a wake-from-zero serves a
  DB-backed read (#1203 harness, #1204 double-zero drill). Runs lead-local / on OKE, serialized per
  the "cluster work is a queue of one" rule — **not CI**, and **not claimable as shipped** until
  those issues close.

## Proposed change

In `## The pipeline (per task)`, immediately after the T1 stage 3a proposed by the #1197 diff
(or after step 3 if that diff is not applied), insert:

```diff
+3b. **Platform e2e (scale-to-zero profiles)** — the leg the per-PR round deliberately does not
+    carry: a live cluster, the operator, and a real wake-from-zero. Two profiles, different
+    cadences, neither a PR gate:
+    - **Profile A (compute scale-to-zero) — nightly, proven.** `operator-e2e-nightly.yml` job
+      `scale-to-zero-cache` (`make test-e2e-scale`, tag `e2e_scale`): operator deploys the signed
+      file-manager image on kind+Knative, scales to zero, wakes, and the woken pod serves GET `/`
+      (real-render marker), a force-dynamic route, and authenticated ISR invalidation
+      (401-without-token / 200-with / revalidated, pod-recycle-proof control). Trigger: nightly
+      cron + `workflow_dispatch` (`gh workflow run operator-e2e-nightly.yml`). A nightly red is a
+      pipeline signal even though it blocks no PR: whoever opens the sprint day triages it — a
+      PR-green tree can be nightly-red, and nothing else will say so.
+    - **Profile B (DB scale-to-zero) — lead-local/OKE, PLANNED.** db-demo + scale-zero-pg, idle
+      BOTH compute and DB to zero, verify wake-from-zero serves a DB-backed read. Lead-owned,
+      serialized like all cluster work (queue of one), not CI. Until it ships, no claim that
+      "double-zero wake" is verified — the honest status is compute-zero proven, db-zero planned.
+    Scoping rule: the per-PR gate stays the T1 process round (stage 3a); the platform profiles run
+    on their own clocks (nightly / lead-initiated) and are never made PR-blocking without a design
+    decision — a cluster-bound gate on every PR is the cost model the nightly split exists to avoid.
```

(As with the T1 diff: either renumber the following steps or keep this as a sub-step of 3 —
maintainer's call. The two proposed stages compose; applying only one is coherent.)

## Notes for the reviewer

- **No workflow-logic change is proposed** — every mechanism named (aggregator, nightly job,
  dispatch) already exists; Profile B's mechanism does not exist yet and is labeled PLANNED.
- The contributor-facing "how to run it" detail lives in
  `packages/kn-next-operator/test/e2e/README.md` (updated in the same PR as this file), not here —
  rules state the scoping, the dev-doc states the invocation.
- Deliberately NOT in the user docs site (`apps/docs`): this is a contributor/CI concern, and the
  docs site carries no internal CI stages, issue numbers, or codenames (content-hygiene).
- Known adjacent debt, not papered over: three sibling nightly jobs (`cli-e2e`, `gc-e2e`,
  `rollback-e2e`) have pre-existing failures tracked in #1208, and nightly red-alert routing is
  #1207 — Profile A's "proven green" claim is about its own job, not the whole workflow.
