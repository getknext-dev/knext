# SCS / Zones contract (knext)

> The short, always-on contract. Full explanations live in the skills: **`scs-zones`** (SCS +
> Multi-Zones architecture) and **`pwa-zones`** (the opt-in PWA stitching layer). Complements
> `architecture.md` + `security.md`.

## What knext is
**Current state:** a **scale-to-zero Next.js deployment framework for Knative** (TS + Go). Data
plane: Postgres + Redis + GCS. **Zone databases = PostgreSQL via CloudNativePG.** Each zone = one
**Self-Contained System** (owns UI + logic + data), deployed as its own Knative Service.

**End goal (north-star):** a **comprehensive full-stack SCS framework** that **generates** zones
(scaffolder), **isolates** micro-frontends (asset + runtime/Module-Federation isolation), and ships
the **PWA stitching** layer as a first-class capability. Today those are app-level recipes / not
built; treat "knext generates X" as the target and never present an unbuilt generator as shipping.

## Data sovereignty (hard rule)
- A zone **owns its data store**; **no shared database**.
- A zone **must not read another zone's database** — never connect to another zone's CNPG `-rw`
  (primary) or `-ro` (replica) service. (Enforced: `protect-zone-data-sovereignty.sh`.)
- Cross-zone data flows **only** via **async Kafka domain events** (each zone keeps its own copy)
  and via the **browser** (links / UI composition). Transient UI state via BroadcastChannel.
  These domain events are an **application concern (bring-your-own broker + clients)** — knext's
  `spec.revalidation.kafka` is ISR-revalidation-only, not a domain-event bus. See the scope
  boundary in [`docs/operator/kafka-eventing.md`](../../docs/operator/kafka-eventing.md#scope-isr-revalidation-vs-cross-zone-domain-events).
- A zone reaches **its own** DB via `DATABASE_URL` from a K8s Secret — never a hardcoded host.

## Scope boundary (sequencing line, not permanent)
The end goal is for knext to **own** zone generation, MFE isolation, and the PWA layer. The split
below is **where the line sits today**, during the adapter-correctness phase — it moves as the
framework grows into the full goal.
- **knext owns today:** Knative/scale-to-zero, the official Next.js adapter, per-zone deploy,
  `assetPrefix` wiring, serving the App Shell, generating the precache manifest.
- **Not in core yet (app-level recipe `pwa-zones`):** Service Worker / SWI / BroadcastChannel /
  Module-Federation runtime. Keep it in the app template, **not** core packages (`packages/kn-next`,
  `packages/cli`, the operator), **until the framework absorbs it** — a phasing guard, not a verdict.
  (Advisory: `protect-core-vs-app-boundary.sh`.)
- **End goal:** these become generated, first-class framework capabilities (the `generate zone`
  scaffolder + a PWA flag).

## Caching (security)
SW/caching config: **never cache auth endpoints or any mutation route** (network-only). Caching
them is a correctness + security bug. (Advisory: `guard-sw-cache-policy.sh`.) See `security.md`.

## Sequencing
Zone generation / MFE isolation / PWA stay **design + app-level template** during the fame-first
phase, then get promoted into the framework **after** the official-adapter migration + Tier-A
correctness (`ROADMAP.md`) — the path toward the full-stack SCS goal. Credibility-phase north star =
**verified-adapter status**; the comprehensive SCS framework is the end-state built on top of it.
