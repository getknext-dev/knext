# ADR-0020 — Release channels: npmjs `@knext/*` canonical, GitHub Packages `@getknext-dev/*` interim

- **Status:** Accepted
- **Date:** 2026-07-10
- **Relates to:** the E1 adoption workstream (issue #53 — first npm publish, the
  #1 adoption blocker), PR #226 (interim GitHub Packages channel), PR #227
  (auto GitHub Releases + dated deprecation plan).

## Context

knext's publishable packages are `@knext/core` (`packages/kn-next`) and
`@knext/lib` (`packages/lib`). The canonical publish path — Changesets →
`.github/workflows/release.yml` → registry.npmjs.org with provenance — is fully
built and verified: the in-repo harness is `scripts/install-smoke.mjs`
(pnpm-pack tarballs → clean `npm install` outside the workspace, run in CI),
and a one-off end-to-end rehearsal against a throwaway local Verdaccio registry
(2026-07-07, not a repo artifact) confirmed the full `changeset publish` flow
including the `workspace:^` rewrite. It is blocked on an irreducible **human**
step: claiming the npm org `knext` and
setting an `NPM_TOKEN` repo secret. Until that happens, no outside user can
install knext at all, which blocks `npx @knext/core`, the Next.js-docs listing
submission, and real-world adoption feedback.

The maintainer directed (2026-07-06): publish an **interim** release to GitHub
Packages so the packages are installable *now*, without waiting on the npmjs
step. GitHub Packages imposes two constraints that shaped the design:

1. The package **scope must match the owning org** → the interim packages are
   `@getknext-dev/core` / `@getknext-dev/lib`, renamed at publish time by
   `scripts/rename-for-ghp.mjs` (which also rewrites the hardcoded `@knext/lib`
   import strings in the compiled `dist/**` — `@knext/lib` is tsup-externalized,
   so a name-only rename would ship a runtime-broken package).
2. Installs require auth **even for public packages** → consumers need a GitHub
   token with `read:packages`; anonymous `npx` remains impossible on this
   channel.

## Decision

Two channels, with an explicit hierarchy and a dated exit:

- **Canonical: npmjs, `@knext/*`.** The only long-term home. Changesets-driven
  (`release.yml`), provenance-attested, safe-by-default (no publish until
  `NPM_TOKEN` exists). On real publishes the workflow also creates GitHub
  Releases tagged `@knext/<pkg>@x.y.z` (`createGithubReleases: true`).
- **Interim: GitHub Packages, `@getknext-dev/*`.** Manual-dispatch only
  (`release-ghp.yml`), built-in `GITHUB_TOKEN` (`packages: write`), no human
  secrets, no provenance (GHP does not support it). Exists solely to make knext
  installable before #53 resolves.
- **Deprecation is automatic policy, not a future decision:** the day
  `@knext/*` publishes to npmjs, the `@getknext-dev/*` versions are marked
  deprecated (`npm deprecate … --registry=https://npm.pkg.github.com`, or a
  final pointer-patch if GHP rejects the deprecate endpoint), `release-ghp.yml`
  stops being dispatched, and docs migrate consumers to `@knext/*`. The GHP
  versions are **never unpublished** — existing consumers keep resolving.
  The executable runbook lives in `docs/RELEASING.md`.

## Options considered

| Option | Installable now? | Human secrets | Anonymous `npx` | Long-term fit |
| --- | --- | --- | --- | --- |
| Wait for npmjs (#53) | no | npm token (human) | yes, once live | canonical |
| **GHP interim + dated deprecation (chosen)** | **yes** | **none** | no (token required) | explicitly temporary |
| Local/self-hosted registry (e.g. Verdaccio) | rehearsal only | n/a | no | not a distribution channel |
| Publish `@knext/*` from a personal npm account | yes | personal token | yes | scope squatting risk; migration pain — rejected |

The personal-account option was rejected because the `@knext` scope must belong
to the project org from its first public version; a later ownership migration
is worse than a short installability gap. A local registry stays what it is —
a rehearsal tool (the standing in-repo verification is `scripts/install-smoke.mjs`),
not a channel.

## Consequences

- knext is installable today (`@getknext-dev/{core,lib}@0.1.0`, published
  2026-07-06) with zero human secrets spent.
- Two package identities exist temporarily; every GHP-facing doc must carry the
  "interim — canonical home is `@knext/*`" framing so no consumer mistakes the
  stopgap for the product. The rename script fails loudly if the dist layout
  stops matching its rewrite assumptions.
- The exit is one-way for maintainers (stop dispatching, deprecate) and
  reversible for consumers (deprecated ≠ removed).
- `npx @knext/core` (anonymous, tokenless) still arrives only with #53 — the
  interim channel deliberately does not relieve pressure on the human step.

## Action items

- [x] Interim channel shipped and published (PR #226, run 28829862963).
- [x] Auto GitHub Releases + deprecation runbook (PR #227).
- [ ] On #53: execute the deprecation plan in `docs/RELEASING.md` (dry-run
      `npm deprecate` first — GHP's support for it is historically flaky).
