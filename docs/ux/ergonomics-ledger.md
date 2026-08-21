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

---

## Row 2 — 2026-08-21, the same journey re-run after iteration 2 merged (#810)

Instrument: main @ 781376b, all three packages built fresh (`pnpm build`) and `pnpm pack`ed (which
rewrites `workspace:^` — a bare `npm pack` ships an uninstallable tarball, and `pack` runs NO build,
so a stale `dist/` ships silently: both hit during this sitting and both are release-pipeline-only
concerns, but they cost this measurement two false starts, recorded so the next sitting skips them).
Clean scratch dir, `npm install <tarballs>`, journey re-run verbatim. **Caveat: this measures merged
main, not the published npm packages — the novice's real `npx` journey stays at 0.3.0's behavior
until the next publish (user-owned).**

| finding | row-1 state | row-2 state |
|---|---|---|
| 1a `npx kn-next` | npm 404, no guidance | **unchanged** (needs the user-owned `kn-next` alias publish; docs incantation unified in #810) |
| 1b no-config | FATAL + stack + bundler chunk paths | plain-English: what the config is, `create my-app` pointer, docs link — no stack, and the state is guidance, not an error dump |
| 1c doctor no-cluster | "check network/VPN and retry" misdirection | in review (iteration 3, `feat/ux-doctor-no-cluster`) |
| 1d help surface | 7 of ~15 verbs, `create` hidden | grouped **Start here / Deploy and operate / Database** surface, `create` first, examples, `Docs: https://knext.dev` footer |

**Found beyond the row-1 findings, fixed en route (review-driven, ADR-0046):** `cleanup`/`build`
were advertised but undispatched and FELL THROUGH TO DEPLOY (a teardown that deployed); the first
fix made `cleanup --help` tear the app down (caught round 1); stray positionals rode into deploy
behind flags (`--namespace prod cleanup` deployed to prod — caught round 2); the usage-error sweep
claimed complete with six live FATAL dumps (caught round 3, both-streams measurement — pino writes
FATAL to stdout). Now: typo'd verb → "did you mean", every usage mistake is a plain stderr message,
and an inverted fail-closed scan guards the contract (two phrase-list guards died decorative under
mutation before the inverted form held — four decorative guards total in one PR; the dist-bin
behavioural tests caught what every static guard missed).

**Next lever (iteration 4 candidates, in order):** finish 1c (in review) → the config-authoring
wall (can the persona fill `kn-next.config.ts`? does `create` produce something deployable
without edits?) → the "get a cluster" journey (the big wall; founder direction: git-integration +
prepared clouds). User-owned, unblocking 1a permanently: publish the `kn-next` alias package.

---

## Row 3 — 2026-08-21, the config-authoring wall (iteration-4 sitting)

Instrument: the row-2 tarball install (main @ post-#810), `kn-next create my-app` run as the
persona, scaffold inspected, and the schema's requirements read from the source of truth
(`packages/kn-next/src/config.ts`, `cli/validate.ts`).

**What works:** `create` scaffolds 13 files, exit 0 — a complete Next.js app with the guarded
instrumentation pair, Dockerfile, tests, and a genuinely well-commented `kn-next.config.ts`
(every field explained in plain language, scaleDownDelay trade-off included). The persona gets
a real app skeleton in one command.

**Findings:**

| # | finding | severity for the persona |
|---|---|---|
| 3a | `create`'s parting line — "install deps, then `npm run test:seam` to prove the instrumentation seams survive the standalone build" — is contributor jargon. The persona's actual next steps (`cd my-app && npm install && npm run dev`, then doctor/deploy when ready) are not stated. | Medium — first-contact tone, easy fix |
| 3b | **The wall, measured at the source: a minimal deploy hard-requires BOTH a container registry (`'registry' is required`) and an object-storage bucket (`'storage' is required`, `config.ts:258` non-optional).** The scaffold's placeholders (`ghcr.io/<your-user>`, `<your-assets-bucket>`) each imply an account, a provisioning step, and CLI auth (docker login, gsutil/aws) the persona has never done. Vercel's hello-world needs neither. | **The #1 wall after "get a cluster"** |

**Lever candidate (GATED — config-schema change = escalation trigger, architect summoned):**
make `storage` optional for starters — omitted storage ⇒ no asset upload, no assetPrefix, the
standalone server serves its own `_next/static` from the image (how `next start` works
everywhere else). Trade-offs to be judged by the gate: no CDN offload (fine for starters,
documented as the growth path), image a little larger, cold pod serves statics. The registry
half has no in-pod dodge (an image must live somewhere) — its lever is guidance (`create`
could ask/derive, `doctor` could verify push access) and belongs to a later iteration.

**Not yet reached (fog):** the actual `npm install && kn-next deploy` run of the scaffold
against the live cluster (blocked on the wall above being decided); the "get a cluster"
journey itself.
