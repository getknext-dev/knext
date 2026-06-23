# ADR-0014: Rollback via Knative revision traffic split

- Status: Accepted
- Date: 2026-06-23
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), ADR-0011 (build-id-versioned assets +
  retention GC), ADR-0013 (preview lifecycle), issue #92 (rollback), issue #93 (skew protection)

## Context

Every `kn-next deploy` produces a new Knative **Revision**; Knative can already split traffic across
revisions. We needed a first-class **rollback** affordance (and, as a near-free extension, canary)
without violating ADR-0001 — the operator must remain the single writer of cluster state, and the
CLI may only emit intent. The question was: where does the traffic-target intent live, and how does
the operator render it?

## Decision

A traffic target is a declarative field on the `NextApp` CR, and the operator renders it into the
Knative Service's `spec.traffic`:

- **CR field** `spec.traffic` (`TrafficSpec { revisionName, canaryPercent }`):
  - unset / empty `revisionName` → Knative default (100% latest-ready) — byte-identical to pre-#92.
  - `revisionName` set, `canaryPercent` 0 → 100% pinned to that revision (a full rollback).
  - `revisionName` set, `canaryPercent` p∈1..99 → `(100−p)%` pinned + `p%` latest-ready (canary).
- **CLI** `kn-next rollback <app> [--to <revision>] [--canary <n>]` patches **only** the `NextApp`
  CR (`kubectl patch nextapp … --type merge`), never the ksvc/Route directly. The operator's
  `buildTrafficTargets` is the sole writer of `ksvc.spec.traffic`.
- **Status** `NextApp.status.currentTraffic` mirrors the observed live split (concrete revision
  names + percents) so `kubectl get nextapp -o yaml` shows what is actually serving.

This is a thin, declarative wrapper over a native Knative primitive — no new runtime, no
blue/green controller, no out-of-band mutation.

## Options considered

| Option | Verdict | Why |
|---|---|---|
| **CR `spec.traffic` → operator renders `ksvc.spec.traffic` (chosen)** | Accepted | ADR-0001-clean (CLI emits intent only); uses Knative's own traffic primitive; canary falls out for free; status reflects reality |
| CLI patches `ksvc.spec.traffic` directly | Rejected | Second writer of deployment shape — direct ADR-0001 violation |
| A separate blue/green controller | Rejected | New runtime + state for something Knative already does; scope drift |

## Consequences

- Rollback and canary are one CR field and one CLI verb; no new control loop.
- Pinning an old revision interacts with **skew protection** (ADR-0011): a rolled-back/canary
  revision must keep serving its own assets, so the build-id-aware GC treats any revision in
  `status.currentTraffic` as live and never reaps its assets.
- A pinned `revisionName` that Knative has garbage-collected yields an unresolvable target
  (`RoutesReady=False`); the operator does not yet surface this as a `Degraded` condition — a known
  follow-up (the reconciler could detect the unresolvable-revision case and mark `Degraded`).

## Action items

- [x] `TrafficSpec` + `status.currentTraffic` on the CRD; `buildTrafficTargets` in the reconciler.
- [x] `kn-next rollback` CLI (CR-only patch, shell:false argv).
- [ ] Surface an unresolvable pinned revision as `Degraded` in status (follow-up).
