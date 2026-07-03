# Upstream Bun bug: keep-alive socket reset on immediate reuse (≤1.3.14, fixed in 1.4.0)

**Status:** **MONITOR-ONLY — no upstream filing recommended.** Fixed in Bun 1.4.0
(verified live in knext CI run 28622051531, `oven/bun:canary` observed `1.4.0`, 2026-07-02:
the keep-alive guard self-disabled and every socket-hang-up family stayed green). knext ships a
self-disabling workaround (`packages/kn-next/src/adapters/bun-keepalive-guard.cjs`) for the
affected versions. A contingency issue draft is kept below in case Bun 1.4 **stable** regresses.
Filing is a maintainer decision — never filed automatically.

## The bug

On Bun ≤1.3.14, a plain `node:http` server (no Next.js involved) can RESET a reused keep-alive
socket when the next request arrives immediately after the previous response completed. A
Node-style keep-alive client (the Next.js e2e harness uses node-fetch@2 over Node ≥19's
keep-alive `globalAgent`) reusing sockets back-to-back sees `ECONNRESET` → `FetchError: …
socket hang up`. Single requests succeed; reuse delayed ≥~50ms succeeds — only small/fast
responses (tiny 404s, draft-mode enables, header dumps, hashed SVGs) lose the race.

Root-cause isolation (bun-lane compat campaign, #188 / PR #189, round 1):

- Baseline run **28607626868** (Bun 1.3.14, linux-x64): 30 of 39 bun-lane failures were
  per-request TCP aborts (`socket hang up`) from the standalone server.
- The one-flag discriminator **exonerated** knext's `cache-control-normalize` preload
  (`KNEXT_CACHE_CONTROL_NORMALIZE=0` reproduced identical hang-ups).
- Applying `Connection: close` per response (nothing else) flipped ~33 failing files in run
  **28612654960** — the reset is unreachable once clients stop reusing sockets.
- Canary run **28622051531** (observed Bun `1.4.0`): guard self-disabled (keep-alive semantics
  restored) and the hang-up families stayed green → fixed upstream.

The campaign record (`bun-keepalive-guard.cjs` module header, PR #189 body) states the reduced
plain-`node:http` repro was verified on **linux-x64 and darwin-arm64** at the time (2026-06/07,
Bun 1.3.14).

## Repro script (as re-run 2026-07-03 — see honesty note below)

Server (run under the Bun version being tested):

```js
// keepalive-server.js — plain node:http, no frameworks. Run: bun keepalive-server.js
const http = require('node:http');
http
  .createServer((req, res) => {
    res.end('ok');
  })
  .listen(3123, () => console.log('listening', process.versions.bun ?? process.version));
```

Client (run under Node — the harness client shape):

```js
// keepalive-loop.js — N back-to-back keep-alive requests on one reused socket.
// Run: node keepalive-loop.js 500 0   (500 iterations, 0ms delay between reuse)
const http = require('node:http');
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const iterations = Number(process.argv[2] ?? 500);
const delayMs = Number(process.argv[3] ?? 0);

function get() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: 3123, path: '/', agent }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', (err) => reject(Object.assign(err, { reused: req.reusedSocket })));
  });
}

(async () => {
  let errors = 0;
  for (let i = 0; i < iterations; i++) {
    try {
      await get();
    } catch (err) {
      errors++;
      console.log(`iteration ${i}: ERROR ${err.code ?? err.message} (socket reused: ${err.reused === true})`);
      if (errors >= 5) break;
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log(`done: ${iterations} iterations, ${errors} errors (delay=${delayMs}ms)`);
  process.exit(errors > 0 ? 1 : 0);
})();
```

**Honesty note (2026-07-03 re-run):** on darwin-arm64 (macOS 15 / Darwin 25.5.0), against
`bun 1.3.14` (npm `bun@1.3.14` binary) and `bun 1.3.5`, this script — plus three sibling
client shapes (node-fetch@2 over a keep-alive agent, node-fetch@2 over Node 24's global agent
against a tiny-404 server, and a concurrent burst over `maxSockets: 1`) — did **NOT** reproduce
the reset across 3,500+ requests at 0ms reuse delay. The authoritative evidence therefore
remains the CI-scale isolation above (linux-x64, real harness load: 30 files red → green on
`Connection: close` alone → green again with the guard self-disabled on 1.4.0). The reset is a
race; standalone single-connection loops on this machine evidently do not tighten it enough.
This is the main reason the verdict below is monitor-only: we currently cannot hand Bun
maintainers a self-contained repro that fails deterministically outside the harness.

## Version matrix

| Bun version | Result | Evidence |
|---|---|---|
| 1.3.14 (linux-x64) | **AFFECTED** | knext CI run 28607626868 (30/39 files `socket hang up`); flip to green via `Connection: close` in run 28612654960 |
| 1.3.14 (darwin-arm64) | AFFECTED per campaign record | `bun-keepalive-guard.cjs` header (campaign-time verification); NOT reproduced in the 2026-07-03 standalone re-run (see honesty note) |
| 1.4.0 (canary, linux-x64) | **FIXED** | knext CI run 28622051531 (guard self-disabled, hang-up families green); local docker `oven/bun:canary` 2026-07-03 also clean |

## Impact

Any Node-style HTTP client that reuses keep-alive sockets back-to-back against a Bun-served
`node:http` server: node-fetch@2 (the Next.js e2e harness), undici/Node global fetch, browsers,
and the Knative activator. Failure shape is intermittent `ECONNRESET`/`socket hang up`
concentrated on small/fast responses.

## knext's workaround

`packages/kn-next/src/adapters/bun-keepalive-guard.cjs` — a dependency-free CJS preload
(`bun -r`), loaded only on the Bun runtime:

- Advertises `Connection: close` on every response before the app handler runs, so
  spec-honoring clients never reuse the socket and the race is unreachable.
- **Self-disables on Bun ≥1.4.0** (version gate `FIXED_MAJOR=1, FIXED_MINOR=4`, validated live
  on canary in run 28622051531). Unparseable Bun versions are treated as affected (fail-safe).
- Escape hatches: `KNEXT_BUN_KEEPALIVE_GUARD=0` disables; `=1` forces on (regression
  insurance). No-op under Node — the Node serving path is byte-identical (contract-tested).
- Trade-off while active (Bun ≤1.3.x only): clients, including the Knative activator, open a
  fresh connection per request. Documented in the README env section.

## Verdict: monitor, don't file

1. The bug is **already fixed** in Bun 1.4.0 (canary), verified live in knext CI.
2. We have no self-contained repro that fails outside the harness (2026-07-03 attempt above),
   so a report today would be "a race we can't demo, in a version you already fixed."
3. Action instead: when Bun **1.4 stable** ships, the weekly bun lane (Sunday 05:17 UTC) picks
   it up. If the hang-up families regress, the guard's version ceiling
   (`bun-keepalive-guard.cjs`) must be raised **and** the contingency issue below becomes
   file-worthy with the new run ID attached.

## Contingency issue draft (oven-sh/bun) — only if 1.4 stable regresses

**Title:** Regression: `node:http` server resets reused keep-alive sockets on immediate reuse
(was fixed in 1.4.0 canary)

**Body:**

> A plain `node:http` server under Bun resets a reused keep-alive socket when the next request
> arrives immediately after the previous response completes. Node-style keep-alive clients
> (node-fetch@2 / undici over a keep-alive agent) see intermittent `ECONNRESET` ("socket hang
> up"), concentrated on small/fast responses; single requests and reuse delayed ≥~50ms succeed.
>
> This affected Bun ≤1.3.14 and was **fixed in the 1.4.0 canary** (we verified the fix at CI
> scale on 2026-07-02: a Next.js e2e deploy-test suite that showed ~30 files of keep-alive
> hang-ups on 1.3.14 went green on `oven/bun:canary` 1.4.0 with our `Connection: close`
> workaround disabled). We are seeing it again on `<VERSION>` (regression).
>
> **Server (run with bun):**
> ```js
> require('node:http').createServer((req, res) => res.end('ok')).listen(3123);
> ```
> **Client (run with node):** issue back-to-back GETs over
> `new http.Agent({ keepAlive: true, maxSockets: 1 })` — under load the reused socket is reset.
> At small scale the race can need harness-level concurrency to trigger; evidence at scale:
> knext CI runs 28607626868 (fail, 1.3.14) → 28612654960 (green with `Connection: close`) →
> 28622051531 (green on 1.4.0-canary, workaround off) → `<NEW RUN ID>` (regressed).
>
> **Expected:** a keep-alive socket accepted for reuse is either served or closed gracefully
> (FIN before/instead of RST), as Node behaves.
