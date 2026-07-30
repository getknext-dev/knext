# Multi-Zone Architecture — worked example

> **This describes a layout to build, not the layout of this repository.**
> The `apps/main`, `apps/dashboard` and `apps/users` zones below are an
> illustrative three-zone app used to explain the conventions. They are not
> directories in this repo — the apps here are `apps/file-manager`,
> `apps/db-demo`, `apps/docs` and `apps/spike-bun-bytecode`.
>
> Zone **generation** is a north-star capability, not a shipped one. Nothing in
> knext scaffolds these zones for you today; you assemble them yourself using the
> conventions on this page. See [`docs/guides/multi-zone-composition.md`](docs/guides/multi-zone-composition.md)
> for how the pieces are deployed and composed.

Next.js Multi-Zones let independently built and deployed Next.js apps serve one
origin. In knext each zone is a **Self-Contained System** — it owns its UI, its
logic and its data — deployed as its own Knative Service that scales to zero
independently of the others.

## Shape of a three-zone app

```
┌──────────────────────────────────────────────────────────────┐
│  Proxy zone  (apps/main)                                     │
│  - public entry point, owns the home page                    │
│  - rewrites /dashboard/* and /users/* to the other zones      │
└──────────────────────────────────────────────────────────────┘
             │                          │
             ▼                          ▼
   ┌───────────────────┐      ┌───────────────────┐
   │  apps/dashboard   │      │  apps/users       │
   │  basePath         │      │  basePath         │
   │    /dashboard     │      │    /users         │
   │  assetPrefix      │      │  assetPrefix      │
   │    /dashboard-…   │      │    /users-static  │
   │  owns its OWN DB  │      │  owns its OWN DB  │
   └───────────────────┘      └───────────────────┘
```

Each zone is a separate Knative Service, so a zone with no traffic costs nothing
while its siblings stay warm.

## The two conventions that make it work

**`basePath`** — every route the zone serves is prefixed, so the proxy can route
to it by path without collisions.

**`assetPrefix`** — the zone's build output is served from a *distinct* path.
This is the part that is easy to get wrong: two zones both serving `/_next/static`
will overwrite each other's assets behind one origin, and the failure looks like
random chunk 404s after a deploy. Give every zone its own prefix.

knext wires `assetPrefix` for you at deploy time; you declare the zone's
`basePath` in its own `next.config.ts`.

## Data sovereignty (hard rule)

A zone **owns its data store**. There is no shared database.

- A zone must never connect to another zone's database — not its primary, not a
  replica.
- Cross-zone data moves only by **async domain events** (each zone keeps its own
  copy) or **through the browser** (links, UI composition).
- A zone reaches its own database via `DATABASE_URL` from a Kubernetes Secret,
  never a hardcoded host.

Domain events are an application concern — bring your own broker and clients.
knext's `spec.revalidation.kafka` is ISR-revalidation wiring only, not a
cross-zone event bus.

## Adding a zone

1. Create the app directory and give it a Next.js app of its own.
2. Set `basePath` in its `next.config.ts` to the path it will own.
3. Add a rewrite in the proxy zone pointing that path at the new zone's URL.
4. Add it to the workspace so the monorepo builds it.
5. Give it its own database. Do not point it at a sibling's.

## Environment

Each zone needs the URL of any zone it rewrites to, plus its own
`DATABASE_URL` from a Secret. Name the URL variables after the zones
(`DASHBOARD_URL`, `USERS_URL`, …) and inject them per zone — the proxy is the
only zone that needs to know where the others live.
