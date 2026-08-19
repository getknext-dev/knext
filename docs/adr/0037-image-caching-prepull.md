# ADR-0037: Image caching via an operator-reconciled pre-pull DaemonSet

- **Status:** Accepted (2026-07-22; implemented in the same PR — operator DaemonSet reconciler +
  `spec.scaling.imagePrewarm` + envtest; the live no-`Pulling`-on-cold-start OKE proof and user-facing
  docs are tracked follow-ups)
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

### Relationship to the existing Knative `Image` pre-pull (why a DaemonSet on top)

The operator already reconciles a Knative `caching.internal.knative.dev/v1alpha1` `Image` for the app
(`nextapp_controller.go` step 3). That resource is a **hint** to the cluster's image-pull machinery —
where the Knative image-caching extension is installed, it can pre-pull to nodes, but it **does not keep
a running container referencing the image, so it does not pin the layer against containerd garbage
collection**, and the extension is not guaranteed present on every cluster. The pre-pull DaemonSet here
is stronger and portable: a *running* container holds the app digest resident on every node until
`imagePrewarm` is disabled. The two coexist — the Knative `Image` stays as the lightweight default hint;
`imagePrewarm` is the opt-in, GC-proof guarantee for cold-start-critical apps.

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

  **Measured (2026-08-18, #767): an unpinned first pull cost 14.9 s end-to-end.** A first request
  landing on a node that had not pulled the new digest paid **14.9 s** — a single sample with no
  raw file committed; the citation is **Addendum 4** of
  `docs/benchmarks/fm-confirmatory-prepulled-ab-2026-08-18.md`. Compared like-for-like: that
  record's pinned cold median is 2.28 s (n=5), and this ADR's own model predicts **~4.2 s** for a
  cold-image cold start — so the sample is ≈ **+12.7 s of pull where the model assumed ~2 s**, the
  tail the action items below already warn about ("holds at the median and understates the tail",
  max-to-max +10.7 s), realized and exceeded. "Acceptable" above still stands, but it is now
  priced, with a condition: the window stays short only **while the re-pointing mechanism runs** —
  `image_prewarm.go` CreateOrUpdate over `app.Spec.Image` on every reconcile, envtest-guarded by
  "updates the DaemonSet's app image when the NextApp digest changes". Per the 2026-08-04
  amendment below, a *failing* prewarm reconcile degrades rather than fails: the pin silently
  stays at the old digest with only `ImageCacheReady`/the alert as signal, and in that state the
  window is unbounded — at this price. Corollary, recorded so spike data is not misread as ADR
  evidence: a **hand-rolled prepull DaemonSet is NOT this ADR's mechanism** — it pins the digests
  it was told at creation and never follows a redeploy, so after one redeploy it prewarms a dead
  digest while every cold start pays the full unpinned price. The 14.9 s sitting ran exactly that
  configuration (attribution per the #767 gate ruling — the record's own text says only that
  "prepull pins track digests: they pin what they are told, not what is deployed"). Do not cite
  hand-rolled DaemonSets as evidence for or against `imagePrewarm`.

## Amendment (2026-08-04, #471 item 4): a prewarm failure DEGRADES, it does not FAIL the pass

As first implemented, `reconcileImagePrewarmDaemonSet`'s error was returned out of `Reconcile`,
mirroring the PVC/NetworkPolicy siblings. That coupling is wrong for **this** child, and the
asymmetry is the point: the ksvc *is* the app and the NetworkPolicy is a security control, whereas
`imagePrewarm` is an **opt-in latency optimisation**. A persistent failure — in practice, an
operator ServiceAccount without DaemonSet RBAC, e.g. an operator upgraded without its new ClusterRole
— aborted the pass **before `computeStatusVerdict` ran**, so `Ready` was never written and the object
sat in controller-runtime's exponential backoff. An optimisation nobody had to enable took the app's
whole status convergence down with it.

**Decision:** the error is carried into `imageCacheState.reconcileErrMsg` and surfaces **only** on
`ImageCacheReady` (`False`, reason `ReconcileFailed`; reason `CleanupFailed` when prewarm is disabled
but the leftover DaemonSet could not be deleted — removing the condition there would hide an orphaned
DaemonSet still pinning the image and a pod slot on every node). `Ready`/`Degraded` are untouched.
Because Reconcile no longer returns the error, controller-runtime's backoff no longer retries it, so
the verdict carries its own bounded `imagePrewarmFailureRequeueAfter` (2 min, deliberately looser than
the ksvc requeue and never allowed to override a tighter one) plus a transition-gated Warning event
(`ImagePrewarmFailed`) so the failure is loud rather than swallowed.

**What the decoupling costs, and what pays for it.** Removing the error from the return path also
removes it from `knext_nextapp_reconcile_errors_total`, and therefore from the **critical**
`KnextOperatorReconcileErrors` page. That is correct — the app is healthy — but it left the failure
visible only in an event (which expires with event TTL) and a condition nothing scrapes. So the
failure gets its **own** unlabeled counter, `knext_nextapp_image_prewarm_errors_total`, incremented at
the point of failure, and its own **warning**-severity `KnextImagePrewarmFailing` rule. Without that
the decoupling would trade a false-critical for a silent failure.

**Two failure-shape rules that fall out of it, both learned the hard way in review:**

- The `Delete` issued when prewarm is disabled is unconditional, so on the very "operator upgraded
  without its new ClusterRole" path this amendment cites, a `Forbidden` reaches the verdict for
  **every** `NextApp` in the cluster — including every app that never opted in. The verdict therefore
  reports a prewarm failure **only when the feature is enabled or the condition was already present**;
  otherwise every never-prewarmed app would grow a `CleanupFailed` condition asserting a DaemonSet
  that never existed, plus a Warning and a forced 2-minute poll, breaking the byte-identical-conditions
  invariant (#98). The failure is not lost — it still increments the counter and fires the alert, which
  is where a cluster-wide RBAC problem belongs.
- `CreateOrUpdate` is Get-then-Update, so a `Conflict` is **routine** and says nothing about the
  DaemonSet's health. It is classified as transient: retried, never reported, never degrading. And the
  DaemonSet coverage GET runs even on the failure path, with the observed coverage folded into the
  condition message — "9/10 nodes cached and the 10th update was rejected" is a different incident
  from "nothing is cached".

**Guarded, not documented:** `reconcile_fatality_guard_test.go` scans `Reconcile`'s AST for every
`r.reconcile*`/`r.ensure*` child call and asserts both halves against a fail-closed allowlist — the
prewarmer's error must NOT reach a `return`, and every other child's error MUST. A new child that
silently swallows its error fails the guard because it is not on the allowlist.

## Amendment (2026-08-04, #471 item 1): the helper's libc variant is load-bearing

The first live-node run of this design did not measure anything — it found the mechanism **broken**,
on the very case the design exists for.

`prewarmHelperImage` was pinned as `busybox:1.36.1@sha256:73aaf09…` (#479, "digest-pin the helper").
That digest is Docker's **default** busybox tag, which is the **glibc** build — dynamically linked.
The design stages that binary into an emptyDir and execs it *inside the app image*, so on any app
image without glibc it cannot start. Measured on OKE with an Alpine-based (musl) knext app image:

- the pin container exited **255 immediately** with `exec /knext-pin/busybox: no such file or
  directory`, the `<app>-imgcache` DaemonSet sat in **CrashLoopBackOff** (2 desired, 0 ready), and
  `ImageCacheReady` stayed `False/Pulling` indefinitely;
- staging the same way from `busybox:1.36.1-uclibc` (which is `FROM scratch`, statically linked) ran
  `busybox sleep` in that **same** app image and exited 0; with it pinned, the DaemonSet reached
  **2/2 Ready, restartCount 0**, and `ImageCacheReady` went `True/Cached`.

**Decision:** the helper pin must name a **statically linked** official variant (`-uclibc`/`-musl`),
not the default tag; it is now `busybox:1.36.1-uclibc@sha256:0872fb3a…`.
`TestPrewarmHelperImage_IsStaticallyLinkedVariant` enforces it, with the predicate table-tested so the
assertion cannot go vacuous. Linkage itself is not assertable without a container runtime, so the guard
asserts the one property that predicts it — which variant is pinned.

Three things worth keeping from how this was missed:

- **The degrade-not-fail amendment above worked exactly as designed, and that is why nobody noticed.**
  `Ready` stayed `True`, `Degraded` stayed `False`, the app served traffic normally; the only signal
  was `ImageCacheReady=False/Pulling`. An opt-in optimisation failing quietly is the intended
  behaviour — which makes the condition, the `knext_nextapp_image_prewarm_errors_total` counter and
  the `KnextImagePrewarmFailing` alert the *only* things standing between "not cached" and "believed
  cached". Note the failure shape here does not increment that counter: the reconcile **succeeded**
  (the DaemonSet was created as specified); it was the *pods* that never ran. Coverage is what
  distinguishes them, and only the condition carries it.
- **The pull still happened.** A CrashLoopBackOff pod has already pulled the image and still
  references it, so even broken the prewarmer pulled and pinned. That is precisely why a
  "no `Pulling` event" assertion alone would have passed over a feature whose DaemonSet was
  crash-looping on every node — the criterion has to be read together with `ImageCacheReady` and the
  pods' restart counts.
- **The existing e2e would have caught it; it had never been executed.** `test/e2e/image_prewarm_e2e_test.go`
  asserts every prewarm pod Ready with `restartCount == 0`, against an Alpine app image — the exact
  failing configuration. It only runs on a manual `workflow_dispatch` supplying `SCALE_TEST_IMAGE`
  (unset on this repo), so it has never run. A spec that cannot run is not a guard.

## Action items

- [x] `spec.scaling.imagePrewarm` field + CRD regen (`make manifests`/`make generate`); CLI config
      passthrough + validator (no CEL invariant needed — it's a plain bool).
- [x] Operator reconciler: create/update/delete the `<app>-imgcache` DaemonSet from the field + digest;
      honest status condition via `computeStatusVerdict` (e.g. `ImageCacheReady`).
- [x] Digest-pin the operator-owned busybox helper image (#479).
- [x] Decouple the prewarm reconcile from app-reconcile success (#471 item 4 — see the amendment above).
- [x] e2e, live-cluster half: `test/e2e/image_prewarm_e2e_test.go` (`e2e_scale`) — DaemonSet
      lifecycle enable→disable, the staged-helper hand-off working under a **real kubelet** (every
      prewarm pod Ready on every node with restartCount 0, which envtest cannot see for lack of a
      kubelet or container runtime), the pin container running the APP image under the staged static
      helper, and the app server never booting.
      **Caveat on where it runs:** the nightly needs `vars.SCALE_TEST_IMAGE`, which is **unset on this
      repo** (`gh api …/actions/variables` → `total_count: 0`). Since #659 an unset value **fails** the
      lane rather than skipping it (see the checked item below), so the spec still executes only on a
      `workflow_dispatch` supplying an image — but the gap is now loud on every nightly instead of
      silent. Setting that variable is what turns it into a live gate, and
      [#670](https://github.com/getknext-dev/knext/issues/670) owns doing so.
- [x] **The e2e's SKIP is now a FAIL ([#659](https://github.com/getknext-dev/knext/issues/659),
      landed 2026-08-05).** The nightly used to resolve
      `inputs.scale_test_image || vars.SCALE_TEST_IMAGE`, log a `::warning::` on an empty result and
      set `skip=true`; the job then reported SUCCESS in ~90 seconds having executed nothing (observed
      on run 30979879905). That is the shape `.claude/rules/workflow.md` names as a trigger — a
      capability landed behind a check that **skips rather than fails** — and the third instance
      closed in this repo (#408, #448).
      **What landed:** a dedicated `scale-image-preflight` job in
      `.github/workflows/operator-e2e-nightly.yml` that **exits non-zero** when no image resolves,
      when the value is not a digest-pinned `@sha256:<64 hex>` reference (a positive scan, so a
      mis-set `:latest`/tag-only/truncated/whitespace-bearing value fails *here* rather than
      `ErrImagePull`ing inside the `continue-on-error` job — and it enforces the repo's
      digest-pinning rule at the point of first acceptance, mirroring the operator's own admission),
      and when the value is the deliberately-unpullable all-zeros placeholder, with
      `scale-to-zero-cache` consuming its output via `needs:`. It is a separate job **because the
      scale job carries `continue-on-error: true`** for genuine Knative scale-timing flake — leaving
      the precondition inside it would have let that swallow the failure and report success exactly
      as the skip did. Failing is safe because the workflow has **no `pull_request`/`push` trigger**
      (repo variables: `total_count: 0`, and the nightly's own annotation proves nothing resolves it
      at org level either), so it cannot red PR CI.
      **Both halves are guarded** by `tests/operator-e2e-scale-image-preflight.test.ts`, which
      executes the workflow's own resolve script (hence the script is expression-free, values via
      `env:`) *and* asserts nothing opts the job out — no `continue-on-error` (literal or `${{ }}`),
      no `if:` (parsed YAML, so a quoted `"if":` cannot evade it, #661), no upstream `needs:`, the
      scale job's `needs:` edge, and the absence of any `::warning::` in either job of this lane.
      Mutation-proved: thirteen mutations, including restoring the original skip, each turn it red —
      plus the shape check both ways (`:latest`, a bare tag, whitespace-only, a wrong-length digest
      and a multi-line step-output injection each go red; a real `@sha256:<64 hex>` stays green).
      **Checked, with the residual stated:** what this closes is the *silence*, not the coverage —
      `vars.SCALE_TEST_IMAGE` is still unset, so the spec still does not execute on the schedule; the
      nightly is now RED about it every night instead of green. **That red has an owner and a close
      condition: [#670](https://github.com/getknext-dev/knext/issues/670)** — a publish job that sets
      the variable from an image it just pushed, plus the pinned-issue alert job this workflow
      (unlike `image-pin-resolution-nightly.yml`) lacks. Note the limit of the preflight: it checks
      **shape, not pullability**, so a well-formed digest for an image that was never pushed still
      dies inside the `continue-on-error` job. Only #670 closes that.
- [ ] **STILL OPEN — the distroless / shell-less app-image case.** The e2e above runs against
      `SCALE_TEST_IMAGE` = the file-manager image, whose runner stage is `node:22-alpine`
      (`apps/file-manager/Dockerfile:105`). **Alpine ships busybox and `/bin/sh`**, so a naive
      `sleep infinity` would work there too — that spec cannot distinguish the shell-free mechanism
      from a shell-dependent one, and must not be cited as the distroless proof. Closing it needs a
      genuinely distroless, digest-pinned app image (e.g. a knext runtime image on
      `gcr.io/distroless/nodejs`) plumbed in as the e2e app image.
      **Partial evidence added 2026-08-04 (OKE, live node):** the staged static helper does run in a
      **libc-free, shell-free** image — `gcr.io/distroless/static-debian12:nonroot`, as a stand-in app
      image, executed `/knext-pin/busybox sleep 15` to completion, exit 0, restarts 0 — and the glibc
      helper's failure on an Alpine app image shows the staged binary really is the only thing exec'd
      (a shell-dependent `sleep infinity` would have worked there). That is the *mechanism* proven on a
      real kubelet; the open item remains the *e2e* running against a distroless knext app image.
- [x] **The no-`Pulling`-on-cold-start proof + the warm-vs-cold delta — measured on OKE 2026-08-04**
      ([`docs/benchmarks/image-prewarm-oke.md`](../benchmarks/image-prewarm-oke.md), harness in
      `benchmarks/image-prewarm-oke/`). Still not assertable on kind, which side-loads images into every
      node's containerd; this ran on a 2-node OKE cluster pulling a content-unique 370 MB image from a
      same-region registry, ABBA-interleaved, one digest on both arms, 10 replicates per arm.
      **`Pulling` events: 0/10 with prewarm, 10/10 without.** Cold-start TTFB medians **2490 ms vs
      4782 ms** (delta 2293 ms; 2193 ms when restricted to the one node that took 19 of 20 pods), with
      **non-overlapping distributions** and positive deltas in all five pairs. The ~2 s estimate holds at
      the median and understates the tail, compared like for like: p75 to p75 is +3.9 s and max to max
      +10.7 s. The write-up records one caveat on the tail specifically — the harness's own privileged
      eviction Jobs ran only on the no-prewarm arm and ate into that arm's quiet time before the
      request, which this run cannot separate from the pull (the harness has since been fixed; the
      mechanism result, 0/10 vs 10/10, is unaffected).
      **Read this criterion together with `ImageCacheReady` and the prewarm pods' restart counts** — see
      the 2026-08-04 amendment: a crash-looping prewarmer still pulls the image, so "no `Pulling` event"
      alone does not establish that the feature works.
- [x] Docs: user-facing "cold start & image caching" guidance
      (`apps/docs/content/docs/image-caching.mdx`), carrying the N×image-size disk cost and the M×N
      pod-slot cost as the honest trade.
