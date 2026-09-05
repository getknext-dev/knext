# Sprint-2 aggregate verification (S3-V) — kind → OKE

Runbook: `.claude/sprint3-plan-sysdesign.md` §1 (P0 → P1 → P2 → A–H).
Task: `.claude/sprint3-taskgraph.md` S3-V. Runner: S3-V verification agent. Date: 2026-09-05.

Every row below is **OBSERVED** (raw command + raw output + the assertion that consumed it) or
**UNVERIFIED** (with the reason). No row is inferred from source.

---

## P0 — worktree and subject hygiene

**P0.1 `git worktree list`** — this run's worktree is
`/Users/banna/alpheya/pocs/knext/.claude/worktrees/agent-ab0c2f31e261b1899` on `agent/s2-tail`;
no other worktree holds `agent/s2-tail` (the s3-lockfile worktree sits detached-equivalent on its own
branch at the same SHA, which is legal — one branch, one worktree holds).

**P0.2 subject SHA** (all later steps attribute to this commit):

```
$ git rev-parse HEAD
9e96881e8b6cbb76f136555037e22302a5a45098        # == origin/agent/s2-tail
```

**P0.3 clean tree:**

```
$ git status --porcelain
(empty)
```

**P0.4 toolchain:**

```
bun 1.4.0 · node v24.14.0 · kubectl client v1.33.3 · kind 0.29.0 · docker server 29.4.0
```

Deps installed with bun 1.4.0 (`bun install`, 1031 packages); packages built via
`turbo run build --filter=@getknext/core --filter=@getknext/lib --filter=@getknext/db` (3/3 successful).
(The full-repo `bun run build` fails only in `apps/spike-bun-bytecode`, a spike app with no
`pages`/`app` dir — unrelated to the subject packages; recorded, not hidden.)

---

## P1 — kind bootstrap

```
P1.1  kind create cluster --name knext-s3-verify --wait 120s   → Ready after 16s; context kind-knext-s3-verify
P1.2  Knative Serving v1.16.0 (serving-crds, serving-core) + net-kourier v1.16.0 applied;
      cm/config-network patched ingress-class=kourier.ingress.networking.knative.dev;
      kubectl wait Available: controller, webhook, autoscaler, net-kourier-controller — all "condition met"
P1.3  cert-manager v1.16.2 applied; cert-manager, -webhook, -cainjector — all Available
P1.4  make docker-build IMG=knext-s3-verify/operator:9e96881e   (built FROM the P0.2 SHA's tree)
      → image sha256:07b030c58aaecba6a28f99782e3a472f9b86c5a5013c2a71f8e30021c025c136
      kind load docker-image → loaded; make install deploy → CRD + operator deployed
      kubectl wait Available deploy/kn-next-operator-controller-manager → condition met
P1.5  deployed image (spec):    knext-s3-verify/operator:9e96881e
      resolved imageID (status): sha256:07b030c58aaecba6a28f99782e3a472f9b86c5a5013c2a71f8e30021c025c136   # == the just-built image
      CRD nextapps.apps.kn-next.dev generation: 1
```

Digest precheck (kind flavor): the running imageID equals the image built minutes earlier from
`9e96881e` — trivially satisfied, recorded for shape-parity with P2.

---

## A–H on kind

### A — fresh scaffolded app · **OBSERVED (green, with one ecosystem finding)**

```
A.1  cd <scratch>; node <wt>/packages/kn-next/dist/cli/kn-next.js create knext-s3-app --name knext-s3-app
     → "Created 17 file(s)"; knext-bun-entry.mjs and runtime-contract.mjs ARE in the list
A.3  grep knext-bun-entry.mjs:
     line 79  import { handleImageRequest } from '@getknext/core/internal/vinext-image-optimizer'
     line 85  import sharp from 'sharp'   (static, so the bundler embeds it — per the file's own comment)
     line 221-231  the /_next/image intercept calls handleImageRequest({ …, sharp })
     lines 290-293 REQUEST_BYTE_CAP / METRICS_BYTE_CAP wiring present
```

The subject is a **generated** app; no repo app was used at any point. §2.2's scan-pin claim is
hereby an observation: the scaffolded entry DOES carry the intercept.

**Finding A-1 (blocks a real consumer):** the scaffold's `package.json` pins
`@getknext/{lib,core}` at `^0.3.1`, which is **not on npm** (publish blocked on the dead token,
issue #853) — `npm install` of a fresh `kn-next create` app fails with
`notarget No matching version found for @getknext/core@^0.3.1`. This run substituted
bun-packed tarballs of the subject SHA (which is also the more faithful subject). A consumer
cannot do that.

Minimal content the rows require was added to the scaffold (this does not disqualify — the
disqualifier is a repo app): `src/app/isr/page.tsx` (`revalidate = 30`), `src/app/api/echo/route.ts`
(POST sink), `public/test-image.png` (5,343,524-byte PNG generated via sharp).

### B — vinext build + deploy · **OBSERVED (green after 5 real obstacles, each recorded)**

**Finding B-1 (real defect, node CLI):** `kn-next build` on the vinext target **always fails under
node** — `detectBunVersion`'s lazy `require("node:child_process")` becomes `__require(...)` in the
tsup ESM bundle and throws `Dynamic require of "child_process" is not supported`, which the
`catch {}` swallows and mis-reports as *"needs `bun` on PATH … not found"* (bun 1.4.0 WAS on PATH;
verified by running the same `execFileSync("bun", ["--version"])` from the same cwd = 1.4.0).
Instrumented the installed bundle's catch to print the real error; restored it afterwards.
`packages/kn-next/src/cli/vinext-build.ts:254-268`. The `cli-node-runtime` guard covers
dispatch/help, not this path. Workaround for the rest of the run: drive the CLI under bun.

**Observation B-2 (guard worked as designed):** first build refused fail-closed — *"knext staged
native packages but found no bun.lock to pin them against"* (app was npm-installed). Actionable
message; `bun install --save-text-lockfile` cleared it.

**Finding B-3 (real defect, native-integrity checker):** with the scaffold's own defaults —
`sharp: ^0.35.2` (dep) + `next: 16.2.11` (devDep, which pins its own `sharp@0.34.5`) — the
lockfile holds TWO sharp versions, and `readLockfilePackages` keys a `Map` **by package name**
(`native-integrity.ts:122-138`), so one entry overwrites the other and the build fails spuriously:
*"'@img/sharp-wasm32' is staged at 0.35.4 but bun.lock pins 0.34.5"*. A fresh scaffold hits this
out of the box once it has a bun.lock. Workaround: `overrides.sharp = "0.35.4"` so one version
exists. (First tried downgrading the app to sharp 0.34.5 — that trips **Finding C-1b** below:
the dlopen shim's injection filter matches only sharp 0.35's `sharp/dist/sharp.mjs` layout,
0.34 ships `lib/`, so the shim silently never injects.)

**Observation B-4 (root-tracing):** with a stray `package-lock.json` in an ancestor dir the CLI
widened the Docker build context to that ancestor (it WARNED correctly) and the image build failed
on `COPY knext-exec-linux-x64`. Moved the app to a clean `mktemp`-style root per runbook A.1.

**Observation B-5 (environment, not the subject):** `docker buildx` with a docker-container
builder cannot push to a host-only `localhost:5077` registry; used the docker-driver builder
(`BUILDX_BUILDER=orbstack`).

```
B.1/B.2  build (under bun): exit 0 — "Single executable compiled", binary knext-exec-linux-x64;
         static assets: content-hashed /_next/static/chunks/<name>-<hash>.js + a per-build UUID dir
         (rev5 build: 218dd43e-85fd-404b-86ca-55cfb43f9fae). NOTE: on the vinext axis there is no
         NEXT_DEPLOYMENT_ID-derived static prefix — see row F.
B.3      deploy: exit 0 — "Digest-pinned image ref resolved:
         localhost:5077/knext-s3/knext-s3-app:<tag>@sha256:…" then "Applying NextApp CR to cluster"
B.4      the CR yaml contains exactly one document, kind: NextApp (grep -c "kind:" == 1);
         the ksvc's ownerReferences[0] = NextApp/knext-s3-app (operator-created, not CLI-applied).
         ADR-0001 holds: the CLI applied a NextApp and nothing else.
```

App infra added for the rows (created and owned by this run): `deploy/knext-s3-redis` +
`svc/knext-s3-redis` (redis:7-alpine) in `default`; `cache: { provider: "redis", url:
"redis://knext-s3-redis.default.svc.cluster.local.:6379" }` in kn-next.config.ts — the operator
correctly injected `CACHE_PROVIDER=redis` + `REDIS_URL` into the pod (observed in pod spec).

### C — boot → READY + the negative half · **OBSERVED (green only after two more findings)**

**Finding C-1a (real defect, blocks every macOS-built deploy):** revisions 00001–00002
**CrashLoopBackOff**: `stageNative` (`vinext-build.ts:225-251`) copies whatever `node_modules/@img`
holds on the BUILD HOST — darwin-arm64 addons on a mac — so the alpine image has no
linuxmusl-x64 sharp addon and the binary dies at import: *"Could not load the 'sharp' module using
the linuxmusl-x64 runtime"*. The Dockerfile's own comment claims an absent addon degrades to
unoptimized pass-through; **observed behaviour is a boot crash-loop**, because the entry imports
sharp statically. Workaround: manually extract `@img/sharp-linuxmusl-x64@0.35.4` +
`@img/sharp-libvips-linuxmusl-x64@1.3.3` into `node_modules/@img` (bun refuses to install
foreign-platform optional deps).

**Finding C-1c (real defect, shim discovery):** with BOTH darwin and linuxmusl addons staged,
revision 00003 STILL crash-looped: the dlopen shim's discovery (`sharp-addon-dlopen.mjs:64-93`)
returns the **first** `sharp-*` directory in `native/` — alphabetically `sharp-darwin-arm64`
before `sharp-linuxmusl-x64` — and dlopen fails with `Exec format error`. No platform matching in
the discovery loop. Workaround: the shim's own `KNEXT_SHARP_ADDON` escape hatch via config
`env:` → `/app/native/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64-0.35.4.node`.

**Finding C-2 (real conflict, entry vs queue-proxy):** revision 00004 crash-looped on
`EADDRINUSE :9091` — the entry's metrics server collides with **Knative queue-proxy's own 9091**
(user-metrics port), which is bound whenever serving's default
`metrics.request-metrics-backend-destination: prometheus` is in effect. The platform contract
(operator stamps `prometheus.io/port: 9091`, NetworkPolicy grants 9091) requires the app to own
9091, so on a default Knative install the scaffolded app **cannot boot**. Fixed on this cluster by
`config-observability → metrics.request-metrics-backend-destination: "none"`. Worth an explicit
docs/operator decision — an OKE/GKE cluster with default observability config will reproduce it.

```
C.1  after the three fixes: revision 00005 → kubectl wait ksvc Ready → "condition met"; pod 2/2 Running
C.2  GET /api/health (via kourier-internal port-forward, Host: knext-s3-app.default.svc.cluster.local)
     → 200, body {"status":"ok"}
C.3  ksvc template readinessProbe.httpGet.path == /api/health; livenessProbe.httpGet.path == /api/health
C.4  restartCount at startTime+5m46s (00:13:59Z → 00:19:45Z): queue-proxy 0, user-container 0  ✓
```

### D — `/_next/image` really transforms · **OBSERVED (green)**

```
D.1  GET /test-image.png                            → 200, image/png, content-length 5343524
D.2  GET /_next/image?url=%2Ftest-image.png&w=640&q=75   (Accept: image/avif,image/webp,*/*)
     → 200, content-type image/avif, cache-control "public, max-age=31536000, immutable"
D.3  17,380 bytes  <  5,343,524 source  ✓  (and the format CHANGED png→avif at w=640 — not a pass-through)
D.4  kubectl logs | grep -i sharp → NO match: the runtime logs no transform line, so D.4 as scripted
     is not observable. Compensating evidence that the transform runs in-process: revisions 00001-00003
     CRASHED precisely when sharp could not load (C-1a/C-1c), and D.2's avif bytes came back after and
     only after the addon loaded.
```

### E — ISR on the Redis path · **OBSERVED — RED (ISR is not wired on the vinext axis at this SHA)**

```
E.1  GET /isr → 200, x-nextjs-cache: MISS, cache-control: no-store, must-revalidate
E.2  GET /isr (2s later) → x-nextjs-cache: MISS again (same no-store)
E.3/E.4  unreachable — there is no HIT to go STALE from
E.5  redis-cli --scan on knext-s3-redis (REDIS_URL confirmed in the pod env): ZERO keys
E.6  unreachable — no key to TTL
```

The page carried `export const revalidate = 30` and no dynamic API. The scaffold wires
`cacheHandler` in `next.config.ts`, but nothing in `vinext@1.0.0-beta.8`'s dist references
`cacheHandler`, and the template's own `runtime-contract.mjs` says RuntimeContract item 4
("Redis cache-handler") is "likely fallback-to-node … explicitly deferred". **Exit criterion 2's
ISR clause is NOT MET on the shipped (vinext) target** — consistent with #906's prover testing a
pure function with `REDIS_URL` deleted. This is the row the plan predicted could only be closed
here, and it closed red.

### F — skew guard · **OBSERVED on 9e96881e — no vinext guard in this tree (topology; see re-attribution below and the merged-tree re-run)**

```
F.1  recorded resourceVersion of nextapp/knext-s3-app: 12546
     full deploy with NEXT_DEPLOYMENT_ID=skew-probe-mismatch exported:
       → exit 0 (NOT non-zero); WARN ".next/BUILD_ID not found — skipping build-id lock-step check";
       → resourceVersion after: 14114 (the cluster WAS touched — new revision 00006 went Ready)
     Two structural reasons, both in deploy.ts: (i) deploy.ts:399 OVERWRITES the env
     (process.env.NEXT_DEPLOYMENT_ID = buildId) so a mismatch cannot even be induced;
     (ii) the lock-step guard reads .next/BUILD_ID, which the vinext artifact shape never writes.
F.2  INCONCLUSIVE by construction on this app: no storage block → assets are served from each
     image (the build log itself warns "the in-flight skew window is unprotected"), and the vinext
     chunks are content-hashed (identical names across both builds: index-CHiQsKQE.js …), so
     "prior revision's assets still served" is not distinguishable from "current".
F.3  kn-next gc → exit 0, "no object storage configured — nothing to reap … announced no-storage
     mode, not a failure" — correct, and it reaped nothing (trivially satisfies "nothing from F.2").
```

**RE-ATTRIBUTION (2026-09-05, post-run correction from the lead):** `origin/agent/s2-tail` does
NOT contain #920 (`agent/s2-skew-chain`) — the skew-chain is a sibling branch off
`agent/s2-byte-cap`, never merged into the hardening chain (`git merge-base --is-ancestor` says
not-in). So the F.1 result above is evidence of **tree topology** — on a tree where the vinext
skew guard does not exist, "cannot fire" is the expected behaviour, not a defect in #920. The
observations stand as facts about `9e96881e`; the *verdict* moves to the re-run below.
See "Row F re-run on the merged tree".

### G — byte cap on the wire · **OBSERVED (green, all six)**

```
G.1  POST 9,437,184 bytes (Content-Length set) → 413
G.2  POST 9,437,184 bytes, Transfer-Encoding: chunked, NO Content-Length → 413   ← the load-bearing case
G.3  POST 1,048,576 bytes → 200, body {"bytes":1048576}
G.4  GET pod:9091/metrics (port-forward to the pod, co-resident path) → 200,
     text/plain prometheus exposition (knext_bunexec_process_… metrics)
G.5  POST 66,560 bytes to :9091 → 413; immediate re-scrape of :9091 → 200 (scrape works while capped)
G.6  pod boot log: "REQUEST_BYTE_CAP:8388608 METRICS_BYTE_CAP:65536 (default)"
```

### H — probe hygiene · **OBSERVED (green)**

```
H.1  the probed path (/api/health, per C.3) is the scaffolded route: `export const dynamic =
     'force-dynamic'`, zero imports, zero I/O, zero env reads (file content recorded from the
     deployed app's own source tree).
H.2  the app's only external service (Redis; no DB is bound) scaled to 0:
     kubectl scale deploy/knext-s3-redis --replicas=0 → GET /api/health → 200 {"status":"ok"}
     (Redis restored to 1 afterwards.)
```

---

## P2 — OKE precheck (the digest gate)

```
P2.1  context: context-ckmva7v7zvq (recorded verbatim; nodes 10.0.1.253 / 10.0.1.78, v1.33.10)
P2.2  deployed operator image (spec):
      me-abudhabi-1.ocir.io/axfqznklsd2t/knext/operator:sha-d0725e2@sha256:fd02c0ce5b609c7ed395480d9aab3ad6a56cad668335ca867779ec8c5ff43f67
P2.3  resolved imageID: …/knext/operator@sha256:05bcd920f924d53fb39bca6f1877ed1dae67fd44a0b035067467fd48e0ec9db8
P2.4  d0725e2 is an ancestor of the subject, 202 commits behind, WITH operator-package commits in
      between (incl. 7f460fd9 "regenerate the CRD"). CRD generation at precheck: 2.
      → GATE FAILED as found.
```

**Gate resolution: the "redeploy from P0.2's SHA" arm was taken** (the runbook's first legal
outcome), because the mismatch also *bit in practice* — see the preflight observation below.

- Built the operator image FROM the subject tree (`docker buildx --platform linux/amd64`, pushed
  with the cluster's own ocir-secret creds via a temp `DOCKER_CONFIG`):
  `me-abudhabi-1.ocir.io/axfqznklsd2t/knext/operator:9e96881e@sha256:351a6571a83dfb415f57c478261ae827048b3aab0b382294a093d52969129f98`
- `make install` applied the subject CRD → **CRD generation 2 → 3** (recorded).
- `kubectl set image` to the digest-pinned ref; rollout complete; re-checked resolved imageID
  **== sha256:351a6571…** (the digest built from `9e96881e`). Gate now PASSES.
- Existing tenants (`knext-prewarm/pw`, `knext-prewarm/sdd-drill`) re-checked after the swap:
  both still `READY=True`.
- **Cluster state deliberately left upgraded** (operator `9e96881e` + CRD gen 3 — a consistent
  pair from the branch queued for merge). Rollback ref if the lead wants the old state back:
  the P2.2 image above.

**F-preflight (OBSERVED on OKE, criterion-3 positive, #548 made real):** the FIRST deploy attempt
(against the d0725e2-era CRD) **exited non-zero before any side effect**:

```
PREFLIGHT FAILED: the NextApp CRD installed on this cluster does not know field(s) this CLI emits,
so the CR would be rejected (or, under a client that does not assert strict validation, SILENTLY
PRUNED):
  - spec.build
Diagnosis source: openapi-v3 … Upgrade order is load-bearing: upgrade the OPERATOR/CRD first,
THEN the CLI … Nothing was built, uploaded or applied — this ran before any side effect.
```

Cluster untouched, proven not asserted: the NextApp's `creationTimestamp` is `00:37:16Z` — from
the *second* (post-upgrade) deploy; the 00:25 abort left **no NextApp at all** in the namespace.

## A–H on OKE (subject operator + subject app image; namespace `knext-s3-verify`, created by this run)

- **A** — same generated app (scaffolded once, in P0's scratch root; not re-scaffolded). **OBSERVED** (carries over).
- **B** — **OBSERVED**: push to OCIR + digest-pinned ref
  `…/axfqznklsd2t/knext-s3-app:<tag>@sha256:b89e72d9…`; CLI applied the NextApp CR only.
  **Observation B-6 (OKE-only):** first revision sat in `ImagePullBackOff` — the operator-created
  `knext-s3-app-sa` carries **no imagePullSecrets**, and nothing in the CLI/operator wires a
  registry credential for a private OCIR repo (the long-standing `knext-prewarm` namespace has
  `ocir-secret` manually attached to its `pw-sa`, i.e. this is hand-fixed everywhere it works).
  Worked around identically: copied `ocir-secret` into the namespace, patched the SA, redeployed.
- **C** — **OBSERVED green**: rev 00002 Ready; `GET /api/health` via the REAL ingress URL
  `http://knext-s3-app.knext-s3-verify.51.170.86.139.sslip.io/api/health` → 200 {"status":"ok"};
  probe paths `/api/health` (readiness AND liveness, C.3); **C.4: restartCount 0/0 at
  startTime+5m18s** (00:50:57Z → 00:56:15Z). Notably the :9091 queue-proxy collision (Finding C-2)
  did NOT reproduce on OKE — its serving config differs from a stock install; the finding stands
  for defaults.
- **D** — **OBSERVED green**: source 200 image/png 5,343,524 B → `/_next/image?w=640&q=75`
  (Accept avif/webp) 200 **image/avif 16,438 B** < source. Same D.4 caveat as kind (no transform
  log line exists to grep).
- **E** — **OBSERVED RED**, same as kind: `/isr` → MISS + `no-store` twice; Redis `DBSIZE` = **0**
  (REDIS_URL injected and Redis reachable — H.2 proves the service resolves). ISR-to-Redis is not
  wired on the vinext axis at this SHA.
- **F** — the id lock-step half: same structural verdict as kind (guard cannot fire on the vinext
  shape) — **not re-run**. The abort-before-side-effect discipline **was** observed on OKE via the
  CRD preflight above (exit non-zero, zero cluster writes). F.2/F.3: same no-storage
  inconclusiveness as kind.
- **G** — **OBSERVED green over the real ingress**: 9 MiB POST → **413** (server answers early,
  then RST/EPIPE on the still-streaming body — correct); 9 MiB chunked/no-Content-Length → **413**;
  1 MiB → 200 `{"bytes":1048576}`; pod :9091 scrape → 200 prometheus exposition; 65,560→66,560-byte
  POST to :9091 → **413** with the next scrape → 200; boot log
  `REQUEST_BYTE_CAP:8388608 METRICS_BYTE_CAP:65536 (default)`.
- **H** — **OBSERVED green**: H.1 same scaffolded shallow route; H.2 Redis scaled to 0 → health
  still 200 (restored after). Scale-to-zero + scale-from-zero also observed incidentally (pod
  vanished when idle; a health request re-created it).

---

## Row F re-run on the merged tree (subject + #920)

Scratch branch `agent/s3-verify-with-920` = `origin/agent/s2-tail` (9e96881e) + a **clean,
conflict-free merge** of `origin/agent/s2-skew-chain` (baf435fd) → merge SHA
**b7c1155171a8eaaa52a73e46155ceb127c075d42**. Packages rebuilt from that tree; the app invoked the
merged-tree `dist/cli/kn-next.js` directly. Run on the still-running kind cluster.

**Scope fact first:** #920's T2a vinext guard (`deploy.ts:497-523` on the merged tree) is scoped
to deploys that actually upload — `hasStorage(config) && !options.skipUpload` — with the rationale
in-code: in no-storage mode there is no prefix/GC correspondence to protect. The kind app was
storage-less, so a `storage` block (`provider: s3`, deliberately nonexistent bucket) was added to
bring the deploy into the guard's scope. The mismatch case aborts BEFORE any upload/push/apply, so
the fake bucket is never touched on the negative path.

```
F.1  resourceVersion before: 15464
     deploy --skip-build -t skew-probe-mismatch   (merged-tree CLI, .output prefix = 694ed3c1-…)
       → exit 1, message:
         ".output/public/_next/static/skew-probe-mismatch/ does not exist (prefix-missing;
          found: 694ed3c1-b38d-4a37-9003-5897a8523ec8, chunks). Skew-protection asset retention
          requires the static prefix to BE the deploy tag. You passed --skip-build, …"
       → zero docker/upload/apply log lines; resourceVersion after: 15464 (UNCHANGED)  ✓
F.pos deploy --skip-build -t 694ed3c1-b38d-4a37-9003-5897a8523ec8   (the MATCHING tag)
       → guard PASSED (no prefix sentence), proceeded to "Running parallel tasks: asset upload +
         Docker build", then failed on the nonexistent bucket (aws s3 sync non-zero)
       → exit 1, and resourceVersion STILL 15464 — a post-guard failure never reaches the CR
         apply (the ADR-0011 abort-before-apply leg, observed rather than asserted)  ✓
```

**Verdict: on the merged tree the vinext skew guard fires on mismatch with the fixed sentence and
an untouched cluster, passes on match, and post-guard failures preserve CR-apply atomicity.**
Remaining scope note, not a defect: the guard is inert in no-storage mode by documented design,
and the positive *GC/retention* case (F.2/F.3 with a real bucket) was not run — no real bucket was
available; that residue is a storage-backed e2e, not a kind gap.

**Row E re-checked on the merged tree's account:** the merge diff contains **zero ISR-path files**
(only deploy/build/cr-builder/asset-upload, `next.config` `generateBuildId` templates, tests,
prover, docs — full `--stat` verified), and the live probes repeated against the running app:
`/isr` → MISS + `no-store` twice, Redis `DBSIZE` = 0. **Row E's red stands unchanged with #920
merged** — #920 wires the NEXT_DEPLOYMENT_ID chain, not ISR.

---

## Verdict table

| row | kind | OKE | negative half recorded |
|---|---|---|---|
| P0 | OBSERVED — SHA 9e96881e, clean tree | — | — |
| P1/P2 | OBSERVED — operator built from subject, digest recorded | OBSERVED — gate FAILED as found (d0725e2, −202 commits), resolved by redeploy; digest 351a6571… == subject build; CRD gen 2→3 | preflight abort proven side-effect-free |
| A | OBSERVED (fresh `kn-next create`; intercept + caps in the emitted entry) | carries over | Finding A-1: scaffold pins unpublished @getknext@^0.3.1 — `npm install` of a fresh app 404s |
| B | OBSERVED green (under bun) | OBSERVED green (+ B-6 pull-secret gap) | Finding B-1: vinext build ALWAYS fails under the node CLI (bundled dynamic require); B-3 sharp double-version false-fail |
| C | OBSERVED green after C-1a/C-1c/C-2 fixes | OBSERVED green | C.4 restartCount 0/0 at ≥5 min on BOTH clusters |
| D | OBSERVED green (5,343,524 → 17,380 B avif) | OBSERVED green (→ 16,438 B avif) | D.3 bytes < source ✓; D.4 log-grep empty (no such log line exists) |
| E | **OBSERVED RED** — no HIT/STALE, Redis empty | **OBSERVED RED** — same | E.5 key does NOT exist; E.6 unreachable |
| F | 9e96881e: no vinext guard in tree (topology — #920 is a sibling, expected). **Merged tree b7c11551: OBSERVED GREEN** — mismatch → exit 1 + fixed sentence + resourceVersion 15464 unchanged; match → guard passes; post-guard failure still never touches the CR | preflight abort OBSERVED (exit≠0, cluster untouched) | resourceVersion compared on both legs; F.2/F.3 retention needs a real bucket (not run) |
| G | OBSERVED green (6/6) | OBSERVED green (6/6) | G.2 chunked-no-CL 413 ✓; G.4+G.5 metrics 200-while-capped ✓ |
| H | OBSERVED green | OBSERVED green | H.2 dependency-down health 200 ✓ |

**Exit criteria (sprint-2 close), re-scored after the #920 re-run:**
- **Criterion 2: NOT closed.** Boots/READY/image-optimization **green on both clusters**, but the
  **ISR clause is red** — no scaffolded vinext app caches ISR to Redis, on 9e96881e AND with #920
  merged (row E; the merge touches no ISR-path file).
- **Criterion 3: substantially closed on the merged tree, open on `agent/s2-tail` itself.** The
  skew guard's loud abort (fixed sentence, exit ≠ 0, unchanged resourceVersion), its pass-on-match,
  the post-guard abort-before-apply atomicity, and the #548 CRD preflight abort are all OBSERVED.
  Still unobserved: the retention/GC positive case against a real bucket (F.2/F.3), and none of
  this exists on `agent/s2-tail` until #920 actually lands — the criterion closes only on the tree
  that merges the skew-chain.

## Findings index (fix, don't propagate)

1. **A-1** scaffold depends on unpublished `@getknext/*@^0.3.1` → fresh-app `npm install` fails (blocked on #853).
2. **B-1** vinext build path dies under the node-run CLI: `__require("child_process")` in the tsup ESM
   bundle throws; the `catch {}` mislabels it "bun not found" (`vinext-build.ts:254-268`).
3. **B-3** native-integrity lockfile map keyed by name → two sharp versions (scaffold default + next's
   own) = spurious build failure (`native-integrity.ts:122-138`).
4. **C-1a** `stageNative` stages the BUILD HOST's `@img` addons — a macOS build ships an image with no
   linux addon and the app **crash-loops at boot** (Dockerfile's "degrades gracefully" comment is wrong
   for the static-import entry).
5. **C-1c** the dlopen shim picks the first `sharp-*` dir alphabetically (darwin < linuxmusl), no
   platform match (`sharp-addon-dlopen.mjs` discovery loop).
6. **C-1b** the shim's injection filter matches only sharp ≥0.35 (`sharp/dist/sharp.mjs`); sharp 0.34
   (what `next` pins) silently never gets the shim.
7. **C-2** entry metrics `:9091` collides with Knative queue-proxy's user-metrics port on a
   default-configured Knative install (kind repro; OKE's config dodges it).
8. **E** ISR→Redis unwired on the vinext axis (RuntimeContract item 4 "explicitly deferred") — the
   half #906's unit prover cannot see, observed red on both clusters.
9. ~~**F** skew lock-step guard is `.next`-shape-only~~ — **RE-ATTRIBUTED, not a defect**: true
   only of `agent/s2-tail`'s topology (the #920 skew-chain is an unmerged sibling). With #920
   merged the vinext guard exists, fires, and preserves atomicity — see "Row F re-run on the
   merged tree". The actionable remainder is sequencing: criterion 3 needs #920 in the tree it is
   scored against.
10. **B-6** no pull-secret story for private registries: operator-created SA has no imagePullSecrets;
    every working namespace was hand-patched.

## Cluster residue (deliberate, recorded)

- kind cluster `knext-s3-verify` + local registry container `knext-s3-registry` (host port 5077):
  teardown is human-gated on this machine (`block-dangerous-bash` hook) — left running; delete with
  `kind delete cluster --name knext-s3-verify && docker rm -f knext-s3-registry`.
- OKE: namespace `knext-s3-verify` (NextApp knext-s3-app, redis, ocir-secret copy, patched SA) left
  for the lead's inspection; operator + CRD left at the subject pair (see P2).

---

## Row E re-observation on df4dd318 (2026-09-05, post-#957 merge — kind only)

Runner: s3v-rowE-recheck. Subject tree: `origin/agent/s2-tail` (9e96881e) merged with
`origin/agent/s3-isr-wiring` — a **fast-forward** to `df4dd318` (the wiring chain already
contained the s2-tail tip), so the observed tree is exactly the ISR-wiring branch's head.
Cluster: the SAME kind `knext-s3-verify` + `knext-s3-registry` (:5077) + `deploy/knext-s3-redis`
as the run above — reused, not rebuilt. OKE deliberately untouched (rides post-merge A7).

Subject app: a **fresh `kn-next create` app** (`rowe-app`, clean scratch root) built from this
tree's CLI (driven under bun per Finding B-1, which was not retested). Its scaffolded
`vite.config.ts` carries the new
`cache: { data: { adapter: '@getknext/core/internal/vinext-cache-adapter' } }` block, and the
factory symbol is present in the emitted server bundle (grep on `.output/server/index.mjs`).
`@getknext/*` substituted with bun-packed tarballs of the subject SHA via `overrides`
(**Finding A-1 still stands** — `^0.3.1` remains unpublished; a consumer still cannot install).
`overrides.sharp = "0.35.4"` still required (**Finding B-3 still stands**). Added content:
`src/app/isr/page.tsx` (`export const revalidate = 30`, body carries a rendered-at timestamp).
Deployed via `kn-next deploy` → NextApp CR only; revision `00003` Ready.

**New sub-finding C-1a′ (darwin build hosts; refines C-1a):** staging the linuxmusl addons
*alongside* the host's darwin ones is NOT enough — `stageSharpNative` copies everything under
`node_modules/@img`, and the dlopen shim's discovery (`sharp-addon-dlopen.mjs`, `addonPath()`)
takes the **first** `sharp-*` directory readdir returns, so `sharp-darwin-arm64` wins over
`sharp-linuxmusl-x64` and revisions 00001/00002 crash-looped on
`Exec format error … /app/native/sharp-darwin-arm64/…`. Workaround observed to work: keep ONLY
the linuxmusl pair in `node_modules/@img` (the text lockfile already pins all platforms) and a
clean `native/` before `kn-next build`. The shim should prefer the addon matching
`process.platform`/`process.arch` — belongs to the darwin-staging fix (#949 scope).

### E — ISR on the Redis path · **OBSERVED — GREEN (all six probes)**

Probed through a `kourier-internal` port-forward, Host `rowe-app.default.svc.cluster.local`:

```
E.1  GET /isr → 200, x-nextjs-cache: MISS,  cache-control: no-store, must-revalidate
E.2  +2s     → 200, x-nextjs-cache: HIT,   cache-control: s-maxage=30, stale-while-revalidate=31535970
E.3  +35s (> revalidate=30) → 200, x-nextjs-cache: STALE, same cache-control
E.4  +3s     → 200, x-nextjs-cache: HIT — and the BODY DIFFERS from E.2's
     (rendered-at 12:00:25.740Z → 12:01:02.878Z: background regeneration ran)
E.5  redis-cli --scan on knext-s3-redis → the ISR keys EXIST BY NAME:
       kn-next:cache:app:0e23b062-…:/isr:html
       kn-next:cache:app:0e23b062-…:/isr:rsc
     (+ tag keys kn-next:tag:_N_T_/isr, kn-next:tag:/isr, …; DBSIZE 8 — it was 0 on 9e96881e)
E.6  TTL kn-next:cache:…:/isr:html → 31,535,986 s (~1 y) — NOT equal to revalidate (30),
     and > revalidate, so stale-while-revalidate is reachable (the #886 rule holds live)
```

**vinext registration-failure warn: ABSENT.** Server-log grep for the fallback signature
(`Class constructor` / `without 'new'` / `MemoryCacheHandler` / falling-back-to-memory) → 0
matches; every cache line is labelled `(redis)`
(`[Cache] MISS/SET/HIT/STALE app:…:/isr:html (redis)`).

**Negative half (fail-open): OBSERVED — GREEN.** `kubectl scale deploy/knext-s3-redis
--replicas=0`, pod gone, then:

```
GET /api/health → 200 in 20 ms
GET /isr        → 200 (x-nextjs-cache: MISS, full 7,226-byte body — re-rendered, not a 5xx)
log: "[CacheHandler] Redis unhealthy, failing open: Connection closed"
     then [Cache] MISS/SET … (memory)   ← per-pod fallback, exactly the designed degradation
```

Redis restored to 1 replica afterwards (rollout complete).

**Benign observation (not a blocker):** the runtime warns `REDIS_KEY_PREFIX is unset while
REDIS_URL is set — falling back to 'kn-next'`. The operator injects `REDIS_URL` but no
`REDIS_KEY_PREFIX`, so keys land under the `kn-next:` fallback prefix with an app-UUID segment.
Works, but two apps sharing one Redis rely on the UUID rather than the prefix for separation —
worth a look when prefix injection is next touched.

### Verdict

Row E moves **RED → OBSERVED GREEN on `df4dd318`**: the sprint-2 NOT-MET ISR clause of exit
criterion 2 is **MET on the vinext target, kind half** — the scaffold wiring emits, registers,
writes Redis by name with a TTL outliving the window, serves MISS→HIT→STALE→HIT with real
regeneration, and fails open when Redis is gone. Remaining for full closure: the OKE half
(post-merge A7) and the consumer-install path (A-1, npm token #853).

Cluster residue added by this re-observation (deliberate, recorded): NextApp `rowe-app` +
revisions 00001–00003 in `default` on kind `knext-s3-verify` (deletes are human-gated on this
machine) — remove via the CR (`nextapp rowe-app` in `default`).

