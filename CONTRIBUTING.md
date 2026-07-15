# Contributing to knext

## Docs live with the code (`apps/docs/`)

The user-facing docs site (knext.dev) lives in this monorepo at **`apps/docs/`** and consumes
`@knext/core` via `workspace:*` (see `docs/adr/0024-docs-site-in-monorepo.md`).

- **If your PR changes documented behavior — public surface** (`@knext/core` exports, the
  `KnativeNextConfig` / `NextApp` schema, CLI flags, or generated code) — **update
  `apps/docs/content/**` in the same PR**, or say why the change is invisible to users.
  This is judgment-based, not a hard gate: a soft CI reminder (`docs-drift-reminder`) will post a
  non-blocking warning when public surface changes without a `content/**` change, but it never
  fails the build.

- **`apps/docs/content/**` is USER-FACING.** Even though it now lives beside internal ADRs and
  issue history, it must contain **no ADR numbers, no issue/PR numbers (`#NN`), and no internal
  strategy jargon** (e.g. `vinext`, `Nitro`). Write for adopters, not maintainers. A soft CI
  reminder greps added `content/**` lines for these and warns — treat it as a nudge, not a gate.
  (The docs app's `next.config.ts` / `next-adapter.ts` / `kn-next.config.ts` legitimately reference
  internals; the guard is scoped to `content/**` only.)

## Building the docs locally

From the repo root (workspace-aware install/build):

```bash
pnpm install
pnpm --filter @knext/lib build && pnpm --filter @knext/db build && pnpm --filter @knext/core build
pnpm --filter knext-docs build            # vanilla (managed-host / Vercel) build
KNEXT_ADAPTER=1 pnpm --filter knext-docs build   # self-host / adapter dogfood build
```
