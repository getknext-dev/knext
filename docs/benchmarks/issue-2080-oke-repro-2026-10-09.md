# Zone re-wake stall (#2080) on OKE — does it reproduce? (2026-10-09)

**Question.** The Z2 kind spike reported that a Node-runtime zone re-woken while its previous pod
is still `Terminating` holds the request for about 13–28 s, even though the new pod is Ready in
~2.8 s. Bun was unaffected, and a rarer ~10 s stall hit both runtimes. Does this reproduce on the
real cluster (OKE), and is it a 1.x production issue?

**Answer.**

1. **The headline does not reproduce.** In 137 measured wakes (98 of them re-wakes during the old
   pod's `Terminating` window, 84 of those while the old pod still showed `Ready=True`), no
   re-wake during `Terminating` took longer than 11.6 s, and Node did not differ from Bun. On images that carry the ARP primer the
   slowest re-wake during `Terminating` was 5.5 s, the median was 1.4–1.7 s, and none was above
   6 s.
2. **The activator never selects the terminating pod.** In all 98 re-wakes the activator's backend
   set was already empty, 0–1.1 s after the old pod went `Terminating` (median 0.4 s) and before
   the request was sent, although the old pod stayed `Ready=True` for ~28 s. The hold seen on kind
   is therefore not "the activator waits on a still-Ready terminating endpoint" here.
3. **The ~10 s mode does reproduce on OKE, but it is the flannel stale-ARP blackhole, not the
   terminating pod and not Node-specific.** On the two images without the ARP primer, 48 of 54 wakes
   took 9.2–18.6 s (median ≈ 9.9 s), at the same rate whether the old pod was still terminating or fully
   gone, and Node = Bun. The activator logged 19–28 failed probes of the new pod
   (`context deadline exceeded`). Setting `KNEXT_ARP_PRIMER=0` on a primer-bearing image brings the
   stalls back (25 of 27 wakes at 9.2–13 s), so the primer is causal here. The primer ships in v1.0.0-rc.5 and later.
4. **Verdict: does not reproduce (headline); partial for the rare ~10 s mode.** That mode exists on
   OKE for images older than rc.5 and is already fixed in stable releases. A ~5 s tail remains in
   2 of 56 primed wakes (unattributed, pre-existing, not tied to termination).

jev scores are in §Interpretation. They are a gut check, not the decider: the verdict question
itself came back at low confidence (0.20), so the call rests on the counts above.

## Setup

- **Cluster.** OKE `knext-oke` via context `knext-oke-sa`, k8s v1.34.10, flannel, nodes
  `10.0.1.118` / `10.0.1.169`. Knative Serving 1.16.0 + Kourier. Cluster-wide autoscaler config
  untouched (defaults), so every scale-down is Knative's own: a cycle is ~1.5 min.
- **Apps.** Six `NextApp` CRs in namespace `z2080-repro`, applied with `--validate=strict`. No raw
  ksvc was created, edited or patched. Each is a default scaffold app on `/api/health`, `maxScale:
  1` (as in the kind run), `minScale: 0`, operator defaults otherwise (`containerConcurrency` 20,
  `terminationGracePeriodSeconds` 300 from the revision timeout, user-container `preStop` =
  queue-proxy `/wait-for-drain`).

  | app | image (node-local, digest-pinned) | runtime | primer |
  |---|---|---|---|
  | `z2080-node`, `z2080-bun` | `rc5-rc4-node@sha256:7fa693ed…`, `rc5-rc4-bun@sha256:ea973029…` | node, bun | absent (`arp-primer.cjs` not in `dist/adapters`) |
  | `z2080-nodei`, `z2080-buni` | `rc5-integration-node@sha256:1a4dae07…`, `rc5-integration-bun@sha256:6d438be5…` | node, bun | present |
  | `z2080-nodei0`, `z2080-buni0` | same as `*i` | node, bun | present but `env: {KNEXT_ARP_PRIMER: "0"}` |

  Image provenance caveat: these are the two image sets already cached on both nodes from earlier
  release-cell runs. Both report `@getknext/core` `1.0.0-rc.4` in `package.json`; the `integration`
  set contains the primer, the `rc4` set does not. They are **not** the exact v1.0.0 / v1.3.0 bits.
  The supervisor's shutdown path (`node-server.ts`, `shutdown.ts`) has no changes between
  `v1.0.0-rc.5` and `origin/main` at the time of the run.
- **Client.** A `node:22-alpine` pod in the same namespace issues every timed request with a fresh
  TCP connection to `http://<app>.z2080-repro.svc.cluster.local/api/health` (through the Knative
  internal gateway and activator, as the kind run did). The timing is taken inside that pod.
- **Driver.** `scripts/driver.py`. Per trial: wait for Knative to scale the app to zero live pods
  (a `Terminating` pod remains), read the termination start from the pod
  (`deletionTimestamp − deletionGracePeriodSeconds`), sleep until the target offset, fire one
  request, record pods before/after. Two arms: `recent` (fire at 1–29 s offsets, actual 4–35 s,
  spread and interleaved) and `settled` (fire after the old pod has vanished, +1 s).
  Request *initiation* was serialised across the concurrently running arms with a lock so no two
  cold starts overlapped. The arms themselves did overlap in time (their waits are idle).
- **Evidence collected.** Pod and EndpointSlice watches with ms timestamps
  (`watch*.log`), the activator log (`activator-z2080.log`, throttler lines kept, the 3 811
  probe-failure lines dropped from the committed copy; their per-trial counts are in
  `rows.json`), per-pod queue-proxy and user-container logs (not committed: the follower attached
  after start), and in half of the first-pass `recent` trials a direct probe of the terminating
  pod's user-container port at +5 s.
- **Excluded.** 3 trials where `kubectl exec` itself failed (apiserver TLS error), 2 pilot trials
  (reported below, not pooled).

## Results

End-to-end first-request latency, ms (curl-style, client clock):

| arm | window | n | median | IQR | min–max | >5 s | ≥9 s | probe-failure signature |
|---|---|--:|--:|---|---|--:|--:|--:|
| Node, no primer | re-wake during Terminating | 20 | 9902 | 9308–10308 | 1655–11631 | 16 | 16 | 16 |
| Node, no primer | after old pod gone | 7 | 9889 | 9734–10324 | 9596–10669 | 7 | 7 | 7 |
| Bun, no primer | re-wake during Terminating | 19 | 9726 | 9506–9939 | 1465–10400 | 18 | 18 | 18 |
| Bun, no primer | after old pod gone | 8 | 10150 | 9699–12224 | 3457–18560 | 7 | 7 | 5 |
| **Node, primer** | re-wake during Terminating | 20 | **1726** | 1481–2018 | 1401–5519 | 1 | 0 | 0 |
| **Node, primer** | after old pod gone | 8 | 2110 | 1904–2340 | 1665–2664 | 0 | 0 | 0 |
| **Bun, primer** | re-wake during Terminating | 20 | **1418** | 1198–1872 | 976–5017 | 1 | 0 | 0 |
| **Bun, primer** | after old pod gone | 8 | 1830 | 1370–2755 | 1090–4375 | 0 | 0 | 0 |
| Node, primer image, `KNEXT_ARP_PRIMER=0` | re-wake during Terminating | 10 | 10428 | 9644–10651 | 1780–10883 | 9 | 9 | 9 |
| Node, primer image, `KNEXT_ARP_PRIMER=0` | after old pod gone | 4 | 11717 | 10677–12572 | 9700–12995 | 4 | 4 | 4 |
| Bun, primer image, `KNEXT_ARP_PRIMER=0` | re-wake during Terminating | 9 | 9597 | 9285–9920 | 1685–10693 | 8 | 8 | 8 |
| Bun, primer image, `KNEXT_ARP_PRIMER=0` | after old pod gone | 4 | 10569 | 10185–11011 | 10012–11360 | 4 | 4 | 4 |

"Probe-failure signature" = the activator logged ≥5 `Failed probing pods … context deadline
exceeded` lines for the new pod during the request. Pilot (unprimed, one wake each at +10 s):
Node 10 330 ms, Bun 1 729 ms.

Tests (Mann-Whitney, two-sided, normal approximation, `recent`):

| comparison | p |
|---|---|
| Node vs Bun, no primer | 0.4 (medians 9902 vs 9726) |
| Node vs Bun, primer | 0.027 (1726 vs 1418; both well inside 2.2 s) |
| no primer vs primer, Node | 2.2e-6 |
| no primer vs primer, Bun | 3.7e-7 |
| primer vs `KNEXT_ARP_PRIMER=0` (same image), Node | 6.2e-5 |
| primer vs `KNEXT_ARP_PRIMER=0` (same image), Bun | 7.5e-5 |
| no primer, recent vs settled, Node / Bun | 0.51 / 0.09 |

Stall rate by node the new pod landed on (unprimed arms): `10.0.1.118` 21 of 26, `10.0.1.169` 27
of 28. Both nodes are affected on this cluster.

### Where the time goes (timeline, unprimed Node pilot, t = request sent)

```
-10.0  old pod enters Terminating (deletionTimestamp set)
 -9.8  EndpointSlice: old addr ready=false serving=true terminating=true
 -9.8  activator: "Updating Revision Throttler … trackers = 0, backends = 0"   <- old pod dropped at once
 +0.0  request sent
 +0.5  new pod Pending;  +2.0 EndpointSlice has the new address
 +2.2  new pod Running (containers up)
 +2.25 … +10.07  activator: "Failed probing pods … http://10.244.0.234:8012/healthz: context deadline exceeded"  (every 0.3 s)
+10.32 activator: "trackers = 1, backends = 1"  -> request released
+10.33 response (10 330 ms)
+13.25 kubelet marks the new pod Ready=True
+20.4  old pod Ready=False;  +21.8 old pod gone (Terminating window ≈ 31 s)
```

The queue-proxy of a running pod does not answer on its pod IP for ~8 s (a timeout, not a refusal),
then does. That is the signature `arp-primer.cjs` documents: a stale neighbour entry for a recycled
pod IP black-holes traffic from outside the pod until the pod sends a packet of its own.

### Terminating window (all arms, from the pod watch)

| runtime | old pod `Ready=False` at | old pod exits at |
|---|---|---|
| Node (3 arms, 42 pods) | +20…33 s (median 28–30) | +31…34 s (median 31) |
| Bun (3 arms, 39 pods) | +21…31 s (median 28–30) | +31…33 s (median 31) |

The old pod stays `Ready=True` for ~28 s on both runtimes, and it exits at the same time on both.
The kind observation that the Bun pod "exits quickly" does not hold here. The window is set by the
Knative drain (`preStop` = queue-proxy `/wait-for-drain`, three missed kubelet probes), identical
for both runtimes. A direct probe of a terminating pod's user-container port, sent 5 s into the request,
returned 200 in 14–21 ms in 28 of 35 probes. The other 7 timed out, all in trials fired at offsets
≥ 26 s (probe at ≥ 31 s, after the app had begun to exit); 4 more probes failed to run (exec
error).

### Where the request is held (task step 4)

- **Not the activator picking the old pod.** `backends = 0` was in force at the moment of the
  request in every one of the 98 re-wakes (median update 0.4 s, max 1.1 s after `Terminating`).
- **Not queue-proxy draining on the old pod.** The request was never sent there.
- **Not the old pod's endpoint.** The EndpointSlice flipped to `ready=false` at once
  (`serving=true, terminating=true`), and the activator followed.
- **Where it is held when it is held:** at the activator, waiting for the *new* pod to answer its
  health probe, which the new pod does not do for ~8–10 s while the node's neighbour entry is
  stale. The Node supervisor's drain settings are not on this path: `SHUTDOWN_GRACE_MS` 25 s is
  below the 300 s `terminationGracePeriodSeconds`, and Node and Bun exited together.

## Interpretation (jev)

State given: the counts above (`data/…/jev-state.txt`). All calls ran through `jev ask`.

| question | P(yes) |
|---|--:|
| Does the OKE data show the Node-only 13–28 s hold during `Terminating`? | 0.06 |
| Is the Node-only hold claim contradicted by the data? | 0.94 |
| Does the headline Node-only hold fail to reproduce on OKE? | 0.87 |
| Is the 9–11 s stall on primer-less images the flannel stale-ARP blackhole, not the terminating pod? | 0.88 |
| Do users of releases before v1.0.0-rc.5 face the 9–11 s stall on OKE-like clusters? | 0.94 |
| Do users of v1.0.0 / v1.3.0 face it in this data? | 0.20 |
| Is a code change to the Node shutdown drain warranted by this data? | 0.30 |
| Is the residual ~5 s tail (2 of 56 primed wakes) evidence of a separate defect? | 0.23 |

Verdict choice for the issue as filed: *does not reproduce* 0.43, *partially reproduces* 0.47
(top, conf 0.20), *reproduces* 0.10. Priority choice: P1 0.36 (conf 0.15), P2 0.28, close 0.22, P0
0.14. Both are near-ties at very low confidence, so neither was used as the decider; they only
confirm that "reproduces" is the least likely reading. The verdict above rests on the counts.

## What this does not show

- **It does not explain the kind result.** The kind stall (29.3–29.9 s, 4 of 4 Node trials, released
  the moment the old pod's `Ready` dropped) is a measurement on a different stack (kindnet, a
  single node, `stable-window` 10 s and `scale-to-zero-grace-period` 10 s, a different zone app,
  Rosetta amd64). Nothing here says the kind observation was wrong; it says it does not transfer to
  a flannel cluster with default autoscaler windows and the shipped drain settings. The kind
  mechanism stays unexplained. The kind ~10 s mode may or may not be the same ARP effect; kind has
  no flannel, so do not assume it.
- **Default OKE scaling (`maxScale` 10) was not run.** All arms used `maxScale: 1` to match kind.
- **Image provenance** (above): the primer-bearing set is the 1.0/1.3 integration build, not the
  GA artifacts. A re-run on the exact v1.0.0 image would be a small follow-up.
- **n is 4–20 per arm.** The effect sizes (10 s vs 1.5 s) are large enough that the verdict does
  not turn on that, but the ~5 s tail (2 of 56 primed wakes: Node at +21.9 s offset, Bun at
  +12.5 s offset, both on `10.0.1.169`, no probe failures, new pod endpoint published ~5 s late)
  is too rare to characterise here. It matches the unattributed ~5 s `bound → pod IP` tails
  already recorded on that node.
- **Late-run activator fallback.** The last three settled Bun wakes without the primer
  (3.5, 13.1 and 18.6 s) show the activator in `clusterIP` probing mode after the pod-probe
  failures, the sticky fallback recorded in the troubleshooting runbook. It lengthened those three
  and is not a separate finding.
- **Concurrency.** Four to six apps were driven in parallel (initiation serialised). Pod boots
  from other arms may have added small contention; the stall/no-stall split is far outside it.

## Recommendation

- Re-scope #2080: the Node-only terminating-pod hold is a kind-only observation until someone
  explains it on kind. It is not evidenced on OKE and no Node shutdown change is warranted by it.
  Downgrade from "P1, may affect 1.x today".
- The Z2 report's footnote on #2080 should say the stall did not reproduce on OKE and that the
  ~10 s mode on OKE is the stale-ARP effect, fixed by the primer. Z10 (the OKE window) must use
  primer-bearing images; on a pre-rc.5 image roughly 9 in 10 wakes would carry +8 s.
- If a 1.x user on a flannel cluster reports ~10 s wakes, check the image first: a pre-rc.5
  build, or `KNEXT_ARP_PRIMER=0` in `spec.env`, is the cause.

## Reproduction

`scripts/` holds the driver, watchers, client, probe, analysis and the three CR sets. Run order:
apply a set, `watch.py <file>`, `driver.py <app> <out.jsonl> "$(cat plan.txt)"`,
`analyze.py <since>` (it reads the activator log from `run/activator.log`). Raw trials:
`main-*.jsonl` (one record per wake with pod snapshots), `rows.json` (joined view),
`analysis.txt`.

## Cleanup state

No `kubectl delete` was run. Namespace `z2080-repro` is left in place with the six `NextApp`s at
`minScale: 0` (they scale to zero on their own) and the client pod `z2080-drv`.
