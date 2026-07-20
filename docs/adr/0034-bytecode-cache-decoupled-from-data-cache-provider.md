# ADR-0034: Bytecode caching is decoupled from the data-cache provider and default-OFF

- Status: Accepted
- Date: 2026-07-20
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), ADR-0010 (operator-managed Knative PVC
  feature flags), issues #431 (this change), #432, #436 (PVC support disabled on a stock Knative
  install), `docs/benchmarks/scale-to-zero-oke.md` run 5

## Context

Cold start on the OKE reference cluster breaks down, measured across five runs, roughly as:

- **Scheduling: ~0s.** The node pool has headroom; pods are placed immediately.
- **Image pull: ~0s.** The image is already cached on the node.
- **`Started → Ready`: ~2s** of a ~3.8–4.0s median. This is uncached Node boot — V8 parsing and
  compiling the standalone server's JavaScript on every cold start.

That ~2s is the segment `NODE_COMPILE_CACHE` targets, which is why bytecode caching exists in knext
at all. But the way it was wired made it unreachable for most apps and a placebo for the rest:

- **The CLI gated it on the data-cache provider.** Bytecode caching was enabled only when
  `provider === "redis"`. These are unrelated concerns — the ISR/data cache backend has nothing to
  do with whether the Node runtime persists its V8 compile cache — so an app using any other
  provider, or none, could not turn on a runtime optimisation it was otherwise eligible for.
- **The operator nested the env var under a provider check.** `NODE_COMPILE_CACHE` was only emitted
  when `Provider != ""`. An app that set the bytecode flag without a data-cache provider therefore
  got the **PVC created and mounted, but no env var** — Node never looked at the mount. That is a
  **placebo**: a 512Mi ReadWriteOnce PVC provisioned and paid for, delivering exactly zero benefit,
  with nothing in the status to say so.

The two conditions also disagreed with each other, so the observable behaviour depended on which
path (CLI-emitted CR vs. hand-written CR) produced the spec.

## Decision

**Bytecode caching is an independent capability, controlled by its own CRD field, and is default-OFF.**

1. The operator emits `NODE_COMPILE_CACHE` — and provisions/mounts the cache volume — based solely
   on the bytecode-cache field. No data-cache-provider condition anywhere in that path. The
   placebo state (mount without env var) is no longer reachable.
2. The CRD default is **off**.
3. The **CLI retains a legacy inference**: `provider === "redis"` ⇒ bytecode caching on, for
   back-compat with existing Redis-provider configs. This is a CLI-side compatibility shim only;
   the operator has no such rule.

**Why default-OFF.** The cache volume is a **`ReadWriteOnce` PVC**, while the default `maxScale` is
**10**. A default-on capability would therefore mean: the first pod binds the PVC on its node, and
every burst pod the autoscaler places on a *second* node is stuck **`Pending`** — an unmountable
volume, on the exact scale-out path knext exists to serve. A latency optimisation must not be able
to break autoscaling for an operator who never asked for it. Opt-in is the only safe default while
the storage shape is RWO.

## Options considered

| Option | Pro | Con | Verdict |
|---|---|---|---|
| **Default-ON** (decouple, enable by default) | Every app gets the ~2s boot saving with no config | RWO PVC vs. `maxScale=10` strands burst pods `Pending` on a second node; silently degrades autoscaling for users who never opted in | **Rejected** |
| **Default-OFF, own CRD field** (chosen) | Removes the placebo; the capability is reachable for any provider; no autoscaling risk by default; opt-in makes the RWO constraint an explicit choice | Users must set a flag to get the saving; the saving stays unmeasured until someone opts in | **Chosen** |
| **Drop the legacy `redis ⇒ on` inference** | Cleanest semantics — one control, no hidden coupling | Silently **turns the feature off** for existing Redis-provider users who are relying on it today; a behaviour change landed as a cleanup | **Rejected** — keep the shim, retire it on a deliberate deprecation |

## Consequences

**The decoupling is correct and worth landing.** It removes a placebo that charged a PVC for
nothing, it makes the capability reachable independent of an unrelated setting, and being
default-off it cannot regress anyone's autoscaling.

**But be blunt about what it does not deliver.** Benchmark run 5 (#436) established that the PVC
approach **cannot work on a default Knative install at all**:
`kubernetes.podspec-persistent-volume-claim` and `kubernetes.podspec-persistent-volume-write` are
both `disabled` in stock `config-features`, so the admission webhook rejects any ksvc that mounts
the cache PVC. The capability this ADR unblocks is therefore **currently unusable without a
cluster-admin flag change** — and worse, it fails as an opaque webhook rejection rather than a
readable status condition. (ADR-0010 asserted the OKE cluster already had these flags on; run 5
contradicts that on the same cluster, which is itself part of what #436 must settle.)

**The delivery mechanism is unresolved, and this ADR deliberately does not pick it.** The open
question is PVC vs. a per-pod `emptyDir` plus an image-baked cache — `kubernetes.podspec-volumes-emptydir`
*is* enabled by default, which is why `emptyDir` is a live candidate; it trades cross-pod cache
sharing for working on a stock install and for having no RWO/`maxScale` conflict at all. **#436 and
#432 must be resolved by a follow-up ADR.** Nothing here should be read as endorsing the PVC shape.

**There is still no measurement.** Run 5's AFTER arm never executed, so the ~2s `Started → Ready`
segment remains a *hypothesis* about what bytecode caching would recover, not a measured saving. Do
not cite a speedup for this feature anywhere until an AFTER arm actually runs.

## Action items

1. **Verify the operator-managed path on default Knative feature flags** — confirm what a stock
   install actually does with a bytecode-cache-enabled `NextApp`, end to end (#436).
2. **Decide PVC vs. `emptyDir` + image-baked cache** and record it in a follow-up ADR (#436 / #432).
   Until then, treat the PVC shape as provisional.
3. **Surface a clear status condition** when the cache cannot be mounted, instead of an opaque
   admission-webhook error. The user-visible failure today gives no hint that a cluster feature flag
   is the cause.
4. **Document the cluster prerequisite** for whichever mechanism wins — including, if PVC survives,
   that the flags must be enabled before the capability can be turned on.
5. **Measure it.** Re-run the #431 before/after once the mechanism actually admits, and record the
   AFTER arm in `docs/benchmarks/scale-to-zero-oke.md`.
6. **Plan the retirement** of the CLI's legacy `redis ⇒ on` inference as an announced deprecation,
   not a silent cleanup.
