# ADR-0067: Allowlisted public origin for redirects built from `request.url`

- **Status:** **Proposed (2026-10-10).** Exit: Accepted at the next sprint-close design review.
  Phase 1 (this ADR's runtime half) lands with it; phase 2 (the CRD field) is a separate issue.
- **Date:** 2026-10-10
- **Trigger class:** security (a response header derived from request headers) + runtime (a new
  preload in the standalone serving set) + operator env / CRD (phase 2 only). Reviewed at sprint
  close per `.claude/rules/workflow.md` (2026-09-22 amendment: not a merge gate).
- **Relates to:** ADR-0001 (the operator is the source of truth for cluster state; phase 2 renders
  the env from the CR), ADR-0044 (in-process preloads on the standalone server; Amendment 6's
  `request-body-cap.cjs` is the mechanism reused here), ADR-0036 (the build targets this must
  cover).
- **Covers:** #2133. Found while triaging #2125 (the `adapter-rsc-query-leak` Draft Mode cases).
- **Decision method:** each choice below was scored with jev (`jev-1.13.0`). The score is quoted
  where the choice is made; the evidence it rests on is the code line or test next to it, not the
  score.

## Context

A route handler that redirects with an absolute URL built from `request.url` —
`NextResponse.redirect(new URL('/x', request.url))` — answers `Location: http://0.0.0.0:PORT/x`
behind Knative. Released 1.x on Next 16.3.8 is affected, and so is 16.4.

**Why.** Next's standalone server never derives the request origin from the `Host` header:

- `next/dist/server/next-server.js` `attachRequestMeta` sets `initURL` to
  `${protocol}://${this.fetchHostname}:${this.port}${req.url}`, and
  `lib/router-utils/resolve-routes.js:117` builds the router's `initUrl` the same way from the
  `hostname` the server was started with. A route handler's `request.url` is
  `new URL(req.url, initURL)` (`web/spec-extension/adapters/next-request.js`).
- Middleware's URL is built separately, from `this.fetchHostname` again
  (`next-server.js:1146`, unless `skipProxyUrlNormalize`).
- The standalone `server.js` starts Next with `hostname = process.env.HOSTNAME || '0.0.0.0'`, and
  the knext supervisor sanitizes `HOSTNAME` to empty (`adapters/env.ts`). Kubernetes sets
  `HOSTNAME` to the pod name, and binding to it caused an earlier outage. So the server binds, and
  names itself, `0.0.0.0`.
- `experimental.trustHostHeader` hard-codes `https://` and trusts `Host` unconditionally, so it is
  not a fix.

A browser that follows such a redirect lands on an unroutable origin and drops every host-only
cookie the redirecting response set. In #2125 that is the Draft Mode bypass cookie: the article
renders its published prerender instead of the draft. A stub that made `request.url` read
`http://localhost:PORT` turned all 8 failing cases green.

**Two facts found while implementing**, both of which shape the decision:

1. **Next rewrites the forwarded headers on the live request.** `base-server.js:609-611` runs
   `x-forwarded-host ??= host` and `x-forwarded-proto ??= (TLS socket ? 'https' : 'http')` before
   any handler. Anything that reads those headers at response time sees Next's synthesized `http`,
   not the absence of a proxy header.
2. **The `NextApp` CR declares no domains.** `api/v1alpha1/nextapp_types.go` has no host or domain
   field (`spec.networking` carries only `visibility`). `status.url` mirrors the Knative route URL,
   which is known only after the Knative Service is Ready. DomainMappings are user objects the
   operator only reads. "The operator injects the domains from the CR" therefore needs a new CRD
   field, and that is a public API change.

## Decision

**1. The origin comes from an allowlist (option C), read from `KNEXT_PUBLIC_ORIGINS`.** Phase 1 (this
change) reads it from the environment, which users set through `spec.env` / `knext.config.ts`
`env`. That works with any operator version, so it can be patched into 1.x. Phase 2 adds a CRD field
(`spec.networking.publicHosts`) that the operator renders into the same variable. The lead tracks
it as a separate issue. Phase 2 must not change the runtime contract described here.

**2. The rule.**

- Only a `Location` whose origin is a wildcard bind address (`0.0.0.0` or `[::]`, any port) is
  rewritten. Everything else is left byte-for-byte alone: a real host, a relative path, a lookalike
  such as `0.0.0.0.evil.com` or `user@0.0.0.0`. The path, query and fragment are kept verbatim.
- Host: the request's `X-Forwarded-Host` (first comma token), then its `Host`, but only when the
  value equals an allowlist entry, compared case-insensitively and including the port. Otherwise
  the first entry is used. The emitted host is always the allowlist's own spelling: a header value
  is only ever used as a key into the list.
- Scheme: the matched (or first) allowlist entry's own scheme; a bare host means `https`.
  `X-Forwarded-Proto` is not read. (Amended 2026-10-11, see Amendment 1.)
- No allowlist (unset, empty, or every entry invalid) means nothing is installed. Behaviour is
  then byte-identical to today, and there is no boot log line.
- A wildcard bind address is recognised by its canonical form (`new URL(...).hostname`), so `[::0]`,
  `[0:0:0:0:0:0:0:0]`, `0` and `[::ffff:0.0.0.0]` count as wildcards both in a `Location` and as an
  allowlist entry (dropped).
- A response whose `Location` was rewritten also gets `Vary: X-Forwarded-Host, Host`, merged into any existing `Vary` (jev: add it, 0.95), so a shared cache cannot
  serve a redirect built for one allowlisted host to another. It is applied at `writeHead`, so a
  `Vary` the app sets later cannot clobber it; a `Vary: *` is left as is.

**3. Mechanism: rewrite the `Location` response header, not `request.url`.** Next computes the
origin in two independent places: the router's `initURL`, and the middleware URL from
`fetchHostname`. Rewriting `request.url` means rewriting one of them, and they then disagree.
`resolve-routes.js` compares a middleware rewrite's origin with `initUrl` (`getRelativeURL`) to
decide whether it is internal. A middleware `NextResponse.rewrite(new URL('/y', request.url))`
would then be treated as an **external proxy**. The response header is the one place where a single
narrow rewrite fixes the user-visible bug and touches nothing Next relies on internally. Triage
scored this mechanism highest: Location rewrite 0.82, listen patch 0.14, bind localhost 0.03,
`trustHostHeader` 0.01.

**4. Read the headers as they arrived.** Because of fact 1, the preload snapshots
`X-Forwarded-Host` and `Host` when the request is emitted
(`http.Server.prototype.emit('request')`, the hook `request-body-cap.cjs` already uses), before
Next defaults them. It applies the rule to that snapshot at response time (jev 0.85). Without the
snapshot the "no proxy header gives `https`" default never applies. The served-build test caught
this on a real Next build.

**5. Where it lives: a preload, `packages/kn-next/src/adapters/public-origin.cjs`.** It is
dependency-free CommonJS, like `cache-control-normalize.cjs` and `request-body-cap.cjs`, and is
installed on `http.ServerResponse.prototype` (`setHeader`, `appendHeader`, and `writeHead` in its
object, flat-array and pair-array forms). It runs Next's own server unmodified, with no patch to
`next`. Coverage, each proven by `public-origin-standalone.test.ts` against a real `next build`:

| Target | How it loads | Proven by |
|---|---|---|
| Node standalone | `node-server.ts` passes `--require public-origin.cjs` to the child (outside the Bun-only block) | `node --require` mode, and the supervisor mode |
| Bun standalone | same supervisor path; the child is Bun | `bun --require` mode, and the `node-server.ts` supervisor run under Bun |
| Compiled single executable | `standalone-compile.mjs` `PRELOAD_NAMES` bakes it into the entry | the compiled-executable mode (host-target compile of the same tree) |
| vinext | **Out of scope, and not affected.** vinext's production server builds `request.url` from the `Host` header (`vinext/dist/server/proxy-trust.js` `resolveRequestHost`), honouring `X-Forwarded-Host` only through its own `VINEXT_TRUSTED_HOSTS` allowlist. It never uses the bind address, so knext does not load this preload there. | — |

**6. Entry format.** Each entry is `[scheme://]host[:port]`. A trailing `/` is accepted and
stripped. The scheme is kept and becomes the redirect's scheme (rule 2); a bare host means `https`.
One entry per host: a repeat of a host is ignored, whatever its scheme. An entry with a path, userinfo, a wildcard, an out-of-range port, or a wildcard
bind address is dropped with a stderr warning naming it. **Header scope (jev: Location only, 0.74):**
`Refresh`, `Content-Location` and `Link` are not rewritten. Next's own `Refresh` on a 308 is only
added on the router's redirect path, where middleware redirects are already made relative.

## Options considered

**Origin source** (lead decision on #2133; jev choice, confidence 0.55):

| Option | What | Security | Fit | jev |
|---|---|---|---|---|
| A. Trust `Host` / `X-Forwarded-*` | Build the origin from request headers | Open redirect and cache-poisoning surface: any client picks the redirect host | Simple | 0.01 |
| B. Fixed origin | One operator-provided origin, no header consulted | Safe | Wrong for multi-domain apps; every redirect goes to one host, which drops cookies set on the others | 0.33 |
| **C. Allowlist** | Headers only select among listed hosts; fallback is the first entry | Safe: no unlisted value reaches the header | Multi-domain correct, previews and aliases work | **0.66** |
| D. Bind `localhost` | Make the server name itself `localhost` | Safe | Redirects still carry a non-public origin (`localhost:PORT`); only same-host harnesses benefit | 0.00 |

**Where the allowlist comes from, phase 1** (lead pick: phased C 0.77, CRD field now 0.06, env-only
forever 0.17). Env now, through `spec.env`, so it ships to 1.x without an operator upgrade. CRD
field later. Deriving it from `status.url` and DomainMappings was rejected: rendering env from
status or from user objects churns a new Knative revision on first deploy and on every mapping
change.

**Mechanism** (triage on #2133): Location rewrite 0.82 · listen/hostname patch 0.14 · bind localhost
0.03 · `trustHostHeader` 0.01. Rewriting `request.url` through Next's request-meta symbol was
considered and rejected for the middleware/`initURL` disagreement in Decision 3.

## Consequences

**Positive**

- Redirects built from `request.url` land on the app's domain on every standalone target, so
  host-only cookies survive them. The Draft Mode entry flow from #2125 works end to end in the
  served test: the redirect targets the allowlisted host, and the bypass cookie renders the draft
  there.
- No request header outside the allowlist can reach `Location`. The unit suite enumerates a
  header × header × proto grid and asserts every output origin is in {http, https} × allowlist.
- Unset means unchanged. Local runs, `next start`, and deploys that don't set the variable behave
  exactly as before.

**Negative / accepted**

- **Not automatic until phase 2.** Users must set `KNEXT_PUBLIC_ORIGINS`, and the docs say so
  plainly. Until then the bug's default persists.
- **`request.url` still reads the bind address.** App code that embeds it anywhere other than
  `Location` (an OAuth `redirect_uri`, a link in an email, an absolute URL in a body) still sees
  `0.0.0.0`. This is documented.
- **The compat harness does not set the variable**, so the upstream `adapter-rsc-query-leak` Draft
  Mode cases keep their quarantine. Their browser also runs against `localhost:<random port>`, which
  an allowlist entry would have to name exactly.
- **An attacker can still choose among allowlisted hosts.** That is bounded by design. The scheme is
  not attacker-chosen (Amendment 1).
- **Shipped bytes change.** A new file joins the standalone preload set and the dist build. The
  published-bytes and credential freeze guards will see it. The lead decides any marker; this ADR
  adds none.
- **One more prototype patch** on `ServerResponse` and `Server.prototype.emit`. It composes with the
  existing ones, since each wraps whatever it finds. It is installed only when the allowlist is
  non-empty.

## Action items

1. **Phase 2 (separate issue, lead-owned):** `spec.networking.publicHosts` on the `NextApp` CRD,
   CEL-validated hostnames, plus a `knext.config.ts` key and a cr-builder mapping. The operator
   renders `KNEXT_PUBLIC_ORIGINS` from it and omits it when the list is empty. Upgrade order is
   operator/CRD first, then CLI. Its tests: the env is rendered from the field, and absent without
   it.
2. **Cluster verification (lead):** on kind or OKE, deploy an app with
   `spec.env.KNEXT_PUBLIC_ORIGINS` set and a route handler that redirects from `request.url`. Check
   that `curl -sI` through the ingress shows the public origin in `Location`, through both the
   default route host and a DomainMapping host. Record which `Host` / `X-Forwarded-Host` the pod
   actually receives behind a DomainMapping, since that decides whether entry order matters there.
   Check that a forged `X-Forwarded-Host` falls back to the first entry, that the scheme follows
   the ingress's `X-Forwarded-Proto`, and that the pod log carries the `PUBLIC_ORIGINS:` line.
3. **Docs:** user-facing section "Make redirects use your domain" in Custom domains & TLS, and a
   troubleshooting entry. Done with this change.

## Amendment 1 (2026-10-11): the scheme comes from the allowlist entry

Kind verification of the shipped rule (results on #2133) showed that taking the scheme from
`X-Forwarded-Proto` is wrong in both directions. Kourier sets the header to `http` on a plain-HTTP
listener, so redirects came out `http://app.example.test/...` for an `https` app; and it passes a
client-supplied value through, so a client could choose the scheme. The host was never
attacker-chosen, only the scheme.

Rule 2's scheme line is replaced: the scheme is the matched entry's own (`https://` or `http://`,
as the operator wrote it), on a host match and on the first-entry fallback alike. A bare host with
no scheme defaults to `https`, which is what the rule gave when no proxy header was present, so
existing bare-host configuration keeps its behaviour (jev scored the three options nearly level,
0.39 / 0.39 / 0.22 with confidence 0.09; the backward-compatible default is chosen on that basis,
not on the score). No request header now influences the redirect's origin: headers only select among
entries. Because `X-Forwarded-Proto` no longer affects the result it is removed from the added
`Vary`, which is now `X-Forwarded-Host, Host`. Everything else in rule 2 is unchanged.

Action item 2's check "the scheme follows the ingress's `X-Forwarded-Proto`" is superseded: the
scheme follows the allowlist entry.
