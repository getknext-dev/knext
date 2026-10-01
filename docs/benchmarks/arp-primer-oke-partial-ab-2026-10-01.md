# ARP primer opt-in — partial OKE A/B (2026-10-01, stopped early)

> **Status: PARTIAL, stopped early.** Founder direction moved cold-start testing to GKE;
> this OKE run was stopped mid-sitting before reaching the planned n≥10 per arm per node. The
> numbers below are real, collected data — not projected — but the sample is small (n=5/6,
> one node only) and the GKE run is the one to cite going forward.

## What ran

- **Cluster:** OKE `knext-oke` (context `knext-oke-sa`), namespace `bench-cells`.
- **Operator image under test:** built via Cloud Build (`docker buildx build`, never local
  docker — the stock `gcr.io/cloud-builders/docker` classic builder has a `.dockerignore`
  directory-pruning bug that silently drops `cmd/` entirely; `buildx` does not have it),
  pushed by digest via `crane copy` to `ghcr.io/getknext-dev/kn-next-operator`.
- **Arms:** `bc-bun-turbopack` (`spec.coldStart.arpPrimer` unset = off) vs
  `bc-bun-turbopack-arp` (`spec.coldStart.arpPrimer: true`), both pinned to node `10.0.1.169`
  (the affected node per `cold-start-phase-breakdown-2026-10-01.md`) via a JSON patch
  (`op: add`, never `merge`) adding `nodeSelector: {kubernetes.io/hostname: "10.0.1.169"}`
  directly onto each bench `ksvc`'s revision template — **an out-of-band, bench-only change**
  (ADR-0001: the operator's `buildDesiredKsvc` never touches `Affinity`/`NodeSelector`, so the
  patch survives operator reconciles without a CRD change). Verified after every patch and
  before every measured wake: the serving revision still had its full `env`/`resources`/
  `readinessProbe` (no merge-patch wipe) and the `nodeSelector` was present.
- **Driver:** `scripts/bench-cold-start-phases/drive.py` (from PR #1763), interleaved AB/BA
  rotation, one wake per arm per round.
- **Cluster feature flags enabled by the lead for this test (reverted by the lead afterward,
  not by this agent):** `kubernetes.podspec-init-containers`,
  `kubernetes.podspec-nodeselector`.

## A live-cluster finding that changed the init container's design

The first reconcile attempt on OKE was rejected by Knative's admission webhook:
`must not set the field(s): spec.template.spec.containers[0].env[0].valueFrom.fieldRef`.
Knative gates **any** env `valueFrom.fieldRef` — not just init containers — behind its own,
separately-disabled-by-default feature flag (`kubernetes.podspec-fieldref`), distinct from
`kubernetes.podspec-init-containers`. The init container's original design used
`valueFrom.fieldRef: status.hostIP` (Downward API) to learn its target; that is a THIRD
cluster precondition nothing in this spike actually needs. Fixed by resolving the default
gateway **inside the container at runtime** via `ip route show default` instead (confirmed
working on the live cluster's busybox image) — this removes a feature-flag dependency rather
than adding one. See PR #1762 for the code change, tests and mutation-proof.

## Results (partial — stopped before n=10)

| arm | node | n | median (ms) | range (ms) |
|---|---|---|---|---|
| off (`bc-bun-turbopack`) | 10.0.1.169 | 5 | 10234 | 9537 – 11156 |
| on (`bc-bun-turbopack-arp`) | 10.0.1.169 | 6 | 2940 | 2461 – 3276 |

Exact two-sided Mann-Whitney **p = 0.0043**; difference of medians **+7295 ms**, bootstrap 95%
CI **[+6597, +8261] ms**. No overlap at all between the two samples at this n. This is
consistent with the earlier E1 finding in `cold-start-phase-breakdown-2026-10-01.md`
(9928 → 2379 ms, p = 0.007) and with the 2026-10-01 design study's headline number.

**Not collected (run stopped before this):** the .118 (healthy-node) overhead arm, and the
full n≥10 per cell the plan called for. Treat this as a strong directional confirmation, not
the final evidence — the GKE run is where the real n≥10×4-cell comparison belongs.

## `ip neigh` evidence (captured live, both arms)

Two read-only, hostNetwork-only pods on node `10.0.1.169` (`ip-neigh-169`, `ip-neigh-169-r2`
— see "Cleanup" below) ran `ip neigh show` once per second throughout. Full data:
[`data/arp-primer-oke-partial-2026-10-01/`](data/arp-primer-oke-partial-2026-10-01/)
(`ip-neigh-excerpt.txt` is the window below; `out-169.jsonl` is the raw per-wake driver
output).

**Off-arm wake** (pod IP `10.244.0.77`, wake started `06:36:53.964Z`, ready at `06:37:04`,
measured `first_byte` 9969 ms) — the *exact* Linux neighbour state machine, captured for the
first time (the original design study could not get node access for this):

```
06:36:50–53  STALE    lladdr 3e:9d:4b:f5:4c:63   (the PREVIOUS pod that held this IP)
06:36:55–00  DELAY    lladdr 3e:9d:4b:f5:4c:63   (delay_first_probe_time, 5s)
06:37:01–03  PROBE    lladdr 3e:9d:4b:f5:4c:63   (ucast_solicit x retrans_time, 3x1s — to the WRONG mac)
06:37:04     REACHABLE lladdr 7a:0b:53:b4:1e:49  (the NEW pod's real mac — resolved)
```

Request→ready (9969 ms) lands almost exactly on the `REACHABLE` transition.

**On-arm wake** (pod IP `10.244.0.78`, wake started `06:39:32.878Z`, measured `first_byte`
3267 ms) — the primer's outbound packet reaches the node fast enough that the entry is
already pointing at the correct mac by the time it is first observed, and the state machine
never re-probes the wrong address:

```
06:39:20–32  STALE    lladdr 5e:ba:78:ba:b5:1b   (the PREVIOUS pod)
06:39:34–38  DELAY    lladdr 7a:17:97:ae:4f:6f   (already the NEW/correct mac)
06:39:39     REACHABLE lladdr 7a:17:97:ae:4f:6f
```

No `PROBE` state at all — the stale-mac re-probe sequence the off-arm wake pays for is
entirely absent once the pod has sent its own packet.

## Cleanup (confirmed)

- Operator deployment **restored** to `ghcr.io/getknext-dev/kn-next-operator:v0.1.0@sha256:5c700909beaddaf08d96c2617a47b874b5c0a652409e3f36bfcfdd87fbde5e06`
  (the pre-spike digest) — rollout confirmed complete, both replicas `Running` on the restored
  image.
- `nodeSelector` JSON-patch-**removed** (never merge) from both `bc-bun-turbopack` and
  `bc-bun-turbopack-arp`; `bc-bun-turbopack-arp`'s rendered `initContainers` was also removed
  (its presence alone blocked any further patch once the feature flag reverted) and
  `spec.coldStart.arpPrimer` set back to `false` on its `NextApp`. Both `ksvc`s confirmed
  `Ready` and free of `nodeSelector`/`initContainers` afterward.
- `knative-serving/config-features` was **not** touched by this agent — the lead reverts the
  flags.
- Two `ip neigh` capture pods were created, bounded by `activeDeadlineSeconds`, never
  `kubectl delete`d (hook-blocked for this agent): **`ip-neigh-169`** (already `Completed`
  before this stop) and **`ip-neigh-169-r2`** (still `Running` at stop time, self-terminates
  on its own deadline — left to expire per instruction).

## Recommendation

Not finalized here — the partial OKE numbers (and the live `ip neigh` mechanism capture) are a
strong directional confirmation of the design study's hypothesis and the primer's effect size,
but the planned full A/B (n≥10 × 4 cells, including the .118 healthy-node overhead) did not
complete. Recommend carrying this data forward as supporting evidence into the GKE run rather
than drawing a final default-on/off call from it alone.

**jev scores** (`~/.claude/skills/jev`, gut-check not oracle):
- P(default `arpPrimer` to `true` on this partial evidence) = **0.11 (no)** — the sample is
  real but small, one node only, and depends on two feature flags most clusters have off.
- P(keep it opt-in/off-by-default pending the GKE run) = **0.81 (yes)**.

Both point the same way: `spec.coldStart.arpPrimer` stays opt-in, off-by-default, as shipped
in PR #1762 — this partial data is supporting evidence, not a basis for flipping the default.
