# ADR-0024: The knext.dev docs site lives in the monorepo at `apps/docs/`

Status: Accepted · Date: 2026-07-15

## Context
The user-facing docs site (Next.js 16 + Fumadocs, deployed on Vercel at **knext.dev**,
package name `knext-docs`) previously lived in a **separate repository** (`getknext-dev/docs`,
npm-based). To type-check and build the dogfood/self-host config it declared a dependency on
`@knext/core` via a `file:` specifier (`file:../knext/packages/kn-next`), which required a
**sibling checkout** of the core repo at build time. The docs CI checked out the core repo into
`../knext` purely so that `file:` dep would resolve. That sibling-checkout step was the root cause
of a global CI startup failure (docs issue: fragile cross-repo checkout, 0 jobs) and, more
broadly, meant the docs never saw the *live* `@knext/core` surface — the `file:` dep pointed at a
stale local `dist`, so public-surface drift (e.g. an export the site imported) could go undetected
for months.

Two writers of the docs↔code contract (a separate repo consuming a frozen `file:` snapshot) breaks
the "docs updated in the same PR as the code that changed the documented behavior" workflow, and
adds a moving part (the sibling checkout) with no upside now that both live under one org.

## Decision
**Co-locate the docs site in the knext monorepo at `apps/docs/`** as a first-class pnpm workspace
member, consuming `@knext/core` via **`workspace:*`**. This reverses the earlier
three-repos split (core+operator / docs / examples) for the docs site specifically — the docs now
ship from the same repo that owns `@knext/core`.

- Landing location `apps/docs/` (not `docs/`, which is the internal ADR/guide directory; not a new
  top-level glob). `apps/*` is already a pnpm workspace glob and turbo picks it up — it mirrors the
  existing `apps/file-manager` adapter-consumer app exactly.
- The `@knext/core` dependency moves from a `file:`/`optionalDependencies` entry to a
  `workspace:*` `dependencies` entry. pnpm links the in-repo package; **no more sibling checkout**.
  The site's three importers — the `KnativeNextConfig` type (`.`), `@knext/core/adapter`, and
  `@knext/core/validate` — resolve against the built workspace `dist`. (The `./validate` export
  already exists on `main`; it is **not** re-added here — the move merely proves it resolves.)
- **History:** the migration is a **content copy, not a `git subtree`.** knext squash-merges every
  PR, which would collapse a subtree graft anyway. Full commit history remains in the archived
  source repo (see Consequences); this ADR is the provenance pointer.
- **Vercel:** the site keeps shipping from the same Vercel project at knext.dev. The in-repo
  `apps/docs/vercel.json` runs **install and build at the REPO ROOT** (`cd ../..`), so `workspace:*`
  and the root `pnpm.overrides` (Trivy remediations) resolve — Vercel must NOT scope the install to
  `apps/docs`. The build is vanilla Next (`KNEXT_ADAPTER` unset); the platform handles output.
- **CI:** a scoped `docs-site` job joins the monorepo CI (mirrors the `compat-smoke` file-manager
  job): root install → build the `@knext` chain (lib→db→core) → build `knext-docs`. It runs **two
  build legs, both required** — vanilla (managed-host / Vercel parity) and `KNEXT_ADAPTER=1`
  (self-host dogfood, catches adapter-key drift) — plus a Trivy fs scan of the docs dependency
  closure (the npm→pnpm conversion can shift transitive versions). The old cross-repo `ci.yml` and
  its sibling checkout are retired.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **`apps/docs/` in the monorepo, `workspace:*`, content copy** (chosen) | Kills the sibling checkout; docs see the live `@knext/core` surface (drift caught immediately); docs-per-PR becomes natural; mirrors `apps/file-manager`; zero new workspace glob | One-time content copy loses in-tree git history (mitigated: archived source repo + this pointer); adds a Fumadocs build to CI (mitigated: path-filter + turbo cache) |
| Keep the separate repo, replace `file:` with a git dependency | No monorepo change | Still cross-repo; still a stale snapshot; doesn't fix docs-per-PR; more fragile, not less |
| `git subtree add` (preserve history in-tree) | Keeps history under `apps/docs/**` | Squash-merge collapses the graft anyway → the preserved history is lost on merge; not worth the noise |
| Land at top-level `site/` or `www/` | — | Needs a new `pnpm-workspace.yaml` glob; breaks the "apps are apps" convention; no upside over `apps/docs/` |

## Consequences
- docs issue (sibling-checkout global startup failure) is closed: the checkout no longer exists and
  the build runs inside the repo that owns `@knext/core`.
- The docs are now user-facing content living **beside** internal ADRs and issue history. The
  binding rule stands: **no ADR numbers, issue/PR numbers, or internal strategy jargon in
  `apps/docs/content/**`.** A soft, non-blocking CI reminder (`docs-drift-reminder`) greps
  added `content/**` lines for `ADR-NNNN | #NN | vinext | Nitro` and warns.
- **Content debt surfaced by the move (NOT fixed in the migration — follow-up required):** the
  imported `content/docs/scale-zero-pg/**` subtree (and the DB sections of `operator.mdx` /
  `data-sdk.mdx`) was authored as internal product docs and (1) over-claims that knext *builds*
  scale-to-zero Postgres machinery (a Neon-on-Kubernetes routing plane, an `AppDatabase` operator
  that provisions branch-per-app databases, `spec.database.enabled: true` managed provisioning) —
  which conflicts with the engine-agnostic DB-scope decision (knext builds **no** DB scale-to-zero
  machinery; Postgres+pooler recipe only), and (2) is dense with internal references (hundreds of
  `ADR-NNNN`/`#NN`/`deploy/*.sh` mentions) that violate the user-facing rule. This content needs a
  dedicated engine-agnostic + user-facing scrub before it should ship from the monorepo; the soft
  CI reminder keeps it visible.
- **Human-gated (NOT in this change):** in the Vercel dashboard — re-link the project to the
  monorepo repo, set **Root Directory = `apps/docs`**, confirm env vars (`NEXT_DEPLOYMENT_ID`,
  etc.) and that `KNEXT_ADAPTER` is unset, and keep the knext.dev domain attached. Then **archive**
  (do not delete) `getknext-dev/docs`, replacing its README with a pointer to `apps/docs/` — it
  holds the full git history and the docs issue record.

## Action items
- [x] Copy the site into `apps/docs/`; drop `package-lock.json`, `node_modules`, `.next`,
      `.source`, `.vercel`, and the old `.github/`.
- [x] Switch `@knext/core` to `workspace:*`; keep `knext-docs` private.
- [x] Add `apps/docs/vercel.json` (repo-root install/build, vanilla Next).
- [x] Add the `docs-site` CI job (vanilla + `KNEXT_ADAPTER=1` legs + Trivy fs scan).
- [x] Add the soft `docs-drift-reminder` job + CONTRIBUTING guidance.
- [ ] **Follow-up:** scrub `content/docs/scale-zero-pg/**` (+ DB sections of `operator.mdx`,
      `data-sdk.mdx`) to be engine-agnostic and free of internal references before promoting.
- [ ] **Human:** Vercel re-link + Root Directory + env/domain verify; archive the old docs repo.
