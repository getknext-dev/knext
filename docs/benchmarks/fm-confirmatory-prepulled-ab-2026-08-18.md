# Confirmatory pre-pulled A/B: fm-vinext (warm entry) vs fm-node — 24 samples (2026-08-18)

**Sitting:** `fm-prepulled-20260818T195748Z` — 6 ABBA blocks, 24 samples, **zero lost**, same-app
gate green on every sample. Both digests **pre-pulled and pinned on both nodes** (DaemonSets), PG
held warm. This is the confirmation run the n=5/6 sitting called for.

## Result

| | n | median | IQR | range |
|---|---|---|---|---|
| **fm-vinext** (bytecode, warm entry) | 12 | **2635 ms** | [2285, 5390] | 2080–7530 |
| **fm-node** (webpack, compile cache) | 12 | **3685 ms** | [3598, 3793] | 3450–4410 |

- median difference **−1050 ms (vinext faster)**; Hodges-Lehmann **−1090 ms**
- Mann-Whitney U=48, z=−1.386, **p=0.166**; pooled **distribution separation: NO**

## The structure that matters

vinext is **bimodal**; node is tight:

- vinext **fast mode, 8/12**: `2080 2140 2240 2300 2410 2530 2740 3100` — median **2355 ms**, and its
  **maximum (3100) is below node's minimum (3450)**. On the fast mode, the arms **separate fully**.
- vinext **slow mode, 4/12**: `5350 5510 5680 7530`.

Per ADR-0036 D6/D7 a bare median across a mode mixture is inadmissible, so the claim is stratified:
**when the routing path is clean, vinext + bytecode with the warm entry beats the node arm on every
sample, with full separation (8 vs 12 samples, ~1.3 s at the median).** The pooled test does not
reach significance because of the slow mode, which is attributed below — to the platform, not the
runtime.

## Slow-mode attribution (follow-up probing, same day)

- **Not image pull** — both digests pinned on both nodes for the whole sitting.
- **Not the app** — slow and fast samples show identical boot logs (`LISTENING` ~0.7 s,
  `WARMED` ~430 ms after start).
- **Reproduced under direct probing only when the request lands during the previous pod's
  termination window**: probes whose `t0` fell inside a Terminating/SKS-transition window stalled to
  5.5–6.0 s in the routing layer before any new pod work began; probes against a genuinely
  scaled-to-zero service completed in 2.3–2.7 s consistently (4/4). The mechanism is the
  activator/endpoints transition around scale-to-zero — a Knative-layer stall, arm-independent in
  principle, though this sitting happened to charge it to the vinext arm 4 times and node 0.

## Two hypotheses falsified on the way (kept because falsifications decay fastest)

- **"Boot is disk-bound" — WRONG.** Page-cache prewarm (pin pods faulting the binary) changed
  nothing: `WARMED` 407–430 ms before and after. The ~430 ms is **CPU-bound app-graph evaluation**
  on OKE vCPUs (the same evaluation takes 104–133 ms on an M-series laptop).
- **"The slow mode is harness revision-churn" — WRONG.** It reproduced under direct probing with no
  harness and no revision minting.

## Current cold-start budget (fresh cold start, direct measurement)

| phase | ms |
|---|---|
| activator wake → pod created | ≤ 1000 |
| pod created → container started | ~1000 |
| container start → LISTENING | ~700 |
| app-graph warm (overlapped) | (430, hidden) |
| first render + egress | ~900 |
| **total observed** | **2317–2748 ms external** |

Remaining levers, in order of expected value: the scale-down **transition stall** (Knative
config/version; `scale-down-delay` masks it at the cost of idle pods), the **~2 s
schedule+start** floor (infra), and warming `/` instead of `/api/health` (converts the first user's
page-cache MISS into a HIT; untested on-cluster).

## Raw samples (ms)

```
fm-vinext: 2530 5350 3100 2080 5510 5680 7530 2240 2300 2740 2140 2410
fm-node:   4300 3670 3890 3590 3760 4410 3450 3600 3710 3580 3700 3640
```

## Addendum — warm path `/` (same day, sitting `fm-warmroot-…`)

`KNEXT_WARM_PATH=/` (renders the page and pre-fills the Redis page cache at startup, so the first
user's request is a HIT): 3 cold samples → **2160, 2130, 5860 ms**. The two clean samples sit at the
fast end of the confirmatory fast mode (2080–3100); the third is the platform-transition stall again,
which this change was never going to touch. n=2 clean samples is not a claim — recorded as *likely
helpful, kept deployed* (it is also strictly more representative: the warm now exercises the same
path a user hits first). Cross-sitting pooling deliberately not done (D5).

## Addendum 2 — the platform-side iteration (2026-08-19)

**CPU request: falsified as a lever ON THIS CLUSTER, and the finding is bigger than the lever.** The
container had `resources: {}`; granting it a real request was the obvious fix for the CPU-bound
430 ms evaluation. It cannot schedule: the two nodes are at **98% and 83% of allocatable CPU
requested** (limits 432%/388%) with only 1830m allocatable each — a 1-CPU request left the revision
unschedulable/starved and was reverted. Consequence: the ~430 ms evaluation and part of the
~700 ms start→LISTEN are **contention on undersized shared test nodes**, not app properties — the
same evaluation takes ~110 ms on a laptop core. On production-sized nodes this term shrinks toward
that. The cluster, not the runtime, is the current floor.

**`autoscaling.knative.dev/scale-down-delay: 5m` — applied and PROVED.** Pods stay routable 5 min
after last traffic: measured 3.5 min idle → pod still up → **646 ms** response (vs 2.1–2.7 s cold).
This (a) gives every request within 5 min of the previous one a warm hit with **no cold start at
all**, and (b) removes the scale-down transition window — the attributed slow mode — for that entire
traffic class, while still reaching zero afterwards. This is the right default posture for the
product's bursty target users, and it is a one-annotation change.

**Where sub-second stands.** For traffic within the delay window: **achieved (~0.6 s)**. From a true
zero on THIS cluster: not reachable — the remaining budget is ~2 s of Knative wake/schedule/start on
oversubscribed 2-vCPU nodes plus contention-inflated boot. The next real levers are node sizing and
Knative-version work, both platform decisions, not code.
