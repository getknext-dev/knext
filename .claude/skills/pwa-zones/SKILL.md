---
name: pwa-zones
description: The PWA stitching layer that makes independently-deployed knext zones (Multi-Zones SCS) feel like one SPA — App Shell, the Navigation API + event.intercept(), Service Worker Includes (SWI), Serwist, the caching matrix, and BroadcastChannel cross-zone state. Use this skill whenever the user mentions PWA, service workers, offline support, app shell, cross-zone or cross-app navigation feeling slow/janky, "make zones feel like one app", precaching, Serwist/Workbox, BroadcastChannel, or hydration/version-skew issues between zones. End goal: knext ships this as a first-class, generated framework capability; today it is an app-level recipe (not built into core yet).
---

# PWA Stitching Layer for Zones

> **End goal:** knext ships this PWA stitching layer as a **first-class, generated framework
> capability** (part of the comprehensive full-stack SCS goal). **Today:** it is **not in core
> yet** — knext owns serving the App Shell and generating the precache manifest, while the Service
> Worker / SWI / BroadcastChannel machinery lives in the **app template** as an opt-in recipe (see
> *Current state vs end goal* in `scs-zones`). The macro-architecture is the `scs-zones` skill.

## The problem: the "initialisation tax"
Cross-zone navigation in Next.js Multi-Zones is a **hard navigation** — the browser unloads the
DOM, drops in-memory state, and re-bootstraps React from scratch. Result: latency, lost client
state, and a disjointed, page-reload feel across what should look like one app. The PWA layer
hides that real architectural boundary.

## App Shell
A minimal **precached skeleton** (persistent header / nav / footer) that hosts each zone's content
region. Because it's precached by the Service Worker, it renders **instantly** on repeat visits —
even offline — while the zone's content streams in.

## Stitch mechanism (how a cross-zone nav becomes SPA-like)
1. A client script listens for the **Navigation API** `NavigateEvent` (covers links, form
   submissions, and programmatic navigation) — the modern, Baseline replacement for History-API
   routers.
2. On a **cross-zone** navigation it calls **`event.intercept()`**, preventing the default hard
   reload.
3. The **Service Worker** performs **Service Worker Includes (SWI)**: it fetches the target zone's
   complete server-rendered HTML, extracts `<main>` + that zone's **`assetPrefix`-scoped scripts**,
   and **streams** them into the live App Shell.
4. The new React tree **mounts and hydrates** — an instant, SPA-like transition across a real
   architectural boundary.

## Serwist
The **TypeScript-native Workbox successor** with Next.js App Router integration. It manages the SW
lifecycle, **precache-manifest injection**, and route matching. Prefer it over hand-rolled
Workbox for the App-Router fit and TS ergonomics.

## Caching matrix (choose strategy per resource)
| Strategy | Use for |
|---|---|
| **cache-first** | immutable hashed assets, zone JS/CSS bundles |
| **stale-while-revalidate** | the App Shell, shared CSS |
| **network-first** | dynamic HTML, user-specific data |
| **network-only** | **auth endpoints + ALL mutations — never cached** (integrity/security) |

The network-only row is a hard line: caching an auth or mutation route is a correctness **and**
security bug. (A hook, `guard-sw-cache-policy.sh`, warns if SW/caching config caches auth/mutation
routes.)

## Cross-zone state via BroadcastChannel
Same-origin **pub/sub** with structured-clone payloads — no shared memory, no code dependency
between zones. Preferred over `localStorage`-event hacks and `postMessage` plumbing. Example: the
auth zone posts `USER_AUTHENTICATED`; every other open zone receives it and updates its **local**
state. Keep payloads small and serializable; treat them as events, not a shared store.

## Caveats (teach, don't hand-wave)
- **Version skew / hydration mismatch:** SWI + hydration across independently-versioned zones risks
  shared-dependency version skew and hydration mismatches. Pin/align shared runtime deps, or accept
  full reloads on skew.
- **The SW is a real surface:** it's a genuine cache-invalidation and debugging hazard. **Ship a
  kill-switch** (a way to unregister the SW / bust caches) and version your precache manifest.
- **Therefore: opt-in, not default.** Only adopt this layer when the cross-zone UX win justifies
  the operational cost. A plain hard navigation is a perfectly valid default.

## What knext provides vs. what the app ships
- **knext today (current state):** serves the App Shell, generates the precache manifest, wires
  each zone's `assetPrefix`.
- **App template today (this recipe):** the Service Worker, SWI logic, Navigation-API interceptor,
  Serwist config, BroadcastChannel wiring.
- **End goal:** knext **generates** this whole recipe as a first-class capability (e.g. a PWA flag
  on the zone scaffolder), so teams opt in by config rather than hand-writing the SW.
- **Phasing line (for now):** until the framework absorbs it, keep this runtime code in the app
  template, **not** in core packages (`packages/kn-next`, `packages/cli`, the operator) — an
  advisory hook (`protect-core-vs-app-boundary.sh`) flags it. This is a sequencing guard during the
  adapter-correctness phase, **not** a permanent boundary.

## Related
`scs-zones` (the architecture this stitches), `nextjs-deployment-adapter` (assetPrefix/standalone),
`knative-kubernetes`. Contract: `.claude/rules/scs-zones.md`.
