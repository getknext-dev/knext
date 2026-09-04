# PROPOSED maintainer amendment — `.claude/rules/architecture.md` §4

> Drafted by the stability sprint (tasks A4/#885 and the standing ADR-0048 action item 7).
> `.claude/rules/` is not an agent's file to edit; this file is the exact text for the
> maintainer to apply, and both edits are to the same §4 so they land as one action.
> Delete this draft once applied.

## Edit 1 — the official-adapter-default rule (ADR-0048 action item 7)

REPLACE the first §4 bullet ("Official Next.js Deployment Adapter API is the DEFAULT and only
all-apps-verified path…", including its ADR-0036 amendment paragraph) WITH:

- **The vinext + Bun 1.4 compiled single executable is the ONLY user-selectable target
  (ADR-0048, founder decision; Amendment 3 made image optimization work inside it and retired
  the per-file bytecode pass).** The official-adapter/node-standalone path is retired as
  user-selectable but remains described in the artifact contract and reconcilable by the
  operator (stored CRs, `build: turbopack` on the wire). The official compat suite's 778/778
  credential was earned on that retired path; the shipped artifact's claim is
  measured-per-feature until the vinext-axis lane (compat-matrix row) is green — never say
  "suite-verified" of the compiled binary before that row flips with the full evidence
  contract.

## Edit 2 — the seam clause (last bullet of §4)

In the "Instrumentation→app collaborators" bullet, REPLACE the sentence:

> Any such seam MUST be covered by the build-artifact guard
> (`apps/file-manager/standalone-seam-alive.test.ts`, #344) and `@getknext/lib` MUST stay
> bundled — never added to `serverExternalPackages`.

WITH:

> The build-artifact guard is RETIRED (#885, ADR-0027 Amendment): the webpack-layer
> duplication it caught cannot occur in the vinext single-graph build, and a guard whose
> subject cannot exist is decoration. The `globalThis` anchoring itself and the rule that
> `@getknext/lib` stays bundled (never `serverExternalPackages`) remain in force, pinned by
> `template-guarded-instrumentation.test.ts`. If a future build change reintroduces multiple
> module graphs, resurrect the guard BEFORE shipping that change.
