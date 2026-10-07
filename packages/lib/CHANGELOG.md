# @getknext/lib

## 1.3.0-rc.7

## 1.3.0-rc.6

## 1.3.0-rc.5

## 1.3.0-rc.4

## 1.3.0-rc.3

## 1.3.0-rc.2

## 1.3.0-rc.1

### Patch Changes

- 1aa6b8f: knext's public docs site moved from `knext.dev` to `knext-platform.dev` (`knext.dev` now resolves to an unrelated Cloudflare 403 page). Updates every user-facing `knext.dev` URL in the CLI — help text (`knext --help`), error-message hints (`knext doctor`, missing-config guidance), scaffolded `knext.config.ts` template comments, the asset-upload multi-cloud hint, and package READMEs (`@getknext/core`, `@getknext/lib`, `@getknext/db`, the `kn-next` alias package) — to `knext-platform.dev`. `@getknext/action`'s README is also updated but carries no changeset entry since that package is `private: true` and never publishes. Kubernetes label keys that happen to share the domain string (e.g. the CRD-adjacent `apps.knext.dev/build-id` label) are unaffected; they are not web links.

## 1.0.0-rc.5

### Patch Changes

- 65eef13: `@getknext/lib/clients`: `getCerbosClient()` and `getMinioClient()` now load their SDKs
  (`@cerbos/grpc` → `@grpc/grpc-js`, and `minio`) lazily, on first use, instead of at import time.
  Together these two were about 60% of the ~0.8–0.9 s boot cost `@getknext/lib/clients` added when
  an app imported it — paid even by apps that never called either getter. An app with tracing on, or
  one that imports `@getknext/lib/clients` directly, no longer pays to load either SDK unless it
  actually calls the corresponding getter.
  
  Both getters keep their existing synchronous signatures — no public API change. Each now returns a
  lightweight facade that loads the real SDK (once, memoized) the first time a method is actually
  called on it; every existing call site is unaffected.

## 1.0.0-rc.4

### Patch Changes

- 0a32380: Security: new apps now scaffold with Next.js 16.3.6. The default template moves from 16.3.5, and the vinext builder template from 16.3.3. Next.js 16.2.0 through 16.3.5 have a critical remote code execution vulnerability in `next/og` `ImageResponse` (GHSA-vcvr-r3jv-pc5j), fixed in 16.3.6. If you scaffolded an app from an earlier release candidate, upgrade it with `npm install next@16.3.6` (or a later 16.3.x). The compatibility credential suite now runs against Next.js 16.3.6.
  
  `@getknext/lib` depends on `@grpc/grpc-js` through `@cerbos/grpc` with a range that already admits the patched 1.14.5 (GHSA-m9gg-hp2v-232j), so a fresh install resolves the fix. If your lockfile still holds `@grpc/grpc-js` 1.14.4 or older, update it.

## 1.0.0-rc.3

### Patch Changes

- Release-candidate re-cut with no changes to package code. The compatibility credential test harness now covers the sharp version that Next.js 16.3.5 ships, so the Bun credential runs can execute against this candidate.

## 1.0.0-rc.2

### Patch Changes

- 7661878: Rewrite package READMEs for v1.0 release: concise one-paragraph introductions, quickstart commands that work, supported platforms table (Node/Bun × Turbopack/Webpack, with the Next.js versions on the compatibility page), and clear links to docs, compatibility, security, and contributing pages. Remove internal references (ADR numbers, issue/PR numbers) to prepare for npm publication.

## 1.0.0-rc.1

## 0.4.3

## 0.4.2

No changes in this release.

## 0.4.1

### Patch Changes

- Republish the @getknext/* group at 0.4.1. The 0.4.0 tarballs shipped unresolvable `workspace:` ranges in their sibling dependencies (EUNSUPPORTEDPROTOCOL on install), so `@latest` was rolled back to 0.3.1. The release lane now rewrites `workspace:` ranges to the concrete published version at publish time and a guard verifies the packed tarballs before publishing (see docs/incidents/2026-09-08-npm-release-workspace-and-partial-publish.md). This patch re-ships the 0.4.0 content — the create verb, the OTel fix, and the rest — as an installable 0.4.1.

## 0.4.0

## 0.3.1

### Patch Changes

- bf03457: Version the three published packages in lockstep.
  
  `@getknext/core` depends on `@getknext/lib` and `@getknext/db`, so the three have always had to
  ship as a set — but that was a documented intention, and the tree had already drifted to three
  different numbers. They are now a Changesets `fixed` group, so every release moves all three to the
  same version, and a guard fails if they diverge or if a fourth publishable package appears.
  
  No API change. From this release on, pinning `@getknext/core@x.y.z` pins the whole set.

## 0.2.0

### Minor Changes

- 9810a00: feat(db): core `@getknext/db` data SDK — `getDb` + `getDbRO` (ADR-0021)

  Introduces `@getknext/db`, a thin drizzle-orm wrapper over the existing scale-to-zero
  Postgres pools. The core ships two explicit, never-auto-routed client accessors —
  `getDb()` (writer, `DATABASE_URL`, read-your-writes) and `getDbRO()` (reader,
  `DATABASE_URL_RO`, bounded-staleness ~9s, falls back to the writer with a one-time
  warning when unset) — plus the re-exported drizzle query surface (`eq`/`and`/`sql`/…).

  `@getknext/lib` gains a symmetric read-only pool (`getDbPoolRO` / `closeDbPoolRO`) over
  `DATABASE_URL_RO`, mirroring the writer pool's ADR-0019 contract and tunable via
  `DB_POOL_RO_*`. Schema primitives, extension helpers, and the migrate runner land in
  follow-up work (#239–#242).

### Patch Changes

- Re-release the full three-package set: `@getknext/db` joins the published packages
  (`@getknext/core` depends on it for `kn-next db migrate`), so all three bump
  together and ship as a set — publishing core without db breaks every consumer
  install with a 404 on the missing member.
