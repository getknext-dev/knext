# Architecture & System-Design Rules (knext)

Persisted operating rules for any architecture/design task in this repo. The lead architect
applies these on every non-trivial change.

## 1. Plan before code
Produce designs, ADRs, and phased plans for review. Do **not** implement until the plan is
approved. Planning artifacts (ADRs, design docs, this file) are not "implementation."

## 2. System-design discipline
For any non-trivial component, work through, in order, and state assumptions explicitly:
requirements & constraints → high-level design → component boundaries & contracts →
data/control flow → trade-offs (with alternatives) → failure modes & scaling → security.

## 3. ADR discipline
Record every significant decision as an ADR in `docs/adr/NNNN-title.md` with:
**Context · Decision · Options considered (trade-off table) · Consequences · Action items.**
Recommend an option — don't just enumerate.

## 4. Established hard rules (north star)
- **Official Next.js Deployment Adapter API only.** Target `NextAdapter`
  (`experimental.adapterPath`, `modifyConfig` + `onBuildComplete`). Do NOT reverse-engineer
  Nitro/Vinext or hand-roll a runtime. The vinext/`bun --compile` path is **deprecated**.
- **The Go operator (`packages/kn-next-operator`) is the single source of truth for cluster
  state** (ADR-001). Nothing else may mutate cluster resources out-of-band.
- **Don't rewrite the runtime twice.** One standalone Node server, run on Node and Bun.
- **Gate every feature on the official Next.js compatibility suite.** Correctness is the
  north star; unverified parity is not "done."
- **No unauthenticated mutating endpoints.** Applies to app routes, operator webhooks, and
  service-to-service calls. Backend services are `cluster-local` by default.

## 5. Honesty about scope and fit
Positioning is a **narrow, verified Next.js-on-Knative adapter — not a general PaaS**, on a
fame-first timeline. If a request expands scope against that, say so and recommend sequencing
rather than silently building it. Reconcile against actual code; treat older docs as stale.

## Current reconciliation notes (2026-06)
- This rules file, `docs/ROADMAP.md`/`docs/MATURITY_PLAN.md`, and `docs/adr/` are **newly
  established** — the strategic direction above previously existed only verbally, not in-repo.
- Stale docs to fix/retire: `docs/VINEXT_MIGRATION_PLAN.md`, vinext mentions in
  `docs/ARCHITECTURE.md` (README already migrated).
- Known structural debt: duplicate CLIs (`packages/cli` Go vs `packages/kn-next/src/cli` TS);
  the TS `deploy.ts` mutates the cluster directly (`kubectl apply`), **violating ADR-001** —
  must consolidate behind the operator + `NextApp` CR. `admin`/`knext` packages appear
  dead/duplicated vs `kn-next` (naming drift) — audit and remove.
