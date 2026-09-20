# ADR 0011 — Failover trigger discriminates dependency-degradation from node-death, plus a TTL-bounded maintenance freeze

Status: Proposed
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
| fail | no | — | — | pod absent → **promote** (subject to the §#58 seen-present anchor / ledger-advanced resume) |
| fail | — | — | — (API unreachable) | cannot corroborate → **hold** (fail-closed, ADR-0010) |

Rationale: a live process failing only its *readiness* probe is a degraded dependency,
not a dead node. This is grounded in what the API server already exposes — no new probe,
no object-store credentials in the watcher.

**False-negative bound (a live hang).** A pageserver whose process is "Running" but
genuinely wedged would `hold` under the rule above. That is safe because the pageserver's
own **`livenessProbe`** (also `/v1/status`, `failureThreshold: 6`) restarts a wedged
container; a restart that does not fix it becomes **CrashLoopBackOff** — container **not
running** — at which point the table promotes. So the discrimination adds a bounded delay
(the liveness window) to a true hang, and never a permanent miss.

**2. A TTL-bounded maintenance freeze.** An admin (or the operator) sets a
`pageserver-failover-freeze` ConfigMap with an `until` = RFC3339 absolute expiry (and an
optional `reason`). While active it suppresses promotion **even on a confirmed death**.
Safety is intrinsic and layered:

- **Absolute expiry** — the freeze auto-lapses at `until`; time passing is what clears it,
  so a *forgotten* freeze still ends.
- **Duration clamp** — the *effective* expiry is `min(until, createdAt + MaxFreezeDuration)`
  (`MaxFreezeDuration` default **2h**, `PSW_MAX_FREEZE_MS`), so a *fat-fingered* far-future
  `until` cannot disable HA beyond the bound. The clamp is applied in the Controller (unit
  tested), not in the k8s read.
- **Observability** — `pswatcher_failover_frozen` (gauge 1 while active),
  `pswatcher_failover_freeze_expiry_seconds` (the effective expiry), and
  `pswatcher_failover_freeze_suppressed_total` (would-be failovers suppressed). Alerting
  fires while a freeze is active *and* if the gauge is still 1 near/after its expiry.
- **Fail-loud read** — an unreadable freeze ConfigMap aborts the tick with an error rather
  than silently deciding "no freeze"; a malformed `until` is a loud error, not fail-open.

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
- The live split-brain class is closed: an object-store cred rotation that leaves the
  process running no longer triggers a failover.
- Planned ops have a safe, bounded, observable pause on failover.
- No new RBAC (freeze CM read is covered by the existing `configmaps get`), no
  object-store credentials in the watcher.

**Negative / residual (stated honestly).**
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
- **Unreadable / malformed freeze CM:** fail-loud (tick errors), never fail-open into a
  silent suppression or a silent ignore.

## Action items

- [x] `PodReady` returns `running`; `containersRunning` grounded in `containerStatuses`
      (`internal/pswatcher/k8s.go`).
- [x] Degradation-hold branch + `dependency_degraded_total` (`internal/pswatcher/watcher.go`,
      `metrics.go`).
- [x] Freeze read (`FailoverFreeze`) with the Controller-side TTL clamp; suppression on a
      confirmed death; `failover_frozen` / `_freeze_expiry_seconds` /
      `_freeze_suppressed_total` metrics; `pswatcher_failover_reason{reason="node_death"}`.
- [x] Unit tests (degradation-hold, crashloop-promote, freeze-suppress, freeze-expiry,
      TTL clamp, fail-loud read) — each mutation-proved.
- [x] `deploy/58-pswatcher.yaml` wires `PSW_FREEZE_CONFIGMAP` + `PSW_MAX_FREEZE_MS`;
      alerts in `deploy/60-prometheus.yaml`.
- [x] `docs/operations.md` — trigger contract + maintenance-freeze runbook.
- [ ] On-cluster: `deploy/_verify-failover-freeze.sh` (degrade object store with the
      process UP → assert NO failover; freeze set → suppressed → expires). Lead-run.
- [ ] Follow-up: a per-op freeze helper in the operator (set/clear with reason) so admins
      do not hand-edit the ConfigMap.
