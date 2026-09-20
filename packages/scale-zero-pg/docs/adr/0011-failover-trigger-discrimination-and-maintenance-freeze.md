# ADR 0011 — Failover trigger discriminates dependency-degradation from node-death, plus a TTL-bounded maintenance freeze

Status: Accepted — on-cluster verification pending (C2: one green end-to-end multi-tenant drill on a recovered/clean plane)
Date: 2026-09-20

> Numbered to continue the `docs/adr/000N` sub-series (0001–0003, then 0010). The
> root `docs/adr-000N-*.md` files are a SEPARATE, older series; "ADR-0004" elsewhere
> in the repo means the root provisioning ADR, not this one.

## Context

`pswatcher` (ADR-0010) promotes the warm standby on **sustained primary-pageserver
death**. Promotion is **irreversible and standby-consuming**: it fences the old
primary at `generation+1`, flips the client `pageserver` Service selector, and bounces
every compute. There is one standby, and failover is one-way — so a promotion fired on
a **recoverable** condition is a self-inflicted outage.

The trigger, before this ADR, was a liveness signal that could not distinguish two very
different situations:

1. **The pageserver process/pod is dead** — crashed, evicted, node gone. Promote.
2. **A dependency is degraded, process still alive** — e.g. object-store creds
   mid-rotation (MinIO→GCS). Do **not** promote; it recovers on its own.

Both surfaced identically. The pageserver's k8s **readiness *and* liveness probes both
hit `/v1/status`** (`deploy/53-pageserver.yaml`). When object storage degrades, the
status endpoint fails, the pod goes **NotReady**, and the watcher's own HTTP probe
fails — which the old trigger read as death. The **live incident (2026-09-19)**: a
MinIO→GCS cred switch briefly degraded the primary, `pswatcher` failed over needlessly,
and the plane split-brained.

Second, some **planned** operations legitimately make the primary unreachable — a cred
rotation that restarts the pageserver pod, an object-store migration. During those, no
container-state signal can distinguish the planned restart from a crash, so the operator
needs an explicit, **safe** way to pause failover for the window.

## Decision

**1. Discriminate on the container-running signal (grounded in pod status).**
`K8sOps.PodReady` now also reports whether the primary pod's container(s) are in the
**`Running`** state (`pod.status.containerStatuses[].state.Running`), independent of the
`Ready` condition. The failure-path decision table becomes:

| HTTP probe | pod present | Ready | container running | verdict |
|---|---|---|---|---|
| fail | yes | yes | — | our-side partition → **hold** (`suspected_partitions_total`, ADR-0010 §#26) |
| fail | yes | no | **yes** | **dependency degraded → hold** (`dependency_degraded_total`) — NEW |
| fail | yes | no | no | container gone/crashing → **promote** |
| fail | yes | *stale* | *stale* | **node lost** (`Ready=False`/`NodeLost`/`NodeStatusUnknown`) → **promote** — NEW, see below |
| fail | no | — | — | pod absent → **promote** (subject to the §#58 seen-present anchor / ledger-advanced resume) |
| fail | — | — | — (API unreachable) | cannot corroborate → **hold** (fail-closed, ADR-0010) |

Rationale: a live process failing only its *readiness* probe is a degraded dependency,
not a dead node. This is grounded in what the API server already exposes — no new probe,
no object-store credentials in the watcher.

The `running` bit is read from the **pageserver container by name**
(`PSW_PRIMARY_CONTAINER`, default `pageserver`), not from "all containers", so a future
sidecar crashlooping is not misread as the pageserver process dying. A container name
that matches nothing in the status list reads as **not running** — we assert liveness
only on positive evidence, and that direction costs the discrimination rather than
fabricating liveness that could hold through a real death.

**The node-death carve-out (required, not optional).** When a node dies there is no
kubelet left to write pod status, so `containerStatuses` stays **frozen at `Running`**
indefinitely. Read naively, the row above turns a **true node death** into "process alive
⇒ dependency degraded ⇒ hold" — deferring recovery from ~40s to taint-based eviction
(~5.5 min on cluster defaults), and, with an `unreachable` toleration on the storage
plane, deferring it **forever**: a silent, permanent HA outage. The discrimination would
then have *caused* a worse outage than the one it prevents. So the node-lifecycle
controller's marking (`Ready=False` with reason `NodeLost`/`NodeStatusUnknown`, or
`pod.status.reason = NodeLost`) is treated as **stale status ⇒ death ⇒ promote**, in both
the `ready` and the `running` bit. `deploy/_validate.sh` additionally asserts the storage
plane carries no infinite `unreachable`/`not-ready` toleration, so the permanent variant
cannot be reintroduced silently, and `PswatcherDependencyDegraded` pages when a hold is
**sustained** (`for: 5m`) so a hold can never masquerade as health.

**False-negative bound (a live hang).** A pageserver whose process is "Running" but
genuinely wedged would `hold` under the rule above. That is safe because the pageserver's
own **`livenessProbe`** (also `/v1/status`, `failureThreshold: 6`) restarts a wedged
container; a restart that does not fix it becomes **CrashLoopBackOff** — container **not
running** — at which point the table promotes. So the discrimination adds a bounded delay
(the liveness window) to a true hang, and never a permanent miss.

**Scope bound (the discrimination is a SUB-60s mechanism — read this before quoting it).**
All three signals — the watcher's probe, the pageserver's readiness probe and its
**liveness** probe — hit the **same `/v1/status`** endpoint. So an object-store
degradation that outlasts the liveness window (`failureThreshold: 6 × periodSeconds: 10`,
≈60s) **kills the container itself**, at which point `running` goes false and the watcher
promotes anyway. The discrimination therefore covers degradations **shorter than the
liveness window only**. The incident that motivated this ADR — a MinIO→GCS credential
rotation — is a **minutes-long** class, so it is **outside** that window: the mitigation
for it is the **maintenance freeze in §2, not the discrimination**. The two are sequenced,
not interchangeable, and the drill asserts them separately (DG1 = sub-window; FZ2 =
the freeze).

**2. A TTL-bounded maintenance freeze.** An admin (or the operator) sets a
`pageserver-failover-freeze` ConfigMap with an `until` = RFC3339 absolute expiry (and an
optional `reason`). While active it suppresses promotion **even on a confirmed death**.
Safety is intrinsic and layered:

- **Absolute expiry** — the freeze auto-lapses at `until`; time passing is what clears it,
  so a *forgotten* freeze still ends.
- **Duration clamp** — the *effective* expiry is `min(until, createdAt + MaxFreezeDuration)`
  (`MaxFreezeDuration` default **2h**, `PSW_MAX_FREEZE_MS`), so a *fat-fingered* far-future
  `until` cannot disable HA beyond the bound. The clamp is applied in the Controller (unit
  tested), not in the k8s read. A freeze with **no `createdAt`** cannot be clamped at all,
  so it is **refused** (treated as no freeze and counted) rather than honoured unbounded.
  The manifest's `PSW_MAX_FREEZE_MS` and the binary's `DefaultMaxFreezeDuration` are held
  in **lockstep by `deploy/_validate.sh`**, so the "2h" above is a claim about the code
  actually shipped, not about a default nobody sets.
- **Observability** — `pswatcher_failover_frozen` (gauge 1 while active),
  `pswatcher_failover_freeze_expiry_seconds` (the effective expiry),
  `pswatcher_failover_freeze_suppressed_total` (would-be failovers suppressed) and
  `pswatcher_freeze_read_errors_total` (the freeze state could not be established).
  Alerting fires while a freeze is active *and* if the gauge is still 1 near/after its
  expiry. Every one of those metrics is **pinned to its alert by `deploy/_validate.sh`**
  in both directions, so a rename cannot leave the mitigation's own alert dormant with
  CI green.
- **Fail-SAFE read (amended — this reverses the original decision).** The first cut made
  an unreadable ConfigMap or a malformed `until` **abort the tick**, on a "fail loud"
  argument. That was **wrong, and dangerously so**: the abort returned *before* the
  prober, the second-vantage read and the failover path, so a **permanent** error — and a
  fat-fingered `until` is permanent by construction — **silently disabled HA entirely**,
  froze `pswatcher_primary_up` at its last value and fired no alert. "Fail loud" produced
  the quietest possible outage: fail-open-to-outage, the exact class this feature claims
  to bound. The watcher now treats *any* unestablishable freeze state as **NO freeze — HA
  stays ON, the tick completes** — and **counts** it
  (`pswatcher_freeze_read_errors_total` → `PswatcherFreezeUnreadable`). The trade is
  asymmetric on purpose: skipping a freeze for one tick on a transient API error risks a
  failover during a planned op (recoverable, re-read next tick), while disabling HA
  permanently risks an unbounded read outage with no signal.

**3. Classify the failover.** On a real-death promotion the watcher publishes
`pswatcher_failover_reason{reason="node_death"} 1`, so a scraper (and the failover drill)
can prove the trigger discriminated rather than firing blindly.

## Options considered

### Discrimination signal

| Option | How death is told from degradation | Trade-offs |
|---|---|---|
| **A. Container-running state via the API server (CHOSEN)** | `containerStatuses[].state.Running` — process alive vs Terminated/Waiting | Grounded in existing pod status; no new probe, no object-store creds in the watcher; the pageserver's own livenessProbe backstops a true hang. Residual: adds a liveness-window delay to a genuine hang. |
| B. A dedicated pageserver dependency-health endpoint | The pageserver reports object-store health separately | Cleanest signal, but no such endpoint exists on `neon:8464`; building/patching one is upstream work far beyond this task, and couples the trigger to a bespoke image. |
| C. The watcher probes the object store directly | Watcher scans S3/MinIO itself | Puts object-store credentials and a bucket-scanning path into the failover controller for one decision — the same surface ADR-0010 §vantage deliberately refused. |
| D. Longer fail-threshold / backoff only | Just wait longer before promoting | A degradation can outlast any fixed threshold, and lengthening it delays *real* failover for everyone; tuning trades one failure mode for the other without discriminating. |

### Freeze mechanism

| Option | Who sets it / shape | Trade-offs |
|---|---|---|
| **A. `pageserver-failover-freeze` ConfigMap, absolute `until` + duration clamp (CHOSEN)** | Admin `kubectl` or operator | Declarative, GitOps-visible, RBAC already covers `configmaps get`; absolute expiry + clamp make a stuck freeze impossible to leave open indefinitely; auditable. |
| B. A pod annotation on the pageserver | Admin annotates the pod | Ephemeral (lost on reschedule), and the watcher would need pod-write RBAC; no natural TTL. |
| C. A duration-from-now (`freeze for 30m`) | Admin sets a duration | Requires the watcher to record set-time durably anyway; an absolute `until` is simpler and inspectable, and the clamp already bounds abuse. |
| D. No freeze; rely on discrimination alone | — | Discrimination cannot cover a planned op that RESTARTS the pod (container not running looks like death). A freeze is required for that class. |

**Recommended: A + A.** Discrimination handles "process up, dependency down"; the freeze
handles "planned op that takes the process down". They are complementary, not redundant.

## Consequences

**Positive.**
- A **short** (sub-liveness-window) object-store degradation that leaves the process
  running no longer triggers a failover.
- Planned ops — including the **minutes-long** class the live incident belongs to — have
  a safe, bounded, observable pause on failover.
- A true node death still promotes promptly rather than being misread as a degradation.
- No new RBAC (freeze CM read is covered by the existing `configmaps get`), no
  object-store credentials in the watcher.

**The live split-brain class is NOT "closed" by the discrimination alone — do not claim
it is.** The earlier draft of this ADR said it was. That claim does not survive its own
§1 scope bound: the cited incident (a MinIO→GCS credential rotation) lasts **minutes**,
the discrimination only holds for **under ~60s**, and past that the shared `/v1/status`
livenessProbe crashloops the container and the watcher promotes. What actually covers the
incident class is the **operator setting a freeze before the operation** — which is a
**procedural** mitigation, and therefore only as reliable as the procedure. `operations.md`
states it as a requirement rather than a suggestion, and that is the honest strength of
the claim.

**Negative / residual (stated honestly).**
- **The freeze read is a GLOBAL HA dependency.** One ConfigMap's readability is consulted
  on *every* tick, ahead of everything else. The fail-safe amendment above means a blind
  read can no longer disable HA — but it does mean a blind read silently leaves a planned
  op **unprotected**, which is why `pswatcher_freeze_read_errors_total` exists and is
  alerted rather than merely logged.
- **A freeze is PLANE-WIDE, never per-tenant.** One freeze suppresses failover for the
  base tenant **and** every per-app timeline on the plane. There is no way to freeze one
  app's database while leaving the rest under HA; the scope is the whole storage plane.
- **On a PERMANENT object-store outage, failover cannot help — and the platform will try
  anyway.** Once the degradation outlasts the liveness window the primary crashloops and
  the watcher promotes the standby, which reads from the **same object store** and
  therefore fails identically. The promotion consumes the standby for no benefit. A
  freeze set *before* the op is what prevents that, and the reason `operations.md` makes
  it mandatory for object-store work rather than advisory.
- **Manifest/binary lockstep is a real upgrade hazard.** `PSW_FREEZE_CONFIGMAP` /
  `PSW_MAX_FREEZE_MS` only take effect in a pswatcher image that contains this code.
  Apply the manifests against an **older** image and the freeze an operator sets is read
  by nobody: the new env vars are inert and failover proceeds through the planned op.
  Roll the pswatcher image **before** relying on a freeze.
- **Re-applying the freeze ConfigMap resets its TTL anchor.** The clamp is keyed to the
  object's `CreationTimestamp`, so `kubectl delete`+recreate (or a GitOps re-create)
  starts a fresh 2h budget, while an in-place `patch`/`edit` keeps the original anchor and
  can therefore *shorten* a freeze the operator believes they just extended. Both
  behaviours are documented in the runbook.
- **A true hang costs the liveness window.** A wedged-but-Running pageserver is held
  until its livenessProbe restarts it into a crashloop (≈ `failureThreshold × period`,
  ~60s on the shipped probe) before promotion. This is a deliberate trade against the far
  more common needless-failover.
- **The container-running signal is coarse.** It is "all containers Running", not
  "the pageserver is actually serving pages". A process that is Running but silently
  wrong is caught only by the liveness backstop, not instantly.
- **A freeze IS a real HA suppression.** For its window (bounded by the clamp) a genuine
  death will not fail over. That is the point, but it is a foot-gun: the alert on
  `pswatcher_failover_frozen == 1` is the mitigation, and the clamp is the hard backstop.
  An operator who sets a freeze and the primary genuinely dies during it accepts a read
  outage until the freeze lapses or is cleared.
- **The `containerStatuses.state.Running` shape and the `/v1/status`-degrades-on-object-
  store behaviour are pinned by the on-cluster drill, not unit tests.** Off-cluster tests
  fake the pod status; the sibling drill (`deploy/_verify-failover-freeze.sh`) exercises
  the real behaviour.

## Failure modes

- **Stuck freeze (silent HA outage).** Mitigated three ways: absolute `until`, the
  `MaxFreezeDuration` clamp (effective expiry ≤ `createdAt + 2h`), and the
  `pswatcher_failover_frozen` gauge + expiry metric for alerting.
- **False-negative that misses a real death** (degradation misread as "just degraded"):
  bounded by the pageserver livenessProbe → crashloop → container-not-running → promote.
- **Unreadable / malformed freeze CM:** fail-**safe** — treated as no freeze so HA keeps
  running, and counted (`pswatcher_freeze_read_errors_total` → `PswatcherFreezeUnreadable`)
  so the operator learns their freeze is not in effect. Never a silent suppression, and
  never — as in the first cut — an aborted tick that disables HA outright.
- **True node death read as a degradation:** closed by the `NodeLost`/`NodeStatusUnknown`
  carve-out, backed by the no-`unreachable`-toleration assertion in `deploy/_validate.sh`
  and by `PswatcherDependencyDegraded` paging on a **sustained** hold.
- **Degradation longer than the liveness window:** the container crashloops and the
  watcher promotes onto a standby backed by the same object store. **Not** mitigated by
  the discrimination; mitigated only by setting a freeze before the operation.

## Action items

- [x] `PodReady` returns `running`; `containersRunning` grounded in `containerStatuses`
      (`internal/pswatcher/k8s.go`).
- [x] Degradation-hold branch + `dependency_degraded_total` (`internal/pswatcher/watcher.go`,
      `metrics.go`).
- [x] Freeze read (`FailoverFreeze`) with the Controller-side TTL clamp; suppression on a
      confirmed death; `failover_frozen` / `_freeze_expiry_seconds` /
      `_freeze_suppressed_total` metrics; `pswatcher_failover_reason{reason="node_death"}`.
- [x] Unit tests (degradation-hold, crashloop-promote, freeze-suppress, freeze-expiry,
      TTL clamp, fail-SAFE read, zero-createdAt refusal) — each mutation-proved.
- [x] `internal/pswatcher/k8s_test.go` — the pod-shape branches the discrimination rests
      on, against client-go's fake clientset: Running / Waiting / Terminated / empty
      statuses / terminating pod / `NodeLost` / sidecar scoping, plus the freeze read
      (absent, empty, malformed, valid).
- [x] `deploy/_validate.sh` pins the #1099 alert↔metric family in both directions, holds
      `PSW_MAX_FREEZE_MS` in lockstep with `DefaultMaxFreezeDuration`, and asserts the
      storage plane tolerates no unreachable/not-ready node.
- [x] `deploy/58-pswatcher.yaml` wires `PSW_FREEZE_CONFIGMAP` + `PSW_MAX_FREEZE_MS`;
      alerts in `deploy/60-prometheus.yaml`.
- [x] `docs/operations.md` — trigger contract + maintenance-freeze runbook.
- [ ] On-cluster: `deploy/_verify-failover-freeze.sh` (freeze gauge lifecycle; natural
      TTL expiry without deleting the CM; degrade the object store with the process UP →
      assert NO failover *within the liveness window* → restore → assert normal
      operation resumes; freeze set → suppressed). Lead-run. Note DG1 proves the
      **sub-liveness-window** case only — see the scope bound in §1.
- [ ] Follow-up: a per-op freeze helper in the operator (set/clear with reason) so admins
      do not hand-edit the ConfigMap.

## Cross-note: live-API observation of the corroboration signal (ADR-0010 §5, C1)

The abort/hold posture this ADR builds on assumes the second-vantage read can distinguish a
tenant this pageserver does not hold. **Observed on live GKE (2026-09-20, ADR-0010 §5 C1):**
that distinction is valid only via **`GET /v1/tenant/<T>`**, which `404`s on an unheld tenant.
The promotion **`PUT location_config`** does NOT `404` — it `200`-attaches — so the promoter's
`404`-skip branch is dead code against a real pageserver. This does not change this ADR's
fail-safe freeze read or its node-death discrimination; it only clarifies that the corroboration
this ADR's hold-vs-act logic relies on (ADR-0010 §1b) rides the GET viewer, not the PUT. The
full reconciling principle is ADR-0012 (fail toward the reversible outcome).
