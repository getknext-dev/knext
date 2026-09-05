# Contributing to knext

## Mutation-proving a guard

Every new guard is mutation-proved (delete the behaviour it protects, watch it go RED, restore).
**Restore from a byte snapshot and run the residue scan** — `git status --porcelain` cannot see
residue in a file your PR legitimately modifies, which is how two near-misses happened in one
session:

```bash
bun run lint:mutation-residue     # red-on-fail in CI; run it before you commit
```

Read [`docs/guides/mutation-testing.md`](docs/guides/mutation-testing.md) before writing a harness;
it ships one (`scripts/lib/mutation-harness.mjs`) so you do not hand-roll the restore.

## Docs live with the code (`apps/docs/`)

The user-facing docs site (knext.dev) lives in this monorepo at **`apps/docs/`** and consumes
`@getknext/core` via `workspace:*` (see `docs/adr/0024-docs-site-in-monorepo.md`).

- **If your PR changes documented behavior — public surface** (`@getknext/core` exports, the
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
bun install
bun run --filter @getknext/lib build && bun run --filter @getknext/db build && bun run --filter @getknext/core build
bun run --filter knext-docs build            # vanilla (managed-host / Vercel) build
KNEXT_ADAPTER=1 bun run --filter knext-docs build   # self-host / adapter dogfood build
```
