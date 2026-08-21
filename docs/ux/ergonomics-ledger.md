# Ergonomics ledger — one row per loop iteration, measured on the real first-user journey

> The standing loop (goal set 2026-08-21): **measure end-user ergonomics each iteration; improve
> it next iteration.** Companion to `docs/benchmarks/cold-start-ledger.md`, same discipline: every
> claim carries the verbatim evidence, every next lever is chosen FROM the measurement, and the
> instrument is stated. The persona is fixed and binding: **a Next.js developer with zero cloud or
> Kubernetes knowledge**, on the path `npx … → config → cluster → deploy`. If a finding is only a
> problem for a k8s-literate user, it scores lower by definition.
>
> Instrument (sitting 1): a clean scratch directory outside the monorepo, the **published**
> `@getknext/*@0.3.0` packages from the real npm registry, and the commands the docs advertise —
> executed exactly as a novice would type them, failures captured verbatim.

| # | date | journey step measured | finding (evidence verbatim) | severity for the zero-k8s persona | lever chosen |
|---|---|---|---|---|---|
| 1a | 2026-08-21 | first command ever: `npx kn-next --help` (bare, no install — what a blog post or LLM would suggest) | `npm error 404 — 'kn-next@*' could not be found`. The bin is `kn-next` but the package is `@getknext/core`; nobody owns the bare `kn-next` name on npm. The docs split the story: `apps/docs …/getting-started.mdx:21` teaches `npx kn-next` (works only AFTER local install, via `node_modules/.bin` — the page says so, a novice won't parse that), `README.md:232` teaches `npx @getknext/core`. | **Fatal first contact.** The advertised front door 404s; there is no error message pointing at the scoped name. | Publish a tiny `kn-next` → `@getknext/core` alias/passthrough package (**user-owned: needs npm auth**, recorded not fixed here). Doc-side: one incantation everywhere, chosen in iteration 2. |
| 1b | 2026-08-21 | first real command in a project dir with no config: `npx @getknext/core` | `FATAL … "Config file not found: …/kn-next.config.ts"` followed by a **stack trace with bundler chunk paths** (`dist/chunk-7AQXUP74.js:17`). No guidance, no mention of `kn-next create`, no docs link. | **High.** The novice's second command crashes with internals. Vercel's equivalent path answers with "run this to set up". | **Iteration 2 (chosen):** no-config becomes a guided message — what a config is, `npx @getknext/core create` to scaffold one, docs URL. No stack trace on this expected state. |
| 1c | 2026-08-21 | `doctor` with no working cluster (stale/absent kubeconfig) | `WARN Cluster reachable — apiserver unreachable (…127.0.0.1:26443 refused) … hint: cluster connection flaked — check network/VPN and retry` | **High.** The hint is written for someone who HAS a cluster having a bad day. The zero-k8s persona has no cluster yet; "check VPN and retry" sends them in a circle. Doctor cannot currently distinguish "no cluster configured" from "cluster flaked". | Iteration 3 candidate: doctor detects the no-kubeconfig / no-context / refused-localhost states and answers with "you don't have a cluster connected yet" + the getting-a-cluster guide. |
| 1d | 2026-08-21 | discoverability: `--help` vs the real CLI surface | `--help` lists **7** verbs (deploy, db bind/migrate, doctor, status, rollback, gc). `src/cli/` dispatches ~**15** — hidden ones include **`create`** (the scaffolder a novice needs first, ADR-0041), `validate`, `preview`, `cleanup`, `build`, `exec`, `loadtest`. `README.md:800` even advertises `cleanup`, which help omits. | **High.** The one command that would rescue finding 1b is undiscoverable from the tool itself. | **Iteration 2 (chosen, same PR as 1b):** help lists the full user-facing surface, `create` first under a "start here" grouping. |

**What sitting 1 establishes:** the platform's runtime story (scale-to-zero, cold start, DNS
rooting) is far ahead of its front door. A zero-knowledge user currently fails at command one
(1a), gets a stack trace at command two (1b), gets misdirected by the diagnostic tool (1c), and
cannot discover the command built to rescue them (1d). None of these need new infrastructure —
1b and 1d are error-message and help-surface changes; 1a needs one `npm publish` of an alias
package; 1c is a state-detection branch in doctor.

**Iteration 2 scope (one PR):** findings 1b + 1d — the guided no-config error and the honest,
complete help surface. Exit criterion, measured by re-running the sitting: a novice in a bare
directory who types the default command is told, in plain words, what to do next — and `--help`
shows them `create`.

**Known walls this ledger has NOT yet reached (fog, not findings):** the config-authoring
experience (can a novice fill `kn-next.config.ts` without knowing what a registry is?), the
"get a cluster" journey itself (the single biggest conceptual wall for the persona — the
long-term direction per the founder is git-integration + prepared clouds), and the first
`deploy` against a real cluster with missing prereqs. Each becomes a sitting once the front
door stops 404ing.
