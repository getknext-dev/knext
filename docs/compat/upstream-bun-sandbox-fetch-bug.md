# Upstream Bun finding: edge-sandbox outbound `fetch()` hangs under the bun lane (persists on 1.4.0) — FILEABLE (path 3 found the discriminating repro)

**Status:** **FILEABLE — the hang phase is named and a deterministic, discriminating,
next-free repro exists (path 3, 2026-07-03; see its section below).** The phase verdict from
in-realm instrumentation of a red CI shard (run 28661219608): the sandbox fetch does NOT
stall before dispatch, at connect, at TLS, or awaiting headers — it **resolves with status
200**; the hang is the **response body**: the socket dies mid-body, the bundled undici
publishes `undici:request:error`, and the body promise (`text()`) **neither resolves nor
rejects**. The isolated bug: **real undici JS running over bun's node-compat sockets never
settles an errored response body** (node rejects `text()` with "terminated"; bun hangs
forever) — 25 lines, local server, deterministic on bun 1.3.5/1.3.14/1.4.0-canary, no next,
no vm, no WAN. Filing is a maintainer decision — never filed automatically; the filled draft
skeleton is at the bottom.

Historical context (why this took three paths): the 2026-07-03 local reproduction campaign
could not produce a discriminating repro at the app level — in that environment the same
middleware fetches intermittently hung under Node too. The GHA-hosted controlled A/B (path 1)
went further: the minimal app-level repro did not hang under EITHER runtime (0/40 vs 0/40).
Path 2's host-side instrumentation was structurally blind under bun (calibrated null). The
app-level reductions all failed because they probed the wrong layer: the trigger is a
mid-body connection death (WAN-endpoint-dependent, hence unreproducible against clean local
echoes), and the hang is the error-swallow underneath it (runtime-level, hence invisible to
any reduction that never errored a body).

## The finding (CI-grade evidence)

When knext's compat lane runs the official Next.js e2e deploy tests with the standalone
server booted on **bun** instead of node, outbound `fetch()` from Next's edge-runtime sandbox
(middleware / edge routes run through `next/dist/compiled/edge-runtime` — undici compiled
into the bundle, executed under `node:vm`, wrapped by `next/dist/server/web/sandbox`)
**never resolves** for the affected test cases: the middleware awaits forever, the harness
times out at 60s, and the server log shows **zero** exceptions. (Path-3 precision, 2026-07-03:
the `fetch()` promise itself RESOLVES — it is the response **body** promise that never
settles; the middleware's combined `await fetch(...)` + `await response.text()` is what hangs.
Two other mechanism corrections along the way: the bundled undici executes **host-side**, not
under `node:vm` — primitives `load()` runs in the host realm and its objects are injected into
the context — and it reaches the network through bun's node-compat `net`/`tls`.)

Affected files and the evidence trail (#188, PR #189 rounds 1–3):

- `middleware-fetches-with-any-http-method` (2 cases — plain `fetch(url, { method })` and
  `fetch(new Request(url, { method }))` to an external HTTPS echo endpoint): red on **every**
  bun-lane run — [28607626868](https://github.com/getknext-dev/knext/actions/runs/28607626868),
  [28612654960](https://github.com/getknext-dev/knext/actions/runs/28612654960), 28616072395,
  28618585946 (all Bun 1.3.14), and
  [28622051531](https://github.com/getknext-dev/knext/actions/runs/28622051531)
  (`oven/bun:canary`, observed `1.4.0`, 2026-07-02) — **the gap persists on 1.4.0**.
- `app-static`'s POST-fetch case (`/variable-revalidate-edge/post-method-request`, an
  edge-runtime page): same signature, same runs.
- Ledger note: the `server-actions-redirect-middleware-rewrite` cross-run wobble overlaps this
  mechanism class (PR #189 round 3).

**The control that makes this evidence-grade:** the **node lane** of the identical workflow —
same GHA infra, same test files, same external echo endpoint, same knext build — is green on
all of these (the Node compat credential is all-green). Many runs, both lanes, one variable
(the serving runtime). That discrimination is what no local setup has matched yet (see below).

PR #189 round 2 additionally records a campaign-time local reproduction ("middleware
`fetch()` to an external URL hangs under Bun 1.3.14 while a host-side render `fetch()`
works"). The 2026-07-03 re-verification below could not confirm that reproduction as
Bun-specific; treat it as a campaign record, not verified evidence.

## Local reproduction attempts (2026-07-02/03) — why there is no fileable repro yet

Full honesty, because this doc is the basis for an upstream report. A minimal app mirroring
the upstream fixture (`test/e2e/middleware-fetches-with-any-http-method` at v16.2.0) was
built and probed; **initial** small-sample runs (2026-07-02, darwin-arm64 native +
docker-linux, Next.js 16.2.0 standalone) looked like a clean Bun-only POST-hang pattern.
**Extended repetitions on 2026-07-03 falsified that reading:**

- The hang is **intermittent**, not deterministic: sequences that hung on 2026-07-02 fully
  resolved on 2026-07-03 and vice versa, on the same images and trees.
- **Node hangs too in this environment.** A/B hang-rate measurement, 5 fresh-server boots ×
  4 middleware fetches per runtime, probe timeout 15s:

  | Target | node:24-slim | oven/bun:1.3.14 | oven/bun:canary (1.4.0) |
  |---|---|---|---|
  | Public echo endpoint (`next-data-api-endpoint.vercel.app`, WAN) | **5/20 hung** | 3/20 hung | 4/20 hung |
  | Local HTTPS echo (self-signed CA via `NODE_EXTRA_CA_CERTS`, WAN eliminated) | **3/20 hung** | 2/20 hung | 5/20 hung |

  With Node hanging at rates comparable to Bun, **nothing in this environment attributes the
  hang to Bun** — the noise floor (docker port-forwarding / host-gateway networking / the
  probe path / endpoint behavior) dominates.
- Consequently, every fine-grained claim from the 2026-07-02 session — "POST hangs, GET
  doesn't", "1.4.0 fixed plain-`fetch` but `new Request` still hangs", "a hung request
  poisons the pool", "TLS is in the trigger", "raw `EdgeRuntime.evaluate` is clean so Next's
  sandbox wrapper is required" — is **withdrawn as small-sample noise**. None of it may be
  cited or filed.

What this does NOT undermine: the CI A/B above (six runs, two lanes, deterministic red on the
bun lane only) remains valid — it is simply not yet portable to a standalone repro script.

## GHA-hosted controlled A/B (2026-07-03) — path 1 executed: does NOT discriminate (does not even reproduce)

Path 1 from the verdict section ("move the A/B where the discrimination already exists") was
executed: `.github/workflows/bun-sandbox-fetch-ab.yml` (dispatch-only investigation tool) runs
the minimal repro app below on the SAME runner class as the compat lanes (`ubuntu-latest`,
no docker), `runtime: [node, bun]`, 10 fresh-server-boot trials per runtime × the 4 probe
shapes, against a **controlled local HTTPS echo** on `127.0.0.1` (self-signed CA via
`NODE_EXTRA_CA_CERTS` — WAN eliminated, TLS kept in the path; TLS failures would surface as
500s/client errors, never miscounted as hangs). Probe client, trial driver, and echo server
always run under node — the serving runtime is the only variable. Fixture pins `next@16.2.0`
exactly (the version behind the 6/6 CI record); bun lane pinned `1.3.14` (ditto).

Result — run [28650729775](https://github.com/getknext-dev/knext/actions/runs/28650729775)
(node v24.18.0 vs bun 1.3.14, probe timeout 15s):

| Shape | node hangs | bun hangs |
|---|---|---|
| GET normal-fetch | 0/10 (0%) | 0/10 (0%) |
| POST normal-fetch | 0/10 (0%) | 0/10 (0%) |
| GET new-request | 0/10 (0%) | 0/10 (0%) |
| POST new-request | 0/10 (0%) | 0/10 (0%) |
| **ALL** | **0/40 (0%)** | **0/40 (0%)** |

Every one of the 80 middleware fetches resolved (max 303ms), with the echo's JSON in
`x-resolved` — the sandboxed fetch genuinely traversed HTTPS to the local endpoint under both
runtimes. **The discrimination criterion (bun ≥50% hangs on some shape while node ≤5%) is not
met — and stronger: the minimal repro does not reproduce the hang AT ALL on the CI runner
class once the WAN is removed.** Two consequences:

1. **Still not fileable.** The oven-sh report stays blocked; the [REQUIRED] repro slot below
   stays empty. Path 1 is spent.
2. **The CI-lane divergence needs a different explanation.** The clean 0/80 says the failure
   mechanism is NOT "bun + Next 16.2.0 edge-sandbox middleware fetch + HTTPS" in isolation.
   Candidate hypotheses, in order of plausibility given the data: (a) the **WAN echo endpoint**
   (`next-data-api-endpoint.vercel.app`) interacting with bun's connection handling — the
   documented bun keep-alive/pool class overlaps this mechanism (see the keep-alive finding +
   `bun-keepalive-guard.cjs`); a fresh-boot 4-probe pattern never stresses pool reuse the way a
   long-lived suite server does; (b) **harness-scale conditions** — the deploy harness keeps one
   server serving hundreds of requests across many test files with concurrent in-flight
   fetches, vs 4 sequential probes here; (c) the harness's jest/next-test client behavior.
   Next diagnostic step is the verdict section's **path 2** (instrument a red CI shard); a
   cheaper intermediate probe: extend the A/B workflow with a WAN-endpoint knob and/or a
   long-lived-server many-request mode to test (a)/(b) directly on the same infra.

## Path 2 (2026-07-03): instrument a red shard IN THE FULL HARNESS — executed; host-side observation of the sandbox fetch is bun-blocked (+ a NEW isolated `bun -r` dc bug), sandbox fetch ≠ bun-native fetch

Path 1's clean 0/80 moved the mechanism into whatever the minimal reduction omits
(WAN endpoint / pool state / harness-scale load). Path 2 therefore instruments the
red shard itself: an opt-in debug lane on the compat workflow
(`workflow_dispatch` input `sandboxFetchDebug`, default off; env
`KNEXT_SANDBOX_FETCH_DEBUG=1`; **schedules can never enable it** — guard-tested in
`tests/compat-suite-workflow.test.ts`, so the Node credential nightly and the
weekly bun lane stay byte-identical).

**What the instrumentation is** (`packages/kn-next/src/adapters/sandbox-fetch-debug.cjs`,
`@knext/core/internal/sandbox-fetch-debug`):

- Pre-run ground-truth probe against the published `next@16.2.0` tarball: the
  edge sandbox's `fetch` is the undici bundled into
  `next/dist/compiled/@edge-runtime/primitives/fetch.js` (~780 KB), reaching
  the network through `require("net")`/`require("tls")` — i.e. **bun's
  node-compat sockets on the bun lane** — and publishing the standard undici
  diagnostics channels (`undici:request:create|bodySent|headers|trailers|error`,
  `undici:client:beforeConnect|connected|connectError|sendHeaders`) through
  `require("diagnostics_channel")`. **SUPERSEDED IN PART by the results below:**
  the "executes host-side, so a main-graph host subscriber observes it under
  bun" inference held for a DIRECT require of the primitives bundle, but the
  REAL server's sandbox fetch proved invisible to that subscriber under bun
  (conclusions 1–2 in the results section) — the execution-locus claim is
  downgraded to hypothesis; the channel list and the socket layer stand.
- The debug module subscribes those channels in the server process and logs one
  timestamped `[sandbox-fetch-debug]` line per phase, plus a watchdog that names
  the **last seen phase** of any request in-flight >20s (pool-queue stall vs
  connect stall vs awaiting-response-headers vs body-streaming stall — exactly
  the discrimination every reduction has missed) and takes a rate-limited
  `ss -tnp` socket snapshot. Verified end-to-end locally under node 24 AND bun
  1.3.x: all 7 lifecycle events observed for a bundled-undici `fetch`.
- Lane asymmetry is a feature: bun's **native** fetch publishes no `undici:*`
  channels, so on the bun lane every `undici:*` line is sandbox (bundled-undici)
  traffic; `BUN_CONFIG_VERBOSE_FETCH=curl` is additionally exported (bun lane,
  debug only) so bun-native fetch traffic is visible too — together they say
  which fetch implementation a request actually traversed.
- `scripts/e2e-cleanup.sh` ships the `[sandbox-fetch-debug]` lines (bounded) in
  the teardown output the harness prints inside each failing file's log group.

**Side finding while building this (bun quirk, isolated repro, bun 1.3.x):**
`diagnostics_channel` subscriptions made from a `bun -r <preload>` module
**never register for the main program** — the module object is identical
(`require('node:diagnostics_channel')` compares `===` across preload and main),
but the main program's publishes see `hasSubscribers === false` and no callback
fires; the same module required from the main graph works, and node works both
ways. Workaround shipped: in debug mode `scripts/e2e-deploy.sh` boots the
**instrumentation module as the entry** and chain-requires the real
`server.js` (`KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS`) — never `-r`. (Candidate
for its own upstream report once minimized further; the three-line repro is in
the PR discussion.)

### Path 2 results (run [28657820369](https://github.com/getknext-dev/knext/actions/runs/28657820369), bun 1.3.14, `sandboxFetchDebug=true`, 2026-07-03)

The lane executed as designed and the target reproduced: shard 4/16 carried
`middleware-fetches-with-any-http-method`, both cases hung 60s on all 3
harness attempts (the record is now **7/7 bun-lane runs red** on this file),
the server chain-booted through the instrumentation
(`[sandbox-fetch-debug] installed (runtime=bun 1.3.14 …) — subscribed 9 undici
channels`), `BUN_CONFIG_VERBOSE_FETCH=curl` was exported, and teardown shipped
the debug output. The rest of the run matched the known bun baseline (shards
8/11 = the not-found invariant pair; no perturbation from the debug lane).

**The instrumented result is a calibrated null:** across the ENTIRE run — and
in the hung fixture's complete server log (it fits whole inside the 16 KiB
teardown tail) —

- **zero `undici:*` diagnostics events** were observed (0 matches in 22.7k
  surfaced log lines; 15 `installed` markers prove the subscriptions were
  live), and
- **zero `BUN_CONFIG_VERBOSE_FETCH` output** for the middleware fetches.

**Local calibration (same instrumented boot, same next@16.2.0 standalone tree,
local echo — what makes the null meaningful instead of a shrug):**

| Observation | node 24 | bun 1.3.x |
|---|---|---|
| middleware fetch outcome | resolves (200/405 echoed) | resolves (200/405 echoed) |
| `undici:*` events seen by the host-realm subscriber | **full 7-phase lifecycle per fetch** (create → beforeConnect → connected → sendHeaders → bodySent → headers → trailers) | **ZERO** |
| `BUN_CONFIG_VERBOSE_FETCH=curl` output for the middleware fetch | n/a | **ZERO** (control: a plain bun-native `fetch()` under the same env prints the full curl transcript) |

So the CI zeros do NOT mean "the fetch never dispatched" — under bun **even a
successful sandbox fetch is invisible** to host-realm diagnostics_channel
subscribers and to bun's native-fetch verbosity. Three hard conclusions:

1. **The sandbox fetch under bun is NOT bun's native fetch** (verbose-fetch
   control). It is the undici bundled into next's edge-runtime, running over
   bun's node-compat `net`/`tls` (execution locus — host graph vs sandbox
   context — not yet pinned; see conclusion 2's scope precision) — that stack
   is where the CI hang lives, and the keep-alive/pool hypothesis class stays
   live.
2. **Bun defect isolated (new, independently fileable): `bun -r` preload-graph
   `diagnostics_channel` subscriptions never register for the main program**
   (node: process-global, works). The proven observable is (a): the `-r`
   repro above — 3 lines, deterministic, bun 1.3.x, `hasSubscribers === false`
   on the main side for a preload-made subscription, identical module object.
   **Scope precision (review counter-probe):** a `node:vm`-realm publish (host
   `require` passed into the context) IS delivered to host subscribers under
   bun — so the defect is **preload-graph-local, NOT vm-realm-local**; do not
   overstate it as "realm-local". Observable (b) — publishes from the real
   server's sandbox fetch never reach main-graph subscribers, under bun only
   (the table above) — therefore has a **not-yet-isolated mechanism**: it is
   NOT explained by (a) alone, and the vm counter-probe rules out the simple
   vm-realm story too.
3. **Path 2's instrument-from-outside design is structurally blocked under
   bun** by observable (b): a main-graph host subscriber does not see the
   sandbox undici's phases on the runtime where the hang happens. The
   instrumentation itself is correct — the node lane shows the full lifecycle
   through the identical wiring.

## Path 3 (2026-07-03): in-realm instrumentation — EXECUTED; the hang phase is named and a discriminating repro exists

Executed as PR #207: the debug lane (same dispatch-only `sandboxFetchDebug` input, #206's
plumbing) additionally patches the FIXTURE's staged standalone
`next/dist/server/web/sandbox/context.js` (v16.2.0, two verified-unique anchors:
`const __fetch = context.fetch;` and `return context;` inside `extend`) with a hook that
loads `@knext/core/internal/sandbox-fetch-realm-debug` and wraps

- next's host-realm `context.fetch` wrapper (entry/settled), and
- the base primitives `__fetch` (entry/settled + `body.<method>()` start/done),

with per-call timestamps, a stall watchdog naming the **last seen phase** of any call
in-flight >20s, process-wide `net`/`tls` connect instrumentation (dns/tcp/tls/first-byte/
error/close per socket), and an `undici:*` diagnostics_channel subscription made from
**inside next's require graph**. (One mechanism precision over the earlier path-3 sketch:
the bundled undici does not "live in the sandbox realm" — `@edge-runtime/primitives`
`load()` executes in the HOST realm inside `next/dist/compiled/edge-runtime` and its objects
are injected into the vm context, so the whole fetch stack is instrumentable host-side once
you sit at the right graph position.) Calibrated on a SUCCESS case first (local echo,
patched real standalone tree): full phase chain under node 24 AND bun 1.3.5; zero output
with the env off.

### Path 3 results (run [28661219608](https://github.com/getknext-dev/knext/actions/runs/28661219608), bun 1.3.14, `sandboxFetchDebug=true`, 2026-07-03)

The red reproduced (now **8/8 bun-lane runs** on `middleware-fetches-with-any-http-method`;
both cases, 60s timeouts, all attempts) and the patch applied on every fixture. The in-realm
transcript for a hanging middleware fetch (labeled excerpt, attempt 1, pid 15703 — all 7
captured middleware fetches in the file show the identical sequence):

```
context-fetch#1 call POST https://next-data-api-endpoint.vercel.app/api/echo-headers
base-fetch#2    call POST https://next-data-api-endpoint.vercel.app/api/echo-headers
dc undici:request:create POST …/api/echo-headers
dc undici:client:beforeConnect
socket#1 tls next-data-api-endpoint.vercel.app:443 connect() called (+0ms)
socket#1 … dns lookup -> 216.198.79.131 +37ms
socket#1 … tcp connected +62ms
socket#1 … tls secureConnect +90ms
dc undici:client:connected
dc undici:client:sendHeaders POST …
dc undici:request:bodySent POST …
socket#1 … first bytes received (441B) +203ms
dc undici:request:headers POST …
dc undici:request:error POST …                      <- undici errors the BODY, post-headers
base-fetch#2    resolved status=200 +220ms          <- the fetch promise RESOLVED fine
context-fetch#1 resolved status=200 +221ms
base-fetch#2    body.text() start
socket#1 … error aborted +215ms                     <- the socket dies mid-body
socket#1 … closed hadError=true +216ms
socket#2 … connect()/connected (replacement socket; idles out 4s later)
WATCHDOG: STALLED 30s at phase=base-fetch:body.text()
WATCHDOG: STALLED 60s … 240s at phase=base-fetch:body.text()   <- text() NEVER settles
```

**The phase verdict:** no stall before dispatch, none at DNS/TCP/TLS, none awaiting headers.
The fetch **resolves (status 200)**; the socket then errors (`aborted`) right after the
first response bytes; undici publishes `undici:request:error`; and **`text()` neither
resolves nor rejects** — the middleware awaits it forever. Zero `rejected` lines in the
whole run. Corroboration with an internal control: `app-static`'s edge page
(`/variable-revalidate-edge/post-method-request`, the other documented red) shows 47
`body.text()` starts, 40 `done`, **7 never settle — every unsettled one preceded by
`undici:request:error`** (10 total), 0 rejections: the swallow is per-request, and clean
bodies complete normally in the same process.

Two bun-specific layers separate:

1. **The trigger (unisolated):** under bun, the WAN echo connection dies mid-body
   (`aborted`, `hadError=true`) right after headers — the node lane on the identical
   infra/endpoint shows no such aborts (lane green). This overlaps the documented bun
   keep-alive/socket class. Why bun's socket aborts there is NOT yet isolated and is
   environment-dependent (clean local echoes never abort — which is exactly why paths 0/1
   could not reproduce).
2. **The hang (ISOLATED, deterministic, fileable):** an errored response body never settles
   its consumer promise — see the repro below. Layer 2 converts layer 1 from a catchable
   error (node: `text()` rejects "terminated"; middleware would 500) into an infinite hang.

### The discriminating repro (next-free, local, deterministic)

Real undici JS over bun's node-compat sockets, local HTTP server that sends headers plus a
partial body then destroys the socket. NOTE: `require('undici')` under bun is aliased to
bun's NATIVE fetch (which rejects, with a bun-branded message) — the bug needs the real
undici JS, so require the package's entry **file** directly:

```js
// undici-file-repro.cjs — npm i undici@5 (or @7; both reproduce)
'use strict';
const http = require('node:http');
const { fetch } = require('./node_modules/undici/index.js'); // NOT require('undici'): bun aliases that to native fetch

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
  res.write('{"partial":'); // fewer bytes than content-length
  setTimeout(() => res.socket.destroy(), 50); // kill the connection mid-body
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
  console.log(`fetch resolved status=${res.status}`);
  const timer = setTimeout(() => { console.log('VERDICT: text() DID NOT SETTLE in 10s (hang)'); process.exit(2); }, 10_000);
  try { console.log('VERDICT: text() resolved:', await res.text()); }
  catch (err) { console.log('VERDICT: text() rejected:', err && err.message); }
  clearTimeout(timer); process.exit(0);
});
```

Verbatim verdict matrix (5/5 deterministic per cell where repeated):

| Runtime | undici under test | VERDICT |
|---|---|---|
| node 24.14.0 (darwin-arm64) | next@16.2.0 bundled primitives `load({}).fetch` | `text() rejected: terminated` |
| node 24.14.0 (darwin-arm64) | undici@5.29.0 (file require) | `text() rejected: terminated` |
| node 24.14.0 (darwin-arm64) | undici@7.28.0 (file require) | `text() rejected: terminated` |
| bun 1.3.5 (darwin-arm64) | next@16.2.0 bundled primitives `load({}).fetch` | **`text() DID NOT SETTLE in 10s (hang)`** |
| bun 1.3.5 (darwin-arm64) | undici@5.29.0 / undici@7.28.0 (file require) | **hang** |
| bun 1.3.14 (linux docker — the CI pin) | undici@5.29.0 (file require) | **hang** |
| bun 1.4.0 canary (linux docker) | undici@5.29.0 (file require) | **hang** |
| bun 1.3.5 | `require('undici')` (bun's alias → native fetch) | rejects with bun's own "socket connection was closed unexpectedly" — control proving the alias is NOT the buggy path |

This is the discrimination criterion the verdict section demanded: bun hangs 100%, node
rejects 100%, same script, no WAN, no next.

### Path-3 side datapoint: the bun diagnostics_channel invisibility is graph-position-dependent

In the SAME server process (pid 15703), the path-2 host-side subscriber (the chain-boot
entry module) saw **zero** `undici:*` events — reconfirming the path-2 null — while the
path-3 in-realm subscriber (required from inside `next/dist`'s graph by the patched
context.js) received **every** phase of every sandbox fetch, with
`require('diagnostics_channel') === require('node:diagnostics_channel')` true. So under bun,
diagnostics_channel delivery depends on the subscriber's REQUIRE-GRAPH POSITION relative to
the publisher, not on the process: observable (b) from path 2 is now scoped to
"entry-module-graph subscribers do not receive publishes from `next/dist/compiled`'s graph"
— sibling of the proven `-r` preload-graph loss, still its own fileable bun bug.

### Run-hygiene note (honesty)

Shards 3 and 7 of run 28661219608 went red as **truncated** (49/50 and 48/49 selected tests
reported; every reported test passed net of retries — shard 3's `segment-cache-basic`
recovered on retry 1, a known bun-lane wobble class). Truncation is a shard-kill/time
failure mode, not a new test red; the instrumented run is slower (verbose logs + 60s hangs ×
retries), which plausibly contributes. The debug lane is dispatch-only, so the steady-state
lanes are unaffected; noted so nobody reads shards 3/7 as new regressions.

## Repro app (the vehicle for a future discriminating attempt)

The app below is the faithful reduction of the upstream fixture; it is what a controlled
environment should run repeatedly per runtime. It hangs in *this* author's environment under
both runtimes, so it is **not** attached to any upstream report yet.

```jsonc
// package.json
{ "type": "module", "dependencies": { "next": "16.2.0", "react": "^19", "react-dom": "^19" } }
```

```js
// next.config.js
export default { output: 'standalone' };
```

```js
// middleware.js
import { NextResponse } from 'next/server';

const HTTP_ECHO_URL = 'https://next-data-api-endpoint.vercel.app/api/echo-headers';

export default async function middleware(req) {
  const kind = req.nextUrl.searchParams.get('kind');
  const handler = handlers[kind] ?? handlers['normal-fetch'];
  const response = await handler({ url: HTTP_ECHO_URL, method: req.method });
  const json = await response.text();
  const res = NextResponse.next();
  res.headers.set('x-resolved', json ?? '{}');
  return res;
}

const handlers = {
  'new-request': ({ url, method }) => fetch(new Request(url, { method, headers: { 'x-kind': 'new-request' } })),
  'normal-fetch': ({ url, method }) => fetch(url, { method, headers: { 'x-kind': 'normal-fetch' } }),
};

export const config = { matcher: '/' };
```

```js
// app/layout.js
export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}
```

```js
// app/page.js
export default function Page() {
  return <h1>hello</h1>;
}
```

Build: `npm install && npx next build`; boot the emitted
`.next/standalone/<...>/server.js` with `bun server.js` (vs `node server.js` as control).
Probe (run with node; a 15s client timeout marks a hung middleware fetch):

```js
// mw-probe.js
const http = require('node:http');
function probe(method, path) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 3000, path, method }, (res) => {
      res.resume();
      res.on('end', () => resolve(`${method} ${path}: ${res.statusCode} resolved=${(res.headers['x-resolved'] ?? '').slice(0, 30)}`));
    });
    req.on('error', (e) => resolve(`${method} ${path}: ERROR ${e.code}`));
    req.setTimeout(15000, () => { req.destroy(); resolve(`${method} ${path}: TIMEOUT (15s)`); });
    req.end();
  });
}
(async () => {
  console.log(await probe('GET', '/?kind=new-request'));
  console.log(await probe('POST', '/?kind=new-request'));
  console.log(await probe('POST', '/?kind=normal-fetch'));
  console.log(await probe('GET', '/?kind=normal-fetch'));
  process.exit(0);
})();
```

Representative verbatim transcripts (fresh server per block):

```
# oven/bun:1.3.14, linux docker, 2026-07-02 (3-probe order: POST normal, POST new-request, GET new-request)
POST /?kind=normal-fetch: TIMEOUT (15s)
POST /?kind=new-request: TIMEOUT (15s)
GET /?kind=new-request: 200 resolved={"url":"/api/echo-headers","h

# oven/bun:1.3.14, linux docker, 2026-07-03, same 3-probe order — run 1
POST /?kind=normal-fetch: 405 resolved={"url":"/api/echo-headers","headers":{"u
POST /?kind=new-request: 405 resolved={"url":"/api/echo-headers","headers":{"h
GET /?kind=new-request: 200 resolved={"url":"/api/echo-headers","headers":{"x

# node:24 (native darwin), 2026-07-03 (4-probe order: POST new-request, GET, POST, GET)
POST /?kind=new-request: TIMEOUT (15s)      <- Node hangs too: the repro does not discriminate
GET /?kind=normal-fetch: 200 resolved={"url":"/api/echo-headers","he
POST /?kind=normal-fetch: 405 resolved={"url":"/api/echo-headers","he
GET /?kind=new-request: 200 resolved={"url":"/api/echo-headers","he
```

## knext status

- **Documented gap, no workaround shipped.** 2 official deploy-test files red on the bun lane
  (`middleware-fetches-with-any-http-method`, `app-static`'s POST-fetch case). Swapping
  `context.fetch` out from under the sandbox was rejected during the campaign — it would break
  inline-asset fetches (`fetchInlineAsset`).
- **Mechanism now named (path 3):** the hang is layer 2 above — an errored response body that
  never settles under bun. A knext-side workaround CANDIDATE exists but is deliberately not
  built in this round: a bun-lane-only response-body watchdog (reject the body promise when
  the underlying socket has errored) would convert the 60s hangs into catchable errors, but it
  patches deep inside the sandbox fetch path and the correct fix is upstream; revisit only if
  the bun row must go green before the upstream fix ships.
- **Not Bun-version-gated away:** still red on the 1.4.0 canary run 28622051531, and the
  path-3 repro hangs on 1.4.0-canary too.
- The compat-matrix Bun row (`docs/compat-matrix.md`) carries this as a named reason the row
  stays ❌. Watch: weekly bun lane (Sunday 05:17 UTC).

## Verdict: FILEABLE — path 3 delivered the discriminating repro (2026-07-03)

The blocking condition below is met by path 3: the phase is named (errored response body
never settles its consumer promise under bun) and the next-free repro discriminates
deterministically (bun hangs 100% on 1.3.5/1.3.14/1.4.0-canary; node rejects 100%). Filing
remains a maintainer decision. The historical path record:

To become fileable, one of:

1. **Move the A/B where the discrimination already exists:** a minimal GHA workflow (ubuntu
   runner, no docker port-forwarding) booting the repro app N times per runtime and counting
   hangs — if it shows bun-hangs/node-clean there, that transcript IS the filing evidence.
   **EXECUTED 2026-07-03 (`.github/workflows/bun-sandbox-fetch-ab.yml`, run 28650729775) —
   it does NOT: 0/40 hangs under bun AND 0/40 under node with the WAN removed** (full table
   in the GHA-hosted A/B section above). Path spent; the minimal reduction is clean on the
   CI runner class, so the divergence lives in something the reduction omits (WAN endpoint /
   pool state, harness-scale load — see the hypotheses above).
2. **Instrument a red CI shard** (packet capture / `strace` around the hung middleware fetch)
   to name the syscall-level difference. **EXECUTED 2026-07-03 (the path-2 section above,
   run 28657820369): the harness-scale instrumentation worked, the red reproduced (7/7),
   but host-side observation of the sandbox fetch is structurally blocked under bun
   (observable (b), mechanism unisolated). Along the way a NEW, independently fileable
   bun bug was isolated — `bun -r` preload-graph diagnostics_channel subscriptions never
   register for the main program (3-line repro; preload-graph-local, NOT vm-realm-local
   per the vm counter-probe) — and the sandbox fetch is proven NOT to be bun-native
   fetch. Next: path 3 (in-realm instrumentation) and/or file the `-r` bug.**
3. Failing both, file with **suite-level** evidence only ("Next.js's official e2e deploy tests
   X and Y hang under `bun server.js`, pass under `node server.js`; six-run record") and be
   explicit that the standalone reduction does not yet transfer — weakest option, last resort;
   after path 1's clean 0/80 this option is weaker still, since we now hold controlled
   evidence that the minimal mechanism is NOT bun-broken in isolation.
4. **Path 3 (EXECUTED 2026-07-03, PR #207, run 28661219608): in-realm instrumentation named
   the phase (body-consumption; fetch resolves, `text()` never settles after a mid-body
   socket error) and the reduction at THAT layer discriminates: real undici JS (bundled or
   npm, @5 and @7) over bun's node-compat sockets hangs deterministically where node
   rejects "terminated" — the repro in the path-3 section fills the [REQUIRED] slot below.**

## Issue draft (oven-sh/bun) — repro slot FILLED by path 3; filing is a maintainer decision

**Title:** undici's `fetch()` response body never settles (`text()` hangs forever) when the
connection dies mid-body under Bun's node-compat sockets; Node rejects with "terminated"

**Body:**

> Real undici JS (npm `undici@5` or `@7`, and the copy bundled into Next.js's edge runtime)
> running under Bun: when the server closes the connection after the response headers but
> before the body completes, `fetch()` resolves normally (status 200) but the response body
> promise (`res.text()`) **neither resolves nor rejects — it hangs forever**. Under Node the
> same script rejects with `terminated`. Deterministic (5/5 per runtime) on Bun 1.3.5
> (darwin-arm64), 1.3.14 and 1.4.0-canary (linux, `oven/bun` images); local HTTP server, no
> TLS, no network dependency. NOTE the repro requires requiring undici's entry **file**
> (`./node_modules/undici/index.js`) — `require('undici')` is aliased to Bun's native fetch,
> which handles this case correctly (rejects) and is not the buggy path.
>
> **Repro:** [the `undici-file-repro.cjs` script in the path-3 section above — paste
> verbatim, plus the verdict matrix table.]
>
> **Impact (how we found it):** Next.js's official e2e deploy tests served with
> `bun server.js` — `test/e2e/middleware-fetches-with-any-http-method` (both cases) and an
> edge-page POST-fetch case in `test/e2e/app-dir/app-static` hang 60s and time out on every
> bun-lane run (8/8 CI record), pass under `node server.js` on identical infra. In-realm
> instrumentation of the red shard (GHA run 28661219608) shows the exact sequence: fetch
> resolves 200 → socket errors (`aborted`) mid-body → undici publishes
> `undici:request:error` → `text()` never settles. Any Next.js middleware/edge route making
> outbound requests stalls instead of erroring whenever a connection dies mid-body.
>
> **Expected:** the errored body rejects `text()` (as under Node), so callers can catch and
> retry instead of hanging.
