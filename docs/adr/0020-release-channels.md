# ADR-0020 — Release channels: npmjs `@getknext/*` canonical, GitHub Packages `@getknext-dev/*` interim

- **Status:** Accepted (amended 2026-07-12: `@getknext/db` joins the package set;
  amended 2026-07-28: upgrade order — operator/CRD first, then CLI)
- **Date:** 2026-07-10
- **Relates to:** the E1 adoption workstream (issue #53 — first npm publish, the
  #1 adoption blocker), PR #226 (interim GitHub Packages channel), PR #227
  (auto GitHub Releases + dated deprecation plan), #255/#256 (the @getknext/db
  packaging incident that forced the 2026-07-12 amendment).

## Context

knext's publishable packages are `@getknext/core` (`packages/kn-next`),
`@getknext/lib` (`packages/lib`) and — since the 2026-07-12 amendment —
`@getknext/db` (`packages/db`, the ADR-0021 data SDK that `@getknext/core` depends
on via `workspace:^` for `kn-next db migrate`). The canonical publish path — Changesets →
`.github/workflows/release.yml` → registry.npmjs.org with provenance — is fully
built and verified: the in-repo harness is `scripts/install-smoke.mjs`
(pnpm-pack tarballs → clean `npm install` outside the workspace, run in CI),
and a one-off end-to-end rehearsal against a throwaway local Verdaccio registry
(2026-07-07, not a repo artifact) confirmed the full `changeset publish` flow
including the `workspace:^` rewrite. It is blocked on an irreducible **human**
step: claiming the npm org `knext` and
setting an `NPM_TOKEN` repo secret. Until that happens, no outside user can
install knext at all, which blocks `npx @getknext/core`, the Next.js-docs listing
submission, and real-world adoption feedback.

The maintainer directed (2026-07-06): publish an **interim** release to GitHub
Packages so the packages are installable *now*, without waiting on the npmjs
step. GitHub Packages imposes two constraints that shaped the design:

1. The package **scope must match the owning org** → the interim packages are
   `@getknext-dev/core` / `@getknext-dev/lib` / `@getknext-dev/db`, renamed at
   publish time by `scripts/rename-for-ghp.mjs` (which also rewrites the
   hardcoded `@getknext/lib` + `@getknext/db` import strings in the compiled
   `dist/**` — both are tsup-externalized in core, and db's tsc build preserves
   its `@getknext/lib` imports, so a name-only rename would ship runtime-broken
   packages).
2. Installs require auth **even for public packages** → consumers need a GitHub
   token with `read:packages`; anonymous `npx` remains impossible on this
   channel.

## Decision

Two channels, with an explicit hierarchy and a dated exit:

- **Canonical: npmjs, `@getknext/*`.** The only long-term home. Changesets-driven
  (`release.yml`), provenance-attested, safe-by-default (no publish until
  `NPM_TOKEN` exists). On real publishes the workflow also creates GitHub
  Releases tagged `@getknext/<pkg>@x.y.z` (`createGithubReleases: true`).
- **Interim: GitHub Packages, `@getknext-dev/*`.** Manual-dispatch only
  (`release-ghp.yml`), built-in `GITHUB_TOKEN` (`packages: write`), no human
  secrets, no provenance (GHP does not support it). Exists solely to make knext
  installable before #53 resolves.
- **Deprecation is automatic policy, not a future decision:** the day
  `@getknext/*` publishes to npmjs, the `@getknext-dev/*` versions are marked
  deprecated (`npm deprecate … --registry=https://npm.pkg.github.com`, or a
  final pointer-patch if GHP rejects the deprecate endpoint), `release-ghp.yml`
  stops being dispatched, and docs migrate consumers to `@getknext/*`. The GHP
  versions are **never unpublished** — existing consumers keep resolving.
  The executable runbook lives in `docs/RELEASING.md`.

## Amendment (2026-07-12) — `@getknext/db` joins the package set on BOTH channels

`@getknext/core@0.1.0` gained a `@getknext/db: workspace:^` dependency (ADR-0021;
`kn-next db migrate` dynamically imports `@getknext/db/migrate`). Because
`pnpm pack`/`changeset publish` rewrite `workspace:^` to `^0.1.0` and
`@getknext/db` was published on NEITHER channel, every consumer install of the
packed/published `@getknext/core` 404'd — the compat credential lanes went red at
"Prepare" (#255 node nightly, #256 bun weekly) and the GHP interim channel
shipped an uninstallable `@getknext-dev/core`. The channel package set is
therefore **{core, lib, db}** on both channels:

- **npmjs canonical:** `@getknext/db` publishes via changesets alongside the other
  two (`publishConfig.access: public, provenance: true`; it was never in
  `.changeset/config.json`'s `ignore` list — the correction is to the workflow
  header/docs that claimed a two-package set).
- **GHP interim:** `release-ghp.yml` stages/publishes `@getknext-dev/db`
  BETWEEN lib and core (dependency order lib → db → core), and
  `scripts/rename-for-ghp.mjs` guards the rewrite PER `@getknext/*` dependency
  (each staged package's dist must contain ≥1 occurrence of each declared
  `@getknext/*` dep specifier) plus a publish-set closure check.
- **Deprecation plan scope grows accordingly:** when #53 lands, `npm deprecate`
  ALL THREE `@getknext-dev/*` packages (`core`, `lib`, `db`) — not just the
  original two.

## Amendment (2026-07-28) — upgrade order: operator/CRD first, then CLI

A release channel decides *how* the packages reach a user; it did not say in what **order** a user
may take them relative to the cluster-side operator. #547 made that order load-bearing, so it is
recorded here (issue #548).

**Decision: upgrade the operator (and therefore the CRD) BEFORE upgrading `@getknext/core` —
operator/CRD first, then CLI.** The CRD is versioned independently of the npm packages, so this is
an ordering rule, not a lockstep requirement.

### Measured, not assumed

The rule follows from an apiserver behaviour that was **measured on a live cluster** (server-side
dry-run), not inferred: whether a field the CLI emits that the installed CRD does not know is
*pruned* or *rejected* depends on the **apply's validation mode**, not on the CRD.

| apply mode | apiserver behaviour on an unknown field |
| --- | --- |
| `kubectl apply --validate=strict` | **rejected** — `strict decoding error: unknown field "spec.…"` |
| `kubectl apply --validate=ignore` | accepted, field silently **pruned** |

Since #547 every `kubectl apply` the CLI issues passes `--validate=strict` explicitly, so the
guarantee belongs to knext rather than to whichever `kubectl` is on the user's `PATH`, and
`kn-next doctor` reports a client older than v1.25 (where that flag value does not exist). The
consequence is the ordering rule: a CLI ahead of the CRD now **fails the apply** instead of
appearing to work.

### The safe direction

**An older CLI against a newer CRD is always valid.** Unknown-field validation is one-directional —
a client emitting a subset of the schema never trips it — so operator-ahead-of-CLI is a legitimate
steady state and nobody should over-constrain a rollout into lockstep.

### What this does not buy (residuals)

Strict validation converts a silent failure into a loud one on the CLI's own apply path. It does
not make the ordering rule enforceable:

- **GitOps controllers (Argo CD, Flux) do not assert strict validation.** On that path an unknown
  field is still pruned silently; the ordering rule is the only protection.
- **A `kubectl` shim on `PATH` can append `--validate=ignore` and win**, because pflag takes the
  **last** occurrence of a string flag.
- **`kn-next doctor` checks only that the CRD *exists***, not that its schema covers what the CLI
  emits, so it passes against an older CRD.

The complete fix is the schema-diff preflight (#314), which compares the emitted field set against
the live CRD schema; until it lands the rule is documented practice on those three paths, not
enforcement. The user-facing runbook — including the error text to search for and the recovery
command — lives in `docs/RELEASING.md` under "Upgrade order"; it is not duplicated here.

## Options considered

| Option | Installable now? | Human secrets | Anonymous `npx` | Long-term fit |
| --- | --- | --- | --- | --- |
| Wait for npmjs (#53) | no | npm token (human) | yes, once live | canonical |
| **GHP interim + dated deprecation (chosen)** | **yes** | **none** | no (token required) | explicitly temporary |
| Local/self-hosted registry (e.g. Verdaccio) | rehearsal only | n/a | no | not a distribution channel |
| Publish `@getknext/*` from a personal npm account | yes | personal token | yes | scope squatting risk; migration pain — rejected |

The personal-account option was rejected because the `@getknext` scope must belong
to the project org from its first public version; a later ownership migration
is worse than a short installability gap. A local registry stays what it is —
a rehearsal tool (the standing in-repo verification is `scripts/install-smoke.mjs`),
not a channel.

## Consequences

- knext is installable today (`@getknext-dev/{core,lib}@0.1.0`, published
  2026-07-06; `@getknext-dev/db` joins per the 2026-07-12 amendment — until it
  is published, the already-published `@getknext-dev/core@0.1.0` is
  uninstallable) with zero human secrets spent.
- Two package identities exist temporarily; every GHP-facing doc must carry the
  "interim — canonical home is `@getknext/*`" framing so no consumer mistakes the
  stopgap for the product. The rename script fails loudly if the dist layout
  stops matching its rewrite assumptions.
- The exit is one-way for maintainers (stop dispatching, deprecate) and
  reversible for consumers (deprecated ≠ removed).
- `npx @getknext/core` (anonymous, tokenless) still arrives only with #53 — the
  interim channel deliberately does not relieve pressure on the human step.

## Action items

- [x] Upgrade order documented in `docs/RELEASING.md` + this ADR and cited by the `db-bind`
      error string, asserted by `tests/upgrade-order-docs.test.ts` (#548).
- [ ] Replace the documented ordering rule with enforcement: the schema-diff preflight (#314).
- [x] Interim channel shipped and published (PR #226, run 28829862963).
- [x] Auto GitHub Releases + deprecation runbook (PR #227).
- [ ] On #53: execute the deprecation plan in `docs/RELEASING.md` for ALL
      THREE `@getknext-dev/*` packages — core, lib, db (dry-run
      `npm deprecate` first — GHP's support for it is historically flaky).
- [ ] Dispatch `release-ghp.yml` after the 2026-07-12 amendment merges so
      `@getknext-dev/db` exists and `@getknext-dev/core` becomes installable
      again (needs a version bump via changesets if 0.1.0 conflicts).
- [x] **Registry-channel install-smoke** for the interim GHP channel:
      `scripts/ghp-install-smoke.mjs` + the `smoke-ghp` job in `release-ghp.yml`
      (v3-P3a) prove a consumer with `GITHUB_TOKEN` + `packages: read` can
      `npm install @getknext-dev/core@<version>` FROM `npm.pkg.github.com` and get a
      working CLI + real (`.js`) app-import surface, with a dependency-confusion
      guard (assert the `@getknext-dev` scope registry is `npm.pkg.github.com`
      pre-install and every resolved tarball URL is on `pkg.github.com` post-install).
      Unlike `scripts/install-smoke.mjs` (which packs from source and never touches a
      registry), this proves the *published channel* is installable. A single manual
      dispatch of `release-ghp.yml` retro-proves the already-published `0.2.0`.
