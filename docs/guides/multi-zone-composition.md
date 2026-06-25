# Multi-zone composition: serving many zones behind one origin

How to compose several independent knext **zones** — each a Self-Contained System (SCS)
deployed as its own Next.js app — behind a single public origin. This guide records the
**current, working, app-level pattern** and is explicit about what knext does *not* yet
provide as a control-plane primitive.

> Related reading:
> - `README-MULTI-ZONE.md` — the per-zone monorepo layout (`apps/main`, `apps/dashboard`,
>   `apps/users`, …) and the `basePath` / `assetPrefix` conventions this guide builds on.
> - Skill `scs-zones` (`.claude/skills/scs-zones/SKILL.md`) and contract
>   `.claude/rules/scs-zones.md` — the SCS macro-architecture: data sovereignty, per-zone
>   PostgreSQL (CloudNativePG), cross-zone integration via async Kafka events + the browser.
> - Skill `pwa-zones` (`.claude/skills/pwa-zones/SKILL.md`) — the PWA stitching layer
>   (App Shell, SWI, BroadcastChannel) that makes the composed zones feel like one SPA.

## TL;DR

- **Each zone is one `NextApp`.** The operator reconciles it to its own Knative Service and
  mirrors that Service's URL into `status.url`.
- **The proxy is app-level, today.** Deploy an `apps/main`-style Next.js app as *its own*
  `NextApp`, and use Next.js [`rewrites()`](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites)
  to route `/<zone>` and `/<zone>-static` paths to each zone's in-cluster `status.url`.
- **No new knext primitive is required** to ship this. There is **no route / path-prefix /
  `basePath` / `rewrites` field on the `NextApp` CR** — composition lives in the proxy app's
  `next.config.ts`. CR-native routing is a deferred design question (see *Scope & honesty*),
  not a blocker.

## Each zone = one `NextApp`

A zone owns its UI, its logic, and its data (`scs-zones`). On knext it deploys as a single
`NextApp` custom resource. The operator reconciles it into a Knative Service and writes the
Service URL back onto the resource's `status.url`.

`status.url` is set by the operator after the owned Knative Service reports its URL — it is a
direct mirror of `ksvc.Status.URL`
(`packages/kn-next-operator/internal/controller/nextapp_controller.go`):

```go
// 6. Update Status: URL + conditions + observed traffic split
if ksvc.Status.URL != nil {
    nextApp.Status.URL = ksvc.Status.URL.String()
}
```

So after a zone reconciles, you can read its in-cluster address:

```bash
kubectl get nextapp dashboard -o jsonpath='{.status.url}'
# http://dashboard.default.svc.cluster.local   (in-cluster, scale-to-zero)
```

A minimal zone resource (real `apiVersion` and field shapes — see
`packages/kn-next-operator/config/samples/file-manager-nextapp.yaml`):

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: dashboard
  namespace: default
spec:
  # Pin by digest; the operator rejects ":latest".
  image: "us-central1-docker.pkg.dev/example/repo/dashboard@sha256:..."
  scaling:
    minScale: 0          # scale-to-zero
    maxScale: 10
    containerConcurrency: 100
  storage:
    provider: "gcs"
    bucket: "knext-assets-dashboard"
  cache:
    provider: "redis"
    url: "redis://redis.default.svc.cluster.local:6379"
status:
  # set by the operator (read-only):
  url: "http://dashboard.default.svc.cluster.local"
```

Deploy one of these per zone (`dashboard`, `users`, `billing`, …). Each gets its own
Knative Service, its own scale-to-zero lifecycle, and its own `status.url`.

## The proxy is app-level: an `apps/main` rewrites layer

The composition layer is itself just another Next.js app deployed as **its own `NextApp`**.
It is the public-facing zone (`apps/main` in `README-MULTI-ZONE.md`), and it uses Next.js
`rewrites()` to forward zone-prefixed paths to each zone's in-cluster `status.url`.

Per the multi-zone convention, every downstream zone is configured with a `basePath`
(`/dashboard`) and an `assetPrefix` (`/dashboard-static`) so that:

- application routes live under `/<zone>/…`, and
- static assets (`_next/static/…`) live under `/<zone>-static/…` and never collide between
  zones.

The proxy app's `next.config.ts` rewrites both prefixes to the zone Service:

```ts
// apps/main/next.config.ts
import type { NextConfig } from 'next';

// The zone in-cluster URLs come from each zone's NextApp status.url, injected
// as env via the operator/Secret — never hardcode a Service host.
const DASHBOARD_URL = process.env.DASHBOARD_URL; // e.g. http://dashboard.default.svc.cluster.local
const USERS_URL = process.env.USERS_URL;         // e.g. http://users.default.svc.cluster.local

const nextConfig: NextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      // App routes
      { source: '/dashboard', destination: `${DASHBOARD_URL}/dashboard` },
      { source: '/dashboard/:path*', destination: `${DASHBOARD_URL}/dashboard/:path*` },
      // Static assets (matches the zone's assetPrefix)
      { source: '/dashboard-static/:path*', destination: `${DASHBOARD_URL}/dashboard-static/:path*` },

      { source: '/users', destination: `${USERS_URL}/users` },
      { source: '/users/:path*', destination: `${USERS_URL}/users/:path*` },
      { source: '/users-static/:path*', destination: `${USERS_URL}/users-static/:path*` },
    ];
  },
};

export default nextConfig;
```

Each zone sets its own prefixes so its assets resolve under its prefix. The knext example app
already wires `assetPrefix` from an env var
(`apps/file-manager/next.config.ts`: `assetPrefix: process.env.ASSET_PREFIX || ''`); a zone in
this pattern sets, in its own `next.config.ts`:

```ts
// apps/dashboard/next.config.ts
const nextConfig: NextConfig = {
  basePath: '/dashboard',
  assetPrefix: '/dashboard-static',
  // …
};
```

Only the `apps/main` proxy is exposed publicly; the downstream zones stay reachable at their
in-cluster `status.url`. That keeps the zone Services cluster-local while a single origin
serves the composed app — no extra gateway component is required, because Next.js `rewrites()`
*is* the gateway.

### Where the zone URLs come from

Do **not** hardcode `*.svc.cluster.local` hosts in `next.config.ts`. Resolve each zone's
`status.url` (`kubectl get nextapp <zone> -o jsonpath='{.status.url}'`) at deploy time and pass
it to the proxy app as an environment variable (`DASHBOARD_URL`, `USERS_URL`, …), sourced from a
Kubernetes Secret / env per the secrets rule (`.claude/rules/security.md`). This mirrors the
env conventions already noted in `README-MULTI-ZONE.md` ("Environment Variables").

## Single-origin session / auth: verify in your app

Routing several independent Services behind one origin moves a real correctness burden into
**your** application. knext does not guarantee any of the following works transparently — you
must validate it for your zones on your Knative install:

- **Cookie domain & path.** Cookies set by a zone behind a rewrite are visible to the browser
  under the *proxy* origin, not the zone's internal host. Scope cookie `Domain`/`Path` to the
  public origin (and the right path prefix) or auth state will not round-trip.
- **Forwarded headers.** A rewrite proxies the request server-side; confirm the zone sees the
  headers it expects (`Host`, `X-Forwarded-*`, the original path). Anything a zone reads for
  CSRF, redirects, or absolute-URL generation must survive the hop.
- **Scale-from-zero / activator path.** When a target zone is scaled to zero, the first request
  goes through the Knative **activator** while the pod cold-starts. Validate that the proxy's
  request timeout (`spec.timeoutSeconds`, default 300s on the `NextApp`) and any auth handshake
  tolerate that added latency, and that no in-flight redirect/cookie step times out.

Treat all of the above as **"verify in your app,"** not a knext guarantee. The deeper "make
zones feel like one SPA" concerns (navigation interception, cross-zone state, never caching
auth/mutation routes in a Service Worker) are the subject of the `pwa-zones` skill and its
caching-policy rule in `.claude/rules/scs-zones.md`.

## Scope & honesty: no CR-native routing today

There is **no route / path-prefix / `basePath` / `rewrites` field on the `NextApp` CR**.
Composition is **app-level**, via the proxy app's `next.config.ts` `rewrites()`, exactly as
described above.

For reference, the real `NextAppSpec` fields that *do* exist today
(`packages/kn-next-operator/api/v1alpha1/nextapp_types.go`) are:

`image`, `scaling`, `resources`, `storage`, `cache`, `revalidation`, `secrets`,
`observability`, `healthCheckPath`, `preview`, `runtime`, `timeoutSeconds`, `security`,
`traffic`, `buildId`.

None of these expresses HTTP routing or path composition between zones — that is intentional.
`status` carries only `url`, `conditions`, and `currentTraffic`.

CR-native routing (the operator owning `/<zone>` → Service composition as a first-class
primitive) is a **deferred design question**, sequenced after the official-adapter migration
and Tier-A correctness (`ROADMAP.md`, `.claude/rules/scs-zones.md` — the scope boundary).
It is **not a blocker**: the app-level rewrites pattern is the sanctioned way to compose zones
today, and this guide records that boundary rather than promising a primitive that does not
exist.

## See also

- `README-MULTI-ZONE.md` — monorepo zone layout, `basePath`/`assetPrefix` conventions, env vars.
- `.claude/rules/scs-zones.md` and skill `scs-zones` — SCS macro-architecture and data
  sovereignty.
- Skill `pwa-zones` — the PWA stitching layer (App Shell, SWI, BroadcastChannel) for making
  composed zones feel like one app.
- `packages/kn-next-operator/api/v1alpha1/nextapp_types.go` — the authoritative `NextApp` spec.
