# Scale-from-zero cold start, phase by phase, on OKE (2026-10-01)

**Question.** Yesterday's release-cell sitting
([`release-cells-cold-start-2026-09-30.md`](release-cells-cold-start-2026-09-30.md)) put every
cell's cold start at a ~2.1–2.4 s median and could only split it at 1-second resolution. Where,
exactly, does a knext wake spend its time — and which phases can be made shorter?

**Answer.**

1. **Today the cluster has two populations, split by node.** Every Part 1 wake that landed on
   node `10.0.1.118` finished in 1.9–3.7 s (cell medians 2.3 and 2.9 s). Every Part 1 wake that
   landed on node `10.0.1.169` took 9.4–11.0 s, and so did 28 of the 30 later untreated wakes
   there. On `10.0.1.169` the new pod was **up and serving within ~1 s, but unreachable from
   outside its node for another ~8.5 s**: a same-node TCP connect to the app succeeded at once
   while connects from the other node, the activator's probes and the kubelet's
   own readiness probe all timed out. Yesterday's sitting saw this signature once in 40 wakes
   (its single 10.4 s tail: a queue-proxy probe timeout, `Ready` on the next 10 s tick, on
   `10.0.1.169`); its other 39 wakes took 1.7–3.5 s on both nodes.
2. **The pod's first outbound packet ends that blackhole.** Experiment E1: exec'ing a one-shot DNS
   lookup inside the new container ended the blackhole within 10–173 ms of the exec, every time,
   whenever the exec happened (1.6–6.8 s into the wake); median wake **2379 ms treated vs 9928 ms
   untreated** (n = 7 + 7, exact Mann-Whitney p = 0.007, 95% CI of the difference
   [−7841, −5613] ms). The signature fits a **stale neighbour (ARP) entry on the node for a
   recycled pod IP**; that root cause is inferred, not observed (no node shell — see
   [Limitations](#limitations)).
3. **On the healthy node, the ~2.3 s splits like this** (Bun × turbopack, n = 5; Node ×
   turbopack, n = 6 — medians): request → Pod object ~0.08–0.10 s · scheduling ~0.01–0.02 s ·
   **sandbox + both containers started ~0.8–1.4 s** · runtime boot to listening **0.15 s (Bun) /
   0.33 s (Node)** · listening → routable **~0.83–0.86 s** · forward + render ~0.07 s. Inside
   "listening → routable", the app's own first `/api/health` answer takes **~0.72–0.76 s after it
   starts listening** (measured on the same node, around the network), and the kubelet takes
   ~0.4–0.8 s after the containers start to publish the pod IP that the activator needs.
4. **DNS is not on this path, and the "1.2 s DNS fallback" is refuted on the rebuilt cluster.**
   In-pod lookups at wake took ≤ 6.6 ms for in-cluster names and ≤ 27 ms for an external one
   (a single 125 ms outlier), with 0 errors in 21 wakes. The activator routed pod-direct
   (`clusterIP = <nil>`) on every wake; the sticky clusterIP fallback was never observed.
5. **Runtime choice moves exactly one phase.** Bun reaches "listening" 182 ms sooner than Node
   (151 vs 333 ms, p = 3e-6, CI [−195, −176]); the Bun cell boots a compiled single executable.
   That is too small to separate the cells' totals at this n (the healthy-node totals, 2257 vs
   2905 ms, p = 0.33) — consistent with yesterday's "tie".
6. **Two per-app knobs, measured** ([Part 2](#part-2--experiments)): a pod with **no volumes**
   (`security.readOnlyRootFilesystem: false`, which drops the operator's writable `emptyDir`)
   starts its containers **~0.47 s sooner** (p = 0.004) — at the price of the read-only root
   filesystem; lifting the **CPU limit** from 1 to 4 only shortens runtime boot by 37 ms.

The reduction plan built from this lives outside the repo, in the team's research notes.

## Per-phase breakdown

Milestones are taken per wake (definitions in [Method](#method)); each phase is the difference
between two milestones, then summarised across wakes. IQR uses the lower-half/upper-half method.

### Bun × turbopack (the default cell), by node

| phase | on 10.0.1.118 (n = 5) median · IQR | on 10.0.1.169 (n = 6) median · IQR |
|---|---|---|
| 1 activation: request → Pod object | 78 · 186 | 146 · 112 |
| 2 scheduling: Pod → bound to a node | 16 · 5 | 40 · 41 |
| 3 sandbox + containers start: bound → first container log line | 809 · 918 | 709 · 287 |
| 4 runtime boot: first log → Next listening on :3000 | 152 · 10 | 146 · 9 |
| 5 routable: listening → ready | 827 · 185 | **8934** · 327 |
| 6 forward + render: ready → first byte | 73 · 127 | 0 · 3 |
| **total: request → first byte** | **2257** · 899 | **10169** · 399 |
| 5x kubelet status lag: first log → pod IP visible in the API | 684 · 613 | 524 · 228 |
| 5y first log → TCP connect to :3000 succeeds from the other node | 687 · 601 | **8870** · 487 |
| 5w first log → activator marks the pod healthy | 903 · 329 | **8974** · 365 |

### Node × turbopack, by node

| phase | on 10.0.1.118 (n = 6) median · IQR | on 10.0.1.169 (n = 5) median · IQR |
|---|---|---|
| 1 activation: request → Pod object | 99 · 58 | 125 · 75 |
| 2 scheduling: Pod → bound to a node | 10 · 15 | 19 · 8 |
| 3 sandbox + containers start: bound → first container log line | 1388 · 1069 | 834 · 244 |
| 4 runtime boot: first log → Next listening on :3000 | 331 · 12 | 336 · 19 |
| 5 routable: listening → ready | 858 · 27 | **8638** · 735 |
| 6 forward + render: ready → first byte | 68 · 145 | 0 · 5 |
| **total: request → first byte** | **2905** · 1086 | **10382** · 698 |
| 5x kubelet status lag: first log → pod IP visible in the API | 813 · 580 | 374 · 639 |
| 5y first log → TCP connect to :3000 succeeds from the other node | 816 · 580 | **8913** · 592 |
| 5w first log → activator marks the pod healthy | 1139 · 5 | **8877** · 751 |

All values in ms. Pooled per-cell tables (n = 11 each), the per-wake milestone rows and the
control-plane log joins are in [Appendix A](#appendix-a--generated-tables). Pooling the two nodes
is **not** a meaningful summary today — the distribution is bimodal — so no pooled total is
headlined.

**Reading the healthy-node breakdown.**

- **Phases 1–2 (~0.1 s)** are the Knative + Kubernetes control plane: the activator holds the
  request and reports concurrency, the autoscaler decides 0→1 (its log line lands 18–35 ms after
  the request on 12 of 22 wakes and 107–279 ms on the other 10), the Deployment and ReplicaSet controllers
  create the Pod, and the scheduler binds it.
- **Phase 3 (~0.7–1.4 s, the widest spread: 0.6–2.3 s)** is the node: kubelet admission, the pod
  sandbox and its network (CRI-O + flannel CNI), then `user-container` and `queue-proxy` created
  and started one after the other. Nothing in this phase runs knext code. The longest values all
  fell on `10.0.1.118`, which also hosts the activator, the Kourier controller and the bench
  instruments.
- **Phase 4 (0.15 / 0.33 s)** is the runtime from its first log line to Next's `Ready in` line —
  the only phase that differs by cell (above).
- **Phase 5 (~0.83–0.86 s)** has two parallel legs and the slower one wins: the app has to answer
  its first `/api/health` (measured directly on the same node: ~0.72–0.76 s after listening, see
  E1's tables), and the kubelet has to publish the pod IP (via its status update) before the
  Endpoints change reaches the activator, which then probes the pod every 200 ms. On the healthy
  node the app leg is usually the slower one.
- **Phase 6 (~0.07 s)** is the activator forwarding the held request and the page rendering
  (SSR + one loopback `fetch`).

## The node-local blackhole (what makes `10.0.1.169` ~8 s slower)

**Signature, from every slow wake.** On `10.0.1.169`, the containers start and the app listens at
the same pace as on the healthy node (phases 3–4 match). Then:

- a TCP connect from the instrument on the **other node** to the pod's `:3000` and `:8012`
  times out (no RST) for ~8.5 s after the first container log line, then succeeds;
- the **activator** logs `Failed probing pods … context deadline exceeded` every ~300 ms for the
  same window;
- the **kubelet on the pod's own node** logs `Readiness probe failed: Get
  "http://<pod-ip>:8012/": context deadline exceeded` — so the node's own host network namespace
  cannot reach the pod either, and the pod's `Ready` condition only flips on the next kubelet
  probe (period 10 s), ~12 s in;
- but a TCP connect and an HTTP `GET /api/health` from a **pod on the same node**
  (`agent-169`, bridge-to-bridge, never through the host's routing) succeed on the first
  attempt, ~20 ms after the pod IP becomes visible, and `/api/health` answers ~0.72 s after the
  app starts listening — the same as on the healthy node (E1 tables).

So the pod is up and serving; traffic routed through the node's host network namespace (the
kubelet's probes, and every cross-node packet, which flannel delivers via the host) does not reach
it for ~8.5 s.

**E1 — the pod's first outbound packet ends it.** Same Knative Service, same node, ABAB over 14
single-wake rounds. Treated wakes: as soon as the watch showed `user-container` running, the
harness exec'd `node:dns.lookup('kubernetes.default.svc.cluster.local.')` inside the container
(a UDP packet to the cluster-DNS ClusterIP, which is off-subnet, so the pod must first ARP for its
gateway on the node's `cni0` bridge).

| arm (all on 10.0.1.169) | n | median wake | IQR | range | first log → reachable from the other node |
|---|---|---|---|---|---|
| untreated | 7 | **9928 ms** | 434 | 2369–10450 | 8830 ms |
| exec'd DNS lookup at container start | 7 | **2379 ms** | 1820 | 1899–7014 | 1017 ms |

Difference of medians −7549 ms, exact Mann-Whitney p = 0.007, bootstrap 95% CI [−7841, −5613].
The treated arm's spread is the exec's own latency: the exec request goes apiserver → kubelet and
took between 38 ms and 4.8 s to start. **In every treated wake, cross-node reachability followed
the start of the exec by 10–173 ms**, whether the exec started at 1.6 s or at 6.8 s — the effect
tracks the packet, not the clock. One untreated wake (pod IP `10.244.0.41`) was not blackholed at
all (2369 ms), nor was one E2/E3 wake there (`10.244.0.67`), nor any of the 14 wakes on
`10.0.1.118`.

**Interpretation (inferred).** Everything above fits one mechanism: the node keeps a stale
neighbour (ARP) entry for a **recycled pod IP**, pointing at the MAC address of the pod that held
that IP before. Frames sent to the old MAC are flooded by the bridge and dropped by the new pod's
interface. Linux holds such an entry through `delay_first_probe_time` (5 s) plus
`ucast_solicit` × `retrans_time` (3 × 1 s) of unicast re-probes to the old MAC before it falls back
to a broadcast ARP — ~8 s, which is the observed blackhole once the first packet arrives. The
pod's own ARP request for its gateway carries its new MAC and refreshes the node's entry at once.
`10.0.1.169`'s address allocator is visibly on a later pass through its `/25` (it handed out
`.17`–`.70` today while a long-lived pod there holds `.90`), whereas `10.0.1.118` handed out
`.198`–`.215`. What this sitting could **not** do is show the stale entry itself (`ip neigh` on the
node) — that needs node access, and it is the first thing to capture before reporting upstream.
If the mechanism is right, `10.0.1.118` will start showing the same blackhole once its allocator
wraps.

**Scope.** This is a cluster networking condition, not a knext behaviour: any pod that is reached
from outside its node before it has sent a packet of its own is affected, Knative or not. It
matters more for scale-to-zero than for always-on workloads because a woken pod is, by
construction, reached first.

## DNS at wake (the 2026-08-21 finding, re-checked)

Right after each Part 1 wake (after the measured request completed, so the timing is unaffected)
the driver exec'd `dns-probe.js` inside the fresh app container: one `dns.lookup` each, in order,
through the platform resolver (`getaddrinfo`, the path `fetch`/`pg`/`redis` clients take).

| name (resolv.conf: `ndots:5`, 5 search domains) | Bun median / max (n = 11) | Node median / max (n = 10) |
|---|---|---|
| `kubernetes.default.svc.cluster.local.` (rooted) | 2.5 / 2.6 ms | 5.4 / 6.6 ms |
| `kubernetes.default.svc.cluster.local` (search walk) | 3.9 / 4.7 ms | 5.1 / 5.5 ms |
| `kubernetes.default` (short name) | 0.8 / 1.0 ms | 0.8 / 1.1 ms |
| `registry.npmjs.org` (external, search walk) | 3.9 / 27.4 ms | 4.3 / 18.8 ms |
| `registry.npmjs.org.` (external, rooted) | 0.7 / 16.0 ms | 0.9 / 124.7 ms |

0 errors (no `EAI_AGAIN`), 21 wakes; one Node wake's probe returned no output and is not counted.
CoreDNS now runs one replica on each node (`10.244.0.2` on `.169`, `10.244.0.131` on `.118`),
unlike the colocated pair recorded on the old cluster. The activator's throttler logged
`clusterIP = <nil>` (pod-direct) on all 152 of its bench-namespace updates across the sitting; its clusterIP probes
failed during the blackhole (no ready endpoints behind the Service), so the "sticky clusterIP
fallback" never engaged. **Verdict: the ~1.2 s per-wake cost recorded on the old cluster is not
present on the rebuilt one**, and this app makes no DNS lookup on its cold path (its one `fetch`
is loopback). It remains a risk for apps whose first request resolves a name; this sitting cannot
speak to that beyond the lookup timings above.

## Part 2 — experiments

Picked from Part 1's data: the blackhole is the dominant term on the affected node (E1, above);
on the healthy node the largest knext-adjacent slices are **phase 3** (sandbox + containers,
~0.8 s) and the app leg of **phase 5** (~0.74 s from listening to the first `/api/health` 200).
Two per-app levers the `NextApp` CRD already exposes target exactly those, one variable each:

- **E2 — CPU limit 4 instead of 1** (`resources.cpuLimit: "4"`, the node's full 4 vCPU; the
  request stays 250m). Hypothesis: boot and the first request are CPU-throttled.
- **E3 — no writable emptyDir** (`security.readOnlyRootFilesystem: false`). With the default
  read-only root filesystem the operator adds one `emptyDir` (`knext-writable`) with two `subPath`
  mounts (`/tmp`, `.next/cache`); with it off the pod has **no volumes at all**. Hypothesis: the
  kubelet's volume setup is on the start path.

Rejected candidates, with the reason: a more aggressive readiness probe — the operator already
renders Knative's aggressive mode (no `periodSeconds`), and phase 5's app leg is the app's first
answer, not probe cadence; a lighter probe path — the first real request would pay the same
first-request cost (phase 6 is ~0 because the app is already warm by then); removing an init
container — there is none; `initial-scale` / `target-burst-capacity` — neither changes a
scale-from-zero wake of a single request (`initial-scale` applies to a new revision, and the
activator is always in the path at zero pods); image size — images were pre-pulled, and the
larger Bun image (115 MB vs 80 MB) did not start slower (phase 3, Bun 764 vs Node 852 ms).

**Design.** Three Knative Services from the same Bun × turbopack image — baseline
`bc-bun-turbopack`, `bc-bun-cpu4`, `bc-bun-rwfs` — woken once per round in rotating order (ABC,
BCA, CAB), 9 rounds, 2026-10-01 03:34–04:48 UTC. One `bc-bun-cpu4` wake was lost to a
workstation→apiserver connection drop (n = 8 / 9 / 9). With three arms the scheduler put 23 of
26 wakes on the affected node `10.0.1.169`, so **the totals are dominated by the blackhole and
are not the comparison**; the phase metrics are, because every one of them is measured either
from node-side log stamps or from the same-node agent, around the blackhole.

| metric (median ms, n = 9 baseline) | baseline | E2: CPU limit 4 | E3: no emptyDir |
|---|---|---|---|
| 3 sandbox + containers start: bound → first log | 908 | 745 (−163, p = 0.42, CI [−454, +402]) | **435 (−473, p = 0.004, CI [−729, −57])** |
| 4 runtime boot: first log → listening | 143 | **106 (−37, p = 0.0006, CI [−52, −23])** | 148 (+6, p = 0.33) |
| app leg: listening → first `/api/health` 200 (same node) | 737 | 995 (+258, p = 0.24, CI [−150, +383]) | 744 (+7, p = 0.44) |
| bound → first `/api/health` 200 (same node) | 1901 | 1772 (−129, p = 0.89) | **1402 (−498, p = 0.024, CI [−741, +16])** |
| bound → pod IP visible in the API | 1549 | 1586 (+38, p = 0.42) | 1263 (−286, p = 0.14, CI [−918, +222]) |
| total (all nodes; blackhole-dominated, not the comparison) | 10064 | 10409 (p = 0.42) | 9910 (p = 0.30) |

p = exact two-sided Mann-Whitney; CI = bootstrap 95% CI of the difference of medians.

**E2 verdict — not worth it.** Lifting the CPU limit makes the runtime reach "listening" 37 ms
sooner (real, p = 0.0006) and changes nothing else measurably: the app's first-request leg did
not shrink (it trended slower, not significant), and neither did phase 3. The ~0.74 s first
answer is not CPU-throttle-bound — consistent with it being mostly single-threaded work, which a
1-CPU limit does not throttle. A higher default limit would cost tenancy headroom for ~37 ms.

**E3 verdict — a real phase-3 saving, with a security price.** A pod with no volumes starts its
containers ~0.47 s sooner (p = 0.004) and answers its first health check ~0.5 s sooner after
binding (p = 0.024). Nothing else moved (runtime boot and the app leg are unchanged), which points
at the kubelet's volume setup — waiting for the volume manager to mount the `emptyDir` and prepare
the two `subPath` bind mounts — rather than at anything the app does. The price is the read-only
root filesystem, a default-on hardening; it is a per-app trade-off, not a default to flip. The
total-level saving on a healthy node was not measured here (only 1 of 9 E3 wakes landed there)
and is bounded by the parallel network leg (pod IP published −286 ms, not significant), so
expect roughly 0.3–0.5 s, not more.

## Method

**Cluster.** OKE `knext-oke` (context `knext-oke-sa`), Kubernetes 1.34.10, CRI-O 1.34.8, flannel
(VXLAN, one `/25` per node), Knative Serving 1.16.0 with Kourier, knext operator
`v0.1.0@sha256:5c700909…`, 2 × VM.Standard.E4.Flex workers (4 vCPU / 16 GB). Knative config maps
carry no overrides. Quiet: the only application pods running were this benchmark's.

**Subject.** The 2026-09-30 release-cell images, same digests — Bun × turbopack (the default) and
Node × turbopack — deployed as `NextApp` CRs ([`nextapps.yaml`](../../scripts/bench-cold-start-phases/nextapps.yaml)); the operator rendered
the Knative Services (read back: `min-scale 0`, `max-scale 1`, requests 250m / 512Mi, limits 1 CPU
/ 1Gi, readiness `GET /api/health` with no period — Knative's aggressive mode — and the
`knext-writable` emptyDir for the read-only root filesystem). Images were already present on both
nodes (every wake's events read `already present on machine`).

**Instrument.** [`scripts/bench-cold-start-phases/`](../../scripts/bench-cold-start-phases/):

- `harness.mjs` runs **inside the cluster** in the `phase-bench` pod (`node:22-alpine`, pinned to
  `10.0.1.118`), one cold cycle per run. It opens watches on the arm's Pods, Deployment and
  EndpointSlices, resolves the Service name (timed separately; median 8.6 ms), then sends
  `GET /` to the cluster-local Kourier address and records request start, response headers, first
  body byte and end. On the first watch event that carries the pod IP it starts TCP polls of
  `:3000` and `:8012` (10 ms interval, 200 ms connect timeout), an activator-style probe of
  queue-proxy (`K-Network-Probe: queue`, 300 ms timeout, every 50 ms) and asks the agent pod on
  the new pod's node to poll the same `:3000` (TCP and `GET /api/health`). After the response it
  reads the pod's final status, its events and both containers' logs with CRI-O timestamps
  (`?timestamps=true`). Every response was HTTP 200 with the rendered `items:50` marker.
- `drive.py` runs on the workstation and only orchestrates: wait until every arm has zero pods
  (+10 s), then wake the arms one after another, rotating the order each round. All timing
  happens in-cluster; the `kubectl exec` round trip is outside every timed interval. Part 1 used
  the earlier harness revision without the same-node agent poll (the agent pods did not exist
  yet); E1–E3 used the final one.
- `analyze.py` turns a run into the tables here; `stats.py` does the two-sample comparisons
  (exact Mann-Whitney on untied samples, bootstrap CI of the median difference, 4000 resamples).

**Milestones** (ms after the request was sent):

| milestone | source | resolution |
|---|---|---|
| Pod object exists | watch `ADDED`, arrival time | watch delivery, a few ms |
| bound to a node | first watch event with `spec.nodeName` | as above |
| first container log line | CRI-O stamp on the first line from either container | ns stamp, node clock |
| Next listening | CRI-O stamp on Next's `Ready in` line | as above |
| pod IP visible | first watch event with `status.podIP` | watch delivery |
| ready | earliest of: harness's queue-proxy probe got 200, pod `Ready` on the watch, first response byte | probe grid ≤ 350 ms; watch delivery |
| activator marks pod healthy | activator log `Updating Revision Throttler … backends = 1` | ns stamp, node clock |
| autoscaler decides 0→1 | autoscaler log `PA scale got=0, want=1` | ns stamp, node clock |
| first byte | client socket | sub-ms |

**Clocks.** The harness reads `performance.timeOrigin + performance.now()` (CLOCK_REALTIME,
sub-millisecond). Node-side stamps (CRI-O log stamps, kubelet and scheduler events, Knative
component logs) come from the node's own clock; each cycle measured the offset of the app's node
against the harness with an NTP-style exchange against the agent/clock pod on that node (best of
7). **Every measured offset was ≤ 0.29 ms with a round trip ≤ 0.96 ms**, so cross-node skew is
well below anything reported here; offsets were applied anyway. Kubelet events and pod status
timestamps carry **1-second** resolution and are kept only as cross-checks; the scheduler's
`Scheduled` event carries a microsecond `eventTime`. Watch arrival times trail the API write by
the delivery latency, which is why a few wakes show a ~0 or negative sub-phase (one E1 wake's
`bound` event arrived after its first log line); those are kept, not trimmed.

**Interleaving.** Part 1: 11 rounds, both arms woken once per round, order alternating (A B, B A).
With two arms the scheduler placed the first wake of a round on `10.0.1.169` and the second on
`10.0.1.118`, so the alternation put each cell on each node about equally (Bun 6/5, Node 5/6).
22 wakes, 22 valid, none excluded; round 12 was lost to a workstation→apiserver connection drop
before its wakes started. Sitting: 2026-10-01 02:01–02:23 UTC (Part 1), 02:40–03:25 UTC (E1),
03:34–04:48 UTC (E2/E3).

## Limitations

- **The blackhole's root cause is inferred.** The evidence (timing ≈ the Linux neighbour state
  machine's 5 s + 3 × 1 s, host and cross-node paths failing while bridge-local works, a single
  outbound packet clearing it within ~0.2 s, address reuse on the affected node only) points at a
  stale neighbour entry, but no `ip neigh` capture from the node was possible from this seat.
- **Two nodes, one cluster, one app**, images pre-pulled, cluster otherwise idle. A busier node
  stretches phase 3; an app whose first request reaches a database adds its own wake-ups.
- **The probes perturb a little.** The harness's TCP and queue-proxy probes and (E1–E3) the agent's
  direct `GET /api/health` add a handful of requests during boot; the direct health poll can warm
  the health route slightly earlier than queue-proxy alone would. All arms of a comparison carry
  the same instrument.
- **n per node is small in Part 1** (5–6). The phase medians are stable (IQRs above), the totals
  less so.
- **The E1 treatment is a probe, not the product fix.** An exec through the apiserver is late and
  variable; a packet sent by the runtime itself at process start would fire ~1 s earlier than the
  watch can even report the container running.

## Raw data and reproduction

Raw per-wake records (every milestone, event and the first container log lines) are in
[`data/cold-start-phase-breakdown-2026-10-01/`](data/cold-start-phase-breakdown-2026-10-01/):
`part1.jsonl`, `e1-heal.jsonl`, `e2-e3.jsonl`, plus `activator.jsonl` and `autoscaler.jsonl`
(the bench-namespace lines the joins use: throttler updates, failed pod probes, and the
autoscaler's 0→1 decisions). Container log lines are trimmed by `compact.py`; every timestamp the
analysis reads is kept. To reproduce: `kubectl apply` `harness-rbac.yaml`, `node-agents.yaml`
and `nextapps.yaml`, then `python3 drive.py <rounds> <arm,arm,...> out.jsonl [--dns]
[--heal=<arm>]` and `python3 analyze.py out.jsonl --by-node --activator=activator.jsonl
--autoscaler=autoscaler.jsonl` (the logs come from `kubectl -n knative-serving logs
deploy/activator` and `deploy/autoscaler`). `stats.py` reproduces every p-value and CI quoted.

## Left on the cluster

Namespace `bench-cells` on OKE: `NextApp`s `bc-bun-turbopack`, `bc-node-turbopack`, `bc-bun-cpu4`,
`bc-bun-rwfs` (and the Knative Services the operator made from them, all scaled to zero); pods
`phase-bench`, `agent-118`, `agent-169`, `clock-118`, `clock-169` (idle `node:22-alpine`), and
yesterday's `bench-timer`; ServiceAccount, Role and RoleBinding `phase-bench`/`phase-bench-read`;
the `ghcr-bench` pull Secret from yesterday. Nothing outside the namespace was changed.

## Appendix A — generated tables

Produced by `analyze.py` from the committed raw data, with the activator and autoscaler logs joined. Rows 5x–5w are sub-measurements that overlap the numbered phases; they do not add up. In the per-wake rows every value is ms after the request was sent.

### Part 1
valid 22, excluded 0: []

#### bc-bun-turbopack (n=11)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 24 | 220 [20, 239] | 18–279 |
| 1 activation: request -> Pod object | 134 | 149 [78, 227] | 53–951 |
| 2 scheduling: Pod -> bound to node | 18 | 34 [15, 50] | 1–142 |
| 3 sandbox + containers start: bound -> first log line | 764 | 278 [706, 984] | 618–2151 |
| 4 runtime boot: first log -> Next listening | 151 | 8 [144, 152] | 138–169 |
| 5 routable: listening -> ready | 8483 | 8151 [827, 8978] | 768–9304 |
| 6 forward + render: ready -> first byte | 3 | 73 [0, 73] | 0–168 |
| total: request -> first byte | 9445 | 7942 [2257, 10199] | 1862–10992 |
|   5x kubelet status lag: first log -> pod IP visible in API | 616 | 413 [392, 806] | 324–1150 |
|   5y net: first log -> TCP :3000 from the other node | 8548 | 8236 [687, 8923] | 378–9434 |
|   5w activator: first log -> activator marks pod healthy | 8522 | 8134 [903, 9038] | 895–9358 |

#### bc-bun-turbopack on 10.0.1.118 (n=5)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 25 | 243 [22, 265] | 20–279 |
| 1 activation: request -> Pod object | 78 | 186 [56, 243] | 53–258 |
| 2 scheduling: Pod -> bound to node | 16 | 5 [15, 20] | 15–23 |
| 3 sandbox + containers start: bound -> first log line | 809 | 918 [741, 1660] | 719–2151 |
| 4 runtime boot: first log -> Next listening | 152 | 10 [152, 161] | 152–169 |
| 5 routable: listening -> ready | 827 | 185 [795, 980] | 768–1033 |
| 6 forward + render: ready -> first byte | 73 | 127 [3, 129] | 0–168 |
| total: request -> first byte | 2257 | 899 [1953, 2852] | 1862–3406 |
|   5x kubelet status lag: first log -> pod IP visible in API | 684 | 613 [483, 1096] | 350–1150 |
|   5y net: first log -> TCP :3000 from the other node | 687 | 601 [499, 1100] | 378–1154 |
|   5w activator: first log -> activator marks pod healthy | 903 | 329 [898, 1227] | 895–1234 |

#### bc-bun-turbopack on 10.0.1.169 (n=6)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 22 | 97 [19, 116] | 18–239 |
| 1 activation: request -> Pod object | 146 | 112 [105, 218] | 90–951 |
| 2 scheduling: Pod -> bound to node | 40 | 41 [15, 56] | 1–142 |
| 3 sandbox + containers start: bound -> first log line | 709 | 287 [674, 961] | 618–984 |
| 4 runtime boot: first log -> Next listening | 146 | 9 [142, 150] | 138–151 |
| 5 routable: listening -> ready | 8934 | 327 [8799, 9126] | 8483–9304 |
| 6 forward + render: ready -> first byte | 0 | 3 [0, 3] | 0–4 |
| total: request -> first byte | 10169 | 399 [9943, 10342] | 9445–10992 |
|   5x kubelet status lag: first log -> pod IP visible in API | 524 | 228 [392, 621] | 324–806 |
|   5y net: first log -> TCP :3000 from the other node | 8870 | 487 [8759, 9246] | 8548–9434 |
|   5w activator: first log -> activator marks pod healthy | 8974 | 365 [8819, 9184] | 8522–9358 |

#### bc-node-turbopack (n=11)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 26 | 132 [22, 154] | 18–272 |
| 1 activation: request -> Pod object | 107 | 55 [93, 147] | 77–349 |
| 2 scheduling: Pod -> bound to node | 16 | 14 [6, 20] | 1–25 |
| 3 sandbox + containers start: bound -> first log line | 852 | 717 [816, 1533] | 798–2335 |
| 4 runtime boot: first log -> Next listening | 333 | 17 [327, 345] | 307–348 |
| 5 routable: listening -> ready | 952 | 7787 [852, 8638] | 776–9268 |
| 6 forward + render: ready -> first byte | 4 | 116 [0, 116] | 0–176 |
| total: request -> first byte | 3680 | 7484 [2898, 10382] | 2101–10544 |
|   5x kubelet status lag: first log -> pod IP visible in API | 793 | 606 [371, 977] | 279–1058 |
|   5y net: first log -> TCP :3000 from the other node | 1061 | 8117 [796, 8913] | 375–9402 |
|   5w activator: first log -> activator marks pod healthy | 1149 | 7739 [1138, 8877] | 1098–9545 |

#### bc-node-turbopack on 10.0.1.118 (n=6)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 30 | 85 [22, 107] | 18–272 |
| 1 activation: request -> Pod object | 99 | 58 [81, 139] | 77–349 |
| 2 scheduling: Pod -> bound to node | 10 | 15 [4, 19] | 1–25 |
| 3 sandbox + containers start: bound -> first log line | 1388 | 1069 [816, 1885] | 798–2335 |
| 4 runtime boot: first log -> Next listening | 331 | 12 [329, 341] | 307–346 |
| 5 routable: listening -> ready | 858 | 27 [842, 870] | 776–952 |
| 6 forward + render: ready -> first byte | 68 | 145 [3, 148] | 0–176 |
| total: request -> first byte | 2905 | 1086 [2225, 3311] | 2101–3680 |
|   5x kubelet status lag: first log -> pod IP visible in API | 813 | 580 [475, 1054] | 371–1058 |
|   5y net: first log -> TCP :3000 from the other node | 816 | 580 [478, 1058] | 375–1061 |
|   5w activator: first log -> activator marks pod healthy | 1139 | 5 [1135, 1140] | 1098–1149 |

#### bc-node-turbopack on 10.0.1.169 (n=5)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 24 | 156 [21, 177] | 20–201 |
| 1 activation: request -> Pod object | 125 | 75 [100, 175] | 93–202 |
| 2 scheduling: Pod -> bound to node | 19 | 8 [13, 21] | 10–21 |
| 3 sandbox + containers start: bound -> first log line | 834 | 244 [819, 1063] | 811–1274 |
| 4 runtime boot: first log -> Next listening | 336 | 19 [327, 347] | 327–348 |
| 5 routable: listening -> ready | 8638 | 735 [8426, 9161] | 8257–9268 |
| 6 forward + render: ready -> first byte | 0 | 5 [0, 5] | 0–6 |
| total: request -> first byte | 10382 | 698 [9771, 10470] | 9676–10544 |
|   5x kubelet status lag: first log -> pod IP visible in API | 374 | 639 [290, 929] | 279–977 |
|   5y net: first log -> TCP :3000 from the other node | 8913 | 592 [8658, 9250] | 8516–9402 |
|   5w activator: first log -> activator marks pod healthy | 8877 | 751 [8649, 9400] | 8496–9545 |

| round | arm | treatment | node | pod IP | autoscaler_scale | pod_added | pod_bound | ctr_first_log | app_listening | kubelet_reports_ip | app_tcp_cross_node | app_tcp_same_node | app_health_same_node | activator_first_probe | activator_routes | qp_ready | first_byte | clock offset/RTT ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | bc-bun-turbopack | none | 10.0.1.169 |  | 21 | 134 | 276 | 1260 | 1398 | 1652 | 10077 |  |  | 1949 | 10078 | 10197 | 10199 | 0.28/0.95 |
| 1 | bc-node-turbopack | none | 10.0.1.118 |  | 22 | 93 | 112 | 1997 | 2326 | 2368 | 2372 |  |  | 2684 | 3137 | 3195 | 3311 | 0.11/0.82 |
| 2 | bc-node-turbopack | none | 10.0.1.169 |  | 24 | 202 | 222 | 1074 | 1419 | 1376 | 9590 |  |  | 1744 | 9570 | 9676 | 9676 | 0.29/0.91 |
| 2 | bc-bun-turbopack | none | 10.0.1.118 |  | 25 | 78 | 93 | 1262 | 1416 | 1611 | 1640 |  |  | 1926 | 2163 | 2184 | 2257 | 0.12/0.61 |
| 3 | bc-bun-turbopack | none | 10.0.1.169 |  | 19 | 90 | 105 | 810 | 961 | 1361 | 9569 |  |  | 1680 | 9848 | 9939 | 9943 | 0.25/0.93 |
| 3 | bc-node-turbopack | none | 10.0.1.118 |  | 35 | 105 | 106 | 904 | 1237 | 1736 | 1739 |  |  |  | 2039 | 2101 | 2101 | 0.1/0.59 |
| 4 | bc-node-turbopack | none | 10.0.1.169 |  | 22 | 107 | 123 | 934 | 1270 | 1911 | 10336 |  |  | 2262 | 10479 | 10538 | 10544 | 0.28/0.94 |
| 4 | bc-bun-turbopack | none | 10.0.1.118 |  | 24 | 53 | 69 | 878 | 1029 | 1562 | 1565 |  |  |  | 1781 | 1857 | 1862 | 0.12/0.66 |
| 5 | bc-bun-turbopack | none | 10.0.1.169 |  | 116 | 218 | 274 | 891 | 1038 | 1697 | 10325 |  |  | 1991 | 10249 | 10342 | 10342 | 0.26/0.94 |
| 5 | bc-node-turbopack | none | 10.0.1.118 |  | 272 | 349 | 353 | 1597 | 1943 | 2390 | 2393 |  |  | 2677 | 2736 | 2895 | 2898 | 0.12/0.61 |
| 6 | bc-node-turbopack | none | 10.0.1.169 |  | 154 | 147 | 166 | 1000 | 1328 | 1883 | 10098 |  |  | 2534 | 10256 | 10382 | 10382 | 0.26/0.93 |
| 6 | bc-bun-turbopack | none | 10.0.1.118 |  | 250 | 258 | 281 | 2432 | 2584 | 3048 | 3051 |  |  |  | 3327 | 3406 | 3406 | 0.11/0.8 |
| 7 | bc-bun-turbopack | none | 10.0.1.169 |  | 239 | 951 | 1000 | 1961 | 2103 | 2458 | 10884 |  |  | 2787 | 10872 | 10992 | 10992 | 0.28/0.94 |
| 7 | bc-node-turbopack | none | 10.0.1.118 |  | 107 | 139 | 153 | 2488 | 2816 | 3546 | 3548 |  |  |  | 3637 | 3659 | 3680 | 0.18/0.76 |
| 8 | bc-node-turbopack | none | 10.0.1.169 |  | 201 | 125 | 135 | 1409 | 1758 | 1688 | 10322 |  |  | 2007 | 10286 | 10396 | 10396 | 0.28/0.88 |
| 8 | bc-bun-turbopack | none | 10.0.1.118 |  | 279 | 227 | 242 | 1006 | 1175 | 2156 | 2160 |  |  |  | 2227 | 2207 | 2298 | 0.13/0.63 |
| 9 | bc-bun-turbopack | none | 10.0.1.169 |  | 18 | 105 | 106 | 818 | 962 | 1142 | 9365 |  |  | 1468 | 9340 | 9445 | 9445 | 0.27/0.93 |
| 9 | bc-node-turbopack | none | 10.0.1.118 |  | 18 | 81 | 87 | 1620 | 1961 | 2674 | 2679 |  |  |  | 2718 | 2737 | 2913 | 0.14/0.83 |
| 10 | bc-node-turbopack | none | 10.0.1.169 |  | 20 | 93 | 114 | 940 | 1268 | 1314 | 9741 |  |  | 1635 | 9743 | 9863 | 9867 | 0.28/0.92 |
| 10 | bc-bun-turbopack | none | 10.0.1.118 |  | 20 | 60 | 77 | 796 | 948 | 1838 | 1842 |  |  |  | 2030 | 1876 | 2044 | 0.13/0.83 |
| 11 | bc-bun-turbopack | none | 10.0.1.169 |  | 22 | 157 | 187 | 861 | 1012 | 1482 | 10107 |  |  | 1814 | 10045 | 10139 | 10139 | 0.29/0.96 |
| 11 | bc-node-turbopack | none | 10.0.1.118 |  | 26 | 77 | 102 | 918 | 1225 | 1393 | 1396 |  |  | 1705 | 2056 | 2077 | 2225 | 0.08/0.65 |

### E1 (by treatment)
valid 14, excluded 0: []

#### bc-bun-turbopack [heal] (n=7)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 22 | 3 [21, 24] | 21–32 |
| 1 activation: request -> Pod object | 107 | 20 [97, 117] | 89–128 |
| 2 scheduling: Pod -> bound to node | 12 | 4 [10, 14] | 8–29 |
| 3 sandbox + containers start: bound -> first log line | 1161 | 443 [740, 1183] | 735–2148 |
| 4 runtime boot: first log -> Next listening | 146 | 14 [137, 151] | 128–163 |
| 5 routable: listening -> ready | 923 | 2226 [894, 3120] | 874–5590 |
| 6 forward + render: ready -> first byte | 0 | 0 [0, 0] | 0–4 |
| total: request -> first byte | 2379 | 1820 [2296, 4116] | 1899–7014 |
|   5x kubelet status lag: first log -> pod IP visible in API | 716 | 550 [254, 804] | 224–908 |
|   5y net: first log -> TCP :3000 from the other node | 1017 | 2336 [837, 3172] | 465–5558 |
|   5y net: first log -> TCP :3000 from the same node | 791 | 668 [275, 943] | 246–3748 |
|   5z app: listening -> /api/health 200 (same node, direct) | 762 | 109 [730, 839] | 692–1160 |
|   5w activator: first log -> activator marks pod healthy | 972 | 2213 [914, 3126] | 897–5685 |

#### bc-bun-turbopack [none] (n=7)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 25 | 4 [22, 26] | 21–26 |
| 1 activation: request -> Pod object | 120 | 132 [107, 239] | 102–1184 |
| 2 scheduling: Pod -> bound to node | 13 | 108 [12, 120] | 6–134 |
| 3 sandbox + containers start: bound -> first log line | 705 | 545 [613, 1158] | -477–1164 |
| 4 runtime boot: first log -> Next listening | 142 | 9 [137, 146] | 136–155 |
| 5 routable: listening -> ready | 8831 | 855 [8292, 9147] | 810–9167 |
| 6 forward + render: ready -> first byte | 0 | 2 [0, 2] | 0–147 |
| total: request -> first byte | 9928 | 434 [9729, 10163] | 2369–10450 |
|   5x kubelet status lag: first log -> pod IP visible in API | 579 | 565 [266, 831] | 215–1055 |
|   5y net: first log -> TCP :3000 from the other node | 8830 | 840 [8427, 9268] | 272–9278 |
|   5y net: first log -> TCP :3000 from the same node | 604 | 568 [284, 852] | 278–1187 |
|   5z app: listening -> /api/health 200 (same node, direct) | 721 | 349 [713, 1062] | 695–1093 |
|   5w activator: first log -> activator marks pod healthy | 8862 | 826 [8341, 9167] | 933–9199 |

| round | arm | treatment | node | pod IP | autoscaler_scale | pod_added | pod_bound | ctr_first_log | app_listening | kubelet_reports_ip | app_tcp_cross_node | app_tcp_same_node | app_health_same_node | activator_first_probe | activator_routes | qp_ready | first_byte | clock offset/RTT ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | bc-bun-turbopack | none | 10.0.1.169 |  | 23 | 239 | 245 | 870 | 1016 | 1925 | 10138 | 2057 | 2109 | 2210 | 10037 | 10163 | 10163 | 0.23/0.97 |
| 2 | bc-bun-turbopack | heal | 10.0.1.169 |  | 32 | 128 | 136 | 2284 | 2421 | 3192 | 3404 | 3227 | 3260 |  | 3342 | 3439 | 3439 | 0.2/0.89 |
| 3 | bc-bun-turbopack | none | 10.0.1.169 |  | 25 | 111 | 123 | 1286 | 1428 | 1865 | 10087 | 1890 | 2123 | 2181 | 10285 | 10447 | 10450 | 0.24/0.92 |
| 4 | bc-bun-turbopack | heal | 10.0.1.169 |  | 21 | 97 | 110 | 1271 | 1420 | 1988 | 6829 | 5019 | 2112 | 3320 | 6956 | 7010 | 7014 | 0.23/0.94 |
| 5 | bc-bun-turbopack | none | 10.0.1.169 |  | 25 | 226 | 347 | 960 | 1097 | 1422 | 9858 | 1442 | 1810 | 1725 | 9822 | 9928 | 9928 | 0.21/0.92 |
| 6 | bc-bun-turbopack | heal | 10.0.1.169 |  | 21 | 117 | 127 | 868 | 996 | 1092 | 4040 | 1114 | 2156 | 2098 | 3994 | 4116 | 4116 | 0.23/0.94 |
| 7 | bc-bun-turbopack | none | 10.0.1.169 |  | 21 | 107 | 129 | 834 | 969 | 1474 | 10112 | 1492 | 1691 | 1814 | 10033 | 10136 | 10136 | 0.23/0.92 |
| 8 | bc-bun-turbopack | heal | 10.0.1.169 |  | 24 | 89 | 101 | 1262 | 1402 | 2065 | 2278 | 2084 | 2175 |  | 2200 | 2296 | 2296 | 0.25/0.94 |
| 9 | bc-bun-turbopack | none | 10.0.1.169 |  | 26 | 102 | 114 | 1273 | 1412 | 1539 | 1545 | 1557 | 2188 | 1871 | 2206 | 2222 | 2369 | 0.24/0.93 |
| 10 | bc-bun-turbopack | heal | 10.0.1.169 |  | 21 | 114 | 143 | 878 | 1024 | 1594 | 1806 | 1669 | 1787 |  | 1792 | 1899 | 1899 | 0.23/0.97 |
| 11 | bc-bun-turbopack | none | 10.0.1.169 |  | 22 | 1184 | 1318 | 840 | 985 | 1671 | 9670 | 1692 | 2047 | 1975 | 9673 | 9798 | 9798 | 0.23/0.96 |
| 12 | bc-bun-turbopack | heal | 10.0.1.169 |  | 22 | 107 | 121 | 1304 | 1456 | 1558 | 1770 | 1579 | 2209 | 1885 | 2276 | 2379 | 2379 | 0.28/0.92 |
| 13 | bc-bun-turbopack | none | 10.0.1.169 |  | 26 | 120 | 133 | 1282 | 1437 | 1497 | 9709 | 1560 | 2150 | 1838 | 9623 | 9729 | 9729 | 0.23/0.94 |
| 14 | bc-bun-turbopack | heal | 10.0.1.169 |  | 23 | 107 | 117 | 1283 | 1446 | 1907 | 2120 | 1926 | 2176 |  | 2180 | 2340 | 2340 | 0.26/0.91 |

### E2 / E3
valid 26, excluded 1: [(8, 'bc-bun-cpu4', 'harness produced no result in 240 s')]

#### bc-bun-cpu4 (n=8)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 25 | 6 [24, 30] | 22–135 |
| 1 activation: request -> Pod object | 192 | 300 [117, 418] | 108–1016 |
| 2 scheduling: Pod -> bound to node | 20 | 38 [10, 48] | 6–90 |
| 3 sandbox + containers start: bound -> first log line | 745 | 496 [646, 1141] | 270–1656 |
| 4 runtime boot: first log -> Next listening | 106 | 10 [100, 110] | 97–113 |
| 5 routable: listening -> ready | 9281 | 944 [8574, 9517] | 794–9698 |
| 6 forward + render: ready -> first byte | 0 | 0 [0, 0] | 0–99 |
| total: request -> first byte | 10409 | 576 [10134, 10711] | 1834–11654 |
|   5x kubelet status lag: first log -> pod IP visible in API | 931 | 416 [713, 1129] | 383–1159 |
|   5y net: first log -> TCP :3000 from the other node | 9376 | 1029 [8593, 9622] | 876–9790 |
|   5y net: first log -> TCP :3000 from the same node | 1014 | 361 [790, 1151] | 472–1186 |
|   5z app: listening -> /api/health 200 (same node, direct) | 995 | 427 [671, 1098] | 540–1828 |
|   5w activator: first log -> activator marks pod healthy | 9296 | 943 [8578, 9522] | 880–9709 |

#### bc-bun-rwfs (n=9)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 23 | 4 [21, 26] | 18–28 |
| 1 activation: request -> Pod object | 114 | 38 [99, 137] | 75–156 |
| 2 scheduling: Pod -> bound to node | 12 | 17 [10, 27] | 3–97 |
| 3 sandbox + containers start: bound -> first log line | 435 | 404 [419, 824] | 334–835 |
| 4 runtime boot: first log -> Next listening | 148 | 11 [144, 155] | 116–164 |
| 5 routable: listening -> ready | 8953 | 718 [8556, 9274] | 1025–9359 |
| 6 forward + render: ready -> first byte | 2 | 5 [0, 5] | 0–110 |
| total: request -> first byte | 9910 | 848 [9268, 10116] | 2202–10388 |
|   5x kubelet status lag: first log -> pod IP visible in API | 765 | 527 [432, 958] | 255–1135 |
|   5y net: first log -> TCP :3000 from the other node | 8917 | 760 [8589, 9348] | 1145–9466 |
|   5y net: first log -> TCP :3000 from the same node | 790 | 540 [456, 997] | 276–1164 |
|   5z app: listening -> /api/health 200 (same node, direct) | 744 | 152 [725, 878] | 692–1056 |
|   5w activator: first log -> activator marks pod healthy | 8941 | 727 [8621, 9348] | 1217–9366 |

#### bc-bun-turbopack (n=9)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 21 | 3 [20, 23] | 17–26 |
| 1 activation: request -> Pod object | 126 | 99 [102, 201] | 80–299 |
| 2 scheduling: Pod -> bound to node | 13 | 39 [13, 52] | 6–105 |
| 3 sandbox + containers start: bound -> first log line | 908 | 425 [734, 1160] | 733–1205 |
| 4 runtime boot: first log -> Next listening | 143 | 22 [130, 153] | 115–157 |
| 5 routable: listening -> ready | 8783 | 4557 [4711, 9268] | 764–9541 |
| 6 forward + render: ready -> first byte | 3 | 31 [0, 31] | 0–118 |
| total: request -> first byte | 10064 | 4522 [6098, 10621] | 1845–10870 |
|   5x kubelet status lag: first log -> pod IP visible in API | 638 | 398 [500, 898] | 238–1096 |
|   5y net: first log -> TCP :3000 from the other node | 8853 | 4570 [4744, 9314] | 428–9719 |
|   5y net: first log -> TCP :3000 from the same node | 664 | 345 [576, 921] | 261–2408 |
|   5z app: listening -> /api/health 200 (same node, direct) | 737 | 136 [709, 845] | 701–998 |
|   5w activator: first log -> activator marks pod healthy | 8844 | 4506 [4808, 9314] | 891–9572 |

| round | arm | treatment | node | pod IP | autoscaler_scale | pod_added | pod_bound | ctr_first_log | app_listening | kubelet_reports_ip | app_tcp_cross_node | app_tcp_same_node | app_health_same_node | activator_first_probe | activator_routes | qp_ready | first_byte | clock offset/RTT ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | bc-bun-turbopack | none | 10.0.1.169 | 10.244.0.48 | 20 | 206 | 219 | 954 | 1111 | 1592 | 9807 | 1619 | 1812 | 1962 | 9798 | 9894 | 9894 | 0.25/0.92 |
| 1 | bc-bun-cpu4 | none | 10.0.1.169 | 10.244.0.49 | 135 | 436 | 462 | 1608 | 1706 | 1991 | 10205 | 2080 | 2247 | 2367 | 10172 | 10266 | 10266 | 0.25/0.86 |
| 1 | bc-bun-rwfs | none | 10.0.1.169 | 10.244.0.50 | 23 | 105 | 121 | 540 | 684 | 832 | 9039 | 859 | 1428 | 1152 | 9050 | 9147 | 9147 | 0.23/0.93 |
| 2 | bc-bun-cpu4 | none | 10.0.1.169 | 10.244.0.51 | 24 | 108 | 116 | 871 | 980 | 1708 | 10342 | 1728 | 1757 | 2122 | 10210 | 10300 | 10300 | 0.26/0.97 |
| 2 | bc-bun-rwfs | none | 10.0.1.118 | 10.244.0.213 | 18 | 75 | 84 | 910 | 1068 | 2045 | 2056 | 2075 | 2123 |  | 2127 | 2093 | 2202 | 0.12/0.65 |
| 2 | bc-bun-turbopack | none | 10.0.1.169 | 10.244.0.52 | 21 | 80 | 94 | 1002 | 1155 | 2099 | 10722 | 3411 | 2152 | 2706 | 10575 | 10696 | 10696 | 0.25/0.89 |
| 3 | bc-bun-rwfs | none | 10.0.1.169 | 10.244.0.53 | 21 | 93 | 105 | 535 | 688 | 1300 | 9934 | 1326 | 1380 | 1635 | 9883 | 9980 | 9980 | 0.22/0.94 |
| 3 | bc-bun-turbopack | none | 10.0.1.169 | 10.244.0.54 | 22 | 109 | 115 | 1263 | 1396 | 1502 | 9925 | 1524 | 2112 | 1812 | 9974 | 10030 | 10057 | 0.26/0.91 |
| 3 | bc-bun-cpu4 | none | 10.0.1.169 | 10.244.0.55 | 24 | 124 | 140 | 875 | 981 | 2018 | 10648 | 2040 | 2072 | 2339 | 10584 | 10679 | 10679 | 0.27/0.94 |
| 4 | bc-bun-turbopack | none | 10.0.1.169 | 10.244.0.56 | 23 | 168 | 253 | 1265 | 1417 | 2102 | 10518 | 2126 | 2154 | 2412 | 10436 | 10546 | 10546 | 0.27/0.9 |
| 4 | bc-bun-cpu4 | none | 10.0.1.118 | 10.244.0.214 | 24 | 110 | 123 | 839 | 940 | 1704 | 1715 | 1852 | 1842 |  | 1719 | 1734 | 1834 | 0.13/0.63 |
| 4 | bc-bun-rwfs | none | 10.0.1.169 | 10.244.0.57 | 22 | 156 | 159 | 980 | 1128 | 1854 | 10277 | 1888 | 1906 | 2163 | 10328 | 10384 | 10388 | 0.28/0.92 |
| 5 | bc-bun-cpu4 | none | 10.0.1.169 | 10.244.0.58 | 26 | 399 | 469 | 1045 | 1142 | 2041 | 10471 | 2060 | 2229 | 2327 | 10413 | 10518 | 10518 | 0.27/0.92 |
| 5 | bc-bun-rwfs | none | 10.0.1.169 | 10.244.0.59 | 23 | 106 | 203 | 537 | 682 | 1109 | 9328 | 1132 | 1426 | 1412 | 9478 | 9635 | 9635 | 0.27/0.88 |
| 5 | bc-bun-turbopack | none | 10.0.1.169 | 10.244.0.60 | 21 | 299 | 404 | 1296 | 1449 | 1877 | 10090 | 1899 | 2189 | 2213 | 10004 | 10060 | 10064 | 0.27/0.96 |
| 6 | bc-bun-rwfs | none | 10.0.1.169 | 10.244.0.61 | 22 | 121 | 160 | 995 | 1111 | 1704 | 9912 | 1727 | 1820 | 2026 | 9829 | 9905 | 9910 | 0.26/0.91 |
| 6 | bc-bun-turbopack | none | 10.0.1.118 | 10.244.0.215 | 17 | 120 | 138 | 872 | 999 | 1687 | 1698 | 1709 | 1783 |  | 1780 | 1811 | 1845 | 0.11/0.67 |
| 6 | bc-bun-cpu4 | none | 10.0.1.169 | 10.244.0.62 | 26 | 1016 | 1039 | 1309 | 1415 | 1898 | 9897 | 2032 | 1980 | 2210 | 9901 | 10002 | 10002 | 0.27/0.92 |
| 7 | bc-bun-turbopack | none | 10.0.1.169 | 10.244.0.63 | 26 | 126 | 139 | 1344 | 1459 | 2303 | 10718 | 2325 | 2365 | 2653 | 10801 | 10866 | 10870 | 0.25/0.95 |
| 7 | bc-bun-cpu4 | none | 10.0.1.169 | 10.244.0.64 | 34 | 244 | 250 | 1388 | 1500 | 2503 | 10715 | 2526 | 3328 | 2821 | 10642 | 10742 | 10742 | 0.25/0.98 |
| 7 | bc-bun-rwfs | none | 10.0.1.169 | 10.244.0.65 | 28 | 153 | 166 | 584 | 736 | 839 | 9263 | 860 | 1477 | 1206 | 9316 | 9385 | 9389 | 0.25/0.9 |
| 8 | bc-bun-rwfs | none | 10.0.1.169 | 10.244.0.66 | 27 | 116 | 127 | 562 | 726 | 1390 | 9812 | 1490 | 1529 | 1718 | 9814 | 9936 | 9939 | 0.25/0.91 |
| 8 | bc-bun-turbopack | none | 10.0.1.169 | 10.244.0.67 | 20 | 95 | 107 | 1278 | 1421 | 1699 | 1706 | 1828 | 2156 | 2077 | 2169 | 2185 | 2303 | 0.26/0.92 |
| 9 | bc-bun-rwfs | none | 10.0.1.169 | 10.244.0.68 | 24 | 114 | 126 | 744 | 892 | 1786 | 10210 | 1809 | 1844 | 2190 | 10110 | 10251 | 10251 | 0.22/0.87 |
| 9 | bc-bun-turbopack | none | 10.0.1.169 | 10.244.0.69 | 23 | 196 | 208 | 942 | 1080 | 1522 | 10166 | 1569 | 1782 | 1854 | 10069 | 10174 | 10174 | 0.26/0.97 |
| 9 | bc-bun-cpu4 | none | 10.0.1.169 | 10.244.0.70 | 22 | 140 | 230 | 1886 | 1996 | 3045 | 11676 | 3072 | 3101 | 3388 | 11561 | 11654 | 11654 | 0.24/0.95 |
