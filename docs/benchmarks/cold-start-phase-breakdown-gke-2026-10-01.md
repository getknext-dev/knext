# Scale-from-zero cold start, phase by phase, on GKE (2026-10-01)

**Question.** The 2026-10-01 OKE sitting
([`cold-start-phase-breakdown-2026-10-01.md`](cold-start-phase-breakdown-2026-10-01.md)) found a
~8.5 s node-local blackhole on one of OKE's two flannel-VXLAN nodes (a stale neighbour/ARP entry
for a recycled pod IP), fixed by a one-shot outbound packet — the mechanism PR #1762 turns into an
opt-in operator init container (`spec.coldStart.arpPrimer`). Founder direction (2026-10-01): does
the same stall exist on GKE's networking (VPC-native, GKE's own CNI), and if so, does the primer
help there too — or is it pure overhead on a CNI that never stalls?

**Answer.** **No, the OKE blackhole does not reproduce on GKE**, and that makes the primer **pure
overhead here**: Part 1 (n=11 per cell, 2 of 3 nodes organically exercised) showed every wake under
3.8 s with no bimodal split; Part 2's primer A/B (n=11 per arm, all 3 nodes, including the one
Part 1 missed) confirms it directly — the primer-OFF arm, which would show the blackhole if GKE had
it, stayed clean at 2.9–3.4 s on every wake. Turning the primer ON costs a real, statistically
unambiguous **+1052 ms median (+34.6%, p = 2.8e-6)**, almost entirely the init container's own
scheduling + run time (+798 ms in the sandbox/containers-start phase) — not a tradeoff against a
stall that isn't there. jev agrees at confidence 1.00: **keep `spec.coldStart.arpPrimer`
default-off on GKE.** See [Part 1](#part-1--per-phase-breakdown) and
[Part 2](#part-2--arp-primer-ab) for the full numbers.

## Cluster

A new, dedicated cluster — not OKE, not the existing `knext-oke` — so the comparison is clean:

| | |
|---|---|
| Name | `knext-coldstart` |
| Project | `gsw-mcp` (the founder's GCP project) |
| Type | Zonal Standard, `us-central1-a` |
| Nodes | 3 × `e2-standard-4` (4 vCPU / 16 GB), Container-Optimized OS |
| Kubernetes | `v1.35.8-gke.1225000` (regular release channel) |
| Container runtime | `containerd://2.2.7` |
| Kernel | `6.12.94+` |
| Networking | VPC-native (`default` network/subnet), **Dataplane V2 is OFF** — `gcloud container clusters describe` returns no `datapathProvider` field at all (the cluster was left on GKE defaults, as directed; it did not opt into the Cilium-based advanced datapath) |
| Knative Serving | `1.16.0` + net-kourier `1.16.0` — the same version OKE runs ([`cold-start-phase-breakdown-2026-10-01.md`](cold-start-phase-breakdown-2026-10-01.md)'s Method section) and the version this repo's own kind/CI harness pins (`scripts/kind-manifests/apply-knative-kourier.sh`, `operator-e2e-nightly.yml`). The operator's `go.mod` pins the **client library** at `knative.dev/serving v0.48.0`; that Go module version has no corresponding GitHub Release (no release assets for the pre-1.0 `v0.x` tag series upstream), while `serving.knative.dev/v1` (Service/Revision/Configuration/Route) has been API-stable across that whole range, so the live-cluster version and the client-library version do not need to match for this measurement. Flagging the discrepancy rather than silently picking one. |
| knext operator (Part 1) | `operator-latest` release install.yaml (2026-09-29), the documented one-line install (`docs/QUICKSTART.md`) — no operator release is tagged literally `v1.0.0-rc.3`; this is the closest documented, reproducible install path and immediately pre-dates the rc.3 cut |
| knext operator (Part 2) | built from PR #1762's head (`922745b3a84389d74f3f526de786d140ec3c9a55`) via Cloud Build + `docker buildx build` (the classic builder drops `cmd/` — a real `.dockerignore` re-inclusion-order bug, confirmed by reading `packages/kn-next-operator/.dockerignore`), pushed to `us-central1-docker.pkg.dev/gsw-mcp/knative-next-repo/kn-next-operator@sha256:11314187b7a9948b8a6efe196d4ae12d0478cc9ff8f4d0e634486e7aeebfecc1` |
| Feature flags | `kubernetes.podspec-init-containers: enabled`, `kubernetes.podspec-nodeselector: enabled` (both set on `config-features` in `knative-serving`, per the founder's instruction — this cluster is disposable) |
| `service/kourier` | patched to `ClusterIP` immediately after install (was provisioned `LoadBalancer`; GKE does NOT silently reroute this the way the OCI drill saw — it will actually provision and bill a real Network LB if left alone) |
| Left running | yes, per instruction — **not deleted**. See [Cost](#cost-and-cleanup). |

Cert-manager `v1.16.2` installed first (an operator-install prerequisite, same version
`docs/QUICKSTART.md` documents). GHCR bench images (`bench-cells-bun-turbopack`,
`bench-cells-node-turbopack`) are **not public** (`visibility: internal` on the GitHub org), so an
`imagePullSecret` (`ghcr-bench`, built from `gh auth token`, never printed/logged) was created in
the `bench-cells` namespace only.

## Part 1 — per-phase breakdown

**Subject.** The same 2026-09-30 release-cell images as the OKE sitting, same digests, deployed as
`NextApp` CRs from the unmodified
[`nextapps.yaml`](../../scripts/bench-cold-start-phases/nextapps.yaml): `bc-bun-turbopack` (the
default cell) and `bc-node-turbopack`. Images pre-pulled on **every** node before measuring, via a
throwaway `DaemonSet` per image (not committed — a two-line `kubectl apply`/`delete` step, see
Reproduction).

**Instrument.** [`scripts/bench-cold-start-phases/`](../../scripts/bench-cold-start-phases/)'s
existing in-cluster harness (`cold-cycle.mjs`, `drive.py`, `analyze.py`, `stats.py`), **reused
unmodified** except for the one thing that is cluster-specific: OKE's node *names* were the node's
own internal IP (`10.0.1.118`/`10.0.1.169`); GKE's node names are opaque
(`gke-knext-coldstart-default-pool-<hash>-<suffix>`). The GKE-specific copies live in
[`scripts/bench-cold-start-phases/gke/`](../../scripts/bench-cold-start-phases/gke/):
`cold-cycle.mjs` (the `AGENT_PODS` node-name→pod map, extended from 2 to 3 nodes),
`node-agents.yaml` / `harness-rbac.yaml` (3 agent + 3 clock pods, one per real node, instead of 2),
`drive.py` (kubectl context `knext-coldstart`, not `knext-oke-sa`). `analyze.py`/`stats.py` needed
no changes (they are cell/node-generic).

**Interleaving.** 11 rounds, both arms woken once per round, alternating order (A B, B A); 22
wakes, 22 valid (0 excluded), every response HTTP 200 with the `items:50` marker. 2026-10-01
07:2x–07:5x UTC. **All 22 wakes landed on only 2 of the cluster's 3 nodes** (`…c8bn` and `…fm3s`,
11 each split 5/6 and 6/5) — the scheduler never placed a Part 1 wake on `…1ws1`, which also hosts
`net-kourier-controller`, the Knative `autoscaler`, and one knext-operator replica (so it already
carried a slightly higher allocated-resources score going into every scheduling decision). Part 2
later did land on `…1ws1` (see below), so the gap is scheduler preference under this specific
load, not an unschedulable node.

### Bun × turbopack (the default cell), pooled (n=11) and by node

| phase | pooled median · IQR | on `…c8bn` (n=5) | on `…fm3s` (n=6) |
|---|---|---|---|
| 1 activation: request → Pod object | 205 · 30 | 204 · 42 | 218 · 22 |
| 2 scheduling: Pod → bound to a node | 58 · 25 | 58 · 18 | 57 · 26 |
| 3 sandbox + containers start: bound → first container log line | 755 · 60 | 730 · 34 | 786 · 24 |
| 4 runtime boot: first log → Next listening on :3000 | 220 · 15 | 213 · 11 | 227 · 35 |
| 5 routable: listening → ready | 1456 · 223 | 1272 · 170 | 1487 · 48 |
| 6 forward + render: ready → first byte | 192 · 65 | 174 · 97 | 236 · 63 |
| **total: request → first byte** | **2900** · 381 | **2675** · 105 | **3035** · 67 |
| 5z app: listening → first `/api/health` 200 (same node, direct) | 1320 · 215 | 1184 · 56 | 1364 · 79 |

### Node × turbopack, pooled (n=11) and by node

| phase | pooled median · IQR | on `…c8bn` (n=6) | on `…fm3s` (n=5) |
|---|---|---|---|
| 1 activation: request → Pod object | 241 · 48 | 257 · 23 | 223 · 41 |
| 2 scheduling: Pod → bound to a node | 59 · 27 | 68 · 26 | 54 · 24 |
| 3 sandbox + containers start: bound → first container log line | 852 · 69 | 829 · 37 | 885 · 31 |
| 4 runtime boot: first log → Next listening on :3000 | 550 · 41 | 537 · 15 | 575 · 36 |
| 5 routable: listening → ready | 1740 · 278 | 1652 · 36 | 1929 · 119 |
| 6 forward + render: ready → first byte | 58 · 42 | 53 · 17 | 64 · 84 |
| **total: request → first byte** | **3502** · 345 | **3375** · 134 | **3710** · 175 |
| 5z app: listening → first `/api/health` 200 (same node, direct) | 1450 · 367 | 1286 · 291 | 1534 · 212 |

All values ms. Raw per-wake records: [`data/cold-start-phase-breakdown-gke-2026-10-01/part1.jsonl`](data/cold-start-phase-breakdown-gke-2026-10-01/part1.jsonl).

**Reading it.**

- **No bimodal split by node, unlike OKE.** OKE's two nodes split 10x apart (2.3–2.9 s vs 9.4–11 s
  medians); GKE's two measured nodes differ by only ~360–675 ms (`…c8bn` faster than `…fm3s` on
  both cells) — ordinary node-to-node variance, not a step function. **No wake exceeded 3.8 s** —
  no stall of OKE's magnitude appears anywhere in Part 1 (see the stall verdict under
  [Part 2](#part-2--arp-primer-ab), which checks this more directly with the primer).
- **Bun is faster end to end, by a real margin.** Total request→first-byte: bun 2900 ms vs node
  3502 ms (−601 ms, exact Mann-Whitney p = 2.8e-6, bootstrap 95% CI of the difference
  [−951, −372]). Two phases carry it: runtime boot (phase 4, −330 ms, p = 2.8e-6, CI
  [−355, −307] — Bun's compiled-executable boot advantage, same direction as OKE's 182 ms
  finding but roughly 1.8× larger here) and phase 5 (−283 ms, p = 2.8e-6, CI [−532, −174]).
  Phase 5's app-answers-health sub-leg alone is **not** significantly different between runtimes
  here (p = 0.22), so phase 5's gap is not cleanly attributable to one mechanism from this data —
  stated rather than forced to a single cause.
- **Phase 5 (listening → ready) runs noticeably longer on GKE than on OKE's healthy node**: 1456 ms
  (bun) / 1740 ms (node) here vs 827 / 858 ms there — roughly 1.6–2× — and the app's own
  `/api/health` leg inside it is the biggest piece (1320 / 1450 ms here vs ~737–744 ms on OKE).
  This cluster's phase 5 is slower in absolute terms than OKE's, even though neither shows OKE's
  blackhole; see the [GKE vs OKE comparison](#gke-vs-oke-healthy-node) table.
- **Phases 1–3 are close to OKE's**, node-to-node variance aside; nothing here points at a
  GKE-specific control-plane or sandbox-start slowdown.

## Part 2 — ARP-primer A/B

**Subject.** Two `NextApp`s from the same `bc-bun-turbopack` image
([`nextapps-primer.yaml`](../../scripts/bench-cold-start-phases/gke/nextapps-primer.yaml)):
`bc-bun-primer-off` (`spec.coldStart.arpPrimer: false`) and `bc-bun-primer-on`
(`spec.coldStart.arpPrimer: true`), deployed under the PR #1762 operator build above. The CRD was
updated in place first (`packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml`
from the PR branch — purely additive, applied server-side, does not disturb Part 1's already-running
NextApps), then the operator Deployment's image was swapped with a **JSON patch** on
`/spec/template/spec/containers/0/image` only (never a `--type=merge` on a container spec — that
silently drops env/probes).

**Interleaving.** 11 rounds, alternating order, 22 wakes, 22 valid (0 excluded), every response
HTTP 200. 2026-10-01 08:0x–08:3x UTC. Both arms landed on both `…1ws1` and `…fm3s` (`…c8bn` never
got picked this time — scheduler variance, not a fixed assignment); `…1ws1` — unused in Part 1 — is
covered here (off n=5, on n=6).

| phase | off (n=11) | on (n=11) | diff (on − off) |
|---|---|---|---|
| 1 activation: request → Pod object | 204 | 207 | +3, n.s. |
| 2 scheduling: Pod → bound to a node | 55 | 46 | −9, n.s. |
| **3 sandbox + containers start: bound → first container log line** | **794** | **1592** | **+798, p = 2.8e-6, CI [+539, +932]** |
| 4 runtime boot: first log → Next listening | 236 | 250 | +14, p = 0.44 (n.s.) |
| 5 routable: listening → ready | 1560 | 1642 | +82, p = 0.013, CI [−1, +264] (borderline) |
| 6 forward + render: ready → first byte | 229 | 254 | +25, n.s. |
| **total: request → first byte** | **3042** | **4093** | **+1052, p = 2.8e-6, CI [+702, +1163]** |

p = exact two-sided Mann-Whitney; CI = bootstrap 95% CI of the difference of medians, 4000
resamples. Raw per-wake records:
[`data/cold-start-phase-breakdown-gke-2026-10-01/primer-ab.jsonl`](data/cold-start-phase-breakdown-gke-2026-10-01/primer-ab.jsonl)
(both arms, interleaved, one file — matching `drive.py`'s output).

**Does the stall exist on GKE?** **No, on neither arm.** The primer-OFF arm — the one that would
reproduce OKE's blackhole if this CNI had the same stale-neighbour behavior — had every wake land
at 2946–3406 ms, including the 5 wakes on `…1ws1` (never exercised in Part 1). The primer-ON arm's
*slowest* wake (4456 ms) is still nowhere near OKE's ~8.5–11 s blackholed wakes; its slowness is
accounted for entirely by phase 3 (the init container's own run time), not by any
listening-but-unreachable period. **So: if no GKE node stalls, the primer is pure overhead here —
exactly the question the founder's instructions anticipated, and that is the honest result.**

**Primer overhead on healthy wakes.** **+1052 ms median (+34.6%) total, p = 2.8e-6**, concentrated
almost entirely in phase 3 (+798 ms, p = 2.8e-6) — scheduling and running the init container
sequentially before `user-container` starts, even with its image (`busybox:1.36.1-uclibc`)
pre-pulled on every node beforehand (so this is scheduling + init-container-lifecycle cost, not an
image pull). Phase 4 (runtime boot) is unaffected (p = 0.44) — the init container does not slow the
app's own startup once it runs. Phase 5 shows a small, borderline-significant uptick (+82 ms,
p = 0.013, but its CI spans close to zero) that is not clearly attributable to the primer from this
data alone. **Method note:** the `kubelet_reports_ip` milestone (an EXTRA row, not shown in the
table above) goes *negative* relative to `ctr_first_log` on the primer-on arm — an artifact of the
milestone definition, not a real negative duration: `ctr_first_log` is "first log line from EITHER
container," and the init container precedes `user-container`, so adding an init container shifts
what counts as "first log" earlier relative to when the pod IP becomes visible. Harmless for the
comparisons above (none of them cross that boundary), flagged so it is not mistaken for a bug.

**jev recommendation (default on/off).** Asked jev to pick between `default-on` and `default-off`
for `spec.coldStart.arpPrimer` on GKE-style (VPC-native, no Dataplane V2) clusters, given this
sitting's numbers (stall-free on both arms; +1052 ms / +34.6% median overhead, p = 2.8e-6):

**`default-off`, confidence 1.00** (`default-off: 1.00`, `default-on: 0.00`) — jev is a calibrated
gut-check here, not the sole decider, but the result matches the data directly: a lever with a
large, statistically unambiguous cost and no measured benefit on this cluster should not be
default-on. **Recommendation: keep `spec.coldStart.arpPrimer` default-off (nil/false) on GKE**,
consistent with PR #1762's own existing default (opt-in, off unless set). This sitting gives no
reason to change that default, and a reason (the overhead) to keep it exactly as PR #1762 already
has it. Whether OKE's own default should flip to on is a separate question this sitting does not
answer — that cluster DID show the blackhole, so its cost/benefit tradeoff is different and belongs
to a sitting that measures it directly (the OKE doc this one complements did not run the primer
A/B; only the manual exec-based E1 treatment).

## GKE vs OKE (healthy node)

| phase (ms, median) | OKE (bun×turbopack, healthy node, n=5) | GKE (bun×turbopack, pooled, n=11) |
|---|---|---|
| 1 activation: request → Pod object | 78 | 205 |
| 2 scheduling: Pod → bound to a node | 16 | 58 |
| 3 sandbox + containers start | 809 | 755 |
| 4 runtime boot: first log → listening | 152 | 220 |
| 5 routable: listening → ready | 827 | 1456 |
| 6 forward + render | 73 | 192 |
| **total** | **2257** | **2900** |

GKE's total is ~640 ms (28%) slower than OKE's healthy node, almost entirely from phase 5 (+629 ms)
with phases 1 and 6 each a bit slower too (+127 / +119 ms); phases 2–4 are close. **No GKE node
showed anything resembling OKE's ~8.5 s blackhole** — see the stall verdict below, which is the
more direct test of that question (both arms, both measured nodes, two separate parts of this
sitting). Read this table as "GKE is somewhat slower per-phase on this one measurement," not as
"GKE has a defect OKE doesn't" — OKE's own healthy-node n here is 5, GKE's phase-5 IQR is wide
(223 ms), and this is one sitting on each cluster, not a standing benchmark.

## Method

Same milestones, clocks and statistics as the OKE sitting (median, IQR by the lower-half/upper-half
method; exact two-sided Mann-Whitney + Holm correction when comparing arms; bootstrap 95% CI of the
median difference, 4000 resamples) — see that doc's [Method](cold-start-phase-breakdown-2026-10-01.md#method)
section for the full milestone table; not re-derived here.

## Limitations

- **One cluster, one sitting.** GKE's control-plane and networking behavior can vary by release
  and region; this is one measurement, not a standing guarantee.
- **No node shell**, same as the OKE sitting — if GKE *does* show a stall, its root cause is
  inferred from the same signature (cross-node/host-namespace unreachability clearing on the pod's
  first outbound packet), not observed directly (no `ip neigh` capture).
- **n per node is small** when split three ways; see the per-node table for exact n.
- Cluster left running past this sitting (per instruction) means later measurements on
  `knext-coldstart` are not from a pristine, freshly-created cluster.

## Cost and cleanup

**Not deleted**, per the founder's instruction (`gcloud container clusters delete` is the
founder's call). Left running: the `knext-coldstart` cluster (3 nodes), everything installed on it
(cert-manager, Knative Serving + net-kourier, the knext operator — now on the PR #1762 build —
and the `bench-cells` namespace's NextApps/harness pods/DaemonSets), the pushed operator image in
`us-central1-docker.pkg.dev/gsw-mcp/knative-next-repo`, and the `ghcr-bench` pull secret.

**Estimated cost**, public on-demand list pricing for `us-central1` (not fetched live — Cloud
Billing Catalog API is not enabled on this project — so treat as an approximation, not an invoice):

| item | rate | this cluster |
|---|---|---|
| 3 × `e2-standard-4` compute | ≈ $0.134/vCPU-hr-equivalent → ≈ $0.134/hr each | ≈ $0.40/hr |
| 3 × 100 GB `pd-balanced` boot disks | ≈ $0.10/GB-month | ≈ $0.04/hr |
| GKE zonal Standard cluster management fee | $0.10/hr (one zonal cluster/billing account/month is free) | $0–0.10/hr, depending on whether that free allowance is already used elsewhere on this billing account |
| **Total** | | **≈ $0.44–0.54/hr** (≈ $320–390/month if left running) |

No billed load balancer: `service/kourier` was patched from `LoadBalancer` to `ClusterIP`
immediately after install (confirmed via `kubectl get svc -n kourier-system kourier
-o jsonpath='{.spec.type}'` → `ClusterIP`), so GKE never provisioned a forwarding rule for it.

## Raw data and reproduction

Raw per-wake records: [`data/cold-start-phase-breakdown-gke-2026-10-01/`](data/cold-start-phase-breakdown-gke-2026-10-01/)
(`part1.jsonl`, `primer-ab.jsonl` — both primer arms, interleaved, one file matching `drive.py`'s
output format).

```bash
# Cluster + Knative + operator install (abbreviated; see this doc's Cluster section for versions)
gcloud container clusters create knext-coldstart --project gsw-mcp --zone us-central1-a \
  --num-nodes 3 --machine-type e2-standard-4 --release-channel regular
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl apply -f <knative-v1.16.0 serving-crds.yaml / serving-core.yaml / net-kourier kourier.yaml>
kubectl -n knative-serving patch configmap config-network --type=merge \
  -p '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
kubectl -n knative-serving patch configmap config-features --type=merge \
  -p '{"data":{"kubernetes.podspec-init-containers":"enabled","kubernetes.podspec-nodeselector":"enabled"}}'
kubectl apply --server-side -f https://github.com/getknext-dev/knext/releases/download/operator-latest/install.yaml

# Part 1
kubectl apply -f scripts/bench-cold-start-phases/nextapps.yaml
kubectl apply -f scripts/bench-cold-start-phases/gke/harness-rbac.yaml
kubectl apply -f scripts/bench-cold-start-phases/gke/node-agents.yaml
cd scripts/bench-cold-start-phases/gke && python3 drive.py 11 bc-bun-turbopack,bc-node-turbopack part1.jsonl

# Part 2 (after building+pushing the PR #1762 operator image and patching the CRD + operator image)
kubectl apply -f scripts/bench-cold-start-phases/gke/nextapps-primer.yaml
cd scripts/bench-cold-start-phases/gke && python3 drive.py 11 bc-bun-primer-off,bc-bun-primer-on primer-ab.jsonl
```
