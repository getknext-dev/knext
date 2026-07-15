# knext-docs

The documentation site for **[knext](https://github.com/getknext-dev/knext)** — the scale-to-zero
Next.js deployment adapter for Knative/Kubernetes. Deployed at **knext.dev**.

This site is a **Next.js App-Router app** (Fumadocs + MDX) that lives in the knext monorepo at
`apps/docs/` and **dogfoods knext**: with `KNEXT_ADAPTER=1` it builds `output: 'standalone'` with the
knext official adapter (`@knext/core/adapter`) and can deploy as a scale-to-zero Knative Service via a
`NextApp` CR — the same path it documents. See `docs/adr/0024-docs-site-in-monorepo.md`.

## USER-FACING content rule

**`content/**` is user-facing.** Even though it lives beside internal ADRs and issue history, it must
contain **no ADR numbers, no issue/PR numbers (`#NN`), and no internal strategy jargon** (e.g.
`vinext`, `Nitro`). Write for adopters, not maintainers. A soft, non-blocking CI reminder greps
added `content/**` lines and warns. (This app's `next.config.ts` / `next-adapter.ts` /
`kn-next.config.ts` legitimately reference internals — the rule is scoped to `content/**` only.)

## Stack

- **Next.js 16** (App Router; standalone output under `KNEXT_ADAPTER=1`)
- **Fumadocs** (`fumadocs-core`, `fumadocs-ui`, `fumadocs-mdx`) for MDX docs
- **`@knext/core`** — the knext adapter + config types, consumed via `workspace:*`
- The "acid-lime-on-void" visual identity, ported from the original static landing page (now in
  `_design-reference/`)

## Develop (from the repo root — workspace-aware)

```bash
pnpm install
pnpm --filter @knext/lib build && pnpm --filter @knext/db build && pnpm --filter @knext/core build
pnpm --filter knext-docs dev               # next dev → http://localhost:3000
pnpm --filter knext-docs build             # vanilla (managed-host / Vercel) build
KNEXT_ADAPTER=1 pnpm --filter knext-docs build   # self-host / adapter dogfood → .next/standalone
pnpm --filter knext-docs config:validate   # validate kn-next.config.ts with the real kn-next validator
```

## Layout

| Path | What |
|---|---|
| `app/(home)/` | The landing page (acid-lime hero, scale-to-zero meter, NextApp CR panel). |
| `app/docs/` | The Fumadocs docs route. |
| `content/docs/*.mdx` | The documentation pages (USER-FACING — see the content rule above). |
| `next.config.ts` / `next-adapter.ts` | Standalone + official-adapter wiring (mirrors `apps/file-manager`). |
| `kn-next.config.ts` | The dogfood deploy config (`KnativeNextConfig`). |
| `vercel.json` | Vercel config — repo-root install/build so `workspace:*` resolves. |
| `Dockerfile` | Runtime image (ported from `apps/file-manager/Dockerfile`). |
| `DEPLOY.md` | The live-cluster deploy runbook. |
| `_design-reference/` | The original hand-authored static HTML (kept for reference). |

## License

Apache-2.0 (matching knext).
