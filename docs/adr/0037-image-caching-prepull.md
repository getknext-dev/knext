# ADR-0037: Image caching via an operator-reconciled pre-pull DaemonSet

- **Status:** Proposed (2026-07-22)
- **Depends on:** ADR-0001 (operator = single source of cluster state), ADR-0026/0030 (scaling), ADR-0036 (build targets)

## Context

Scale-to-zero means every idle app pays a cold start, and **image pull is a large, target-independent
component of it** — measured, not assumed:

- **Benchmark run 18 (OKE):** a ~105 MB bun+vinext image pulls in **~2.09 s** from OCIR to a node.
- Warm-image cold start (image already on the node) ≈ **2.1 s**; cold-image cold start (fresh node /
  new digest / evicted layer) ≈ **4.2 s**. **Image caching roughly halves the uncached cold start.**

This is not an edge case for a scale-to-zero app: containerd garbage-collects idle images under disk
pressure, a replaced/added node starts with an empty image cache, and the first cold start of a new
revision on each node pays the full pull. Runs 16–17 established that once the image is warm, the
remaining cold start is scheduling + activator + process boot (where the build target — bun vs node —
is only a modest lever). So the two-target cold-start win the project is chasing is **gated on the app
image being present on the node before scale-from-zero**, which today is left to chance (whatever
containerd happens to still have cached).

## Decision

Add an **opt-in, operator-reconciled image pre-pull** capability. When enabled on a `NextApp`, the
operator reconciles a **DaemonSet** that runs one minimal pod per node referencing the app's
(digest-pinned) container image, so the image is pulled to — and **retained on** (a running pod pins it
against containerd GC) — every node. Scale-from-zero then never waits on the pull.

- **CR field:** `spec.scaling.imagePrewarm: bool` (default `false`). Cold-start optimization lives
  under `scaling`, alongside `minScale`/`warmSchedule`.
- **Operator behavior:** on `imagePrewarm: true`, reconcile a DaemonSet `<app>-imgcache` that pulls
  and pins the app's `spec.image` (same digest the ksvc runs) on every node. `imagePullSecrets` from
  the app, tiny resource requests (e.g. cpu `1m`, mem `16Mi`), non-root, `readOnlyRootFilesystem`,
  default seccomp, `AutomountServiceAccountToken: false`, `tolerations: [operator: Exists]` so it caches
  on tainted nodes too. On `false`/unset, the operator deletes the DaemonSet. The image digest is
  threaded from the same resolution the ksvc uses, so a new revision re-pulls on the prewarmer first.
  - **Container mechanism — MUST NOT assume a shell in the app image.** knext runtime images are
    distroless/Alpine and may have no `/bin/sh` (a `sleep infinity` command would CrashLoopBackOff on
    a distroless node-target image). The prewarmer therefore keeps the app image both **pulled** and
    **pinned against containerd GC** without executing the app or relying on the image's own binaries:
    an `initContainer` copies a static `true`/`sleep` into an `emptyDir`; a **second container runs the
    APP IMAGE with `command` pointing at that copied binary** (forcing kubelet to pull the app image
    and keeping a running container referencing it, so image GC never evicts it), while never starting
    the actual app server. A bare `pause` main container is insufficient by itself — it pins only the
    pause image, not the app image; a *running* container must reference the app digest. The
    implementer resolves the exact static-binary source; the invariant is: works on a shell-less
    distroless app image, app server never boots, app image stays resident.
- **Reconciliation home:** in the operator (ADR-0001), gated by `computeStatusVerdict` for any status
  condition (never a new `Reconcile` branch). The CLI only emits the CR field; it never creates the
  DaemonSet.

## Options considered

| Option | Cold-start effect | Cost | Keeps scale-to-zero | Verdict |
|---|---|---|---|---|
| **Pre-pull DaemonSet (chosen)** | removes the ~2 s pull on every cold start | one tiny pod + one image copy **per node** (incl. nodes the app never runs on) | ✅ yes | **chosen — opt-in** |
| `minScale: 1` (keep one warm pod) | removes the WHOLE cold start for 1 replica | a full always-on app replica (CPU+mem) — defeats scale-to-zero economics | ❌ no | rejected as the caching answer (different trade-off; already available for latency-critical apps) |
| Do nothing (rely on containerd cache) | unpredictable — evicted/fresh nodes pay ~2 s | none | ✅ | status quo; the hazard run 18 measured |
| Cluster-wide lazy pulling (stargz/eStargz, containerd) | pull amortized/deferred | cluster/runtime config, out of app scope; not portable across clouds | ✅ | out of scope for the app-level CR (note as a future cluster-level option) |
| Registry/CDN edge caching | speeds the registry hop, not node-local presence | infra | ✅ | doesn't solve node-local pull; complementary at best |

## Consequences

- **Node cost is real and must be honest:** `imagePrewarm` places a copy of the image and a (tiny)
  running pod on **every** schedulable node, including nodes the app may never serve from. For a
  ~105 MB image on an N-node cluster that is N×105 MB of disk + N tiny pods. With **M** prewarm-enabled
  apps it is **M×N** prewarmer pods — which counts against each node's max-pods limit (OKE defaults are
  low), so heavy use can crowd out app scheduling. This is the deliberate trade for a predictable cold
  start; it is **opt-in per app**, never default, and the docs must state the M×N pod-slot cost.
- **Complementary, not a substitute.** It removes the pull component only. The build-target boot edge
  (ADR-0036) and node CPU/scheduling headroom are separate levers; run 17 showed those dominate once
  the image is warm. `imagePrewarm` + bun-exec + adequate headroom is the path toward the founder's
  measured ~600 ms regime; any one alone is partial.
- **Security:** the DaemonSet uses the app's `imagePullSecrets`, runs non-root with no service-account
  token, minimal capabilities; it introduces no mutating endpoint and reads nothing. Digest-pinned
  (never `:latest`), per security.md.
- **Verification:** an e2e that (a) asserts the DaemonSet exists + becomes Ready on `imagePrewarm:true`
  and is removed on `false`, and (b) — the real proof — measures that a scale-from-zero after an
  image would otherwise be uncached does NOT emit a `Pulling` event (the image is already present),
  reproducing run 18's warm-vs-cold delta.
- **Interaction with revisions/rollout:** when the ksvc image digest changes, the prewarmer DaemonSet's
  digest updates too; there is a brief window where the new digest is pulling on the prewarmer while an
  old-revision cold start could still pay a pull — acceptable, and no worse than status quo.

## Action items

- [ ] `spec.scaling.imagePrewarm` field + CRD regen (`make manifests`/`make generate`); CLI config
      passthrough + validator (no CEL invariant needed — it's a plain bool).
- [ ] Operator reconciler: create/update/delete the `<app>-imgcache` DaemonSet from the field + digest;
      honest status condition via `computeStatusVerdict` (e.g. `ImageCacheReady`).
- [ ] e2e: DaemonSet lifecycle + the no-`Pulling`-on-cold-start proof (extends the scale-to-zero
      suite). **Must include a distroless/shell-less app-image case** so the container mechanism is
      verified not to CrashLoopBackOff (the failure both sign-off gates flagged), and assert the app
      server never actually boots in the prewarmer.
- [ ] Docs: user-facing "cold start & image caching" guidance (the N×image-size node cost is the
      honest trade); benchmark the warm-vs-cold delta on a clean cluster (blocked today by cluster
      clutter — see runs 17–18).
