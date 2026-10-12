# ADR-0068: CDN cache tier — cache-correct edge headers and tag purge, no provisioning

- **Status:** **Proposed (2026-10-12).** Exit: **Accepted at the Sprint 4 design gate** (architect +
  system designer) **before CDN-1 (#2259) or CDN-2 (#2260) start building.** This is the one Sprint 4
  task whose acceptance is a build gate, because it amends a `CLAUDE.md` stance (design before code).
  jev on the status: Proposed until the gate **0.83** / Accepted on merge 0.17.
  **Revision 1 (2026-10-12)** applies design-gate round 1 on #2266: the system designer's block
  (middleware auth bypass, now D4.1 condition 10) and required edits, and the architect's four
  required edits. Each change is marked "(gate r1)" where it lands.
  **Revision 2 (2026-10-12)** applies gate round 3, one item from each gate, both in condition 10.
  The architect's: the matchers now come from the official `onBuildComplete` outputs, through a
  knext-owned artifact, instead of Next's internal manifests. The system designer's: the rule now says
  which pathname is tested (raw and decoded, the data-route path, and a conservative i18n rule). Marked
  "(gate r3)".
- **Date:** 2026-10-12
- **Trigger class:** ADR (amends the `CLAUDE.md` §8 "defer global CDN" stance for the header + purge
  slice) + CRD (`spec.cdn` on `NextApp`) + public API (`knext.config.ts` key, CR builder, preflight) +
  security (a credential used for an outbound call, new response headers, a cache-poisoning surface).
- **Relates to:** ADR-0001 (the operator is the only renderer of cluster state; the CLI writes only the
  CR), ADR-0011 (build-ID asset retention, which canary safety depends on), ADR-0027 (`globalThis`
  seams; the tag seam below is one), ADR-0044 (in-process preloads on the standalone server; the header
  rules live in that preload set), ADR-0047 (object storage is optional), ADR-0061 (the cloud
  contract and its tripwires; this ADR stays inside them), ADR-0066 (the cache runtime this hooks
  into; #2254 and #2083 land first), ADR-0067 (`public-origin.cjs`, whose `Vary` the CDN ignores).
- **Covers:** #2258 (Sprint 4 CDN-0), part of #2232. Decides the system designer's Sprint 4 amendments
  **A1–A8** explicitly; Appendix B maps each amendment to the decision that settles it.
- **Decision method:** every choice is scored with jev (`jev-1.13.0`). The score is quoted where the
  choice is made. The evidence a choice rests on is the code line, package line or provider document
  next to it, not the score. Where jev's confidence is low, the ADR says so and states what evidence
  would reverse the choice.

## Context

### What changed

`CLAUDE.md` §8 sorts Vercel's surface into three buckets and defers bucket 1, "architectural edge we
can't easily close (global CDN, edge middleware/PPR)". The founder has prioritised CDN caching across
clouds for v2 Sprint 4 (#2232, scope pick 0.98). The research for #2232 found that most of the "global
CDN" gap is not architectural: an adapter can emit cache-correct headers, and call a purge API when the
app revalidates. OpenNext (AWS and Cloudflare) and Netlify do this. That slice moves from "defer" to
"build". Edge compute, edge middleware and PPR at the edge stay in bucket 1, and stay deferred.

Sprint 4 planning scored the scope against the hard rules, conditional on the fence in D1 below:
violates "not a PaaS" **0.20** (no), violates ADR-0001 **0.27** (no). CLI-side and operator-side
purge were rejected (0.01 / 0.00).

### What knext does today

- `packages/kn-next/src/adapters/cache-control-normalize.cjs` rewrites every `s-maxage` value on a
  GET/HEAD response to `public, max-age=0, must-revalidate`. That is the value the official deploy-mode
  compatibility suite asserts. Immutable values pass through. `response-cache-control.mjs` and
  `bun-serve-cache-control.mjs` apply the same rule on the vinext seams.
- `KNEXT_CACHE_CONTROL_NORMALIZE=0` turns that off. It is today's only "bring your own CDN" path: Next's
  raw `s-maxage` reaches the CDN, with no tags, no purge and no never-cache guarantees beyond what Next
  itself sets.
- Static assets can already be offloaded to object storage behind `storage.publicUrl` (`assetPrefix`),
  with build-ID retention (ADR-0011). That path is unchanged here.

### Facts verified for this ADR

Read from the released packages, not from canary. (The #2232 research read canary; these close its
gaps 7a and 7b.)

1. **The tags never reach the response on knext's path.** knext runs Next's own standalone server in
   non-minimal mode. `next@16.4.0` `dist/build/templates/app-page-runtime.js:1364-1366` deletes
   `x-next-cache-tags` from the cached headers unless `isMinimalMode && isSSG`, and `:1320-1322` /
   `:1383-1385` re-add it only in minimal mode. `app-route.js:321-323` does the same for route
   handlers. `next@16.3.5` is identical (`app-page-runtime.js:1185-1187`, `app-route.js:328-330`). So
   the header preload cannot read tags off the response, and the tags do not leak to clients today.
2. **The tags are visible to knext's cache handler.** `cache-handler.js:829-855` reads them from
   `value.headers['x-next-cache-tags']` on `set` (and `ctx.tags` for the fetch kind); a `get` returns
   the stored entry carrying the same header.
3. **One `revalidateTag` reaches both handlers.** `next@16.4.0` `dist/server/revalidation-utils.js:129-137`
   calls every `cacheHandlers[*].updateTags(tags)` **and** `incrementalCache.revalidateTag(tags)` for
   the same tags. `revalidatePath` arrives as an implicit `_N_T_<path>` tag on the same path.
4. **Invalidation is pod-local, over shared Redis.** `cache-handler.js:1328-1330`: `revalidateTag` runs
   in the pod that received the call, deletes shared-Redis keys, and is tracked by the drain registry
   (`trackWrite`, `cache-write-registry.js`). There is no per-pod fan-out:
   `spec.revalidation.provisionKafkaSource` is inert (`nextapp_types.go:838-859`).
5. **Outbound calls need no policy change.** The default NetworkPolicy is ingress-only
   (`nextapp_controller.go:1956`).
6. **The CDN ignores `Vary`.** `public-origin.cjs` adds `Vary: X-Forwarded-Host, Host` to a rewritten
   3xx (ADR-0067). Cloudflare ignores `Vary`.
7. **Env-name reservation exists, but only for names the operator renders.** Admission rejects a new
   `secrets.envMap` key that collides with a reserved name (`validation/validate.go:762`), and the
   renderer drops a colliding `spec.env` name with a Warning (`nextapp_controller.go:1640-1676`). A name
   the operator does **not** render passes straight through.
8. **No CEL rule may pair `spec.build` with `spec.runtime`.** `tests/adr-state-claims.test.ts` reds on
   any CEL rule mentioning `self.build`, so "reject CDN on vinext" cannot be a CEL rule.
9. **The official adapter API hands knext the middleware matchers.** (gate r1, rewritten gate r3)
   The `onBuildComplete` contract (`next@16.4.0` `dist/build/adapter/build-complete.d.ts:286-309`):
   - `outputs.middleware` is present only when the app has a middleware/`proxy` file.
   - Its `config.matchers` is an array of `{ source, sourceRegex, has, missing }`.
   - The same `ctx` carries `ctx.config`, which includes `basePath` and `i18n`.

   knext's adapter already receives all of this. Today it only counts it
   (`packages/kn-next/src/adapters/next-adapter.ts:265`). A matcher can carry `has`/`missing`
   conditions on headers, cookies and query. Next's internal build manifests
   (`functions-config-manifest.json`, `middleware-manifest.json`) hold the same data, but they are not
   a contract. Reading them would be reverse-engineering, which the official-adapter rule forbids.

### Provider facts (primary sources in the #2232 research)

| Provider | Tag purge | Edge-only directive header | Notes that shape the design |
|---|---|---|---|
| Cloudflare | Yes, `POST /zones/{id}/purge_cache` `{tags}`, Bearer token, ≤100 per request; Free 5/min, bucket 25 | `Cloudflare-CDN-Cache-Control` | Strips `Cache-Tag` before the visitor. `s-maxage` turns SWR off. Does not cache `Set-Cookie` responses. A 200 means "received", not "evicted" |
| AWS CloudFront | Yes, opt-in `CacheTagConfig` (configurable header, ≤50 tags/object); path invalidation | None documented | API calls need SigV4 signing (IAM) |
| Google Cloud CDN | Yes, `Cache-Tag` (≤50 tags, ≤120 B each, ≤4 KiB; over-limit responses are **not cached**) | `CDN-Cache-Control` | Forwards tags to clients. Purge needs an OAuth access token (IAM); 500 req/min |
| Azure Front Door | **No** (path or root only, up to 10 min) | None documented | Purge needs an Azure AD token |
| OCI | **No CDN product** (WAAS path purge only) | — | OKE users are pointed at a CDN that fronts any origin |

Next limits: ≤128 tags per entry, ≤256 characters each. A tag is an arbitrary string; it can contain a
comma or non-ASCII characters.

Research gaps that stay open, and why they do not block this ADR: CloudFront tag-invalidation
propagation and in-flight limits, and Azure's English caching page, matter only to purge rows this ADR
defers (D2). Two Cloudflare behaviours are checked live in CDN-4 rather than assumed: how
`stale-while-revalidate` behaves inside `Cloudflare-CDN-Cache-Control`, and whether HTML is cached on
origin directives alone or needs a user Cache Rule. The user docs follow what CDN-4 records.

## Decision

### D1. Scope fence (jev: fence **1.00**, IaC emit 0.00, headers-only 0.00)

knext emits cache-correct headers and calls a provider's tag (or path) purge API. The **user owns the
CDN**: creates it, points it at the app's public hostname, configures its cache rules, and creates a
minimally scoped purge credential as a Kubernetes Secret. knext never creates, configures or reads
the state of a CDN resource.

Inside the ADR-0061 tripwires, item by item:

1. **No cloud SDK** in `packages/`, in the runtime or the operator. Purge calls are plain `fetch` to a
   hardcoded HTTPS endpoint. A provider whose API needs request signing (SigV4, OAuth, Azure AD) does
   not get a purge implementation under this ADR (D2).
2. **No cloud CLI** invoked by knext.
3. **No stored cloud-account credential.** The purge token is a user-created, user-owned, data-plane
   Secret in the app's namespace, referenced by name. The CRD holds only the reference. For
   Cloudflare the minimal scope is `Zone → Cache Purge` on one zone.
4. **No per-cloud branch in the operator.** The operator renders `spec.cdn` into env as opaque values.
   The provider rows (D2) live in the runtime as data.
5. **No new CLI cluster write.** The CLI maps `knext.config.ts` to `spec.cdn` through the CR builder.
   The CLI and the operator never call a purge API (ADR-0001; Sprint 4 rejected both, 0.01 / 0.00).

Out of scope, stated so it is not re-proposed under this ADR: CDN provisioning, edge compute, edge
middleware, PPR at the edge, WAF, multi-region.

### D2. Providers are data rows, not code branches (jev: Cloudflare + emulator purge now **0.65**, Cloudflare only 0.35, all four now 0.00; confidence 0.48)

Each provider is one row in a runtime table. A row carries: the edge directive header, the tag header
and its limits (count, bytes per tag, total bytes), whether the provider's default cache key includes
the query string, whether `_rsc` responses may be edge-cached (D4.3), the purge endpoint template, the
purge batch size, and the default purge rate.

| Row | Edge directive | Tag header and limits | Keys on query by default | Purge in this ADR |
|---|---|---|---|---|
| `cloudflare` | `Cloudflare-CDN-Cache-Control` | `Cache-Tag`, ≤16 KB total | yes | **yes**: tags, ≤100 per request, `https://api.cloudflare.com/client/v4/zones/{target}/purge_cache`, default 5/min, bucket 25 (Free; the conservative plan) |
| `google-cloud-cdn` | `CDN-Cache-Control` | `Cache-Tag`, ≤50 tags, ≤120 B, ≤4 KiB | yes | **deferred** (needs an OAuth signer) |
| `cloudfront` | `s-maxage` inside `Cache-Control` | `Cache-Tag` (the user sets `CacheTagConfig.HeaderName` to match), ≤50 tags | depends on the user's cache policy: treated as no | **deferred** (needs SigV4) |
| `azure-front-door` | `s-maxage` inside `Cache-Control` (honour-origin mode) | none | depends on the user's rule: treated as no | **deferred** (path purge, needs an Azure AD token) |
| `emulator` | `Cloudflare-CDN-Cache-Control` | `Cache-Tag` | yes | **yes**, Cloudflare-shaped, at a `*.svc.cluster.local` endpoint only (D10) |

There is **no OCI row**. OCI has no CDN product. On OKE, the recommended path is Cloudflare in front of
the Kourier ingress (research pick: Cloudflare **1.00**).

**What each row can claim (gate r1).** Only `cloudflare` gets a live run in this ADR (CDN-4). The
`google-cloud-cdn`, `cloudfront` and `azure-front-door` header rows are unit- and emulator-tested only.
The user docs and `docs/compat-matrix.md` make **no "verified" or parity claim for any row without a
recorded live run**. A row's claim follows its evidence, row by row.

A deferred purge row is still useful: its header mode ships, and staleness is bounded by the edge TTL
(D8). A purge for a deferred row returns when a dependency-free signer is designed in its own ADR
amendment (#2270). That amendment must show it is not the start of a cloud SDK, and ADR-0061 should
then cross-reference that "signer ≠ SDK" bar.

**The `emulator` row sends a fixed dummy token** and never resolves `spec.cdn.purge.secretRef`
(gate r1, architect suggestion; jev yes **0.61**). Pointing a CR at an in-cluster listener then
cannot get a real token sent there. Setting `spec.cdn.purge` on a
deferred row is accepted by the CRD; the runtime makes no call, counts
`result="skipped_unsupported"`, and logs one line at boot (jev: runtime skip **0.94**, CEL reject
0.06). The operator stays provider-agnostic.

### D3. Config surface: `spec.cdn` on `NextApp`, rendered by the operator

Sketch (field names final unless CDN-1 review finds a conflict):

```yaml
spec:
  cdn:
    provider: cloudflare            # enum: cloudflare | google-cloud-cdn | cloudfront | azure-front-door | emulator
    htmlTTLSeconds: 30              # 1..3600, default 30 (D8)
    staleWhileRevalidateSeconds: 0  # 0..3600, default 0 (D8)
    excludePaths: ["/account"]      # optional path prefixes that are never edge-cached
    includePaths: ["/blog"]         # optional; opts middleware-matched prefixes back in (D4.1 condition 10)
    purge:                          # optional; absent = headers only
      secretRef: {name: cdn-purge, key: token}   # same-namespace Secret, user-created
      target: "<zone id>"           # opaque provider resource id
      requestsPerMinute: 5          # optional; overrides the row's default rate
    emulatorEndpoint: http://cdn-emulator.e2e.svc.cluster.local:8080   # only with provider: emulator
```

- **No `tagPrefix` field.** The prefix is derived by the operator (D5.3, A5).
- **The operator renders env and nothing else.** `KNEXT_CDN_PROVIDER`, `KNEXT_CDN_TAG_PREFIX`,
  `KNEXT_CDN_HTML_TTL_SECONDS`, `KNEXT_CDN_SWR_SECONDS`, `KNEXT_CDN_EXCLUDE_PATHS`,
  `KNEXT_CDN_INCLUDE_PATHS`, `KNEXT_CDN_PURGE_TARGET`, `KNEXT_CDN_PURGE_RPM`, `KNEXT_CDN_EMULATOR_ENDPOINT`, and
  `KNEXT_CDN_PURGE_TOKEN` as a `secretKeyRef` (the `DATABASE_URL` mechanism). jev: secretKeyRef env
  **0.99**, file mount 0.01. The build ID the tags use is the existing resolver
  (`.next/BUILD_ID` → `KNEXT_BUILD_ID` → `NEXT_DEPLOYMENT_ID`, ADR-0066 D2).
- **`KNEXT_CDN_*` is reserved unconditionally** (jev: reserved **0.93**, open 0.07). Admission
  rejects any `spec.env` or `secrets.envMap` key with that prefix, **whether or not `spec.cdn` is
  set**. Fact 7 is why "whether or not" matters: a name the operator does not render would otherwise
  pass through, and a CR could pick its own tag prefix or emulator endpoint. The renderer also drops
  such a name with a Warning, as defence in depth for a CR that predates the rule.
  **This guarantee needs a CDN-1+ operator (gate r1).** An older operator reserves nothing under
  `KNEXT_CDN_*`, so a CDN-capable runtime running under it honours a user-set
  `KNEXT_CDN_TAG_PREFIX`. "Unforgeable from the CR" therefore holds only when the operator/CRD is
  upgraded first, before the CLI or runtime. That upgrade order is load-bearing here, not a convention.
- **CEL, within `spec.cdn` only:** `emulatorEndpoint` is allowed if and only if
  `provider == 'emulator'`, and must match an `http(s)://<host>.svc.cluster.local[:port]` pattern with
  no path, userinfo or query. No rule mentions `spec.build` (fact 8).
- **Provider identifiers** go in one opaque `purge.target` string (jev: opaque **0.58**, in the Secret
  0.25, per-provider sub-structs 0.17; confidence 0.37). The runtime row validates its format
  (Cloudflare: 32 hex) and fails closed: no call, `result="skipped_invalid_target"`.
- **Zero diff without `spec.cdn`.** No env is rendered, so the pod template is byte-identical and no
  revision is created. CDN-1's golden guard proves it. Adding, changing or removing `spec.cdn` does
  roll a revision; that is the normal cost of a config change.
- **`knext.config.ts`** gets a `cdn` key mapped by `cr-builder.ts`. The CLI preflight
  (`src/cli/schema/`) learns the new fields, so a CLI emitting `spec.cdn` against an older CRD fails
  the strict dry-run before touching the cluster. Upgrade order stays operator/CRD first, then CLI.

### D4. Response headers: edge-cacheable only by allowlist

The header preload (`cache-control-normalize.cjs`, extended; Node and Bun standalone) decides, per
response, whether to add an edge directive. The browser-facing `Cache-Control` keeps today's
compat-normalized value on every row that has an edge-only header (jev: provider edge header **0.97**,
`s-maxage` everywhere 0.03). So turning on `spec.cdn` for Cloudflare or Google changes nothing a
browser or the compat suite sees.

**D4.1 The allowlist (A4).** A response gets an edge directive **only if every condition holds**.
Anything not positively allowed is not edge-cacheable:

1. The request method is GET or HEAD.
2. The status is 200.
3. Next itself emitted a shared-cache directive: the origin `Cache-Control` carried `s-maxage`, or
   `immutable` (hashed build assets). This alone excludes dynamic renders, `/_next/image` and
   redirects, because Next sets no `s-maxage` on them.
4. The origin `Cache-Control` has no `private`, `no-store` or `no-cache`.
5. The response carries no `Set-Cookie`.
6. The request carries no `Authorization` header and no draft-mode cookie (`__prerender_bypass`).
7. The path is not under `/api/cache/` and not under any `spec.cdn.excludePaths` prefix. Path prefixes
   (`excludePaths`, `includePaths`, `/api/cache/`) are compared against the **decoded** pathname, at a
   **segment boundary**: `/blog` covers `/blog` and `/blog/x`, never `/blogger`. A pathname that fails
   to decode is treated as excluded (gate r3).
8. For a non-immutable response: the **request's own page or route entry tags were recorded,
   including its implicit `_N_T_` path tag** (D5.1), and they fit the row's limits (D5.4). (gate r1:
   fetch-kind tags alone are not enough. On an ISR miss they can be recorded before `writeHead` while
   the page entry's `set`, which carries the path tag, lands after the first flush. Caching then would
   store an entry `revalidatePath` cannot purge.)
9. The RSC rule (D4.3) allows it.
10. **The path is not matched by the app's middleware/`proxy` matcher, unless it is under a
    `spec.cdn.includePaths` prefix** (gate r1, system-designer block).

    **Where the matchers come from (gate r3, architect; jev: adapter artifact **0.91**, Next's internal
    manifests 0.09, confidence 0.82).** knext's `onBuildComplete` reads `outputs.middleware` and
    `ctx.config` (fact 9). It writes a knext-owned artifact, `knext-cdn-routing.json`, that **always
    exists**. The artifact records `basePath`, the `i18n` locales (or `null`), and either an explicit
    `middleware: "none"` or the list of matchers.
    - If middleware is present but has no `config.matchers`, the artifact records one match-all
      matcher.
    - The CDN-1 build step puts the artifact into the runtime image next to the standalone server. The
      preload reads it at boot.
    - **If the artifact is missing or unparseable, or a `sourceRegex` fails to compile, nothing
      non-immutable is edge-cached** (fail closed).
    - **Only an artifact that explicitly says `none`** makes paths eligible without `includePaths`.

    The preload never reads Next's internal manifests.

    **Which pathname is tested (gate r3, system designer; jev: the rule below **0.72**, reproduce Next
    exactly 0.27, raw pathname only 0.01, confidence 0.58).** Next does not match middleware on the raw
    `req.url`, so neither may the preload. A request counts as **matched if any candidate pathname
    matches any matcher**. The candidates are:

    - the raw pathname, `basePath` kept;
    - the `decodeURIComponent` pathname. Next tests the decoded form too, so without it `/%64ashboard`
      would skip a `/dashboard` matcher, which is web-cache deception. **If decoding fails, the request
      counts as matched**;
    - for a pages-router data request (`/_next/data/<buildId>/<path>.json`), the page path it
      normalizes to, with `/index` mapped to `/`.

    Two rules make the comparison over-match rather than under-match:

    - Each `sourceRegex` is compiled **case-insensitively**.
    - `has`/`missing` conditions are ignored, so a path whose regexp matches counts as matched.

    **i18n uses the conservative rule.** When the artifact records an `i18n` config and **any** matcher
    exists, **every path counts as matched**. Next inserts the detected or default locale before
    matching. That locale can depend on the `Host` (i18n `domains`), the `NEXT_LOCALE` cookie and
    `Accept-Language`. So a raw `/dashboard` can miss a raw-URL preload while Next's middleware ran on
    `/en/dashboard`, and the protected page would be edge-cached for anonymous users. Reproducing
    Next's locale detection would be a second implementation of Next's routing, the
    reverse-engineering this ADR rejects for the manifests. The conservative rule costs i18n apps with
    middleware only one thing: they opt paths in through `includePaths`. App Router apps do not use the
    `i18n` config and are unaffected.

    An app whose artifact says `middleware: "none"` is unaffected by condition 10.

**Why condition 10 exists.** Take a static or ISR page that session-cookie middleware protects. An
authenticated request passes conditions 1–9: it has no `Authorization` header, no draft cookie, no
`Set-Cookie`, and the status is 200. The CDN ignores the cookie and stores the page under the URL. The
next anonymous request is then served the protected page without the middleware ever running. That is
an auth bypass, not just a poisoning hazard (system designer: breaks the invariant **0.90**).

**Choice of fix** (jev: condition 10 + `includePaths` **0.95**, flip every app to an opt-in path list
0.05; confidence 0.90). Condition 10 makes middleware-matched paths opt-in, while apps without
middleware keep the default. The earlier scope pick stands for every path condition 10 lets through:
all eligible paths are edge-cacheable by default once `spec.cdn` is set (jev: all eligible **0.62**,
opt-in list 0.38, confidence 0.24; architect with a falsifiable reversal **0.93**, opt-in 0.07).
`excludePaths` (jev: add the field **0.90**) still fences paths that are cacheable for other reasons.

**Reversal criterion, falsifiable (gate r1, architect).** CDN-3a runs two named cases against the
`Vary`-ignoring emulator, using the default `spec.cdn` (no `includePaths`):

- **`cookie-gated-static`**: a statically rendered page behind cookie-checking middleware. Request it
  with the session cookie, then without one. **Pass** means the cookieless request never gets the
  protected body from the edge.
- **`middleware-cookie-variants`**: middleware rewrites one URL, by cookie, to two ISR variants that
  both carry `s-maxage`. Request variant A's cookie, then variant B's. **Pass** means B never gets A's
  body from the edge.

Two more named cases cover the pathname rule (gate r3, system designer):

- **`i18n-default-locale`**: a pages-router app with `i18n` and a matcher written for the
  locale-prefixed path. Request raw `/dashboard` (no locale) with the session cookie, then without it.
  **Pass** means the cookieless request never gets the protected body.
- **`encoded-path`**: request `/%64ashboard` with the session cookie, then `/dashboard` and
  `/%64ashboard` without it. **Pass** means neither cookieless request gets the protected body. A
  malformed escape such as `/%E0%A4%A` must also never be edge-cached.

**Soundness test (gate r3).** A test middleware records every pathname it runs on. For a corpus of
requests, the test asserts **"Next's middleware ran ⇒ the preload counted the request as matched"**.
The corpus covers encoded, double-encoded and malformed paths, mixed case, `basePath`,
trailing-slash, `/_next/data/…json`, and i18n requests with and without a locale, across two `Host`
values when i18n `domains` is set. Over-matching is allowed; under-matching fails the test. This is
the practical form of "the preload tests what Next tests". The reverse direction is not required,
because over-matching only costs cache hits.

All four cases and the soundness test are in the **mutation-proved** condition-10 set. All pass under
condition 10. The two original cases each run a second time with the path listed in `includePaths`. There the wrong variant is expected, which shows
`includePaths` is a real opt-out of the protection and the docs must say so.

**If either case fails in its default form, the ADR flips to an opt-in path list for every app**, and
this section records it as reversed. If both pass, the default stands, and this paragraph is the record
of why.

Extending the allowlist with a general `Vary` condition was weighed and not taken: condition 3 already
excludes the known `Vary` cases (jev: omit **0.62**, require 0.38; confidence 0.24).

**D4.2 The directive.** Edge max-age = `min(Next's s-maxage, htmlTTLSeconds)` for HTML, RSC and route
responses, plus `stale-while-revalidate=<staleWhileRevalidateSeconds>` when that is non-zero. The edge
never holds an entry longer than Next would. On Cloudflare the directive goes in
`Cloudflare-CDN-Cache-Control` as `max-age=N[, stale-while-revalidate=M]`, never `s-maxage`, because
`s-maxage` turns SWR off there. Immutable build assets keep Next's own
`public, max-age=31536000, immutable` and are never tagged or purged. On the two rows without an
edge-only header (CloudFront, Azure) the browser value becomes
`public, max-age=0, s-maxage=N[, stale-while-revalidate=M]`. That is a deliberate deviation from the
compat-normalized value, only on those opt-in rows; `must-revalidate` is dropped because it would
disable SWR at the shared cache. **That browser value is outside the compat-verified configuration**
(gate r1). The compat suite runs without `spec.cdn` and asserts the normalized value. No CloudFront or
Azure configuration may be described as compat-verified, and no row gets a "verified" claim without a
live run (D2).

**D4.3 The RSC rule (A3; SD pick 0.57 vs never-cache 0.42, confidence 0.36).** Two halves:

- **Hard rule, every row, every mode:** a request carrying `RSC: 1` or any `Next-Router-*` header
  **without** `_rsc` in the URL never gets an edge directive. Otherwise a `Vary`-ignoring CDN stores a
  flight payload under the HTML key and serves it to the next browser.
- **Symmetric hard rule (gate r1, architect), every row, every mode:** a request with `_rsc` in the URL
  but **without** `RSC: 1` never gets an edge directive. The response's `Content-Type` must also match
  the key. Under an `_rsc` key it must be `text/x-component`; under a non-`_rsc` key it must **not** be.
  The `_rsc` value is a deterministic hash. Without this rule, one crafted `?_rsc=<hash>` request with
  no RSC header would store HTML under the flight key for up to the TTL, breaking client navigation to
  that URL. jev scored the ADR as written 1.00 against adding the rule. The architect overrode that
  because jev reads the ADR literally, while the vector is reachable with a crafted URL and closing it
  costs one condition. Both halves, and the `Content-Type` check, are in the **mutation-proved** RSC
  test set for CDN-1 and CDN-3a.
- **With `_rsc` present**, the response may be edge-cached only on a row whose default cache key
  includes the query string (`cloudflare`, `google-cloud-cdn`, `emulator`). jev: on for those rows
  **0.57**, a per-row flag that ships off 0.43 (confidence 0.14, close to a coin flip). The SD
  condition "only once CDN-3 proves it" is kept: CDN-3a's `_rsc` case gates CDN-1's merge for these
  rows. If CDN-3a fails, the rows flip to off and the choice is recorded as reversed. CloudFront and
  Azure stay off, since their key depends on a user policy knext cannot see.

**D4.4 Redirects.** No 3xx is edge-cacheable (condition 2). Specifically, a 3xx carrying
`Vary: Host` or `X-Forwarded-Host` from `public-origin.cjs` must never be, because the CDN ignores that
`Vary` and would serve one host's redirect to another.

### D5. Cache tags

**D5.1 Source: a request-scoped seam** (jev: AsyncLocalStorage seam **0.99**, minimal mode 0.01,
path-only 0.00). Fact 1 rules out reading the response. The preload opens a per-request
`AsyncLocalStorage` store at `http.Server` `request` emit (the hook `request-body-cap.cjs` and
`public-origin.cjs` already use). The cache handler's `get` (hit) and `set` (render) record the entry's
resolved tags into the current store. The preload reads them at `writeHead`. Per ADR-0027 the store is
anchored on `globalThis` under `Symbol.for('knext.core.cdn.requestTags')`, never a module-level
binding, and the standalone build-artifact guard must cover it. **No recorded tags means not
edge-cacheable** (fail closed). That covers requests Next coalesces onto another request's render:
they get no tags, so they get no edge directive, which is safe. Minimal mode was rejected because it
changes Next's routing contract.

Three requirements added at gate r1:

- **Own-entry tags only.** The store records which entry each tag set came from. Only the tags of the
  request's own page or route entry, including its `_N_T_` path tag, satisfy D4.1 condition 8.
  Fetch-kind tags recorded on their own do not.
- **`'use cache'` tags are a stated assumption, tested.** Tags that come only from a `'use cache'`
  function (the plural handler) are purgeable only if Next copies them into the page entry's
  `x-next-cache-tags`. That copying is relied on, not verified. CDN-3b tests it: a page whose only tag
  comes from `'use cache'` must go HIT → `revalidateTag(thatTag)` → MISS. If that fails, such pages
  fail condition 8 and are not edge-cached until it is fixed.
- **Bun parity is proved, not assumed.** The seam depends on two things: an ALS context entered at
  `request` emit, and `writeHead` interception, including the implicit header flush on first `write`
  or `end` (`_implicitHeader`). Both must be shown to hold on **Bun's `node:http`**, not only on
  Node. CDN-1's unit tests and CDN-3a run on both runtimes. A path where Bun skips the interception
  must fail closed (no directive), never emit one.

**D5.2 Encoding** (jev: hashed **0.81**, raw 0.19; confidence 0.62). Every emitted tag is ASCII,
lowercase, comma-free and fixed-length:

- app tag: `kn-<p>` (on every non-immutable edge-cacheable response)
- build tag: `kn-<p>-b<first 12 hex of sha256(buildId)>`
- Next tag: `kn-<p>-t<first 16 hex of sha256(tag)>`, one per Next tag, including the implicit
  `_N_T_` path tags

The purge side applies the same function to the tag `revalidateTag` receives, so the two cannot
drift. Hashing makes a tag containing a comma, or a non-ASCII tag, unable to split or corrupt the
header. It also keeps every tag inside Google's 120-byte limit. Where a row forwards tags to clients
(Google), they are opaque. Debug logging can print the tag-to-hash mapping.

**D5.3 Prefix: operator-derived, not user-settable (A5; SD pick 0.86, confidence 0.72; jev on format:
hash **0.90**, readable 0.10).** `<p>` is the first 12 lowercase hex of `sha256("<namespace>/<name>")`,
rendered as `KNEXT_CDN_TAG_PREFIX`. D3 makes it unforgeable from the CR. The prefix stops one app's
purge from evicting another app's pages on a shared CDN zone by accident. **It is not a security
boundary against a token holder.** A Cloudflare `Zone.Cache Purge` token can purge any tag in its zone,
so hard isolation between knext zones (or tenants) means one Cloudflare zone, or one token, per knext
zone. That is the user's choice, and the docs must say so.

**D5.4 Overflow** (jev: not cacheable **0.96**, truncate 0.04). If `2 + n` tags exceed the row's count
or byte limits, the response gets no edge directive and is counted. Truncating would store an entry
that some `revalidateTag` can never purge. Google already refuses to cache over-limit responses, so
this matches the strictest row.

### D6. Purge

**D6.1 Originator: the origin pod (A1; SD pick 0.81, every pod 0.10, Redis outbox 0.09, confidence
0.72).** The pod that ran `revalidateTag` purges. Fact 4 voids the "every pod" premise: there is no
fan-out to purge from. A Redis outbox is rejected as over-engineering at this size.

**D6.2 Hook point: the singular `cacheHandler.revalidateTag` only** (jev: singular **0.77**, both
deduplicated 0.23; confidence 0.54). Fact 3: Next calls both handlers for the same tags, so purging
from `updateTags` too would double every purge. Edge-cacheable responses are page and route entries,
whose tags live in the singular handler. Verified on `next@16.4.0` and `next@16.3.5`, not canary. If a
future Next stops calling `incrementalCache.revalidateTag` next to `updateTags`, CDN-3b reds. The adapter
API has no revalidation hook, and `requestMeta.onCacheEntryV2` does not apply: knext runs Next's own
server, so nothing calls it.

**D6.3 Non-blocking, after the invalidation** (jev: enqueue **0.99**, await 0.01). `revalidateTag`
resolves when the Redis invalidation is done. The purge is enqueued afterwards, so a CDN miss racing
the purge cannot refill the edge from the entry being invalidated. Its promise is tracked in the drain
registry (`trackWrite`). A 429 must not hold a Server Action open for a minute.

**D6.4 Coalescing, rate and retries.**

- A per-pod queue deduplicates tags and flushes after 1 s, or at the row's batch size (Cloudflare 100).
- A token bucket sized from the row (Cloudflare default 5/min, bucket 25) or `requestsPerMinute`. The
  provider's limit is per account, so N pods can still exceed it. 429 handling covers that, and the
  TTL bounds the result.
- Bounded retries (jev: 3 attempts **0.59**, one shot 0.29, unbounded 0.12; confidence 0.38): at most
  3 attempts per batch. On 429, honour `Retry-After`, capped at 60 s. On 5xx or a network error, back
  off 1 s then 2 s. Then give up and count it. No unbounded retry.
- The queue is bounded at 1000 pending tags. On overflow the backlog collapses into **one** purge of the
  app tag `kn-<p>` (jev: collapse **0.73**, drop 0.27; confidence 0.46). That evicts all of this app's
  edge HTML, which is correct and costs one call.

**D6.5 Observability.** `knext_cdn_purge_total{provider,result}` with
`result ∈ {ok, ratelimited, failed, skipped_no_credential, skipped_unsupported, skipped_invalid_target}`,
plus `knext_cdn_edge_decision_total{result,reason}` with a closed `reason` set (the D4.1 condition that
failed, `tag_overflow`, `rsc_without_rsc_param`, …) so "why isn't this page cached?" has an answer. A
purge failure logs the provider, the status code and the tag count. It never logs the response body,
the token or the request headers.

**D6.6 Shutdown.** The purge is a write: it runs under the SIGTERM drain and its hard cap. A pod killed
past the cap loses the purge, and the TTL bounds the result.

**D6.7 Without Redis** (memory fallback), `revalidateTag` clears only this pod's memory, and other pods
may refill the edge with old content. The purge still runs. Staleness is bounded by the TTL.

### D7. First-ready purge, deduped across the cluster (A2; SD yes 0.84; jev on key and target: app tag **0.96**)

When a pod first reports ready, it runs once per process:
`SET knext:cdn:purged:<p>:<buildId> 1 NX EX 604800` in the app's own Redis. The pod that wins purges the
app tag `kn-<p>`, which evicts every edge HTML, RSC and route entry of this app, whichever build
rendered it. The rest do nothing. A pod-local flag would purge on every scale-to-zero wake, and N pods
start at once. The prefix is in the key because apps may share one Redis. **Without Redis there is no
first-ready purge**, and the TTL bounds staleness.

Known limit: a rollback to a build whose key still exists does not purge. Newer-build HTML at the
edge then lives for at most the TTL. Purging from `knext rollback` is not an option (ADR-0001).

### D8. The staleness contract: the edge TTL, never "instant"

What a user can see when a purge fails, is rate-limited, or is lost at shutdown is **stale HTML for at
most `htmlTTLSeconds + staleWhileRevalidateSeconds`**. SWR serves stale content to the first visitor
after an idle gap. Defaults: **TTL 30 s, SWR 0** (jev: 30/0 **0.61**, 60/60 0.24, 300/60 0.15;
confidence 0.41), each capped at 3600 s. Docs and status text say "within the edge TTL", never
"instant". Cloudflare's own purge 200 means "received", not "evicted". Azure's path purge takes up to
10 minutes.

The SD text for A7 says "short TTL + SWR". SWR stays available but is **off by default**, because it
adds to the staleness bound. A user who raises it accepts a longer bound.

### D9. Rollout and canary (A7; SD pick 0.67, confidence 0.51)

- **Rejected: the operator renders CDN off while `canaryPercent` is set (0.23).** Changing rendered env
  adds a revision to the template the canary is pinned against. That is the revision churn the CDN-1
  exit forbids.
- **Chosen:** short HTML TTL (D8), build tags on every response (D5.2), and the deduped first-ready
  purge (D7). During a split, the edge holds whichever build rendered a URL last, for at most the TTL.
  Build tags also let a user purge one bad build by hand with their own token.
- **The dependency, stated:** mixed-build HTML during a split is self-consistent only if **both builds'
  immutable assets stay served**. With object storage, ADR-0011 retains every live revision's
  `_next/static/<buildId>/`. Without it (ADR-0047), a pod serves only its own build's assets, so old
  HTML can request a chunk from a new pod and get a 404. The operator keeps rendering in that case and
  reports an informational status condition through `computeStatusVerdict` when `spec.cdn` and a
  canary split are set with no object storage (jev: condition **0.80**, reject 0.19, docs only 0.01).
- This must stay consistent with #2254, which restores ADR-0066's "until the rollout completes" bound
  on ISR build scoping. The edge TTL bounds edge staleness; #2254 bounds origin regenerations. They are
  independent.

### D10. Security (A6; SD yes 0.80)

- **No new inbound route.** The purge is outbound only. `/api/cache/invalidate` stays Bearer-gated and
  reaches the purge through Next's `revalidateTag`, like any other caller. Any future inbound purge
  route requires auth, per the hard rule.
- **Hardcoded endpoints.** Each real row's API base URL is a constant in the row. Neither the CR nor
  env can override it. Only the `emulator` row takes an endpoint, and it must be a
  `*.svc.cluster.local` host. CEL checks it at admission, and the runtime checks it again and fails
  closed. A CR edit cannot send the token to an arbitrary host.
- **The token** comes only from the user's Secret, as a `secretKeyRef` env. The `emulator` row never
  reads it and sends a fixed dummy token instead (D2). It is never logged, never
  echoed in an error, never written to status or events, and never sent anywhere but the row's
  endpoint. CDN-2 carries a scan test for this. Missing or empty token means no call, no throw, and
  `result="skipped_no_credential"`. Ask for the minimal scope (Cloudflare: Zone → Cache Purge, one
  zone).
- **Poisoning and auth bypass.** D4 is the defence: the allowlist, the middleware-matcher condition,
  both RSC hard rules, no 3xx, and fail-closed tags.
  `Cache-Tag` carries only hashes.
- **Isolation.** The prefix limit in D5.3 is the honest statement.

### D11. Build targets (jev: vinext inert + condition **0.93**, CEL reject 0.07, implement now 0.00)

The first cut covers the standalone server on **Node and Bun**: one `node:http` preload, one cache
handler. On `build: vinext` (Beta) the operator renders no `KNEXT_CDN_*` env and reports an
informational status condition. It is not a CEL reject (fact 8). vinext uses a different cache
adapter and a `Bun.serve` seam; #2271 ports D4–D7 there.

### D12. `KNEXT_CACHE_CONTROL_NORMALIZE` (jev: keep, deprecated **0.82**, keep as equal 0.15, remove 0.03)

The switch stays in v2.0, documented as deprecated in favour of `spec.cdn`. When `KNEXT_CDN_PROVIDER`
is set, CDN mode wins: `=0` is ignored, with one log line. Removal is a later decision with its own
notice.

### D13. Testing

- **Emulator (A8; SD yes 0.83; jev: minimal shim **0.99**, Varnish + xkey 0.01).** A test-only proxy
  that keys on URL + query and **ignores `Vary`** (it models Cloudflare; default Varnish honours `Vary`
  and would pass a poisoning bug). It stores `Cache-Tag`, serves a Cloudflare-shaped `purge_cache`, and
  can return one 429. It lives in `e2e-support/`, never in a shipped package.
- **CDN-3a (#2264)**, needs CDN-1 only. No compat dispatch; it reuses the C-2 baseline. Cases:
  - the never-cache set;
  - the RSC hard rule: an `RSC: 1` request without `_rsc`, then a plain request, must return HTML;
  - the symmetric rule (gate r1): a `?_rsc=<hash>` request without `RSC: 1`, then a real RSC
    navigation to the same URL, must return `text/x-component`;
  - the `_rsc` case per D4.3;
  - the D4.1 condition-10 cases `cookie-gated-static` and `middleware-cookie-variants`, with the
    pass/fail rule stated there (gate r1);
  - the cases `i18n-default-locale` and `encoded-path`, plus the "Next ran ⇒ preload matched" soundness
    test (gate r3);
  - a page entry whose `_N_T_` tag is missing at `writeHead` is not cached (gate r1);
  - tag isolation between two apps;
  - zero diff without `spec.cdn`.

  The header cases run on **both Node and Bun** (gate r1, D5.1).
- **CDN-3b (#2261)**, needs the wire-in. One compat dispatch confirms the default path is unchanged.
  Cases:
  - HIT → `revalidateTag` → MISS-fresh;
  - a page tagged **only** through `'use cache'` goes HIT → `revalidateTag(thatTag)` → MISS (gate r1);
  - a 429 once, then recovery;
  - the first-ready purge deduped across two pods and a simulated wake;
  - no old-build HTML after a rollout beyond the TTL.
- **Live: one cloud, Cloudflare in front of a scratch NextApp on OKE (CDN-4, #2262),** after the operator
  that renders `spec.cdn` is rolled (O4, #2165). It records HIT → purge → fresh, checks that `Cache-Tag`
  is not leaked, checks the SWR mode and whether HTML needs a Cache Rule, and confirms the running
  operator digest.
- **The CDN-4 bypass ruling** (jev: allow **0.86**, forbid 0.14; confidence 0.72). If O4 has not landed,
  a **scratch** NextApp may set the `KNEXT_CDN_*` env through `spec.env` and `secrets.envMap` on the
  currently deployed operator. That is a `NextApp` write rendered by the one writer: no second writer,
  no hand-built operator over the shared one. It is a verification path, not a supported user path.
  The reserved-name rule (D3) closes it once the new operator rolls. The run records which operator
  digest it ran against.
  **Upgrade-order caveat, stated here (gate r1):** this bypass works only *because* the deployed
  operator predates CDN-1 and reserves nothing under `KNEXT_CDN_*`. For the same reason, on that
  operator the tag prefix is whatever the CR sets, so it is not unforgeable (D3). That is acceptable
  for a scratch app holding its own token on its own Cloudflare zone. It is the reason operator/CRD
  goes first for every real user. When the run ends, it **lists its scratch NextApp (and Secret) for
  deletion** in its record. Deleting a cluster object is a founder action for agents, so the run
  does not delete it itself.

## Options considered

| Decision | Chosen | jev | Main alternative(s) | jev | Why the alternative lost |
|---|---|---|---|---|---|
| Scope | Headers + purge, user owns the CDN | 1.00 | Emit IaC; headers only | 0.00 / 0.00 | IaC is provisioning (ADR-0061); headers only leaves staleness unbounded except by TTL with no recovery |
| Purge rows now | Cloudflare + emulator | 0.65 | Cloudflare only; all four | 0.35 / 0.00 | All four needs three hand-rolled signers, the start of a cloud SDK. No emulator row means no kind e2e |
| Edge directive | Provider edge-only header | 0.97 | `s-maxage` everywhere | 0.03 | Changes the browser value the compat suite asserts, and turns SWR off on Cloudflare |
| Tag source | Request-scoped ALS seam | 0.99 | Minimal mode; path tags only | 0.01 / 0.00 | Minimal mode changes routing; path-only loses `revalidateTag` of data tags |
| Tag encoding | Prefix + hash | 0.81 | Prefix + escaped raw tag | 0.19 | Raw tags break on commas and non-ASCII, overflow Google's 120 B, and leak names where tags are forwarded |
| Tag overflow | Not edge-cacheable | 0.96 | Truncate | 0.04 | A truncated set stores entries some purge can never reach |
| HTML scope | All eligible + `excludePaths`, minus middleware-matched paths | 0.62 (+0.90) | Opt-in path list | 0.38 | Low confidence (0.24). Reverses on the falsifiable CDN-3a rule in D4.1 |
| Middleware auth bypass (gate r1) | Condition 10 + `includePaths` | 0.95 | Opt-in path list for every app | 0.05 | Penalises apps without middleware for a hazard only middleware creates |
| Matcher source (gate r3) | `onBuildComplete` `outputs.middleware` → knext artifact that always exists | 0.91 | Next's internal manifests | 0.09 | Not a contract; reverse-engineering under the official-adapter rule |
| Tested pathname (gate r3) | Raw + decoded + data-route path; decode failure = matched; i18n with any matcher = every path matched | 0.72 | Reproduce Next's locale insertion exactly; raw only | 0.27 / 0.01 | Exact reproduction re-implements Host/cookie/Accept-Language locale detection; raw only enables `/%64ashboard` deception |
| Symmetric RSC rule (gate r1) | Added (architect override) | — | As written | 1.00 | jev read the ADR literally; a crafted `?_rsc=` request is a reachable poisoning vector |
| Emulator token (gate r1) | Fixed dummy token | 0.61 | Resolve `secretRef` | 0.39 | A CR could point the real token at an in-cluster listener |
| `Vary` in the allowlist | Omit (3xx rule explicit) | 0.62 | Require | 0.38 | `s-maxage` condition already excludes known `Vary` cases |
| RSC with `_rsc` | On for query-keyed rows, gated by CDN-3a | 0.57 | Per-row flag off | 0.43 | Near coin flip; CDN-3a evidence decides |
| Purge originator (A1) | Origin pod | 0.81 | Every pod; Redis outbox | 0.10 / 0.09 | No fan-out exists on v2; outbox is over-engineering |
| Hook | Singular `revalidateTag` | 0.77 | Both, deduplicated | 0.23 | Next calls both for the same tags |
| Blocking | Enqueue after invalidation | 0.99 | Await in `revalidateTag` | 0.01 | A 429 would hold a Server Action open |
| Retries | ≤3, `Retry-After` ≤60 s | 0.59 | One shot; unbounded | 0.29 / 0.12 | Unbounded violates A1; one shot gives up on a transient 429 |
| Queue overflow | Collapse to app tag | 0.73 | Drop oldest | 0.27 | Dropping leaves known-stale entries until TTL |
| First-ready purge (A2) | Redis `SET NX`, app tag | 0.84 / 0.96 | Pod-local flag; old build tag | — / 0.04 | Purges every wake; the pod cannot discover the old build |
| TTL defaults | 30 s, SWR 0 | 0.61 | 60/60; 300/60 | 0.24 / 0.15 | Longer staleness bound |
| Canary (A7) | Short TTL + build tags + deduped purge | 0.67 | CDN off during canary | 0.23 | Revision churn |
| Canary without storage | Status condition | 0.80 | Reject; docs only | 0.19 / 0.01 | Reject blocks a valid config; docs only is invisible |
| Token delivery | `secretKeyRef` env | 0.99 | File mount | 0.01 | Env matches `DATABASE_URL`; the app process needs the token anyway |
| `KNEXT_CDN_*` | Reserved unconditionally | 0.93 | Open | 0.07 | A CR could pick another app's prefix or the endpoint |
| Provider ids | Opaque `purge.target` | 0.58 | In the Secret; sub-structs | 0.25 / 0.17 | Sub-structs are a per-cloud branch in the CRD |
| Deferred purge row set | Runtime skip + metric | 0.94 | CEL reject | 0.06 | CEL would tie the CRD to row maturity |
| Normalize switch | Keep, deprecated | 0.82 | Keep equal; remove | 0.15 / 0.03 | Removal breaks existing users without notice |
| vinext | Inert + condition | 0.93 | CEL reject; implement now | 0.07 / 0.00 | CEL may not mention `build`; scope |
| Emulator (A8) | Minimal shim | 0.99 | Varnish + xkey | 0.01 | Honours `Vary`; maintenance mode; licence unclear |
| CDN-4 bypass | Allowed, scratch app only | 0.86 | Forbid | 0.14 | Same writer; no out-of-band install |
| Status of this ADR | Proposed until the gate | 0.83 | Accepted on merge | 0.17 | It amends a `CLAUDE.md` stance |

## Consequences

**Positive**

- knext apps can sit behind a CDN with correct caching and tag purge, which closes most of the "global
  CDN" part of the Vercel gap without provisioning anything. That is the same model OpenNext and
  Netlify use.
- No change at all without `spec.cdn`: no env, no revision, the same compat-normalized headers.
- With `spec.cdn` on Cloudflare or Google, the browser-visible `Cache-Control` is unchanged too.
- The never-cache guarantees are positive conditions, so a new response shape is uncached until shown
  safe, not cached until someone notices.

**Negative / accepted**

- **Staleness is real and bounded, not zero.** A failed purge leaves stale HTML for up to TTL + SWR.
  Under a canary split the edge serves mixed builds for up to the TTL.
- **Purge for CloudFront, Google and Azure is deferred.** Those rows get headers only until a signer is
  designed. The docs must not suggest otherwise.
- **The tag prefix is not an isolation boundary against a token holder** (D5.3).
- **Middleware-matched paths are not edge-cached unless listed in `includePaths`.** An app with a
  catch-all middleware gets edge caching only on the paths it lists. Listing a path disables the
  auth-bypass protection for it, and the docs must say that plainly. An app without middleware is
  unaffected. A pages-router app with `i18n` and any middleware gets **no** default edge HTML caching
  at all, only `includePaths`, because of the conservative i18n rule (gate r3).
- **Condition 10 depends on a knext build artifact.** A packaging slip that drops
  `knext-cdn-routing.json` turns off edge HTML caching. That is safe, and it is not silent: the
  `knext_cdn_edge_decision_total` metric counts it under `reason="routing_artifact_missing"`, the
  preload logs one line at boot, and CDN-3a's HIT cases fail on an image without the artifact.
- **`'use cache'`-only tags rely on Next copying them into the page entry.** This is tested in CDN-3b,
  not verified from source.
- **Only Cloudflare carries a live claim.** The other rows are unit- and emulator-tested only (D2).
- **Rollback does not purge** if the build's key still exists (D7).
- **Responses coalesced onto another request's render are not edge-cached** (D5.1). Under a burst on a
  cold key, a few responses miss the edge.
- **Shipped bytes change**: the preload grows, a new seam joins the cache handler, and a purge module is
  added. The published-bytes and credential freeze guards will see them.
- **CRD growth** on `v1alpha1`: a new optional field. Upgrade order is load-bearing: operator/CRD
  first.

## Action items

1. **CDN-1 (#2259, T2):** `spec.cdn` types + CEL + the unconditional `KNEXT_CDN_*` reservation; operator
   render and the zero-diff golden guard; the canary/no-storage and vinext status conditions in
   `computeStatusVerdict`; `knext.config.ts` key, `cr-builder.ts` mapping, preflight schema; the
   header-preload allowlist (D4, including condition 10). For condition 10, CDN-1 writes
   `knext-cdn-routing.json` from `onBuildComplete` `outputs.middleware` + `ctx.config`, and gets it
   into the runtime image; the preload then reads it. Also the tag seam (D5.1, with build-artifact
   guard coverage, own-entry tags and Node + Bun parity) and tag encoding and overflow (D5.2–D5.4).
   Exit tests per the Sprint 4 plan, including:
   - mutation-proved RSC rules (both directions and the `Content-Type` check);
   - a mutation-proved condition 10, gate r3:
     - delete the artifact → nothing non-immutable is cached;
     - corrupt the artifact → nothing is cached;
     - artifact says `middleware: "none"` → only then are paths eligible without `includePaths`;
     - middleware present with no matchers → every path is matched;
     - the `i18n-default-locale` and `encoded-path` cases, and the soundness test;
     - prefix lists decoded and segment-bounded (`/blog` never covers `/blogger`);
   - a scan proving the preload reads no Next internal manifest;
   - an admission test showing a CR cannot set its own prefix.
2. **CDN-2 (#2260, T2 module; T1 makes the one-line wire-in after #2083):** `adapters/cdn-purge/` rows
   (Cloudflare, emulator; deferred rows as data), queue, bucket, retries, overflow collapse, metrics,
   drain enrolment, first-ready purge, the SSRF and token-scan tests, a no-cloud-SDK scan.
3. **CDN-3a (#2264) and CDN-3b (#2261):** per D13, against the Vary-ignoring emulator.
4. **CDN-4 (#2262):** Cloudflare on OKE after O4 (#2165), or the scratch bypass in D13.
5. **CDN-5 (#2263):** user docs: one page per provider row (OCI page says "use Cloudflare"), the
   staleness contract, the prefix limit, and the middleware hazard, named as an auth-bypass risk:
   `includePaths` re-exposes it for every path it lists. Also `excludePaths`, the asset-retention
   dependency under canary, the deprecation of `KNEXT_CACHE_CONTROL_NORMALIZE=0`, and a per-row claim
   that matches its evidence (no "verified" without a live run).
6. **Follow-ups (filed):** #2270, the signer purge rows for CloudFront, Google and Azure (D2); #2271,
   vinext CDN support (D11).
7. **Founder:** the `CLAUDE.md` §8 edit in Appendix A. It is not blocking; this ADR governs meanwhile.

## Appendix A — proposed `CLAUDE.md` §8 amendment (founder-only edit)

Agents do not edit `CLAUDE.md`. Proposed replacement text for §8:

> ## 8. Vercel parity framing
> knext matches Vercel's **compute layer** (scale-to-zero ≈ Fluid Compute), **not** its global edge.
> Gaps: (1) architectural edge we can't easily close (**edge compute, edge middleware/PPR at the
> edge** — partly upstream-gated, multi-region); (2) **buildable-but-unbuilt** — endpoint auth,
> previews, rollback, skew protection, RUM; (3) deliberate model differences (Prometheus/Grafana vs
> Web Analytics; multi-cloud / no lock-in). **Exception, ADR-0068 (v2): CDN caching in the adapter's
> own terms is in scope** — knext emits cache-correct edge headers and `Cache-Tag`s and calls a
> provider's tag purge on `revalidateTag`/`revalidatePath`. **The user owns the CDN**: knext never
> provisions or configures one, the operator carries no cloud SDK, and the purge credential is a
> user-created Secret. Staleness is bounded by the edge TTL, never promised as instant. Recommended
> provider on OKE: Cloudflare (OCI has no CDN product). Fame phase: do bucket-2 cheap wins + security
> basics; defer the rest of bucket 1.

And one clause in §6, Tier C: "CDN (header + purge slice: ADR-0068, v2; provisioning and edge compute
stay out)". §1 needs no change: the fence in D1 is what keeps this inside "narrow adapter, not a PaaS".

## Appendix B — Sprint 4 system-designer amendments, where each is decided

| Amendment | Decided in | Ruling |
|---|---|---|
| A1 purge originator + failure bound | D6.1, D6.3–D6.6, D8 | Origin pod; coalesced, ≤100 tags, row-sized bucket, `Retry-After`, ≤3 attempts; staleness = edge TTL; metric; drain |
| A2 first-ready purge | D7 | `SET knext:cdn:purged:<p>:<buildId> NX`; no Redis → no first-ready purge |
| A3 RSC/HTML key | D4.3, D4.4 | `RSC`/`Next-Router-*` without `_rsc` never cacheable; `_rsc` without `RSC: 1` never cacheable, and `Content-Type` must match the key (gate r1); `_rsc` only on query-keyed rows, gated by CDN-3a; no 3xx |
| A4 never-cache set | D4.1 | Allowlist of positive conditions covering every listed case, plus condition 10: middleware-matched paths only through `includePaths` (gate r1). Matchers come from the official `onBuildComplete` outputs through a knext artifact; matching uses the raw and decoded pathname, with a conservative i18n rule (gate r3) |
| A5 tag prefix | D3, D5.3 | Operator-derived hash, `KNEXT_CDN_*` reserved; the token-holder limit stated |
| A6 credential + SSRF | D10 | Hardcoded URLs; emulator `*.svc.cluster.local` only; token never logged; no inbound route |
| A7 canary | D9 | Rejected CDN-off-during-canary; short TTL + build tags + deduped purge; asset-retention dependency + status condition |
| A8 emulator fidelity | D13 | Ignores `Vary`, keys on URL + query, models tag purge and one 429 |
