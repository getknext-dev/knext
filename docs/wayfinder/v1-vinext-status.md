# V1 — What does vinext actually cover today, in its beta?

> Wayfinder ticket **#606** (child of map **#605**).
> **Evidence date: 2026-08-03.** Every claim below is sourced. Where a fact could not be
> established from a primary source it is written **"not established"** — it has *not* been filled
> in from memory or inference.

## Evidence base (primary sources only)

| # | Source | What it is | Version / date read |
|---|--------|-----------|---------------------|
| S1 | `github.com/cloudflare/vinext` — full repo, shallow clone | The implementation, README, CI workflows, test corpus | HEAD `ced0881` (2026-08-01 02:38:59 +0100) |
| S2 | `README.md` in S1 | The project's own docs (there is **no separate docs site** — no `docs/` dir in the repo) | same commit |
| S3 | `AGENTS.md` in S1 | Maintainer/agent working rules, incl. release + changeset policy | same commit |
| S4 | `tests/nextjs-compat/TRACKING.md` in S1 | Hand-maintained port-tracking of Next.js e2e tests (1247 lines) | same commit |
| S5 | `.github/workflows/nextjs-deploy-suite.yml` + `scripts/e2e-deploy.sh` + `scripts/nextjs-deploy-manifest.mjs` | The nightly run of **Next.js's own e2e suite** against vinext | same commit |
| S6 | `https://vinext-web.vinext.workers.dev/compatibility` | **Public, live conformance dashboard** fed by S5 | latest run **Aug 2, 2026, 03:15 UTC** |
| S7 | `apps/web/app/compatibility/suite-support.ts` + `page.tsx` + `router-buckets.ts` in S1 | The exact definitions behind S6's headline percentages | same commit |
| S8 | npm registry (`npm view vinext`) | Published versions, dist-tags, peer deps, maintainers, license | read 2026-08-03 |
| S9 | GitHub Releases + `packages/vinext/CHANGELOG.md` | Release cadence and change history | read 2026-08-03 |
| S10 | GitHub Issues API (`cloudflare/vinext`) | Open/closed counts, labels, ages | read 2026-08-03 |
| S11 | `https://vinext.dev/` | Official landing page | read 2026-08-03 |
| S12 | `https://blog.cloudflare.com/vinext/` | Cloudflare's launch announcement | published ~late Feb 2026 (repo created 2026-02-24; post says "not even one week old") — **treat as historical** |

**Not used as evidence:** the local skill at `~/.claude/skills/migrate-to-vinext/SKILL.md`. It was read
for orientation only. It is a *copy* of `.agents/skills/migrate-to-vinext/SKILL.md` from the repo and
its "Known Limitations" table is a subset of the README's; nothing here rests on it.

---

## 0. Identity, in one line

vinext is a **Vite plugin that reimplements the public Next.js API surface from scratch** — it does
*not* consume `next build` output (S2 README:9, S2 FAQ "Is this a fork of Next.js?"). Owner:
**Cloudflare** (`cloudflare/vinext`). Licence **MIT** (S8). 8,544 stars / 370 forks; repo created
2026-02-24, last push 2026-08-02 (S10).

**Important distinction for knext:** vinext is **not** an implementation of the official Next.js
**Deployment Adapter API**. Grepping the whole repo for `NextAdapter` / `adapterPath` /
`onBuildComplete` / `modifyConfig` hits only *vendored upstream Next.js type declarations*
(`packages/types/next/upstream/dist/build/adapter/build-complete.d.ts`) — never vinext's own source
(S1). What vinext *does* use from the adapter world is the **adapter test harness contract**:
`scripts/e2e-deploy.sh` opens with `# Contract (per
https://nextjs.org/docs/app/api-reference/adapters/testing-adapters)` and accepts `ADAPTER_DIR`
"(Next.js docs convention)" (S5). Cloudflare's own position on the adapter API, stated in the
announcement: *"Next.js has been working on a first-class adapters API, and we've been collaborating
with them on it. It's still an early effort but even with adapters, you're still building on the
bespoke Turbopack toolchain."* (S12). So: **vinext deliberately competes with the adapter path
rather than sitting on it.**

---

## 1. Next.js versions targeted

| Question | Answer | Source |
|---|---|---|
| Targeted major | **Next.js 16.x**, explicitly and only | S2 FAQ: *"What version of Next.js does this target? Next.js 16.x. No support for deprecated APIs from older versions."* |
| Design principle | *"**Latest Next.js only.** Targets Next.js 16.x. No support for deprecated APIs from older versions."* | S2 "Design principles" |
| Concrete version pinned in the repo | `next: 16.2.7` in the pnpm catalog (`pnpm-workspace.yaml:69`) | S1 |
| Version the nightly conformance run tests against | **`v16.2.6`** (workflow default `inputs.next-ref \|\| 'v16.2.6'`), confirmed by S6's own header: *"Next.js `v16.2.6`"* | S5, S6 |
| Explicitly **not** supported | AMP (`useAmp()` returns `false`), legacy `next export`, `next/jest`, `create-next-app` scaffolding, Turbopack/webpack config, Vercel-specific features (`@vercel/og` edge runtime, Vercel Analytics, Vercel KV/Blob/Postgres), and "bug-for-bug parity with undocumented behavior" | S2 "What's NOT supported (and won't be)" |
| Is `next` required at runtime? | **No.** vinext ships fallback type declarations for `next`/`next/*`. Caveat in the same answer: features consuming Next.js internals (e.g. `styled-jsx`) "may still require a matching Next.js installation" | S2 FAQ |
| A version-support *policy* (how long a Next minor is supported, deprecation window) | **not established** — no such statement in README, AGENTS.md, CONTRIBUTING.md or SECURITY.md | — |

**Non-Next version constraints (these are real adoption gates):** peer deps require
**`vite: ^8.0.0`**, `react: ^19.2.6`, `react-dom: ^19.2.6`, `@vitejs/plugin-rsc: ^0.5.26`,
`react-server-dom-webpack: ^19.2.6` (S8). Vite 8 was made a hard requirement in `1.0.0-beta.0`
("**Build:** require Vite 8 (#2486)", S9). The migration path also requires **ESM**
(`"type": "module"` + renaming CJS config files) (S2 "Migrating an existing Next.js project").

---

## 2. Feature coverage

### 2a. Headline claim, and the caveat on it

The project claims **"~94% of the Next.js 16 API surface has full or partial support"** (S2 README:481).
The landing page says **"92% of the Next.js 16 API surface"** (S11). The Feb announcement said
**"94%"** (S12). **These three numbers disagree and no methodology for any of them is published** —
grepping the repo for `94%`/`API surface` finds the claim in README prose and in agent prompt files,
but **no script, test, or document that computes it**. Treat the 92/94% figure as
**claimed-but-unverified marketing arithmetic**, not a measurement. The measured number is the one
in §3.

### 2b. Per-feature table

Legend: **Documented-supported** = the project's own docs assert it works. **Measured** = backed by
the nightly Next.js-suite run (S6) or the ported-test tracking (S4). vinext's own README legend:
✅ full · 🟡 partial (runtime behaviour correct, some build-time optimisation missing) · ⬜ intentional stub.

| Feature | Status | Basis | Notes / limits (quoted or paraphrased from source) |
|---|---|---|---|
| **App Router** | **Documented-supported ✅ + measured** | S2 "What works today"; S6 App Router supported pass rate **97.7%** (92.1% overall) across 628 files | Pages, routes, layouts, templates, loading, error, not-found, forbidden, unauthorized; route groups; parallel routes `@slot`; intercepting routes `(.)`/`(..)`/`(...)` all ✅ (S2 Routing) |
| **Pages Router** | **Documented-supported ✅ + measured** | S2; S6 **97.2%** supported (95.3% overall) across 246 files | `getStaticProps`/`getStaticPaths`(all 3 fallbacks)/`getServerSideProps` all ✅ (S2 Server features) |
| **RSC** | **Documented-supported ✅** | S2 Server features: "Via `@vitejs/plugin-rsc`. `"use client"` boundaries work correctly" | Implemented *through* `@vitejs/plugin-rsc`, i.e. a third-party dependency owns the RSC pipeline |
| **Server Actions** | **Documented-supported ✅** | S2: "Action execution, FormData, re-render after mutation, `redirect()` in actions" | Known open defect: external redirect from a server action (S4 Phase-3 "New Issues Found"; Playwright chunk 24 = 1 test skipped) |
| **Middleware** | **Documented-supported ✅** but **measurably weak** | S2 Routing: `middleware.ts` **and** `proxy.ts` (Next 16), matcher patterns string/array/regex/`:param`/`:path*`/`:path+` | **4 middleware suites sit in the in-scope-but-failing list**: `middleware-general` (×2), `middleware-rewrites`, `middleware-trailing-slash`, grouped under the label *"Middleware rewrites, query propagation, and trailing slash"* (S7 `SUPPORTED_SUITE_FEATURES`) |
| **ISR** | **Documented-supported ✅**, **partially contradicted by measurement** | S2: "Stale-while-revalidate, pluggable `CacheHandler`, background regeneration"; default handler is in-memory `MemoryCacheHandler` in **all** runtimes incl. Workers — KV is opt-in (S3:512) | Failing supported suites include `app-static.test.ts`, `prerender.test.ts`, `revalidate-reason`, `next-after-app-deploy`, grouped as *"ISR, tags, revalidation, and after()"* (S7). Historic issue #1487 (open, `help wanted`) filed from a deploy-suite run: *"`revalidate`/`fetchCache`/`force-static`/`unstable_cache` do not produce stable values"*, ~18 failures (S10) |
| **Data cache / `"use cache"`** | **Partial — and this is the largest deliberate gap** | S2 Server features marks `"use cache"` ✅ (file- and function-level, `cacheLife()`, `cacheTag()`), but S2 "Known gaps" says the opposite about the *feature*: *"`"use cache"` is partially implemented, but full `cacheComponents` behavior is still incomplete. Cache profiles, tags, partial shells, resume behavior, prefetching, and some dev/build cache semantics do not yet match Next.js in every case."* | This is an **internal contradiction inside the README**. The classifier resolves it: `suite-support.ts` marks all Cache-Components suites **`deferred` — "Cache Components are not implemented yet."** (S7) |
| **Image optimization** | **Partial 🟡** | S2 module shims: `next/image` 🟡 — remote via `@unpic/react` (28 CDNs), local via `<img>` + `srcSet`, **"No build-time optimization/resizing"**; `images` config 🟡 **"Parsed but not used for optimization"** | Request-time optimisation exists **only on Cloudflare** (Cloudflare Images binding) (S2, S11). On Node/other platforms: **not established** that any optimisation happens. Open bug #2699 (2026-07-24): *"`next/image` ignores `images.loaderFile` for remote src (renders unoptimized); per-component loader prop yields width=0"* (S10) |
| **Streaming (SSR)** | **Documented-supported ✅ + measured** | S2: "Streaming SSR ✅ Both routers"; S4 chunk 15 streaming 6/6 Vitest + 2/2 Playwright | One failing supported suite `streaming-ssr/index.test.ts` is grouped under *"CSS ordering, styled-jsx, and dynamic CSS"* (S7) |
| **Route handlers (`route.ts`)** | **Documented-supported ✅ + measured** | S2 Routing: "Named HTTP methods, auto OPTIONS/HEAD, cookie attachment"; S4 chunk 5 app-routes 23/23 pass, ON-3 exhaustive HTTP methods | Open Workers-specific bug #2557: route-handler `Request` is a Proxy and breaks libraries that re-wrap it via `new Request()` (S10) |
| **PPR / fallback shells / segment cache** | **Not supported — explicitly `deferred`** | `suite-support.ts` (S7): `DEFERRED_PARTIAL_PRERENDERING` ("Depends on Cache Components and partial prerendering support"), `DEFERRED_SEGMENT_CACHE` ("Depends on the Cache Components segment-cache protocol") — **16 segment-cache suites + 4 PPR suites excluded from the headline pass rate** | README frames this as "Next.js 16 reworked PPR into `"use cache"`" and calls the remaining gap an "intentional stub" (S2:481) — but the classifier calls it *deferred*, not intentional |
| **Static generation / `generateStaticParams`** | **Documented-supported ✅** | S2 Server features (`generateStaticParams` ✅ with `dynamicParams` enforcement; `output: 'export'` ✅; `output: 'standalone'` ✅) | **The Feb announcement (S12) said the opposite** — "vinext does not yet support static pre-rendering at build time … it's on the roadmap (#9)". The README supersedes it; do not cite S12 for this |
| **`next/font`** | **Partial 🟡** | `next/font/google` 🟡 "Runtime CDN loading. **No self-hosting, font subsetting, or fallback metrics**"; `next/font/local` 🟡 "Runtime `@font-face` injection. Not extracted at build time" (S2) | Open bug #2793: `next/font/local` emits `font-weight: 400` when omitted, clamping variable fonts |
| **i18n** | **Partial 🟡** | S2: Pages Router locale prefix + Accept-Language + `NEXT_LOCALE` cookie; **"No domain-based routing"** | |
| **Route segment `runtime` / `preferredRegion`** | **Ignored (no-op)** | S2 Server features 🟡: "`runtime` and `preferredRegion` are ignored" | Repeated in "Known gaps" |
| **`next/og`, `next/cache`, `next/form`, `next/script`, `next/dynamic`, `next/link`, `next/navigation`, `next/server`, `next/headers`, `next/head`, `next/router`, `next/document`, `next/legacy/image`, `next/error`, `next/config`, `next/constants`** | **Documented-supported ✅** | S2 "Module shims" table | |
| **`next/amp`, `next/web-vitals`** | **Intentional no-op ⬜** | S2 | |
| **`instrumentation.ts`** | **Documented-supported ✅** (`register()` + `onRequestError()`) | S2 | Open bug #2515: Node build bundles `serverExternalPackages`, **breaking OpenTelemetry/APM auto-instrumentation** (S10) |
| **Native modules in App Router dev** (`sharp`, `resvg`, `satori`, `lightningcss`, `@napi-rs/canvas`) | **Known-broken in dev** | S2 "Known gaps": *"can fail in Vite's RSC development environment. Production builds support more of these cases than development mode."* | |
| **Non-Cloudflare deployment** | **Partial / uneven — claimed, coverage unknown** | S2 README:9: *"Cloudflare Workers has the deepest integration; **Node.js and other platforms are available with different levels of support**."* Other platforms go through the **Nitro** Vite plugin | The nightly conformance suite runs `vinext build` + `vinext start` (the **Node** path, per `e2e-deploy.sh`), so the measured numbers *are* Node-path numbers — but **no per-platform breakdown is published**; relative Nitro/Vercel/Netlify/Deno coverage is **not established** |

---

## 3. Its own conformance story — this is the strongest thing about the project

**Yes, it runs a real Next.js test corpus, nightly, and publishes the number.**

`.github/workflows/nextjs-deploy-suite.yml` (S5) checks out the **actual `vercel/next.js` repo** and
runs **`node run-tests.js --type e2e`** in `NEXT_TEST_MODE=deploy`, pointing Next.js's own harness at
vinext via the documented adapter-testing script contract (`NEXT_TEST_DEPLOY_SCRIPT_PATH` →
`scripts/e2e-deploy.sh`, which does `vinext build` + `vinext start` and prints the URL). Schedule:
**`cron: "0 2 * * *"`** (nightly), sharded, results POSTed to a D1-backed public dashboard.

### Published numbers — latest run **Aug 2, 2026 03:15 UTC**, vinext `main` vs Next.js `v16.2.6` (S6)

| Metric | Value |
|---|---|
| **Supported pass rate** | **97.4 %** |
| **Overall pass rate** | **93.3 %** |
| **Supported surface coverage** | **94.2 %** |
| Supported files with failures | **25** (in-scope suites still failing) |
| Test files in the run | **799** (App Router 628 · Pages Router 246 · Mixed 95 · Other 20) |
| Runs in the trend chart | last **89** |
| App Router | 97.7 % supported · 92.1 % overall |
| Pages Router | 97.2 % supported · 95.3 % overall |

### What those three numbers actually mean (read the definitions before quoting them)

From S7 (source) and S6 ("How this works"):

- **Overall pass rate** = `passed / (passed + failed)` over every suite, raw. Excludes tests Next.js
  itself skips.
- **Supported pass rate** = same ratio but **after removing suites classified `deferred`,
  `unsupported`, or `needs-vite-equivalent`**. The exclusion list is a hand-maintained map in
  `suite-support.ts` — **exactly 33 suite files** (counted from source): **16 segment-cache**,
  **5 Cache-Components**, **4 PPR/fallback-shell**, **4 bundler-specific** (Babel / webpack-loader /
  scss npm-import-tilde / `next-config`), **2 needs-Vite-equivalent** (import-conditions,
  react-version), and 2 one-offs (Web Workers, Next.js experimental-React channel).
- **Supported surface coverage** = `supportedVerdicts / allVerdicts` — i.e. **94.2 % is the fraction
  of the corpus that is *in scope*, not a pass rate.** The complement (~5.8 %) is what was excluded
  to get from 93.3 % to 97.4 %.
- **"Supported files with failures = 25"** is computed live from the latest run. Separately,
  `suite-support.ts` carries a second, hand-written map (`SUPPORTED_SUITE_FEATURES`, **36 entries**)
  that only attaches human-readable *feature labels* to in-scope suites that were failing as of a
  named historical run (its comment: "classified in run 29551314872"). Where this document names
  specific failing areas (middleware, ISR, metadata, parallel routes), the names come from that
  label map — so treat them as **the shape of the failure set**, not as a verified list of what is
  failing today.

**So the honest reading is: 93.3 % of Next.js's own e2e deploy corpus passes; 97.4 % passes once
Cache Components, PPR and the segment cache are removed from the denominator.** Both are real,
reproducible, published numbers — a materially better conformance story than "94 % of the API
surface".

**Reclassification is a live risk to the headline:** S6 states the support map is applied **at read
time**, so *"reclassifying a suite therefore updates its supported rate … across every historical
run while leaving the stored raw results and overall rate unchanged."* Moving a suite into `deferred`
raises the headline 97.4 % retroactively without any code change. The **overall** 93.3 % is the
tamper-resistant figure.

### Current nightly status: **red**

The last 12 runs of `nextjs-deploy-suite.yml` (2026-07-31 → 2026-08-02, including both scheduled
runs) all have conclusion **`failure`** (S5/S10 via `gh run list`). That is *expected* for a suite
that is 93 % green — the workflow fails when any shard has a failing test; it is **not** evidence of
regression. **Not established:** whether the nightly has ever been green, or whether any of these
percentages gate a merge. There is no evidence the deploy suite blocks PRs — `ci.yml` is a separate
workflow and the deploy suite is `schedule` + `workflow_dispatch` only.

### The second corpus: hand-ported tests

`tests/nextjs-compat/TRACKING.md` (S4) tracks Next.js `test/e2e/app-dir` suites ported by hand, with
per-test PASS/SKIP/N/A verdicts. Its "Combined Key Metrics" claims **400 tests passing (362 Vitest +
38 Playwright) across 35 files, 11 skipped, 0 failures, 188+ N/A**. Note the shape of the "N/A"
bucket: chunks 8–10 (`parallel-routes-and-interception`, the `app` kitchen-sink, `app-static`) —
**115+ tests** — were **not ported at all**, judged "already covered" or "build-time/ISR-specific".
`app-static` is precisely the area the *machine-run* suite flags as failing. This file is a
self-assessment, not a gate.

### Test-count claims are stale

README/announcement say **"over 1,700 Vitest tests and 380 Playwright E2E tests"** (S2 FAQ, S12).
A static grep of the current tree finds **~10,221** `it(`/`test(` declarations under `tests/`
(excluding `e2e/`) across 396 files, and **~1,437** under `tests/e2e/` across 201 files. The grep is
an upper bound (it counts declarations, not executed cases, and ignores `.each` expansion), so the
**exact executed counts are not established** — but the README figure is clearly no longer current
and understates the suite.

---

## 4. Project health

| Dimension | Finding | Source |
|---|---|---|
| **Age** | Repo created **2026-02-24**; first npm publish `0.0.0` **2026-02-16** | S8, S10 |
| **Release cadence** | Extremely high. **60 npm versions in ~5.5 months.** `0.0.x` was near-daily (Feb–Jun). Since **1.0.0-beta.0 (2026-07-04)**: beta.1 Jul 10, beta.2 Jul 16, beta.3 Jul 21, **beta.4 Jul 24** — roughly weekly | S8, S9 |
| **Release gap at time of writing** | **~10 days** with no publish (last release 2026-07-24; repo HEAD 2026-08-01) — the repo is very active, releases are just batched | S8, S1 |
| **Commit volume** | **1,067 commits in the last ~90 days** | S10 |
| **Maintainer concentration — the key health fact** | Top-2 authors wrote **771 of 1,067 (72 %)** of last-90-day commits: James Anderson 518, Nathan Nguyen 253. Third is 82. All-time contributions show the same shape: `james-elicx` 661, `NathanDrake2406` 435, `southpolesteve` 129, then a long tail | S10 |
| **Contributor breadth** | 40+ distinct contributors all-time; ~20 authors in the last 90 days; `help wanted` (22) and `good first issue` (1) labels in use | S10 |
| **npm maintainers** | 2: `southpolesteve` and `wrangler-publisher` (Cloudflare devprod) | S8 |
| **Authorship** | *"Almost every line of code in vinext was written by AI."* Code review is *"a mix of humans and AI agents"*; humans review PRs before merge; *"the test suite is the primary quality gate."* | S12, S2 FAQ "Who is reviewing this code?" |
| **Open issues** | **155 open / 435 closed** (~26 % open) | S10 |
| **Open-issue age profile** | Feb 8 · Mar 21 · Apr 11 · **May 43** · **Jun 43** · Jul 26 · Aug 3. **~52 % of open issues predate July** — a real, non-trivial backlog tail, not just fresh reports | S10 |
| **Open-issue labels** | `adapter-api-e2e` **25**, `help wanted` 22, `nextjs-tracking` 22, `enhancement` 5, `good first issue` 1 | S10 |
| **What `adapter-api-e2e` means** | Label has **no description**. Reading the issues: they are **agent-authored issues filed from Next.js deploy-suite CI failures** — issue #1487 opens *"This issue was created by an agent analysing CI failures from the Next.js Deploy Suite (vinext `main` vs Next.js `v16.2.6`, 2026-05-22)"*. **25 of these are still open, most dated 2026-05-20/22** | S10 |
| **What `nextjs-tracking` means** | Documented label: *"Tracking issue for a Next.js canary change relevant to vinext."* 22 open — overwhelmingly Cache Components / PPR / segment-cache / App-Shell prefetching | S10 |
| **Breaking-change history** | **Zero.** `grep -ci breaking packages/vinext/CHANGELOG.md` → **0** across all 2,182 lines. The release tooling *has* a mechanism to mark them (AGENTS.md:350 — a `major` changeset produces a "Features (breaking)" section), and it has **never been used** | S9, S3 |
| **How to read that zero** | It does **not** mean no breaking changes shipped. `0.2.1 → 1.0.0-beta.0` required **Vite 8** (#2486), which is breaking in effect. It means the project **does not label breaking changes**, so the changelog cannot be used to assess churn | S9 |
| **Security policy** | `SECURITY.md` present; a `HackerOne` issue label exists | S1, S10 |
| **Production users** | One named: **CIO.gov** (National Design Studio), per Cloudflare's announcement. **Not established** whether it is still on vinext, or on what version | S12 |

---

## 5. What "beta" means — in vinext's own terms

**There is no API-stability promise. "beta" is a version-string label and nothing more.**

What was searched, and found empty: `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `SECURITY.md`,
`packages/vinext/README.md` grepped for `semver|stability|stable release|breaking change|api
stability|1.0 release|release candidate` — the **only** hit is `AGENTS.md:350`, an internal note on
how to retroactively reclassify a changeset's semver bump. There is **no** stability section, **no**
support policy, **no** published 1.0 exit criteria, and a GitHub issue search for a `roadmap 1.0
stable` tracking issue returns **nothing**.

What the project *does* say about its own maturity — all of it caution, none of it a guarantee:

- README banner (README:7): *"**Under active development.** vinext supports substantial Next.js
  applications today, but **it is not yet a drop-in replacement for every application or production
  workload**. Expect compatibility gaps, especially in newer App Router features, and evaluate it
  against your own application before adopting it."* (S2)
- README FAQ, "Can I use this in production?": *"You can, **with caution**. vinext has known
  compatibility gaps and **has not yet been battle-tested across the full range of production
  Next.js workloads**."* (S2)
- README FAQ, vs OpenNext: *"OpenNext … **has been well-tested for much longer** … **If you need a
  mature, well-tested way to run Next.js outside Vercel, OpenNext is the safer choice.**"* — the
  project recommending its competitor for the mature case. (S2)
- Announcement (Feb 2026), section heading **"Status: Experimental"**: *"vinext is experimental …
  proceed with appropriate caution."* (S12)
- Compatibility target is explicitly *not* fidelity: *"**Pragmatic compatibility, not bug-for-bug
  parity.** Targets 95%+ of real-world Next.js apps."* (S2)

**Not established:** what distinguishes `1.0.0-beta.x` from the preceding `0.2.x` in stability terms;
what must be true to ship `1.0.0`; whether any API is considered frozen; whether there is a
deprecation window for anything. The `beta` npm dist-tag is **stale** — it points at `1.0.0-beta.0`
while `latest` points at `1.0.0-beta.4` (S8), which is itself a small signal about how much ceremony
attaches to the label.

---

## Summary answer to V1

vinext today is a **fast-moving, Cloudflare-owned, MIT-licensed, Next.js-16-only reimplementation**
that covers **App Router, Pages Router, RSC, Server Actions, route handlers, middleware, streaming,
ISR and static/standalone output as documented-supported**, with **image optimization, fonts,
`images` config, i18n, and route segment `runtime`/`preferredRegion` as partial or ignored**, and
**Cache Components / PPR / segment cache as explicitly deferred and not implemented**.

Unusually for a beta, it has a **real, machine-verified, publicly published conformance number**
against Next.js's own e2e corpus: **93.3 % overall / 97.4 % on the in-scope subset, 799 files,
nightly, vs Next.js v16.2.6, as of 2026-08-02**. That is the number to reason with — not the
unmethodologised "92–94 % of the API surface" in the README and on the landing page.

What it does **not** have is any stability commitment. "Beta" here is a label.

---

## Three biggest gaps / risks

1. **Cache Components, PPR and the segment cache are not implemented — and they are excluded from
   the headline pass rate.** 33 suite files (16 segment-cache, 5 Cache-Components, 4 PPR/fallback-shell,
   plus 8 bundler/Vite-equivalent/one-off entries) are removed by a hand-maintained map in
   `suite-support.ts` to turn 93.3 % into 97.4 %. Because that map is applied **at read time**, reclassifying a suite
   raises the published headline **retroactively across all 89 historical runs** with no code change.
   Worse, the README **contradicts itself** on this: the Server-features table marks `"use cache"`
   ✅ while "Known gaps" says `cacheComponents` behaviour "is still incomplete", and the classifier
   settles it with *"Cache Components are not implemented yet."* If the roadmap depends on `"use
   cache"` — and the README's own PPR answer says it does — **assume it is not there.**

2. **No API-stability promise of any kind, and no breaking-change discipline to compensate.** Nothing
   in the repo defines what beta means, what 1.0 requires, or what is frozen; there is no roadmap
   issue. Meanwhile the changelog contains **zero** breaking-change entries across 2,182 lines
   despite the mechanism existing and despite `1.0.0-beta.0` hard-requiring Vite 8 — so the changelog
   **cannot be used to assess upgrade risk**. Combine that with ~weekly releases, a project that
   pins itself to "latest Next.js only", and peer deps that hard-pin Vite 8 / React 19.2.6, and the
   version-churn exposure is high and unquantifiable from public sources. The project itself
   recommends OpenNext "if you need a mature, well-tested way to run Next.js outside Vercel".

3. **Coverage outside Cloudflare Workers is asserted, not measured — and the weak spots cluster in
   exactly the areas a self-hosted platform depends on.** The README concedes "Node.js and other
   platforms are available with **different levels of support**", non-Cloudflare targets route
   through **Nitro**, and **no per-platform conformance breakdown is published**. Among the in-scope
   suites carrying known failures (25 in the latest run; 36 labelled in `SUPPORTED_SUITE_FEATURES`),
   **four are middleware** (rewrites, query propagation, trailing
   slash) and several are **ISR/revalidation/`after()`** (`app-static`, `prerender`,
   `revalidate-reason`, `next-after-app-deploy`); image optimization has **no build-time pipeline at
   all** and request-time optimisation exists **only** via the Cloudflare Images binding.
   Compounding this: **25 `adapter-api-e2e` issues filed from CI failures back in May 2026 are still
   open**, ~52 % of the whole open backlog predates July, and **72 % of the last 90 days' commits
   come from two people** on a codebase where "almost every line was written by AI".

### One structural note for the knext decision (out of scope for V1, flagged not concluded)

vinext is **not** built on the official Next.js Deployment Adapter API — no `NextAdapter` /
`adapterPath` / `onBuildComplete` in its source, only Next.js's *adapter-testing script contract*
in CI. Cloudflare's stated position is that adapters "only cover build and deploy" and still bind you
to Turbopack. Since knext's north star (`CLAUDE.md` §3, `.claude/rules/architecture.md` §4) is the
official adapter API, **vinext and knext's default path are alternative strategies, not layers** —
consistent with ADR-0036 treating a vinext/bun build target as an **opt-in, compat-gated
alternative** rather than a runtime direction. Whether the measured numbers above justify that
opt-in is a decision for the map (#605), not a finding of this ticket.
