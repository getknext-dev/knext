# ARP primer (runtime fix) — OKE A/B, affected vs healthy node (2026-10-01)

**Question.** Does sending one best-effort outbound UDP datagram from INSIDE the knext runtime
itself, at process start — rather than from a separate init container
(`arp-primer-oke-partial-ab-2026-10-01.md`, PR #1762) — clear the same node-local blackhole on
`10.0.1.169`, and does it cost anything on the healthy node `10.0.1.118`?

**Answer.** Yes, and no.

- **`10.0.1.169` (affected):** baseline median **10168 ms** (n = 11) vs primer-on median
  **2410 ms** (n = 12). Difference **+7758 ms**, exact two-sided Mann-Whitney **p = 1.04e-05**,
  bootstrap 95% CI of the difference of medians **[+7140, +8034] ms**.
- **`10.0.1.118` (healthy):** baseline median **1900 ms** (n = 11) vs primer-on median
  **1911 ms** (n = 11). Difference **-12 ms**, p = 0.699, 95% CI **[-474, +236] ms** — no
  measurable overhead.

This confirms the mechanism identified in `cold-start-phase-breakdown-2026-10-01.md` and the
partial operator-side result in `arp-primer-oke-partial-ab-2026-10-01.md`, now from the runtime
fix shipped in this PR (#1760): `packages/kn-next/src/adapters/arp-primer.cjs`, required as the
supervisor's (`node-server.ts`) own first action and baked in as the first preload of the
compiled standalone-on-Bun executable (`standalone-compile.mjs`).

## What ran

- **Cluster:** OKE `knext-oke` (context `knext-oke-sa`), namespace `bench-cells`. The apiserver
  was flaky throughout this sitting (intermittent `i/o timeout` / TLS handshake timeouts on both
  `kubectl` and the harness's own retries) — every command here was retried; no timeout was
  treated as a result.
- **Arms:** `bc-bun-turbopack` (baseline — unmodified image, no runtime fix) vs
  `bc-bun-turbopack-runtime-arp` (this PR's branch, `feat/1760-runtime-arp-primer`, built via
  Cloud Build + `docker buildx build --platform linux/amd64`, pushed to
  `ghcr.io/getknext-dev/bench-cells-bun-turbopack-runtime-arp@sha256:f6c937db7ba98834b18f2e33dc68527aedcb5298175dc5a486b710efa78a90a9`).
  Verified with `strings` on the compiled executable that the arp-primer code (the
  `knext-arp-primer` payload string, `parseDefaultGatewayFromRouteTable`,
  `primeArpNow`) is present and is the FIRST preload — ahead of
  `cache-control-normalize`/`bun-keepalive-guard`/`request-body-cap` — matching the source-order
  guards in `arp-primer-entry-order.test.ts`.
- **App:** same shape as the other `bc-*` bench cells (scaffolded via `knext create`, bun runtime,
  turbopack build, `force-dynamic` page + `/api/items` route, `/api/health`), built against this
  PR's packed `@getknext/core` (not the published npm package, since the fix is unreleased).
- **Node pinning:** each node's A/B was run with BOTH arms pinned to that node via a JSON patch
  (`op: add`, never `--type=merge`) adding `nodeSelector: {kubernetes.io/hostname: "<ip>"}`
  directly on each bench `ksvc`'s revision template — an out-of-band, bench-only change (ADR-0001:
  the operator's `buildDesiredKsvc` never touches `Affinity`/`NodeSelector`, so the patch survives
  operator reconciles without a CRD change). Verified after every patch and before every measured
  round: both ksvcs kept their full `env`/`resources`/`readinessProbe` (no merge-patch wipe) and
  carried the correct `nodeSelector`.
- **Driver:** `scripts/bench-cold-start-phases/drive.py`, interleaved AB/BA rotation, one wake per
  arm per round; harness `scripts/bench-cold-start-phases/cold-cycle.mjs` (in-cluster, timing
  unaffected by the workstation↔apiserver link). Both images pre-pulled onto both nodes before
  measuring (throwaway `--rm`-style pods; every measured wake's events read `already present on
  machine`).
- **Cleanup:** nodeSelector JSON-`remove`d from both ksvcs after each node's A/B; both ksvcs
  verified back to `Ready=True` with no `nodeSelector`. The four throwaway image-pull pods
  (`prepull-169-baseline`, `prepull-169-arp`, `prepull-118-baseline`, `prepull-118-arp`) are left
  on the cluster — `kubectl delete` is hook-blocked for this agent.

## Results

### `10.0.1.169` (affected node)

| phase | baseline median · IQR (n=11) | primer-on median · IQR (n=12) |
|---|---|---|
| 3 sandbox + containers start | 984 · 443 | 1164 · 187 |
| 4 runtime boot: first log → listening | 141 · 12 | 144 · 7 |
| 5 routable: listening → ready | **8652 · 399** | **921 · 365** |
| 6 forward + render: ready → first byte | 0 · 4 | 25 · 98 |
| **total: request → first byte** | **10168 · 773** | **2410 · 463** |
| 5y net: first log → TCP :3000 from the other node | 8754 · 386 | 946 · 506 |

Diff of medians (total) **+7758 ms**, exact Mann-Whitney **p = 1.04e-05**, bootstrap 95% CI
**[+7140, +8034] ms**. The effect lands entirely in phase 5 (routable), exactly as the mechanism
predicts — phases 1–4 and 6 are statistically indistinguishable between arms.

### `10.0.1.118` (healthy node)

| phase | baseline median · IQR (n=11) | primer-on median · IQR (n=11) |
|---|---|---|
| 3 sandbox + containers start | 713 · 461 | 769 · 204 |
| 4 runtime boot: first log → listening | 143 · 15 | 141 · 22 |
| 5 routable: listening → ready | 779 · 170 | 797 · 95 |
| 6 forward + render: ready → first byte | 98 · 45 | 100 · 44 |
| **total: request → first byte** | **1900 · 302** | **1911 · 493** |

Diff of medians (total) **-12 ms**, p = 0.699, 95% CI **[-474, +236] ms** — the primer's one extra
UDP send-and-forget is not observable in the total on a node with no blackhole.

All raw per-wake records (compacted: container log lines trimmed, every timing field, milestone
and clock offset kept) are in
[`data/arp-primer-runtime-oke-2026-10-01/`](data/arp-primer-runtime-oke-2026-10-01/)
(`node-169.jsonl`, `node-118.jsonl`). Reproduce the tables with `analyze.py` and the headline
numbers with `stats.py`, both in `scripts/bench-cold-start-phases/`.

## Relationship to the operator-side spike (PR #1762)

PR #1762's partial result (one node, n=5/6, stopped early) measured the SAME mechanism via an
init container: median **10234 → 2940 ms**, p = 0.0043. This sitting reaches full n≥10 on BOTH
nodes and lands a slightly larger effect (**10168 → 2410 ms** on `.169`) because the runtime fix
fires earlier — no container-create round trip — and needs no Knative feature flag
(`kubernetes.podspec-init-containers` / `-fieldref`) at all, unlike the init-container approach.
The two are not mutually exclusive; this PR does not change or depend on `spec.coldStart.arpPrimer`.

## Limitations

- Same caveats as the prior sittings: two nodes, one cluster, one app; images pre-pulled; cluster
  otherwise quiet (only this benchmark's pods in `bench-cells`).
- The apiserver's flakiness during this sitting lengthened both drives (several `kubectl exec`
  calls hit their 180s timeout and were retried) but did not corrupt any measured wake — every
  wake's `first_byte` is a client-socket timestamp from the in-cluster harness, never from a
  `kubectl` round trip.
