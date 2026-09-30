# Release cells — scale-from-zero cold start on OKE (2026-09-30)

**Question.** How long does the first request take when a knext app wakes from zero replicas, for
each of the four v1.0 release cells — Node × turbopack, Node × webpack, Bun × turbopack (the
default), Bun × webpack — and do the cells differ?

**Answer.** On this cluster and app, **all four cells cold-start in about 2.1–2.4 s at the median,
and none of the differences between them is distinguishable from noise** (every pairwise exact
Mann-Whitney p ≥ 0.05 before correction, ≥ 0.31 after Holm; every bootstrap 95% CI of a median
difference spans zero). The one real, consistent difference is on the **warm** path: the Node cells
answer a warm request in ~24 ms against ~31 ms for the Bun cells (in-cluster, same page;
p ≈ 1e-7) — about 7 ms per request, invisible next to a cold start.

| cell (runtime × builder) | n | cold median | IQR [Q1, Q3] | range | warm median |
|---|---|---|---|---|---|
| Node × turbopack | 10 | **2140.5 ms** | 102 ms [2084, 2186] | 2039–3511 | 23.5 ms |
| Node × webpack | 10 | **2425 ms** | 404 ms [2143, 2547] | 2061–10375 | 24 ms |
| Bun × turbopack (default) | 10 | **2167 ms** | 459 ms [1831, 2290] | 1770–2736 | 31 ms |
| Bun × webpack | 10 | **2056.5 ms** | 418 ms [1793, 2211] | 1674–3216 | 31 ms |

Quartiles use the lower-half/upper-half method (n = 10: Q1 is the median of the lowest five).
`cold` = `curl`'s own `time_total` for the first `GET /` after the arm reached zero pods — request
sent to response body complete. `warm` = the median of five `GET /` sent immediately afterwards to
the now-running pod, each also `time_total`.

## What was measured

**Cluster.** OKE `knext-oke` (kube context `knext-oke-sa`), Kubernetes 1.34.10, CRI-O 1.34.8,
**2 × VM.Standard.E4.Flex worker nodes (2 OCPU = 4 vCPU, 16 GB each, amd64)**, Knative Serving 1.16.0
with Kourier, knext operator `ghcr.io/getknext-dev/kn-next-operator:v0.1.0@sha256:5c700909beaddaf08d96c2617a47b874b5c0a652409e3f36bfcfdd87fbde5e06`. `config-autoscaler` carries no overrides
(Knative defaults: 60 s stable window, activator in the request path at low scale). The cluster was
otherwise quiet: a running-pod census taken right after the sitting found application pods only in
this benchmark's namespace (every other knext app was scaled to zero), and no other benchmark ran
(queue of one).

**App — one source, built four ways.** The default scaffold from the published CLI
(`npx -p @getknext/core@rc knext create` → `@getknext/core` / `@getknext/lib` **1.0.0-rc.2**,
`next` **16.3.5**), plus one realistic page: `src/app/page.tsx` is `force-dynamic` and renders a
50-row list after one `fetch` (`cache: 'no-store'`) to the app's own `/api/items` route handler over
loopback — so the measured request exercises SSR + a route handler + a data fetch without an
external dependency. No database, no Redis, no object storage (assets served from the image).
Bench-only config deltas, identical across the four cells: `maxScale: 1`, the scaffold's
`scaleDownDelay: "5m"` removed (so each arm returns to zero between rounds), and
`imagePullSecrets`. The four cells differ **only** in `runtime` (`node` | `bun`) and `build`
(`turbopack` | `webpack`, the latter with `"build": "next build --webpack"`), exactly as a user
would select them.

**Builds.** Google Cloud Build (`E2_HIGHCPU_8`, build `c0edaac6-2dd4-4f2e-a604-1997a40cd7c9`),
one job for all four: `npm install` once, then per cell `knext build` (Bun 1.4.2 on the builder for
the compile step) followed by the published `Dockerfile.standalone` template from the installed
`@getknext/core` with the target `knext deploy` selects (`standalone-node` with
`KNEXT_HEALTH_CHECK_PATH=/api/health` for the compile-cache bake; `standalone-bun` otherwise),
`--platform linux/amd64`. Build-log evidence per cell: the Bun cells logged `Standalone executable
compiled (bytecode verified)`; the Node cells logged `compile cache baked: 1562056 bytes in 534
file(s)` (turbopack) and `1544252 bytes in 485 file(s)` (webpack). Images were pushed to Artifact
Registry and copied **by digest** to GHCR with `crane copy` (digests identical on both sides). The
full recipe is in Appendix A.

| cell | image (GHCR, `getknext-dev`) | digest (single-platform, linux/amd64) | compressed size |
|---|---|---|---|
| Node × turbopack | `bench-cells-node-turbopack` | `sha256:c8d290ee1010d325112e9e214f26c52f12f76014e15321203eeb2040a1002d77` | 80 MB |
| Node × webpack | `bench-cells-node-webpack` | `sha256:ec7f07b3cb88e6c69e4910e6a115a943a80ba149f8c4a124b59e263bbaa1dced` | 79 MB |
| Bun × turbopack | `bench-cells-bun-turbopack` | `sha256:386c1c369a3a2f579af92165cabd0d9399f058415605bdf24ed44c9fdf778dcb` | 115 MB |
| Bun × webpack | `bench-cells-bun-webpack` | `sha256:327bcb2287b7de8aa583fde9ef2b01115451323ae1f8dc1a97fa90343b1a7928` | 116 MB |

**Deploy — through the product path.** Each cell deployed with
`knext deploy --context knext-oke-sa -n bench-cells --image <ghcr ref>@sha256:…`, which applies
only a `NextApp` CR; the operator reconciled the Knative Services. Read back from the resulting
Knative Services: identical autoscaling annotations (`min-scale 0`, `max-scale 1`), identical
resources (requests 250m CPU / 512Mi, limits 1 CPU / 1Gi — the knext defaults), identical readiness
probe (`GET /api/health`, operator defaults), identical env names. The one spec difference is the
operator's own: Bun cells get `command: ["bun", "run", "server.js"]` (the supervisor, which spawns
the compiled executable); Node cells use the image entrypoint.

**Image pre-pull.** Before the sitting every image was pulled onto **both** nodes (one throwaway
`--rm` pod per image per node), and every measured cycle's pod events read `already present on
machine` — **no cycle includes an image pull**.

**Instrument.** In-cluster: a `curlimages/curl:8.10.1` pod (`bench-timer`, node `10.0.1.118`) in
the same namespace sends the request to `http://<cell>.bench-cells.svc.cluster.local/` (the
cluster-local Kourier path → activator → pod). Timing is `curl`'s own `time_total`, taken inside the
pod, so the `kubectl exec` round trip that launches it is **not** inside the timed interval — the arm
is already at zero before `curl` starts, and `curl` itself triggers the wake. Every response was
checked for HTTP 200 and the rendered `items:50` marker (40/40 passed). Driver: Appendix B.

**Interleaving.** 10 rounds. Each round waits until **all four** arms have zero pods (then 10 s for
endpoints to settle), then wakes each arm once, in forward order (Node×turbopack, Node×webpack,
Bun×turbopack, Bun×webpack) on odd rounds and **reverse** order on even rounds — the four-arm form
of ABBA, so a drift across a round loads on no single cell. Sitting: 2026-09-30, 19:49–20:15 UTC.
40 attempted cold cycles, 40 valid, **none excluded**.

**Node placement.** No `NextApp` field pins a node, so placement was recorded, not controlled. The
scheduler alternated nodes by position in the round; because the order reverses every round, **each
cell landed on each node exactly 5 times out of 10**.

## Statistics

Pairwise, exact two-sided Mann-Whitney on the cold samples (n = 10 vs 10), Holm-corrected across
the six pairs, with a bootstrap 95% CI (4000 resamples) of the median difference:

| pair | median diff | p (exact) | p (Holm) | 95% CI of diff |
|---|---|---|---|---|
| Node×turbopack − Node×webpack | −284 ms | 0.225 | 0.900 | [−440, +68] |
| Node×turbopack − Bun×turbopack | −26 ms | 0.796 | 1.000 | [−221, +342] |
| Node×turbopack − Bun×webpack | +84 ms | 0.393 | 1.000 | [−164, +404] |
| Node×webpack − Bun×turbopack | +258 ms | 0.123 | 0.615 | [−89, +618] |
| Node×webpack − Bun×webpack | +368 ms | 0.052 | 0.315 | [−47, +720] |
| Bun×turbopack − Bun×webpack | +110 ms | 0.579 | 1.000 | [−299, +446] |

Pooled by factor (n = 20 vs 20, normal-approximation Mann-Whitney): **runtime** Node 2176 ms vs Bun
2151 ms (p = 0.088, CI of diff [−62, +453]); **builder** turbopack 2152 ms vs webpack 2187 ms
(p = 0.64).

**Verdict.** No cell, runtime or builder differs meaningfully in scale-from-zero cold start at this
n. The closest call — Node×webpack a median 368 ms slower than Bun×webpack, raw p = 0.052 — does
not survive correction for six comparisons, and its CI crosses zero. It is a lead worth re-measuring
with more cycles, not a finding. (jev gut-check on "do any cells differ meaningfully beyond noise":
P(yes) = 0.16.)

**Warm path.** The Node cells' warm median is 24 ms (range 20–27, n = 20) against 31 ms for the Bun
cells (range 26–33, n = 20); U = 3, p ≈ 1e-7. That is a real, consistent difference on this page —
its cause was not investigated here — and at ~7 ms it is
two orders of magnitude smaller than a cold start. (jev: P(real) = 0.93.)

## Where the ~2.1 s goes (coarse)

The instrument records the pod's `creationTimestamp`, the `user-container` `startedAt`, and the
pod's `Ready` condition, relative to the request's start. **Kubernetes stores these at 1-second
resolution**, so this is a coarse decomposition, stated as such:

| phase (median across all 40 cycles, ±1 s) | seconds after the request |
|---|---|
| pod object created (activator → autoscaler → scale 0→1) | 0 |
| container started (schedule + CRI-O create/start) | 1 |
| pod `Ready` (runtime boot + first readiness-probe pass) | 2 |
| response complete | 2.1 (measured, ms resolution) |

Identical medians for all four cells at this resolution — the split between runtime boot and first
render cannot be resolved below 1 s here. The `✓ Ready in 0ms` line in every pod's log reads 0 ms on
all 40 cycles, so it is **not** a usable boot-time measurement; it was recorded and is not used.

**The one tail cycle** (Node×webpack, round 10: 10 375 ms) is a readiness-probe miss, from its
events: the container started at +1 s, the queue-proxy readiness probe **timed out** at +3 s, and the
pod only went `Ready` at +13 s, on the next probe tick. It is kept in the data (it is a real cold
start a user could pay) and is why that cell's range and mean — not its median — stand out. The
Node×turbopack 3511 ms cycle (round 7) shows container start at +3 s instead of +1 s, i.e. slower
scheduling/container create, not a slower runtime.

## How this relates to earlier numbers

The user docs previously quoted "~3.4–3.6 s" for a cluster cold start. That figure came from an
earlier OKE cluster (since rebuilt) that was heavily loaded, a different app (the file-manager, with
Postgres/Redis dependencies), and a node-standalone vs vinext comparison. This sitting uses a
rebuilt, quiet cluster, the default scaffold with no data-plane dependencies, and the four v1.0
cells. **The two are not a like-for-like before/after**, and nothing here claims knext got faster —
the conditions changed. What the docs now state is this sitting's per-cell figure with its
conditions, plus the standing caveat that a cold start on a busier cluster, with a heavier app or an
image that must be pulled, will be slower.

## Limitations

- **One sitting, one app, one cluster.** n = 10 per cell resolves differences of roughly 400 ms+
  here; smaller effects (e.g. the 284–368 ms webpack-vs-other medians) are below what this sitting
  can separate. A second sitting would say whether the Node×webpack lead is real.
- **Light app.** No database, cache or object storage; a real app's first render adds its own
  dependency wake-ups (see the cold-start ledger for how large those can be).
- **Quiet 2-node cluster, images pre-pulled.** A cold start that must pull the image adds seconds
  (the image-caching docs measure it); a contended node adds scheduling delay.
- **1 s decomposition resolution** (above).
- **Timer placement.** `bench-timer` ran on `10.0.1.118`; every cell was measured 5 times from the
  same node and 5 times across nodes, so this is balanced, not eliminated.
- **Build id.** `knext deploy --image` stamps a fresh `buildId`/`NEXT_DEPLOYMENT_ID` on the CR that
  differs from the id baked at build time; identical across cells and irrelevant to the measured
  SSR request (all 40 bodies rendered), but noted.
- **CLI friction found in passing:** `knext deploy --image` still requires a lockfile in the app
  directory even though it builds nothing (worked around with `npm install --package-lock-only`).

## Per-cycle data (all 40 cycles, none excluded)

| round | order | cell | cold (ms) | warm median (ms) | node | pod created / container started / Ready (s after request, 1 s resolution) |
|---|---|---|---|---|---|---|
| 1 | fwd | node-turbopack | 2171 | 23 | 10.0.1.169 | 1 / 1 / 3 |
| 1 | fwd | node-webpack | 2181 | 25 | 10.0.1.118 | 0 / 1 / 2 |
| 1 | fwd | bun-turbopack | 2736 | 32 | 10.0.1.169 | 0 / 1 / 2 |
| 1 | fwd | bun-webpack | 2472 | 31 | 10.0.1.118 | 0 / 1 / 2 |
| 2 | rev | bun-webpack | 2211 | 27 | 10.0.1.169 | 0 / 1 / 2 |
| 2 | rev | bun-turbopack | 2290 | 30 | 10.0.1.118 | 0 / 1 / 2 |
| 2 | rev | node-webpack | 2538 | 24 | 10.0.1.169 | 0 / 1 / 2 |
| 2 | rev | node-turbopack | 2039 | 24 | 10.0.1.118 | 0 / 1 / 2 |
| 3 | fwd | node-turbopack | 2132 | 23 | 10.0.1.169 | 0 / 1 / 2 |
| 3 | fwd | node-webpack | 2063 | 22 | 10.0.1.118 | 0 / 0 / 2 |
| 3 | fwd | bun-turbopack | 1831 | 33 | 10.0.1.169 | 0 / 1 / 2 |
| 3 | fwd | bun-webpack | 1793 | 31 | 10.0.1.118 | 0 / 1 / 2 |
| 4 | rev | bun-webpack | 1842 | 31 | 10.0.1.169 | 0 / 1 / 2 |
| 4 | rev | bun-turbopack | 2028 | 28 | 10.0.1.118 | 0 / 0 / 1 |
| 4 | rev | node-webpack | 2589 | 24 | 10.0.1.169 | 0 / 1 / 2 |
| 4 | rev | node-turbopack | 2138 | 26 | 10.0.1.118 | 0 / 0 / 2 |
| 5 | fwd | node-turbopack | 2610 | 23 | 10.0.1.169 | 0 / 2 / 3 |
| 5 | fwd | node-webpack | 2511 | 26 | 10.0.1.118 | 0 / 1 / 2 |
| 5 | fwd | bun-turbopack | 2161 | 32 | 10.0.1.169 | 0 / 1 / 2 |
| 5 | fwd | bun-webpack | 2192 | 31 | 10.0.1.118 | 0 / 1 / 2 |
| 6 | rev | bun-webpack | 1972 | 31 | 10.0.1.169 | 0 / 1 / 2 |
| 6 | rev | bun-turbopack | 2533 | 29 | 10.0.1.118 | 0 / 1 / 2 |
| 6 | rev | node-webpack | 2143 | 21 | 10.0.1.169 | 0 / 1 / 2 |
| 6 | rev | node-turbopack | 2084 | 20 | 10.0.1.118 | 0 / 1 / 2 |
| 7 | fwd | node-turbopack | 3511 | 26 | 10.0.1.169 | 0 / 3 / 4 |
| 7 | fwd | node-webpack | 2547 | 24 | 10.0.1.118 | 0 / 2 / 3 |
| 7 | fwd | bun-turbopack | 2173 | 31 | 10.0.1.169 | 0 / 1 / 2 |
| 7 | fwd | bun-webpack | 1739 | 32 | 10.0.1.118 | 0 / 1 / 2 |
| 8 | rev | bun-webpack | 3216 | 30 | 10.0.1.169 | 0 / 2 / 3 |
| 8 | rev | bun-turbopack | 1798 | 31 | 10.0.1.118 | 0 / 0 / 1 |
| 8 | rev | node-webpack | 2339 | 25 | 10.0.1.169 | 0 / 1 / 2 |
| 8 | rev | node-turbopack | 2048 | 21 | 10.0.1.118 | 0 / 0 / 2 |
| 9 | fwd | node-turbopack | 2143 | 25 | 10.0.1.169 | 0 / 0 / 2 |
| 9 | fwd | node-webpack | 2061 | 24 | 10.0.1.118 | 0 / 1 / 2 |
| 9 | fwd | bun-turbopack | 2202 | 31 | 10.0.1.169 | 0 / 1 / 2 |
| 9 | fwd | bun-webpack | 1674 | 31 | 10.0.1.118 | 0 / 1 / 2 |
| 10 | rev | bun-webpack | 2141 | 26 | 10.0.1.169 | 0 / 1 / 2 |
| 10 | rev | bun-turbopack | 1770 | 31 | 10.0.1.118 | 0 / 1 / 2 |
| 10 | rev | node-webpack | 10375 | 23 | 10.0.1.169 | 0 / 1 / 13 |
| 10 | rev | node-turbopack | 2186 | 27 | 10.0.1.118 | 0 / 1 / 2 |

## Left behind, and cleanup

The four `NextApp`s were removed with `knext cleanup` (the operator garbage-collected their Knative
Services). `knext cleanup` has no namespace option — it removes the named app from the kube
context's *default* namespace and reports success even when nothing matched there — so the removal
went through a scratch kubeconfig whose context namespace was `bench-cells` (tracked as a CLI bug).

Still present, all inert: namespace `bench-cells` on OKE with the `ghcr-bench` pull Secret and the
`bench-timer` pod (a `sleep 86400`, which exits on its own and then sits `Completed`); the four
`bench-cells-*` GHCR packages under `getknext-dev`; and the four `bc-*` images in the `gsw-mcp`
Artifact Registry repository `knative-next-repo`. None is serving traffic.

## Appendix A — build recipe (Cloud Build)

Source upload: the scaffolded app (`app/`, with the page and route above) plus these three files.

```yaml
# cloudbuild.yaml
steps:
- name: node:22-bookworm
  entrypoint: bash
  args: ['/workspace/build-cells.sh']
- name: gcr.io/cloud-builders/docker
  entrypoint: bash
  env: ['BUILD_ID=$BUILD_ID']
  args: ['/workspace/image-cells.sh']
timeout: 3600s
options:
  machineType: E2_HIGHCPU_8
  logging: CLOUD_LOGGING_ONLY
```

```bash
#!/usr/bin/env bash
set -euo pipefail
npm i -g bun@1.4.2 >/dev/null 2>&1
echo "bun $(bun --version)"
cd /workspace/app && npm install --no-audit --no-fund 2>&1 | tail -3
node -e 'console.log("core", require("./node_modules/@getknext/core/package.json").version, "lib", require("./node_modules/@getknext/lib/package.json").version, "next", require("./node_modules/next/package.json").version)'
mkdir -p /workspace/cells
for cell in node-turbopack node-webpack bun-turbopack bun-webpack; do
  rt=${cell%-*}; bd=${cell#*-}
  echo "=== CELL $cell (runtime=$rt build=$bd)"
  cp -a /workspace/app /workspace/cells/$cell
  cd /workspace/cells/$cell
  sed -i "s|^  name: \"bench-cells\",|  name: \"bc-$cell\",\n  runtime: \"$rt\",\n  build: \"$bd\",|" knext.config.ts
  if [ "$bd" = webpack ]; then
    node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json"));p.scripts.build="next build --webpack";fs.writeFileSync("package.json",JSON.stringify(p,null,2))'
  fi
  grep -n -E '^  (name|runtime|build):' knext.config.ts
  grep '"build"' package.json
  npx knext build 2>&1 | tail -25
  T=node_modules/@getknext/core/templates/runtime-standalone
  cp $T/Dockerfile.standalone.hbs Dockerfile.standalone
  for f in knext-standalone-entry.mjs knext-compile-cache-bake.mjs knext-self-contained-server-shim.js; do cp $T/$f.hbs $f; done
  ls -la
done
```

```bash
#!/usr/bin/env bash
set -euo pipefail
REG=us-central1-docker.pkg.dev/gsw-mcp/knative-next-repo
: > /workspace/digests.txt
for cell in node-turbopack node-webpack bun-turbopack bun-webpack; do
  rt=${cell%-*}
  cd /workspace/cells/$cell
  if [ "$rt" = bun ]; then T=standalone-bun; A=""; else T=standalone-node; A="--build-arg KNEXT_HEALTH_CHECK_PATH=/api/health"; fi
  echo "=== IMAGE $cell target=$T"
  DOCKER_BUILDKIT=1 docker build --platform linux/amd64 -f Dockerfile.standalone --target $T $A -t $REG/bc-$cell:$BUILD_ID . 2>&1 | tail -20
  docker push $REG/bc-$cell:$BUILD_ID 2>&1 | tail -2
  echo "$cell $(docker inspect --format '{{index .RepoDigests 0}}' $REG/bc-$cell:$BUILD_ID)" | tee -a /workspace/digests.txt
done
echo "=== DIGESTS"; cat /workspace/digests.txt
```

## Appendix B — in-cluster driver

Run as `python3 cells_bench.py 10 bc-node-turbopack,bc-node-webpack,bc-bun-turbopack,bc-bun-webpack run1.jsonl` against the `bench-timer` pod above.

```python
#!/usr/bin/env python3
"""4-arm interleaved scale-from-zero bench, in-cluster timing.

Each round: wait until every arm has zero pods, then wake each arm once
(order alternates forward / reverse -> ABCD DCBA ...), timing the first GET /
inside the cluster with curl's own %{time_total} (the exec round trip is not
inside the timed interval: the arm is at zero before curl starts, and curl
itself triggers the wake). After each cold request: 5 warm GETs (median).
Then per-pod evidence: node, image-pull event, condition timestamps, and the
Next "Ready in" log line.
"""
import json, subprocess, sys, time, statistics, datetime

CTX = ["kubectl", "--context", "knext-oke-sa", "-n", "bench-cells"]
ARMS = sys.argv[2].split(",")
ROUNDS = int(sys.argv[1])
OUT = sys.argv[3]
PATH = "/"


def kc(args, check=True):
    return subprocess.run(CTX + args, capture_output=True, text=True, check=check).stdout


def pods(arm):
    j = json.loads(kc(["get", "pods", "-l", f"serving.knative.dev/service={arm}", "-o", "json"]))
    return j["items"]


def wait_zero(arms, timeout=900):
    t = time.time()
    while time.time() - t < timeout:
        if all(len(pods(a)) == 0 for a in arms):
            return time.time() - t
        time.sleep(5)
    raise SystemExit("timeout waiting for zero pods")


CURL = ('s=$(date +%s); r=$(curl -s -o /tmp/b -w "%{http_code} %{time_connect} %{time_starttransfer} %{time_total} %{size_download}" '
        'http://{arm}.bench-cells.svc.cluster.local' + PATH + '); e=$(date +%s); m=$(grep -c "items:<!-- -->50" /tmp/b || grep -c "items:50" /tmp/b); echo "$s $e $r $m"')


def curl(arm):
    out = kc(["exec", "bench-timer", "--", "sh", "-c", CURL.replace("{arm}", arm)]).split()
    s, e, code, tconn, ttfb, ttot, size, marker = out[:8]
    return dict(start_s=int(s), end_s=int(e), code=int(code), ttfb_ms=round(float(ttfb) * 1000),
                total_ms=round(float(ttot) * 1000), size=int(size), marker=int(marker))


def ts(x):
    return datetime.datetime.strptime(x, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()


def evidence(arm, start_s):
    ps = pods(arm)
    if not ps:
        return {}
    p = ps[0]
    name = p["metadata"]["name"]
    cond = {c["type"]: ts(c["lastTransitionTime"]) for c in p["status"].get("conditions", [])}
    cs = {c["name"]: c for c in p["status"].get("containerStatuses", [])}
    started = cs.get("user-container", {}).get("state", {}).get("running", {}).get("startedAt")
    ev = json.loads(kc(["get", "events", "--field-selector", f"involvedObject.name={name}", "-o", "json"]))
    pulls = [e["message"] for e in ev["items"] if e["reason"] in ("Pulled", "Pulling")]
    logs = kc(["logs", name, "-c", "user-container", "--tail", "80"], check=False)
    ready_line = next((l.strip() for l in logs.splitlines() if "Ready in" in l), "")
    created = ts(p["metadata"]["creationTimestamp"])
    rel = lambda v: None if v is None else round(v - start_s)
    return dict(pod=name, node=p["spec"].get("nodeName"), pulls=pulls, ready_log=ready_line,
                created_s=rel(created), scheduled_s=rel(cond.get("PodScheduled")),
                started_s=rel(ts(started) if started else None), ready_s=rel(cond.get("Ready")))


def main():
    res = []
    with open(OUT, "a") as f:
        for r in range(ROUNDS):
            order = ARMS if r % 2 == 0 else ARMS[::-1]
            waited = wait_zero(ARMS)
            time.sleep(10)  # pods gone; let endpoints settle
            for arm in order:
                if pods(arm):
                    raise SystemExit(f"{arm} not at zero before its cold request")
                cold = curl(arm)
                warm = [curl(arm)["total_ms"] for _ in range(5)]
                row = dict(round=r + 1, arm=arm, order="fwd" if r % 2 == 0 else "rev", waited_s=round(waited),
                           cold=cold, warm_ms=warm, warm_median_ms=statistics.median(warm),
                           ev=evidence(arm, cold["start_s"]))
                res.append(row)
                f.write(json.dumps(row) + "\n"); f.flush()
                print(r + 1, arm, cold["code"], cold["total_ms"], row["warm_median_ms"], row["ev"].get("node"),
                      row["ev"].get("pulls"), cold["marker"], flush=True)


main()
```

## Appendix C — analysis

Run as `python3 analyze.py run1.jsonl`; every number in the tables above is its output.

```python
#!/usr/bin/env python3
"""Summarise cells_bench.py JSONL: per-arm median/IQR/range, pairwise exact
Mann-Whitney (two-sided, Holm-corrected), factor-level pooled tests, and a
bootstrap 95% CI for each median difference."""
import json, sys, itertools, statistics, random
from collections import defaultdict

rows = [json.loads(l) for f in sys.argv[1:] for l in open(f) if l.strip()]
valid = [r for r in rows if r["cold"]["code"] == 200 and r["cold"]["marker"] >= 1
         and not any("Pulling" in p or "Successfully pulled" in p for p in r["ev"].get("pulls", []))]
excluded = [r for r in rows if r not in valid]
by = defaultdict(list)
for r in valid:
    by[r["arm"]].append(r)


def q(xs):
    s = sorted(xs)
    n = len(s)
    h = n // 2
    lo, hi = s[:h], s[n - h:]
    return statistics.median(lo), statistics.median(s), statistics.median(hi)


def mw_exact(a, b):
    # exact two-sided p for U via full enumeration of label assignments
    allv = a + b
    n = len(a)
    def U(x, y):
        return sum((1 if xi > yi else 0.5 if xi == yi else 0) for xi in x for yi in y)
    u_obs = U(a, b)
    mu = len(a) * len(b) / 2
    d_obs = abs(u_obs - mu)
    cnt = tot = 0
    idx = range(len(allv))
    for comb in itertools.combinations(idx, n):
        cs = set(comb)
        x = [allv[i] for i in comb]
        y = [allv[i] for i in idx if i not in cs]
        tot += 1
        if abs(U(x, y) - mu) >= d_obs - 1e-9:
            cnt += 1
    return cnt / tot


def boot_ci(a, b, n=4000):
    rnd = random.Random(1)
    ds = sorted(statistics.median(rnd.choices(a, k=len(a))) - statistics.median(rnd.choices(b, k=len(b))) for _ in range(n))
    return ds[int(0.025 * n)], ds[int(0.975 * n)]


print(f"rows={len(rows)} valid={len(valid)} excluded={len(excluded)}")
for r in excluded:
    print("  EXCLUDED", r["round"], r["arm"], r["cold"], r["ev"].get("pulls"))
print("\narm | n | cold median | Q1 | Q3 | IQR | min | max | warm median | ttfb median | nodes | created/started/ready median s")
arms = list(by)
for a in arms:
    xs = [r["cold"]["total_ms"] for r in by[a]]
    q1, m, q3 = q(xs)
    warm = statistics.median(r["warm_median_ms"] for r in by[a])
    ttfb = statistics.median(r["cold"]["ttfb_ms"] for r in by[a])
    nodes = defaultdict(int)
    for r in by[a]:
        nodes[r["ev"].get("node")] += 1
    dec = [statistics.median([r["ev"].get(k) for r in by[a] if r["ev"].get(k) is not None]) for k in ("created_s", "started_s", "ready_s")]
    print(f"{a} | {len(xs)} | {m} | {q1} | {q3} | {q3-q1} | {min(xs)} | {max(xs)} | {warm} | {ttfb} | {dict(nodes)} | {dec}")

print("\nper-cycle (round, order, arm, cold ms, warm median, node):")
for r in rows:
    print(r["round"], r["order"], r["arm"], r["cold"]["total_ms"], r["warm_median_ms"], r["ev"].get("node"), r["ev"].get("created_s"), r["ev"].get("started_s"), r["ev"].get("ready_s"), r["ev"].get("ready_log"))

print("\npairwise (median diff A-B ms, exact MW p, Holm-adjusted, bootstrap 95% CI of diff):")
pairs = list(itertools.combinations(arms, 2))
ps = []
for a, b in pairs:
    xa = [r["cold"]["total_ms"] for r in by[a]]
    xb = [r["cold"]["total_ms"] for r in by[b]]
    ps.append((a, b, statistics.median(xa) - statistics.median(xb), mw_exact(xa, xb), boot_ci(xa, xb)))
order = sorted(range(len(ps)), key=lambda i: ps[i][3])
adj = [0] * len(ps)
run = 0
for k, i in enumerate(order):
    run = max(run, min(1, ps[i][3] * (len(ps) - k)))
    adj[i] = run
for i, (a, b, d, p, ci) in enumerate(ps):
    print(f"{a} vs {b}: diff {d:+.0f} ms, p={p:.4f}, holm={adj[i]:.4f}, CI [{ci[0]:+.0f}, {ci[1]:+.0f}]")


def pooled(pred, label):
    x = [r["cold"]["total_ms"] for r in valid if pred(r["arm"])]
    y = [r["cold"]["total_ms"] for r in valid if not pred(r["arm"])]
    # normal-approx MW for pooled (n up to 20 each)
    import math
    U = sum((1 if xi > yi else 0.5 if xi == yi else 0) for xi in x for yi in y)
    mu = len(x) * len(y) / 2
    sd = math.sqrt(len(x) * len(y) * (len(x) + len(y) + 1) / 12)
    z = (U - mu) / sd
    p = math.erfc(abs(z) / math.sqrt(2))
    print(f"{label}: median {statistics.median(x)} vs {statistics.median(y)} (diff {statistics.median(x)-statistics.median(y):+.0f}), n={len(x)}/{len(y)}, MW normal-approx p={p:.4f}, CI {boot_ci(x, y)}")


print("\nfactor level:")
pooled(lambda a: "node" in a, "runtime node vs bun")
pooled(lambda a: "turbopack" in a, "builder turbopack vs webpack")
```
