---
name: framework-design
description: Public-surface, contract, and versioning discipline for knext as a published framework — what is public API vs internal, semver + deprecation policy, config-schema stability, codegen/contract drift, and back-compat. Use when changing exported APIs, the KnativeNextConfig/NextApp schema, CLI flags, generated code, or planning an npm release. knext is a narrow Next.js+Knative adapter, not a general PaaS.
---

# Framework Design Discipline (knext)

knext is consumed by **outside users** (`npx kn-next`, `@kn-next/*` packages, the `NextApp` CRD).
Once published, its **surfaces are contracts**. Treat changes to them with versioning discipline.

## Define the public surface explicitly
Public (stable, semver-governed):
- **CLI:** `kn-next` commands + flags (`build`, `deploy`, `generate`, `cleanup`, …).
- **Config schemas:** `KnativeNextConfig` (`packages/kn-next/src/config.ts`) and the **`NextApp`
  CRD** (`apps.kn-next.dev/v1alpha1`) — the most load-bearing contracts.
- **Exported package APIs:** `@kn-next/core`, `@knative-next/lib` exports.
- **Generated code shape** (gRPC clients/actions/routes) consumed by user apps.

Internal (free to change): reconciler internals, adapter implementation details, build scripts,
anything not exported or documented.

**Action:** the surface is currently fuzzy — duplicate CLIs (Go `packages/cli` vs TS
`kn-next/src/cli`), scope drift (`@kn-next` vs `@knative-next`; docs say `@knext`). Pick ONE CLI,
ONE scope, mark the rest internal/removed before publishing.

## Versioning
- **Semver** the npm packages; **CRD apiVersion** evolves separately (`v1alpha1 → v1beta1 → v1`)
  with conversion. `v1alpha1` signals "may break" — fine for now, but additive-only once users
  exist.
- **Proto contracts:** `service.vN` packages; `buf breaking` gates back-compat in CI (see
  grpc-services).
- Tie features/flags to the version that introduced them in docs (docs-guard Rule 5).

## Stability rules
- **Additive by default.** New optional fields/flags are safe; removing/renaming/retyping a
  public field is a breaking change → major bump + deprecation period.
- **Deprecate, don't delete:** keep the old name working for ≥1 minor with a warning + the
  replacement documented.
- **No silent default changes.** Changing a default (e.g. `containerConcurrency`) is behavioral —
  document + version it. (And don't hardcode it in a generator — emit from config.)
- **Config validation is part of the contract:** `validate.ts` / CRD OpenAPI schema must reject
  unknown/invalid input clearly (`ConfigValidationError` pattern).

## Codegen & drift
Generated artifacts must be **reproducible and in sync** with their source (proto, config). Ship a
`--check` mode that fails CI on drift (mirrors BUILD_ID sync). Never hand-edit generated files.

## Docs as contract
A code change to a public surface **owes a docs change in the same change** (docs-guard Rule 6).
Grep docs for the old symbol before finishing. README/ADRs/CRD samples must match the code.

## Release gate (see devops-automation)
Don't publish until: public surface is named + frozen, semver/changesets set up, compat suite
green (the verified-adapter lever), docs match code, examples run. Publishing `@…/core` unblocks
`npx kn-next` for outside users.

## Scope guard
Every new surface is a maintenance + compat liability. Resist additions that push knext toward a
general PaaS — stay the narrow Next.js+Knative adapter (CLAUDE.md §1, §10).
