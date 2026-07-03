# Upstream Bun finding: edge-sandbox outbound `fetch()` hangs under the bun lane (persists on 1.4.0) — NOT yet fileable

**Status:** **REAL PER CI EVIDENCE, BUT DO NOT FILE YET.** The knext compat suite's controlled
A/B (bun lane red on exactly these tests across six runs including Bun 1.4.0, node lane green
on the same tests/infra/endpoint) says something Bun-specific is wrong. But a 2026-07-03
local reproduction campaign (details below) could **not** produce a standalone repro that
discriminates Bun from Node — in the test environment the same middleware fetches
intermittently hang under Node too. An upstream report whose repro also hangs under Node
would be dismissed on arrival. A 2026-07-03 GHA-hosted controlled A/B (same runner class as
the CI evidence, WAN eliminated — see its section below) went further: the minimal repro
does not hang under EITHER runtime there (0/40 vs 0/40), so the reduction not only fails to
discriminate, it fails to reproduce. Filing is blocked on a discriminating repro; a draft
skeleton is kept at the bottom. Filing is a maintainer decision — never filed automatically.

## The finding (CI-grade evidence)

When knext's compat lane runs the official Next.js e2e deploy tests with the standalone
server booted on **bun** instead of node, outbound `fetch()` from Next's edge-runtime sandbox
(middleware / edge routes run through `next/dist/compiled/edge-runtime` — undici compiled
into the bundle, executed under `node:vm`, wrapped by `next/dist/server/web/sandbox`)
**never resolves** for the affected test cases: the middleware awaits forever, the harness
times out at 60s, and the server log shows **zero** exceptions.

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
- **Not Bun-version-gated away:** still red on the 1.4.0 canary run 28622051531.
- The compat-matrix Bun row (`docs/compat-matrix.md`) carries this as a named reason the row
  stays ❌. Watch: weekly bun lane (Sunday 05:17 UTC).

## Verdict: blocked on a discriminating repro — do not file yet

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
   to name the syscall-level difference. **← now the primary path.**
3. Failing both, file with **suite-level** evidence only ("Next.js's official e2e deploy tests
   X and Y hang under `bun server.js`, pass under `node server.js`; six-run record") and be
   explicit that the standalone reduction does not yet transfer — weakest option, last resort;
   after path 1's clean 0/80 this option is weaker still, since we now hold controlled
   evidence that the minimal mechanism is NOT bun-broken in isolation.

## Issue draft skeleton (oven-sh/bun) — DO NOT FILE until a discriminating repro exists

**Title:** Outbound `fetch()` from Next.js's edge-runtime sandbox (bundled undici under
`node:vm`) never resolves under `bun server.js`; same build passes under Node

**Body (fill the bracketed evidence before filing):**

> Running Next.js's official e2e deploy tests against a standalone build served with
> `bun server.js`, outbound HTTPS `fetch()` calls from edge middleware never resolve —
> `test/e2e/middleware-fetches-with-any-http-method` (both the plain-`fetch` and
> `new Request` cases) and an edge-page POST-fetch case in `test/e2e/app-dir/app-static` time
> out at 60s with no server-side exception. The identical build served with `node server.js`
> passes every one of these cases on the same infrastructure (six paired CI runs; red on Bun
> 1.3.14 and on 1.4.0 canary).
>
> **Repro:** [REQUIRED — attach the discriminating repro transcript from a controlled
> environment: repro app + N-runs-per-runtime hang counts showing bun-hangs/node-clean.
> Until that exists this report must not be filed. Path-1 attempt 2026-07-03 (GHA-hosted
> A/B, local HTTPS echo, run 28650729775) produced 0/40 hangs on BOTH runtimes — the
> minimal reduction does not reproduce; this slot cannot be filled from it.]
>
> **Impact:** Next.js middleware / edge routes that make outbound requests (auth token
> exchanges, webhooks, revalidation pings) stall when the app is served with Bun.
>
> **Expected:** the sandboxed `fetch()` resolves or rejects, as under Node.
