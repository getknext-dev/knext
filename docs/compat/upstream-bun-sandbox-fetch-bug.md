# Upstream Bun bug: edge-sandbox outbound `fetch()` never resolves (POST class — persists on 1.4.0)

**Status:** **FILE-WORTHY — live and unfixed.** Persists on Bun 1.4.0 (knext CI canary run
28622051531, 2026-07-02: `middleware-fetches-with-any-http-method` still red; local re-repro
2026-07-03 below narrows exactly which case persists). knext carries this as a documented gap —
no clean workaround. Ready-to-file oven-sh/bun issue draft at the bottom; filing is a
maintainer decision — never filed automatically.

## The bug

Outbound `fetch()` from Next.js's edge-runtime sandbox (Next runs middleware/edge routes
through `next/dist/compiled/edge-runtime` — undici compiled into the bundle, executed under
`node:vm`, wrapped by `next/dist/server/web/sandbox`) **never resolves** under Bun for a
POST-shaped class of requests. The request never reaches the target; the middleware awaits
forever; the client times out. The same build under Node resolves everything.

Narrowed shape (local re-repro, 2026-07-03, Next.js 16.2.0 standalone; probe timeout 15s):

| Case (middleware fetch to external HTTPS echo) | Bun 1.3.14 (darwin native + linux docker) | Bun 1.4.0 (`oven/bun:canary` pulled 2026-07-03, linux docker) | Node 24.14.0 |
|---|---|---|---|
| `fetch(url, { method: 'GET', headers })` | resolves | resolves | resolves |
| `fetch(url, { method: 'POST', headers })` | **HANGS** | resolves (fixed) | resolves |
| `fetch(new Request(url, { method: 'POST', headers }))` | **HANGS** | **HANGS** | resolves |
| any same-origin sandbox fetch issued after a hung one | — | **HANGS** (pool poisoning) | resolves |
| `fetch(url, { method: 'POST' })` to a **local plain-HTTP** target | resolves | resolves | resolves |

So on 1.4.0 the plain-`fetch` POST case was fixed, but the **`Request`-object POST case still
hangs**, and one hung request poisons subsequent sandbox fetches to the same origin — exactly
why `middleware-fetches-with-any-http-method` (whose second test case uses
`fetch(new Request(url, { method }))`) stayed red on the 1.4.0 canary run.

Two negative results that localize the bug (both re-run 2026-07-03):

- **Raw `EdgeRuntime.evaluate()` does NOT reproduce**: running the identical fetch expressions
  (`POST` plain and `new Request` input, same external HTTPS URL) directly through
  `new EdgeRuntime()` from `next/dist/compiled/edge-runtime` resolves under Bun 1.3.14 **and**
  1.4.0. The hang requires Next's full sandbox layer (`next/dist/server/web/sandbox` — its
  module context plus the `context.fetch` wrapper that rebuilds init/headers across the vm
  realm boundary) on top of the bundled undici.
- **Plain HTTP to a local target does not reproduce** — TLS appears to be part of the trigger.

## Minimal repro (actually run, 2026-07-03)

Minimal Next app (mirrors the upstream fixture
`test/e2e/middleware-fetches-with-any-http-method` at v16.2.0):

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

Build and boot the standalone output with bun (adjust the standalone subpath to where
`server.js` lands in your tree):

```sh
npm install && npx next build
cd .next/standalone/<repo>/<app> && PORT=3000 HOSTNAME=127.0.0.1 bun server.js
```

Probe (run with node; 15s timeout marks the hang):

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

Observed output, fresh server per run (2026-07-03):

```
# oven/bun:1.3.14 (linux docker; same natively on darwin-arm64 bun 1.3.14)
POST /?kind=normal-fetch: TIMEOUT (15s)
POST /?kind=new-request: TIMEOUT (15s)
GET  /?kind=new-request: 200 resolved={"url":"/api/echo-headers",...}

# oven/bun:canary → reports 1.4.0 (linux docker, pulled 2026-07-03)
GET  /?kind=new-request: 200 resolved={"url":"/api/echo-headers",...}
POST /?kind=new-request: TIMEOUT (15s)          <- still broken on 1.4.0
POST /?kind=normal-fetch: 405 resolved={"url":...}  <- fixed on 1.4.0
GET  /?kind=normal-fetch: TIMEOUT (15s)          <- poisoned by the hung request above

# node server.js (Node 24.14.0): all four resolve
```

## How this bit knext's compat suite

Bun-lane campaign #188 / PR #189 (rounds 1–3): `middleware-fetches-with-any-http-method`
(2 cases, 60s harness timeouts, zero server-side exceptions) plus `app-static`'s POST-fetch
case (an edge-runtime page, `/variable-revalidate-edge/post-method-request`) — red on Bun
1.3.14 (runs 28607626868, 28612654960, 28616072395, 28618585946) and **still red on the 1.4.0
canary run 28622051531**. Also documented: the ledgered
`server-actions-redirect-middleware-rewrite` wobble overlaps this mechanism class (PR #189
round 3). Swapping `context.fetch` out from under the sandbox was rejected as a workaround —
it would break inline-asset fetches (`fetchInlineAsset`). The compat-matrix Bun row
(`docs/compat-matrix.md`) carries this as one of the named reasons the row stays ❌.

## knext status

- **Documented gap, no workaround shipped.** 2 official deploy-test files red on the bun lane
  trace to this bug (`middleware-fetches-with-any-http-method`, `app-static`'s POST-fetch
  case).
- Not Bun-version-gated away: 1.4.0 fixes only the plain-`fetch` half. The `Request`-object
  half (an upstream test case) needs an oven-sh fix.
- Watch: weekly bun lane (Sunday 05:17 UTC). Re-run the probe above when a new Bun ships.

## Verdict: file it

Live on the newest Bun (1.4.0), deterministic, scripted repro with a Node control, and the
narrowing (plain-POST fixed / Request-POST not; raw EdgeRuntime clean; local-HTTP clean; pool
poisoning after a hang) hands the maintainers a tight search space.

## Ready-to-file issue draft (oven-sh/bun)

**Title:** `fetch(new Request(url, { method: 'POST' }))` inside Next.js's edge-runtime sandbox
(bundled undici under `node:vm`) never resolves; plain-object POST was fixed in 1.4.0, the
Request-object form still hangs

**Body:**

> **What:** Outbound HTTPS `fetch()` from Next.js's edge middleware sandbox (Next executes
> middleware via `next/dist/compiled/edge-runtime` — a bundled undici — under `node:vm`,
> wrapped by `next/dist/server/web/sandbox`) never resolves under Bun for POST-shaped
> requests. The promise neither resolves nor rejects; the request never completes. The same
> standalone build under Node works for every case.
>
> **Version matrix** (Next.js 16.2.0 `output: 'standalone'`, probe timeout 15s):
>
> | middleware fetch shape (external HTTPS target) | bun 1.3.14 | bun 1.4.0 (canary, 2026-07-03) | node 24 |
> |---|---|---|---|
> | `fetch(url, { method: 'POST', headers })` | hangs | **fixed** | ok |
> | `fetch(new Request(url, { method: 'POST', headers }))` | hangs | **still hangs** | ok |
> | `fetch(url, { method: 'GET', headers })` | ok | ok | ok |
> | any later sandbox fetch to the same origin after a hang | — | hangs (pool poisoned) | ok |
>
> Reproduced on linux-x64/arm64 (`oven/bun:1.3.14`, `oven/bun:canary`) and natively on
> darwin-arm64 (bun 1.3.14).
>
> **Repro:** minimal Next app — `middleware.js` doing
> `fetch(new Request('https://…/api/echo-headers', { method: req.method }))` (the exact shape
> of Next's own e2e test `test/e2e/middleware-fetches-with-any-http-method`), built with
> `output: 'standalone'`, booted with `bun server.js`. `POST /` → the middleware await hangs
> forever; `GET /` → 200. Full app + probe script:
> https://github.com/getknext-dev/knext/blob/main/docs/compat/upstream-bun-sandbox-fetch-bug.md
>
> **Narrowing already done:**
> - Running the identical fetch expressions directly via `new EdgeRuntime().evaluate(...)`
>   (same `next/dist/compiled/edge-runtime` bundle, no Next sandbox wrapper) resolves fine
>   under both Bun versions — the hang needs Next's sandbox layer on top (its `context.fetch`
>   wrapper rebuilds init/headers across the vm realm boundary).
> - POST to a **plain-HTTP local** target does not hang — TLS is part of the trigger.
> - Under 1.3.14 the plain-object POST form also hung; 1.4.0 fixed that half, so whatever
>   changed there likely points at the remaining Request-object path.
>
> **Impact:** any Next.js app using middleware or edge routes that make outbound POST
> requests (auth token exchanges, webhooks, revalidation pings) cannot be served with
> `bun server.js` — the affected routes time out. Discovered running Next's official e2e
> deploy suite under Bun (2 test files red on 1.4.0 from this bug alone).
>
> **Expected:** the sandboxed `fetch()` resolves or rejects, as it does under Node.
