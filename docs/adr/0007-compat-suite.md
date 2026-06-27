# ADR-0007: Wire the official Next.js adapter compatibility suite into CI

- Status: Accepted
- Date: 2026-06-20 (Accepted 2026-06-22, A3-2 scaffold landed via #89)
- Backlog: A3-1 ("Wire the official adapter compat suite into a CI job, run on every PR;
  PR is red on failure"), A3-2, A3-3
- Related: ADR-0006 (image optimization), `docs/research/adapter-bun-learnings.md`,
  rule `.claude/rules/architecture.md` ("gate every parity claim on the official compatibility suite")

## Context

knext's north-star credibility lever is **verified-adapter status**: open source + passing the
official Next.js compatibility suite. Our rules say "gate every feature on the official Next.js
compatibility suite" and "unverified parity is not done." Today CI (`.github/workflows/ci.yml`)
runs only Biome lint + vitest unit tests + an operator codegen/`:latest` guard. There is **no
compatibility gate**, so every "we support App Router / ISR / middleware / image opt" claim is
currently unverified.

This ADR resolves an important honesty question up front: **does a turnkey "official Next.js
compatibility suite" exist?** Findings, verified 2026-06-20:

### What is REAL (verified against sources)

1. **Next.js ships an official adapter test harness.** The doc
   `nextjs.org/docs/app/api-reference/adapters/testing-adapters` (Next 16.2.9, updated 2026-04-02)
   is titled *"Validate adapters with the Next.js compatibility test harness and custom lifecycle
   scripts."* It is **not** a published npm package. It is a **mode of Next.js's own e2e test
   suite**: you check out `vercel/next.js`, build it, and run `node run-tests.js` with
   `NEXT_TEST_MODE=deploy` plus environment variables that point at *your adapter's lifecycle
   scripts*. The doc literally provides a copy-paste `test-e2e-deploy.yml`.

2. **The reference Bun adapter (`nextjs/adapter-bun`) implements exactly this.** Verified files:
   - `.github/workflows/test-e2e-deploy.yml` — checks out `vercel/next.js@canary`, builds it +
     Playwright chromium, builds the adapter, then runs the deploy tests **sharded 16 ways**
     (`matrix.group: [1/16 … 16/16]`), `timeout-minutes: 60`, `runs-on: ubuntu-latest-8-core`.
     Trigger is **`workflow_dispatch`** (manual) with the nightly `schedule` cron **commented out** —
     i.e. even the reference does **not** run the full suite per-PR.
   - `scripts/e2e-deploy.sh` — the deploy-script contract: `npm pack` the adapter, install it as a
     tarball dep into the harness's temp app, set `NEXT_ADAPTER_PATH`, run `next build`, start
     `bun bun-dist/server.js` on a random port, TCP-probe readiness, and **echo the URL as the only
     stdout line**. Plus `e2e-logs.sh` and `e2e-cleanup.sh`.
   - `test/deploy-tests-manifest.adapter-bun.json` — a small `{ version, suites, rules:{include,
     exclude} }` file. It currently only **excludes 5 known-failing e2e tests** (e.g.
     `app-prefetch/prefetching`, an edge-async-local-storage case). It does *not* enumerate a
     curated pass-list; it runs Next's whole deploy-eligible set minus exclusions.
   - Mechanism: `NEXT_EXTERNAL_TESTS_FILTERS=test/deploy-tests-manifest.json,<adapter-manifest>` —
     Next's own manifest selects which tests are deploy-eligible; the adapter manifest layers
     include/exclude on top.

3. **The harness is heavyweight.** It clones + builds the entire Next.js monorepo, installs
   Playwright, and drives hundreds of real-browser e2e tests. The reference shards into 16 parallel
   jobs on 8-core runners and still budgets 60 min. This is a **nightly/dispatch** cost, not a
   per-PR cost.

### What is ASPIRATIONAL / not real

- There is **no** `@next/compat-suite` or `next test-adapter` one-command npm package. Anyone who
  claims "just run the official suite" is hand-waving the `vercel/next.js` checkout + build.
- "Verified-adapter status … listed in the Next.js docs" is an **upstream/social** milestone, not a
  CI artifact. CI can make us *suite-passing*; it cannot make us *listed*.
- knext diverges from the reference in two ways that affect the deploy script:
  (a) we use `output: 'standalone'` (bundled `server.js`) where the reference boots Next from the
  project dir; (b) our runtime is **Node + Bun**, the reference is Bun-only. Our `e2e-deploy.sh`
  must build with our adapter and start the **standalone `server.js`**, parameterized by runtime.

### knext starting point (verified)

- Adapter exists: `apps/file-manager/next-adapter.ts` (`modifyConfig` forces `output:'standalone'`;
  `onBuildComplete` logs + best-effort artifact upload). Next 16.0.3 in-repo; harness is 16.2.x.
- No `scripts/e2e-*.sh`, no `deploy-tests-manifest.*.json`, no `test-e2e-deploy.yml` in knext yet.

## Decision

**Adopt the official Next.js adapter deploy-test harness (option B), but split it across two CI
triggers to keep PRs fast and green-able:**

1. **Per-PR gate (A3-1): a fast, deterministic "smoke" job** — `compat-smoke` — that builds the
   `apps/file-manager` app **through the knext adapter** (`NEXT_ADAPTER_PATH=./next-adapter.ts`),
   boots the standalone `server.js` on **both Node and Bun**, and asserts a hand-curated set of HTTP
   behaviors (App Router page, RSC payload, route handler, dynamic route, ISR revalidate, streaming,
   middleware header, `next/image` optimization). This is **red on failure** and runs in ~2-4 min.
   It is honest about scope: it is a **knext smoke suite**, not "the official suite."

2. **Scheduled/dispatch full gate (A3-2): the real official harness** — `compat-suite-full` —
   ported almost verbatim from the reference `test-e2e-deploy.yml`: checkout `vercel/next.js` at a
   **pinned ref**, build it, run `NEXT_TEST_MODE=deploy` sharded, wired to our `scripts/e2e-deploy.sh`
   + a `deploy-tests-manifest.knext.json`. Runs **nightly + `workflow_dispatch`**, not per-PR. This
   is the artifact that substantiates "verified-adapter."

This is the only approach that is *both* runnable in CI today *and* honest about the "verified"
claim. A pure hand-built smoke suite (option C) is cheap but cannot back a parity claim; the full
official harness on every PR (option B-per-PR) is the gold standard but is too slow/flaky to gate
PRs and the reference itself does not do it.

### Options considered

| Option | Fidelity to "official" | Maintenance cost | CI runtime (per run) | Honesty of "verified" claim |
|---|---|---|---|---|
| **A. Curated subset of vercel/next.js e2e tests** (run a hand-picked list of Next's own e2e tests, not deploy-mode) | Medium — real Next tests, but our selection, run outside the official deploy harness | High — we own the test-selection list and must track upstream churn | Medium-High (still builds Next.js) | Medium — "we pass *some* real Next tests" — weaker than the harness, no manifest contract |
| **B. Official deploy-test harness** (`NEXT_TEST_MODE=deploy` + lifecycle scripts + manifest, per the Next docs & adapter-bun) | **Highest — this is literally what Next.js calls the compatibility harness** | Medium — own 3 small shell scripts + a manifest; upstream owns the tests | **High: ~60 min, needs 16-way shard + 8-core; clones+builds Next.js** | **Highest — exactly the official validation path; the manifest is the verifiable contract** |
| **C. Hand-built smoke suite** (boot standalone `server.js`, assert HTTP behaviors with vitest/playwright) | Low — our assertions, not Next's | Low — small, in-repo, stable | **Low: ~2-4 min, no Next.js checkout** | Low — "our own smoke tests pass"; must NOT be presented as official verification |

**Recommendation: C as the per-PR gate (A3-1) + B as the scheduled gate (A3-2).** Use C's speed to
keep PRs honest and fast; use B's fidelity to earn the verified-adapter claim. Reject A — it has B's
cost without B's official-contract credibility. **Never label the option-C smoke job as "official
compatibility" in docs or marketing** — that would violate the project honesty rule.

## CI job sketch

### Per-PR: `compat-smoke` (add to `.github/workflows/ci.yml`) — A3-1

```yaml
  compat-smoke:
    name: Adapter smoke (Node + Bun)
    runs-on: ubuntu-latest
    timeout-minutes: 12
    strategy:
      fail-fast: false
      matrix:
        runtime: [node, bun]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 'latest' }
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      # Build apps/file-manager THROUGH the knext adapter (output:'standalone')
      - name: Build via adapter
        working-directory: apps/file-manager
        env:
          NEXT_ADAPTER_PATH: ./next-adapter.ts   # the contract under test
        run: pnpm exec next build
      # Boot standalone server.js on the matrix runtime, run HTTP assertions, then SIGTERM
      - name: Smoke test
        working-directory: apps/file-manager
        run: pnpm exec vitest run --config ../../test/compat-smoke.vitest.ts
        env:
          KNEXT_RUNTIME: ${{ matrix.runtime }}   # node => `node .next/standalone/server.js`
                                                 # bun  => `bun  .next/standalone/server.js`
```

The vitest suite (`test/compat-smoke.*`) starts `server.js` on a random port and asserts, against a
running server (PR is **red** if any fail):
- App Router page returns 200 + expected HTML (`GET /`)
- RSC request returns an RSC payload (`?_rsc=` / `RSC: 1` header → `text/x-component`)
- Route handler returns expected JSON (`GET /api/...`)
- Dynamic route resolves (`GET /<dynamic>/...`)
- ISR: first hit, `revalidateTag`/`revalidatePath` via the (authenticated) cache path, re-hit shows
  new content (ties to ADR-0006 + the cache-auth fix)
- Streaming: a streamed RSC/Suspense route flushes incrementally
- Middleware: a middleware-injected response header is present
- `next/image`: `GET /_next/image?url=...&w=...&q=...` returns an optimized image
  (`content-type: image/webp`, smaller than source) — guards the biggest functional gap
- Graceful shutdown: SIGTERM drains in-flight request, exits 0 (security rule)

### Scheduled/dispatch: `compat-suite-full` (new `.github/workflows/test-e2e-deploy.yml`) — A3-2

Port the reference workflow with knext substitutions:
- `repository: vercel/next.js`, `ref: <PINNED tag matching our installed next, e.g. v16.2.x>`
  (pin — do **not** track `canary`; an upstream break must not look like a knext regression).
- Build adapter step builds knext's adapter package.
- `NEXT_EXTERNAL_TESTS_FILTERS: test/deploy-tests-manifest.json,<ws>/test/deploy-tests-manifest.knext.json`
- `NEXT_TEST_DEPLOY_SCRIPT_PATH` → `scripts/e2e-deploy.sh` (knext version: pack adapter, install into
  temp app, set `NEXT_ADAPTER_PATH`, `next build`, start **standalone** `server.js` on `$PORT`,
  TCP-probe, echo `http://localhost:$PORT` as the only stdout line).
- `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH` → `scripts/e2e-logs.sh`; `NEXT_TEST_CLEANUP_SCRIPT_PATH` →
  `scripts/e2e-cleanup.sh`.
- 16-way `matrix.group` shard, `schedule` cron + `workflow_dispatch`.
- Run the Bun matrix first; add a Node-runtime variant of `e2e-deploy.sh` as fast-follow.

## Consequences

**Positive**
- Every PR gets a fast, deterministic correctness gate covering the routes we claim to support, on
  **both** runtimes — closing the "unverified parity" gap for day-to-day work.
- The full official harness exists and is reproducible, giving a real, defensible basis for the
  verified-adapter claim and a path toward upstream listing.
- The `deploy-tests-manifest.knext.json` exclude-list becomes an **honest, in-repo ledger** of
  exactly which Next behaviors we do *not* yet pass — no overclaiming.

**Negative / risks**
- **Biggest risk: the per-PR smoke suite creates false confidence.** It is *our* assertions, not
  Next's; green `compat-smoke` is **not** "official compatibility." This must be stated wherever the
  job is referenced, and the full harness must actually be kept running (nightly) or the verified
  claim silently rots. If `compat-suite-full` is allowed to bit-rot, we are back to unverified.
- The full harness clones+builds `vercel/next.js` (~60 min, 8-core, Playwright) and is inherently
  flakier; pinning the Next ref is mandatory to keep failures attributable to knext.
- Our `output:'standalone'` + Node/Bun divergence means our `e2e-deploy.sh` differs from the
  reference; the standalone server-boot path must be validated against the harness's expectations
  (e.g. asset/`NEXT_DEPLOYMENT_ID` handling) before the exclude-list is meaningful.
- Next 16.0.3 in-repo vs 16.2.x harness — the harness ref and our installed `next` should be aligned
  before trusting results.

## Addendum (#147, 2026-06): prebuilt-`next` deviation — architect to confirm

The original sketch above (and rounds 1–3 of #147) had `build-next` **compile `vercel/next.js`
from source**. That proved **non-convergent** on the standard GitHub runner: even after scoping the
build to `next` + its workspace deps and adding a GHA-backed turbo remote cache to persist a
cancelled build incrementally, the build exceeded the 180-min ceiling across two cache-warming
dispatches, so the deploy-tests shards **never executed** — zero official results.

**Deviation taken:** `build-next` now `npm pack`s the **published `next@<pinned version>`** tarball
(the built `packages/next` at the same version) and feeds it to the reference harness via
`NEXT_TEST_PKG_PATHS`, which makes `test/lib/create-next-install.js` skip its source-pack
(`linkPackages`) step and install the tarball into each fixture app. `@next/swc` still arrives
prebuilt from the tarball's optionalDependencies; the next.js source checkout is still used for its
`test/` harness + `run-tests.js`.

**Trade-off:** we now test the adapter against the *published* `next`, not a *source-built* one.
For an **adapter** compatibility test this is arguably **more correct** — it is the exact artifact
real users install — but it is a deliberate departure from the reference harness's source-build
model, so a source-only regression (fixed in the published patch) could in principle be masked.
Pinning the npm version to the in-repo `next` keeps results attributable. **Open for the architect:**
accept the prebuilt model as the standing approach, or treat it as interim until larger runners make
the source build viable (the human lever on #147).

## Action items

- **A3-1 (per-PR gate, this PR's deliverable):**
  - [ ] Add `test/compat-smoke.*` (vitest) that boots standalone `server.js` and asserts the HTTP
        behaviors above, parameterized by `KNEXT_RUNTIME` (node|bun).
  - [ ] Add the `compat-smoke` job to `.github/workflows/ci.yml` (Node+Bun matrix), **required** so
        the PR is red on failure.
  - [ ] Document in the job/README that this is a knext smoke suite, **not** the official suite.
- **A3-2 (scheduled full harness — MVP scaffold landed via #89):**
  - [x] Extract the `NextAdapter` into `@knext/core` (`packages/kn-next/src/adapters/next-adapter.ts`,
        package export `./adapter`) so the harness can point arbitrary fixture apps at it via
        `NEXT_ADAPTER_PATH`. `apps/file-manager/next-adapter.ts` re-exports it (no behavior change).
  - [x] Add `scripts/e2e-deploy.sh`, `e2e-logs.sh`, `e2e-cleanup.sh` (knext/standalone variant of the
        reference) and `test/deploy-tests-manifest.knext.json`. The deploy script packs+installs the
        adapter tarball, sets `NEXT_ADAPTER_PATH`, `next build`s, stages `.next/static`+`public` into
        the standalone tree, boots `server.js` on a free port, persists `BUILD_ID`/`DEPLOYMENT_ID`/
        port/pid to `.adapter-build.log`, and echoes the URL as the only stdout line. Covered by
        `tests/e2e-deploy.contract.test.ts` + `tests/deploy-manifest.test.ts`.
  - [x] Add `.github/workflows/test-e2e-deploy.yml` (port of the reference; **pinned** Next ref;
        `schedule` + `workflow_dispatch`). **MVP deltas from the reference:** a **modest 4-way shard**
        (not 16) and **Node runtime only** to start (`KNEXT_RUNTIME=bun` is a fast-follow); it emits a
        per-shard `compat-suite-summary-*.json` artifact (`scripts/e2e-summary.mjs`, covered by
        `tests/deploy-summary.test.ts`) that #41 consumes.
  - **HONESTY:** this is a runnable **PARTIAL subset**, not a green full suite. The
    `docs/compat-matrix.md` official-suite row **stays ❌** until a green nightly (graduation is a
    separate PR, A3-3). The manifest exclude-list is an **honest ledger** that grows from OBSERVED
    failures, never a pre-emptive fake green.
  - [ ] **Version-skew caveat:** in-repo `next@16.0.3` vs the harness's typical `16.2.x`. The workflow
        pins the ref to `v16.0.3` (`nextjsRef` dispatch input / `NEXTJS_REF` env) to keep results
        attributable to knext; bump deliberately when the in-repo `next` moves.
- **A3-2 (publish the matrix, done):**
  - [x] Publish `docs/compat-matrix.md` — an honest, evidence-gated supported/unsupported matrix,
        linked from the README, with a guard test (`tests/compat-matrix.test.ts`) that fails CI on
        any overclaim (issue #41). Note: the matrix is gated on the per-PR `compat-smoke` checks; it
        is **not** the official suite (#89) and says so explicitly.
- **A3-3 (close the loop on the claim):**
  - [ ] Track the exclude-list shrinking to zero as the public "verified-adapter" scoreboard; surface
        it in docs.
  - [ ] Add a Node-runtime variant of `e2e-deploy.sh` so the full harness covers both targets.
  - [ ] Only after the full harness is green + nightly may docs use the words "passes the official
        Next.js adapter compatibility suite." Pursue upstream listing as a separate, social task.
