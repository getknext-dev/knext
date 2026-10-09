# Zone functions — chained cold start on kind (2026-10-09)

> **Spike, not for production.** Local kind only. Absolute numbers are inflated by Rosetta amd64
> emulation on an Apple-Silicon laptop; read the **differences between arms**, not the
> milliseconds. Absolute numbers come from OKE in Z10.

**Question.** When a knext zone calls a scale-to-zero Go or Rust Connect function, what does the
chain cost in each warm/cold combination; does waking the function when the zone wakes
("wake-ahead") remove the chained cold start; and should zone→function traffic default to h2c or
HTTP/1.1 (Q11), given that Bun's HTTP/2 client was unverified (connect-es#1275)?

**Answer.**

1. **A cold function costs ~1.4 s on top of whatever the zone costs.** Behind a warm zone it adds
   **1.40–1.47 s** for all four gateway × language pairs (95% CIs within ±50 ms). This is the case
   the system designer flagged. Retention coupling does not help a function that was never called.
2. **Chained cold (cold zone → cold function) is ~3.5–3.7 s at the median**, against **2.3 s (Node
   zone) / 3.0–3.1 s (Bun zone)** for a cold zone calling a warm function. The cold function adds
   **1.2–1.4 s on a Node zone and 0.5–0.6 s on a Bun zone**. The Bun zone boots slower here, so
   less of the function's start is left exposed.
3. **Wake-ahead as built (fired from `instrumentation.ts` `register()`) does not remove the chain.**
   It fires only ~0.4 s (Node) or ~0.8 s (Bun) before the request reaches the handler, while the
   function needs ~1.4 s.
   - Node: no measurable effect.
   - Bun: the zone's call to the function drops from ~0.8 s to 0.07–0.4 s. End to end it improves
     by 0.42 s for Go (p 0.03, though the CI spans zero) and by nothing measurable for Rust. The residual against a warm function is
     0.2–0.6 s.
   - **To be worth its cost, Z9 has to fire earlier.** That means the runtime supervisor at process
     start, before Next boots.
4. **Retention coupling works as designed** once the function has been called: a cold Node zone
   meeting a retained function costs 2.28 s, the same as a cold zone + warm function.
5. **h2c vs HTTP/1.1: no latency difference** on the unary path, warm or cold. Warm deltas are
   ±1–2 ms, and no cold comparison is significant. **Bun's HTTP/2 client works** for connect-node
   unary calls, including through the activator on the cold path. It had 0 errors in the bench
   calls and in 1,600 concurrent burst calls, and its h2c tail under 20-way concurrency was equal
   to or better than its HTTP/1.1 tail.
6. **Go vs Rust: indistinguishable** on every cold shape. Cold-call deltas range from −277 to
   +91 ms, and none is significant. Rust's image is smaller: 1.3 MB vs 3.8 MB compressed.
7. **Discovered fact (filed as #2080): zone re-wake stalls.**
   - A **Node** zone woken again while its previous pod is still terminating holds the request for
     **~13–28 s**, though the new pod is Ready in ~2.8 s.
   - A rarer **~10 s** stall hit both runtimes (4 of 196 cold-zone samples).
   - Stalled samples are reported separately and are not pooled.

**Q11 recommendation: h2c by default, switchable per binding to HTTP/1.1.** jev scored this 0.53
(h2c-only 0.33, HTTP/1.1-switchable 0.09). Latency does not decide it. h2c wins because:
- it is the only transport that carries bidi streaming;
- it multiplexes under concurrency;
- Bun's client, which was the open risk, worked.

Keep the switch, because only **unary** calls were verified. Z10 must add a server-streaming case
over Bun before the default is final.

## Headline numbers

All values are medians in ms, pooled over transport. Cold cells have n = 14 and warm cells n = 28;
the bracketed n marks exceptions. Node C cells come from the settled supplement (§C).

| shape (end to end) | Node zone, Go | Node zone, Rust | Bun zone, Go | Bun zone, Rust |
|---|---:|---:|---:|---:|
| A warm zone → warm fn | 15 | 14 | 18 | 15 |
| B warm zone → cold fn | 1 483 | 1 464 | 1 449 | 1 412 |
| C cold zone → cold fn | 3 658 (12) | 3 497 (13) | 3 626 | 3 616 |
| D cold zone → warm fn | 2 302 | 2 271 | 2 994 (13) | 3 102 |
| E C + wake-ahead | 3 798 | 3 776 | 3 206 | 3 705 |
| R cold zone → retained fn (n = 7, HTTP/1.1) | 2 279 | | | |

The zone's own timing of the function call (median ms), which isolates the function hop:

| shape | Node/Go | Node/Rust | Bun/Go | Bun/Rust |
|---|---:|---:|---:|---:|
| A | 7 | 6 | 8 | 5 |
| B | 1 475 | 1 445 | 1 424 | 1 392 |
| C | 1 370 | 1 132 | 862 | 799 |
| D | 45 | 41 | 70 | 64 |
| E | 1 320 | 1 485 | 347 | 196 |

Deltas, end to end. Each cell gives Δ median, then the 95% bootstrap CI, then the Mann-Whitney p.

| delta | Node/Go | Node/Rust | Bun/Go | Bun/Rust |
|---|---|---|---|---|
| **B − A** cold fn behind a warm zone | **+1 468** [1 443, 1 500] 2e-7 | **+1 450** [1 427, 1 492] 2e-7 | **+1 431** [1 416, 1 455] 2e-7 | **+1 397** [1 388, 1 437] 2e-7 |
| **D − A** cold zone alone | +2 288 [2 242, 2 336] | +2 257 [2 245, 2 334] | +2 976 [2 944, 3 084] | +3 087 [2 908, 3 578] |
| **C − D** cold fn on top of a cold zone | **+1 356** [1 276, 1 457] 2e-4 | **+1 226** [1 018, 1 506] 2e-5 | **+632** [507, 1 169] 9e-5 | **+514** [40, 1 136] 0.008 |
| **E − C** wake-ahead effect | +140 [−435, 222] 0.55 | +280 [−25, 491] 0.09 | −420 [−1 061, 221] 0.03 | +89 [−882, 236] 0.24 |
| **E − D** wake-ahead residual vs a warm fn | +1 496 [939, 1 571] 1e-4 | +1 505 [1 401, 1 545] 1e-5 | +212 [−19, 858] 0.10 | +603 [−284, 890] 0.45 |

Every per-cell number, with IQRs, comes from the raw data, along with every transport, language and
gateway comparison: [`summary.md`](data/zone-functions-coldstart-kind-2026-10-09/summary.md). The
main run as recorded, before the §C replacement, is in
[`summary-main-run.md`](data/zone-functions-coldstart-kind-2026-10-09/summary-main-run.md).

### §C — Node zone, cold → cold

In the main run, 15 of the Node zone's 28 C samples hit the re-wake stall. These were every C
sample taken in a cycle right after another T1 cycle, plus the first cycle. The rotation put
exactly the h2c functions in those cycles, so the Node C cells were confounded with transport.

The Node C cells were therefore re-measured in a supplementary run. There, each sample waits for
the zone's previous pod to be fully gone
([`c-node-settled.jsonl`](data/zone-functions-coldstart-kind-2026-10-09/c-node-settled.jsonl),
`bench/run.ts … c-node-settled`). It took 7 samples per function. Three of the 28 still hit the
~10 s stall and are excluded.

| Node zone, C | n | e2e median | IQR | call median |
|---|---:|---:|---:|---:|
| Go, HTTP/1.1 | 5 | 3 636 | 3 604–3 671 | 1 308 |
| Go, h2c | 7 | 3 737 | 3 629–3 749 | 1 383 |
| Rust, HTTP/1.1 | 7 | 3 615 | 3 235–3 830 | 1 336 |
| Rust, h2c | 6 | 3 454 | 3 370–3 537 | 1 096 |

The main run's unstalled Node C samples, all HTTP/1.1, agree: a median of 3 691 ms (Go, n = 6) and
3 614 ms (Rust, n = 7).

## Wake-ahead: why it only half works

All times below are on the zone process clock (ms since the Next server process started) and are
medians of the E samples:

| zone | wake fired | request reached handler | overlap | wake answered | zone→fn call (Go / Rust) |
|---|---:|---:|---:|---:|---:|
| Node | 1 006 | 1 394 | **389** | 2 701 | 1 320 / 1 485 |
| Bun | 1 218 | 1 990 | **784** | 2 322 | 347 / 196 |

The function's cold start (~1.4 s, shape B) is longer than either overlap window, so the call
still waits for the remainder.
- On Node, the request arrives ~0.4 s after the wake. The wake's own activation is still in
  flight, and the measured effect is nil.
- On Bun, the window is twice as long, and the call shrinks to match.

`register()` runs late. By the time it fires, the supervisor has started, spawned the Next server,
and that server has loaded its instrumentation bundle. Moving the wake into the supervisor preload
(where the ARP primer already runs) would fire it about 1 s earlier on this setup. That would make
the overlap at least as long as the function's cold start.

**Predicted margin for Z9**, which its exit criterion asks for:
- Moving the wake to process start should take the chained cold start from about C toward about D.
  On kind that is up to **~1.3 s on a Node zone and ~0.5 s on a Bun zone**.
- The residual (E − D) should fall below ~0.2 s.

This is a prediction for Z9 to test, not a result.

## Transport (Q11)

Zone→fn call time, h2c minus HTTP/1.1, as medians in ms. The full table with CIs is in
`summary.md`.

| shape | Node/Go | Node/Rust | Bun/Go | Bun/Rust |
|---|---:|---:|---:|---:|
| A warm | +1 (p 0.08) | −1 | +1 | −1 (p 0.003) |
| B cold fn behind a warm zone | +30 | +61 | +20 | −5 |
| C cold → cold | +74 | −240 | +11 | +56 |
| D cold zone → warm fn | +17 (p 0.003) | +9 | +5 | +16 |

No cold comparison is significant. The one large E-shape difference (Node/Go, +603 ms, p 0.002)
comes from the wake-ahead race above, not from the transport. It does not repeat on Node/Rust
(−66 ms).

**Bun's HTTP/2 client.**
- Under Bun 1.4.2, connect-node's `createConnectTransport({ httpVersion: "2" })` made
  prior-knowledge h2c calls through Kourier and the activator, both warm and cold.
- For the port named `h2c`, the Go function reported `HTTP/2.0` at the container.
- In the robustness probe
  ([`burst.jsonl`](data/zone-functions-coldstart-kind-2026-10-09/burst.jsonl)), each zone ×
  function pair took 200 calls at 20-way concurrency, twice. **All 3 200 calls returned 200.**

| zone | fn | HTTP/1.1 p50 / p95 ms (two runs) | h2c p50 / p95 ms (two runs) |
|---|---|---|---|
| Node | Go | 71 / 164, 69 / 159 | 66 / 114, 65 / 105 |
| Node | Rust | 70 / 110, 71 / 109 | 65 / 115, 67 / 102 |
| Bun | Go | 170 / 450, 47 / 92 | 62 / 222, 28 / 61 |
| Bun | Rust | 62 / 85, 33 / 58 | 52 / 74, 24 / 34 |

What this does **not** cover:
- server-streaming and bidi over Bun's client;
- long-lived sessions across a function scale-down (GOAWAY handling);
- HTTP/2 session reuse after the function's pod is replaced.

Z10 should cover streaming over Bun.

## Discovered: zone re-wake stalls (#2080)

**Mode 1, Node only, deterministic.** This is a Node-runtime zone woken while its previous pod is
still terminating:

| zone runtime | old pod still terminating | old pod gone |
|---|---|---|
| Node | 29.3–29.9 s (4/4) | 2.3–2.4 s (4/4) |
| Bun | 2.7–2.9 s (2/2) | 2.8–2.9 s (2/2) |

([`stall-node.jsonl`](data/zone-functions-coldstart-kind-2026-10-09/stall-node.jsonl),
[`stall-bun.jsonl`](data/zone-functions-coldstart-kind-2026-10-09/stall-bun.jsonl).)

A trace from `stall-trace.ts` shows:
- the new pod is Ready at +2.8 s;
- the request is released at +29.5 s, the moment the **old** pod's `Ready` drops;
- the old Node pod stays `Ready=True` for ~30 s while terminating, whereas the Bun pod exits
  quickly.

Pod IPs were not reused, so this is not the stale-ARP failure mode. The functions never showed
it. It is a zone-runtime question, not a zone-function one.

**Mode 2, both runtimes, ~10 s, rare.** In 4 of 196 cold-zone samples (3 Node C settled, 1 Bun D),
the zone process had been up ~9.7–10.3 s before the request reached it, with no old pod present.
The cause is not identified. It sits in the same place, in front of a running zone, and is noted
on #2080.

Neither mode involves the function. Both inflate any "chain" number that does not separate them
out, which is why this report does.

## Method

**Cluster.**
- kind `knext-z2-coldstart`: one node, Kubernetes 1.33.1, containerd 2.1.1.
- Host: OrbStack 2.2.3 on an Apple M1 Pro, with 8 cores and 16 GiB given to the VM.
- Knative Serving 1.16.0 + Kourier (the repo's pinned manifests) and cert-manager 1.16.2.
- knext operator built from `main` at `f9ee96043`.
- `config-autoscaler`: `stable-window 10s`, `scale-to-zero-grace-period 10s`,
  `scale-to-zero-pod-retention-period 0s`. These only shorten how long a pod lingers before it is
  removed; they do not change how a cold start proceeds.
- Other kind clusters on the machine were stopped for the run. OrbStack's own Kubernetes was
  running and idle.
- The machine restarted once mid-session, between the pilot and the main run. The kind node came
  back on a new IP and was reattached at its original one before any measurement.

**Zone.**
- A minimal Next.js 16.3.8 app (turbopack) using `@getknext/core` from this tree.
- Built and deployed by `kn-next deploy` (the standalone target), once with `runtime: node`
  (Node 22.23.2) and once with `runtime: bun` (Bun 1.4.2).
- Images, linux/amd64 under Rosetta: `zone-node@sha256:53512045e293…` and
  `zone-bun@sha256:b79bd6568f04…`.
- Operator defaults: `max-scale 1`, requests 250m / 256 Mi, limit 1 CPU / 512 Mi.
- Every other zone is a clone of those two `NextApp` CRs, with the same digest and different env:
  - `zone-<rt>-d` for shape D;
  - one `zone-<rt>-wa-<fn>` per function, with `WAKE_AHEAD=1` and `BOUND_FUNCTIONS=<fn>`.
- The zone's `GET /api/chain?fn=…` route calls the function through a module-level connect-node
  client and returns its own timing. The client is `createConnectTransport` with JSON encoding,
  using `httpVersion "2"` for `-h2` functions and `"1.1"` otherwise.
- The app also has a Server Action that uses the same client; the bench does not drive it.

**Functions.**
- One unary `Ping` RPC (`NO_SIDE_EFFECTS`) per language:
  - connect-go v2.0.0 on `net/http`, serving HTTP/1.1 and unencrypted HTTP/2 on one listener;
  - connect-rust 0.9.1 + buffa 0.9.2 on its built-in hyper server.
- Both are static linux/amd64 binaries on an empty base image: Go 8.4 MB, Rust 2.8 MB.
- Each is deployed twice as a plain cluster-local Knative Service (the `BackendService` CRD is Z8):
  `-h1` with the container port named `http1`, and `-h2` with it named `h2c`.
- `max-scale 1`, requests 100m / 32 Mi, no CPU limit.

**Driver.**
- A `curlimages/curl` pod in the same namespace. Every timed value is `curl`'s own `time_total`
  (send to body complete) against the zone's cluster-local URL through Kourier.
- The orchestration (`bench/run.ts`) runs on the host and only reads pod state between requests.
- One request at a time; nothing else ran on the cluster during a measurement.

**Schedule.**
- A cycle starts when no non-terminating Knative pod exists in the namespace.
- It then takes several samples on disjoint (zone, function) pairs. Each sample's precondition is
  checked against pod counts and recorded.
  - T1: C(Node, f_a), A, B(Node, f_b), A, C(Bun, f_c), A, B(Bun, f_d), A, D(Node-d, f_a),
    D(Bun-d, f_c). B and D pre-warm the zone or function immediately before the sample.
  - T2: E on all four functions, with gateways alternating.
- The function assignment rotates every cycle, so each gateway × function gets every shape equally
  often.
- Cycles run as [T1, T1, T2] × 14: 336 samples, all preconditions held.
- Retention (R) and the settled Node C cells are separate runs with their own scripts.

**Statistics.**
- Medians and IQRs per cell.
- Each comparison is a difference of medians, with a seeded 5 000-resample bootstrap 95% CI and a
  two-sided Mann-Whitney p (normal approximation).
- There is no multiple-comparison correction, so read p as a screen, not a verdict.
- A cold-zone sample is classed as a stall when the zone had been up more than 5 s before the
  request reached its handler.

## Caveats (kind vs OKE)

- **Rosetta.** The zone images are amd64 and run emulated. So do the functions: they were built
  amd64 to match the zones and production (jev 0.79 over native arm64). JIT-heavy Node and Bun
  boots suffer more under Rosetta than a static binary does. That inflates D and C, and probably
  explains why the Bun zone boots slower than the Node zone here, the opposite of the GKE e2
  result.
- **One node.** Every pod lands on the same node. There is no cross-node hop, no image pull (every
  image was cached), and none of OKE's flannel/ARP behaviour.
- **The function's pod floor (~1.4 s here)** is the number to re-measure on OKE. The research
  estimate was 1.0–1.3 s.
- **Unary only**, JSON encoding, and a trivial payload.

## Reproduce

`spikes/zone-functions-coldstart/` holds everything:

| file | what it does |
|---|---|
| `cluster/up.sh` | cluster, Knative, operator and driver pod |
| `fn-go/build-image.sh`, `fn-rust/build-image.sh` | function images |
| `bench/stage-zone.sh` | `kn-next deploy` per runtime |
| `bench/deploy.ts` | functions and zone clones |
| `bench/run.ts` | the schedule; `c-node-settled` mode for §C |
| `bench/retention.ts` | shape R |
| `bench/burst.ts`, `bench/burst-all.sh` | the transport robustness probe |
| `bench/stall.ts`, `bench/stall-trace.ts` | the re-wake stall |
| `bench/analyze.ts` | the summaries |

Every script uses a private kubeconfig and refuses any context other than the kind cluster.

## jev calls

| question | pick | probabilities |
|---|---|---|
| Function image architecture | amd64 | amd64 0.79 · arm64 0.21 |
| Q11 transport default | h2c, switchable | h2c-switchable 0.53 · h2c-only 0.33 · HTTP/1.1-switchable 0.09 · HTTP/1.1-only 0.05 |
| What wake-ahead (register hook) does | removes part on one runtime, not the chain | partial 1.00 |
| What Z9 should change | fire earlier (supervisor at process start) | earlier 1.00 |
| Go vs Rust cold start | indistinguishable | same 1.00 |
| File the Node re-wake stall separately | yes | P = 0.86 |
