# Node vs Bun cold start, standalone target, knext 1.3.1 on OKE (2026-10-13)

**Question** (founder). On the latest release, is the Bun bytecode single executable faster to cold
start than Node?

**Answer: no measurable difference. It's a tie.** Both arms were built from the same 1.3.1
scaffold, both are standalone × turbopack, and both were deployed through the operator. A true cold
wake (zero pods → first response byte) has a median of **1706 ms on Node** and **1674 ms on Bun**.
The IQRs overlap. The Hodges-Lehmann shift (Node − Bun) is **+18 ms, 95% CI [−170, +213]**, with
Mann-Whitney p = 0.81. Every one of the 44 wakes returned 200 with the rendered page, and none was
excluded.

Bun *does* boot its server faster: from the container's first log line to Next listening it takes
**149 ms against Node's 331 ms**, with p ≈ 1e-12 and non-overlapping IQRs. That ~180 ms saving does
not show in the total. The phases on either side of it, sandbox/container start and becoming
routable, are several times larger and vary by hundreds of ms from wake to wake, which hides it.

| arm | n | median | IQR [Q1, Q3] | p95 | min – max | median on .118 (n) | median on .169 (n) |
|---|---:|---:|---|---:|---|---|---|
| **A: Node** (`runtime: 'node'`, baked V8 compile cache) | 22 | **1706 ms** | 291 [1573, 1864] | 2153 | 1438 – 2240 | 1573 (11) | 1715 (11) |
| **B: Bun** (`runtime: 'bun'`, compiled bytecode executable) | 22 | **1674 ms** | 465 [1521, 1986] | 2384 | 1045 – 2568 | 1593 (11) | 1856 (11) |

**Verdict rule.** Quartiles use the lower-half/upper-half method. Two arms differ only when their
IQRs do not overlap. Here they overlap almost entirely: [1573, 1864] against [1521, 1986]. A jev
gut-check on "do these measurements show a difference" gave P(yes) = 0.30.

## Phase breakdown (median ms [Q1, Q3], n = 22 per arm)

Produced by `scripts/bench-cold-start-phases/analyze.py` from the committed data, with the activator
and autoscaler logs joined. Rows 5x–5w overlap the numbered phases and do not add up.

| phase | Node | Bun | Node − Bun (bootstrap 95% CI, MW p) |
|---|---:|---:|---|
| 0 autoscaler decides 0→1 (inside phase 1) | 22 [20, 28] | 22 [21, 26] | — |
| 1 activation: request → Pod object | 97 [71, 142] | 100 [79, 137] | −4 [−36, +38], p = 0.79 |
| 2 scheduling: Pod → bound | 12 [8, 17] | 12 [8, 20] | — |
| 3 sandbox + containers start: bound → first log line | 562 [536, 661] | 841 [434, 903] | −279 [−349, +112], p = 0.40 |
| **4 runtime boot: first log → Next listening** | **331 [320, 349]** | **149 [141, 158]** | **+182 [+171, +195], p ≈ 1e-12** |
| 5 routable: listening → ready | 557 [524, 610] | 678 [457, 883] | −121 [−258, +95], p = 0.45 |
| 6 forward + render: ready → first byte | 45 [7, 106] | 47 [5, 101] | −2 [−71, +50], p = 0.82 |
| **total: request → first byte** | **1706 [1573, 1864]** | **1674 [1521, 1986]** | HL +18 [−170, +213], p = 0.81 |
| 5x kubelet status lag: first log → pod IP in API | 489 [284, 814] | 792 [483, 956] | |
| 5w activator: first log → pod marked healthy | 836 [821, 903] | 794 [524, 925] | |

Per-node tables are in `data/…/phases.md`.

**Phase caveat.** Phase 4 is the only sub-phase where the two runtimes are measured the same way:
both supervisors start, then Next prints its `Ready in` banner. Phases 3 and 5 depend on which line
each image writes first and on when the kubelet publishes the pod IP. On this flannel cluster, pod-IP
publication swings by hundreds of ms per wake (the 5x row). That swing, not the runtime, is where the
variance in both totals comes from. Compare the **totals** across runtimes, plus phase 4.

## How it compares with earlier sittings

| sitting | cluster | Bun arm | Node arm | verdict |
|---|---|---|---|---|
| **this one, 2026-10-13** (1.3.1, Next 16.3.8, n = 22/22) | OKE | standalone+Bun **1674** [1521, 1986] | standalone+Node **1706** [1573, 1864] | **tie** |
| rc.6, 2026-10-07 (n = 22) | OKE | standalone+Bun 1907 [1547, 2406] | — (no Node cell) | (vinext vs standalone tie) |
| Node 24 follow-up, 2026-10-12 (n = 22) | OKE | standalone+Bun 1627 [1210, 2004] | Node 22 1957 [1583, 2113], Node 24 1829 [1633, 2055] | tie |
| release cells, 2026-09-30 (n = 10) | OKE | Bun × turbopack 2167 [1831, 2290] | Node × turbopack 2140.5 [2084, 2186] | tie |
| GKE e2-standard-4, 2026-10-01 (n = 11) | GKE | Bun × turbopack 2998 | Node × turbopack 3733 | **Bun −734 ms** (Holm p = 0.0015) |

- **Against rc.6 (standalone+Bun 1907 ms):** today's Bun arm is 233 ms lower at the median, but the
  IQRs overlap ([1521, 1986] vs [1547, 2406]), so by the rule it is a tie. It is also a different
  app build, release and session.
- **Against GKE 2026-10-01 (Bun about 0.73 s faster):** that gap does not reproduce on OKE. The GKE
  report already put it down to the CPU: on GKE's `e2` nodes Node's boot was slow enough (~590 ms
  to `listen` vs Bun's ~230 ms) to dominate. On a faster `c3` node the same pair differed by only
  94 ms. OKE's E4.Flex (AMD EPYC) nodes behave like the faster case. Node's boot leg here is
  331 ms, Bun's 149 ms. That 182 ms gap is real, but it is small next to the ~1.3 s of
  Kubernetes/network time around it.
- **Consistency with 2026-10-12:** that sitting also found standalone+Bun a few hundred ms lower than
  Node without IQR separation (Bun − Node 24 HL −246 ms, CI [−445, +36]). Today's HL is +18 ms. Taken
  together, the two sittings give no stable sign of a Bun lead at n = 22.

**Bottom line for the founder's question:** on OKE, with the shipped 1.3.1 defaults, Bun does not
cold-start measurably faster than Node. Its server binds ~0.18 s sooner, but that saving is inside
the noise of pod start and routing. A claim of "Bun is faster at cold start" is supported only on
slow-CPU nodes, and only by the GKE `e2` measurement.

## What was measured

**Versions.**

| item | value |
|---|---|
| knext | `@getknext/core` / `@getknext/lib` / `@getknext/db` **1.3.1** (npm `latest`), `knext create` from `npx -p @getknext/core@1.3.1` |
| Next / React | `next` **16.3.8** (the scaffold's pin), `react` / `react-dom` 19.3.0 |
| Bun | **1.4.2** on the builder (compiles the executable); runtime base `oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f` (the 1.3.1 template's pin) |
| Node | builder `node:22-bookworm` (v22.23.3); runtime base `node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` (the 1.3.1 template's pin) |
| operator | `ghcr.io/getknext-dev/kn-next-operator:v0.1.0@sha256:3b35d33efcd68ef2799bf740452c0ad42d5ab20e42cef2b7dfeee65e518e29b9` (same as 2026-10-12) |
| cluster | OKE `knext-oke` (context `knext-oke-sa`), k8s v1.34.10, CRI-O 1.34.8, flannel, 2 × VM.Standard.E4.Flex (4 vCPU, 16 GB, amd64), Knative Serving 1.16.0 + Kourier, `config-autoscaler` without overrides |

**Images** (amd64 only, digest-pinned; built on Cloud Build `649bb2bd-80be-471e-9763-458793e8fd33`,
`E2_HIGHCPU_8`, then copied by digest from Artifact Registry to GHCR with `crane copy`, with
identical digests on both sides):

| arm | image | digest | compressed size | build evidence |
|---|---|---|---:|---|
| A Node | `ghcr.io/getknext-dev/bench131-n131` | `sha256:c127c08d2e866df628b21ff07c0371d60b7acef3ba897a2938f20461a1ef42f5` | 89 MB | target `standalone-node`, `compile cache baked: 1352888 bytes in 470 file(s)` |
| B Bun | `ghcr.io/getknext-dev/bench131-b131` | `sha256:f6954acebc8a936fb68298510a0aa724b336fd04baec77e604b9e45316b8bcc2` | 133 MB | target `standalone-bun`, `Standalone executable compiled (bytecode verified)` |

**App: one source, two arms.** A fresh `knext create app --runtime node --builder turbopack --cache
none --storage none --yes` from 1.3.1. The defaults were kept, React Compiler on included. One
realistic page was added, the same shape as the 2026-09-30 release cells: `src/app/page.tsx` is
`force-dynamic` and renders 50 rows after one `fetch` (`cache: 'no-store'`) to the app's own
`/api/items` route over loopback. There is no database, Redis or object storage. Bench-only config
deltas are identical across arms and match the rc.6 / 10-12 sittings: `maxScale: 1`,
`containerConcurrency: 100`, `imagePrewarm: true`, `imagePullSecrets`, and the scaffold's
`scaleDownDelay` removed so that each arm returns to zero. The arms differ **only** in `name` and
`runtime` (`node` | `bun`). One `npm ci` from one lockfile fed both `knext build` runs on the same
builder. The page, route, config and Cloud Build scripts are in `data/…/app/` and `data/…/recipe/`.

**Deploy through the product path.** `knext deploy --image <ghcr ref>@sha256:… --context knext-oke-sa
-n bench-131-20261013` (the 1.3.1 CLI) applies only a `NextApp` CR, and the operator reconciled the
Knative Services. Reading the Knative Services back shows identical autoscaling annotations
(`min-scale 0`, `max-scale 1`), `containerConcurrency 100`, resources (requests 250m / 512Mi,
limits 1 CPU / 1Gi), readiness probe (`GET /api/health :3000`) and env names. The one spec
difference is the operator's own: the Bun arm gets `command: ["bun", "run", "server.js"]`, a
supervisor that spawns the compiled executable. A `ps` in the running Bun pod showed
`/app/.next/standalone/knext-standalone-exec` as the server process.

**True cold, no pull.** Each round waits until **both** arms have zero pods, then 10 s, then wakes
each arm once. The order alternates (AB, BA, …), so neither arm always goes first. Each wake was a
new pod. All 44 cycles' pod events read `already present on machine`: the operator's `imagePrewarm`
DaemonSets held both images on both nodes, so **no wake includes an image pull**. Node placement was
not pinned, and came out at exactly 11/11 per node for each arm.

**Instrument.** This is the tracked in-cluster phase harness `scripts/bench-cold-start-phases`
(`cold-cycle.mjs`, run in a `phase-bench` pod; clock and agent pods on each node), unchanged apart
from taking its namespace from `NS`. It ran in its own namespace, `bench-131-20261013`, with its own
copy of the harness RBAC and pods. t = 0 is the request on the wire to
`http://<arm>.bench-131-20261013.svc.cluster.local/` (Kourier → activator → pod). The total is the
first response byte. Every response was checked for HTTP 200 and the `items:50` marker.

**Queue of one.** Before the sitting, a census found no other benchmark on the cluster. Every other
knext app was at zero pods, and the existing harness pods in other namespaces were idle `sleep`
processes. The sitting ran 2026-10-13 13:54–14:37 UTC: 22 rounds and 44 wakes, all valid.

**Round count.** The brief asked for n ≥ 7. jev preferred 7 (P = 0.71) at low confidence (0.56).
22 was chosen so the numbers compare directly with the rc.6 and 10-12 sittings (both n = 22). The
first 7 rounds alone gave the same verdict: Node 1701 vs Bun 1690, IQRs overlapping.

## Limits

1. **One cluster, one app, one sitting.** At n = 22, the IQRs here (291 and 465 ms) resolve shifts of
   roughly 200–300 ms. A runtime difference smaller than that, such as the ~180 ms boot gain, cannot
   show in the total on this cluster.
2. **Comparisons with earlier sittings are loose.** Each used a different app build, release and
   session. The rc.6 app source no longer exists.
3. **No warm-request, memory or image-pull measurement.** The Bun image is 44 MB larger compressed
   (133 vs 89 MB). This sitting pre-pulled both images, so a pull-inclusive cold start (first wake on
   a fresh node) was not measured and would likely favour Node.
4. **No node-journal split** of phase 3 (sandbox vs container start). The journal reader pods are
   not available, as on rc.6 and 10-12.

## Observed while measuring (not a cold-start effect)

Both 1.3.1 images log a level-40 warning at startup: `@getknext/lib/clients is not present in this
runtime image: DB-pool drain (writer + read-only) and optimized-image-cache sync are DISABLED`. On
the Node image the underlying error is `Cannot find package '@getknext/lib' imported from
/app/node_modules/@getknext/core/dist/adapters/node-server.js`. This app uses neither a database nor
object storage, so neither number above is affected. But it means the shipped standalone images
carry no working DB-pool drain or image-cache sync, the symptom an earlier, now-closed tech-debt item
described. Flagged for triage, not investigated here.

## Leftovers

Agents cannot run `kubectl delete` (it is hook-gated), so nothing was deleted. **For the founder to
delete** (all created by this sitting):

- namespace `bench-131-20261013`, which holds the `NextApp`s `n131` and `b131` (both at zero app pods;
  their `*-imgcache` pre-pull DaemonSets run one small pod per node until removed), the harness pods
  `phase-bench`, `clock-118`, `clock-169`, `agent-118`, `agent-169` (`phase-bench` exits on its
  own after 48 h), the harness `ServiceAccount`/`Role`/`RoleBinding`, and the copied `ghcr-bench`
  pull secret.
- images `ghcr.io/getknext-dev/bench131-{n131,b131}:b131-20261013` and Artifact Registry
  `gsw-mcp/knative-next-repo/bench131-{n131,b131}:649bb2bd-…`.

## Files (`data/oke-node-vs-bun-standalone-1.3.1-2026-10-13/`)

- `run.jsonl`: the 44 harness rows, trimmed by `compact.py`. Every timing field, event and clock
  offset is kept; `analyze.py` and `report.py` reproduce `phases.md` and `report.txt` byte-for-byte
  from it.
- `activator.jsonl`, `autoscaler.jsonl`: control-plane logs for this namespace. The autoscaler log
  is cut to its `PA scale` lines, the only ones the analysis reads.
- `report.py` / `report.txt`: per-arm medians, quartiles, all samples by round, HL shift and the IQR
  verdict.
- `phases.md`: the per-phase tables, overall and per node.
- `drive.out`, `run-start.txt`, `run-end.txt`: the driver log and sitting window.
- `images.txt`, `recipe/` (Cloud Build config, scripts, version and bytecode evidence), and `app/`
  (the bench page, route and config).

Reproduce: `NS=bench-131-20261013 python3 scripts/bench-cold-start-phases/analyze.py <data>/run.jsonl
--by-node --activator=<data>/activator.jsonl --autoscaler=<data>/autoscaler.jsonl` and
`python3 <data>/report.py <data>/run.jsonl`.

## Raw samples (wake → first byte, ms; node, wake start UTC)

| round | A: Node | B: Bun |
|---:|---|---|
| 1 | 1711 (.169, 13:55:37) | 1710 (.118, 13:55:59) |
| 2 | 1936 (.118, 13:57:52) | 1244 (.169, 13:57:47) |
| 3 | 2153 (.169, 13:59:45) | 1554 (.118, 13:59:54) |
| 4 | 1457 (.118, 14:01:57) | 2384 (.169, 14:01:45) |
| 5 | 1701 (.169, 14:03:58) | 1129 (.118, 14:04:06) |
| 6 | 1585 (.118, 14:06:02) | 1690 (.169, 14:05:56) |
| 7 | 1657 (.169, 14:07:51) | 2275 (.118, 14:07:58) |
| 8 | 2075 (.118, 14:10:04) | 2207 (.169, 14:09:50) |
| 9 | 2240 (.169, 14:11:53) | 1650 (.118, 14:12:00) |
| 10 | 1520 (.118, 14:13:55) | 1448 (.169, 14:13:49) |
| 11 | 1764 (.169, 14:15:44) | 1593 (.118, 14:15:50) |
| 12 | 1529 (.118, 14:17:44) | 1737 (.169, 14:17:37) |
| 13 | 1618 (.169, 14:19:32) | 1045 (.118, 14:19:39) |
| 14 | 1928 (.118, 14:21:30) | 1288 (.169, 14:21:24) |
| 15 | 1615 (.169, 14:23:22) | 1541 (.118, 14:23:29) |
| 16 | 1567 (.118, 14:25:23) | 2568 (.169, 14:25:17) |
| 17 | 1864 (.169, 14:27:13) | 1658 (.118, 14:27:29) |
| 18 | 1863 (.118, 14:29:30) | 2067 (.169, 14:29:18) |
| 19 | 1715 (.169, 14:31:19) | 1521 (.118, 14:31:26) |
| 20 | 1573 (.118, 14:33:20) | 1856 (.169, 14:33:13) |
| 21 | 1754 (.169, 14:35:08) | 1957 (.118, 14:35:14) |
| 22 | 1438 (.118, 14:37:11) | 1986 (.169, 14:37:05) |
