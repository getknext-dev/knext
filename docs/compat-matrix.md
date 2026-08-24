# knext — Next.js compatibility matrix

> **Honest, evidence-gated status of what the knext adapter supports.** Every row is grounded in
> real, on-disk evidence and a mechanical guard test (`tests/compat-matrix.test.ts`) fails CI if a
> ✅ ("supported") row cannot be backed up. When in doubt we mark ⚠️, not ✅.
>
> **knext passes the official Next.js deploy-test suite on `main`** (the `vercel/next.js`
> deploy-test harness, ADR-0007 option B): run 28602886003 (2026-07-02) — **788 passed / 0 failed**
> across 16 shards against `vercel/next.js` **v16.2.0**, Node runtime. The exact scope of that claim
> (architectural exclusions, the per-case flaky-quarantine ledger, Node-only) lives in the
> official-suite row below — read it before repeating the claim. The guard test now **requires**
> that row to cite its run ID + pinned ref + "N passed / 0 failed" result; an evidence-less ✅
> fails CI. See **Maintenance & honesty** below.

## Legend

| Marker | Meaning |
|---|---|
| ✅ | **Supported** — backed by a red-on-fail check (the per-PR `compat-smoke` gate) or test-covered source on disk. |
| ⚠️ | **Partial** — implemented but **not** guarded by a hard correctness check, or with a known caveat (see Notes). Do not rely on it as "verified." |
| ❌ | **Unsupported / unverified** — no working implementation or no evidence; treat as a gap. |
| ⛔ | **Upstream-gated** — architecturally out of reach today (global edge, not yet adapter-standardizable upstream). |

The **Evidence** column cites either a real file path in this repo, or a `compat-smoke` check id
(`a`–`k`) from [`apps/file-manager/scripts/compat-smoke.mjs`](../apps/file-manager/scripts/compat-smoke.mjs),
or the `compat-smoke` CI job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). The
`compat-smoke` job runs per-PR on a **Node + Bun** matrix (ADR-0007 / A3-1). It is a knext **smoke**
gate, not the official suite — the official suite has its own row, own workflow
([`test-e2e-deploy.yml`](../.github/workflows/test-e2e-deploy.yml)), and a stricter evidence rule
(run ID + pinned ref + result, enforced by the guard test).

## Matrix

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| App Router (RSC server render, `GET /` → 200 HTML) | ✅ | smoke a | Hard-asserts 200 + `text/html` + non-trivial body against the standalone `server.js`. |
| RSC flight payload (`RSC: 1` → `text/x-component`) | ✅ | smoke b | Hard-asserts the React flight content-type. |
| Route handlers (App Router `app/api/*/route.ts`) | ✅ | smoke c, apps/file-manager/src/app/api/health/route.ts | Hard-asserts `GET /api/health` → 200 + valid JSON. |
| Dynamic routes (`force-dynamic`, per-request render) | ✅ | smoke d | Hard-asserts 200 on a `force-dynamic` route. |
| Static / prerendered routes (`force-static`) | ✅ | smoke e | Hard-asserts 200 on a `force-static` route. |
| Middleware (Node runtime, response header injection) | ✅ | smoke f, apps/file-manager/src/middleware.ts | Hard-asserts the middleware-injected `x-knext-smoke: 1` header. Node-runtime middleware only (see edge-middleware row). |
| Graceful shutdown (SIGTERM drain) | ✅ | packages/kn-next/src/adapters/shutdown.ts, packages/kn-next/src/__tests__/shutdown.test.ts | Unit-tested drain-on-SIGTERM in the standalone runtime. Not yet exercised end-to-end by `compat-smoke` (no SIGTERM-drain HTTP check in the as-built script). |
| ISR / Data Cache (Redis-backed cache handler) | ✅ | smoke k, apps/file-manager/cache-handler.js, apps/file-manager/src/app/knext-smoke/isr/page.tsx | Redis cache handler (`cacheHandler` in `next.config.ts`), **not** GCS. Since Sprint 1 / T4 the `compat-smoke` job runs a **real Redis service container** and check (k) asserts **content**, not status codes: back-to-back requests must return the **same** value (it is cached — a `force-dynamic` route fails here), the value must **change** after the revalidate window (it is revalidated — a frozen static route fails here), and the configured Redis must then hold keys (`DBSIZE > 0` — the in-memory fallback fails here). The check **fails, never skips**, when `REDIS_URL` is unset. |
| `next/image` optimization (sharp, avif/webp) | ✅ | smoke g, docs/adr/0006-image-optimization.md, packages/kn-next/src/adapters/image-cache-sync.ts | Implementation landed (ADR-0006, sharp #43, scale-to-zero image cache sync #66). Check **(g) is now hard** (Sprint 1 / T4): its two `skip()` paths are gone — the runner has **no skip-on-fail mechanism at all** — and it asserts the optimizer's own evidence, not "some bytes arrived": `Accept: image/webp` must be honoured with `content-type: image/webp` (a static-file passthrough answers `image/png`) and the output must be materially **smaller** than the ~181 KB source fixture (it was re-encoded). |
| Server Actions (`'use server'` mutations) | ✅ | smoke i, apps/file-manager/src/app/knext-smoke/stream/page.tsx | Check (i) drives a **real round-trip** over the no-JS progressive-enhancement path: it reads the `$ACTION_ID_*` field out of the rendered form, POSTs it as `multipart/form-data` with a **per-run random nonce**, and asserts the action's effect both on the response and on a **subsequent render**. Only genuine execution of the action can produce that nonce. The fixture action mutates no server state (caller-scoped cookie only — `security.md`). |
| Streaming / Suspense (incremental flush) | ✅ | smoke j, apps/file-manager/src/app/knext-smoke/stream/page.tsx | Check (j) asserts **chunk arrival ordering**, not the final body — a fully buffered response reproduces the final body byte-for-byte, so asserting it would prove nothing. The shell marker must land in a **strictly earlier chunk** than the Suspense payload, **≥300 ms** before it. |
| Edge Middleware (edge runtime) | ⛔ | docs/adr/0007-compat-suite.md | Upstream-gated: edge-runtime middleware is not yet adapter-standardizable on Knative; knext middleware runs on the Node runtime only. |
| PPR / Cache Components | ⛔ | docs/adr/0007-compat-suite.md | Upstream-gated: Partial Prerendering / Cache Components are not yet adapter-standardizable (CLAUDE.md §6, Tier C). |
| Official Next.js compatibility suite (deploy-test harness) | ✅ | .github/workflows/test-e2e-deploy.yml, test/deploy-tests-manifest.knext.json, docs/adr/0007-compat-suite.md | **GREEN — run 28702729595** (2026-07-04, `workflow_dispatch` on the #215 branch): **778 passed / 0 failed** across **16 shards** (0 notRun, 0 truncated), `vercel/next.js` **v16.2.0**, `NEXT_TEST_MODE=deploy`, Node runtime, driven by knext's `scripts/e2e-*.sh` lifecycle scripts + the `@getknext/core` adapter tarball (totals summed from the run's 16 `compat-suite-summary-*.json` artifacts; 0 failed on every shard). 778 is the reproducible total under the current manifest — the ADR-0007 §d family selection. Historical graduation reference: run 28602886003 (2026-07-02, `main` @ `f247151`, 788 passed / 0 failed) — it **predates the §d selection** (its 788 included the family files that have since been file-level quarantined), so its total is not comparable to the current manifest. **What the claim covers:** Next's own deploy-eligible e2e set — the `test/deploy-tests-manifest.json` base selection mirrored at the pinned ref, including upstream's own per-case known-failing skips — minus (1) knext's **4 documented architectural exclusions** (`$knextExclusions` in [the manifest](../test/deploy-tests-manifest.knext.json): edge-runtime module errors, edge middleware, PPR, Cache Components — the ⛔ rows above) and (2) the **evidence-quarantined flaky ledger** (`$knextQuarantines` — each entry carries the observed run IDs, failure mechanism, and upstream provenance; guarded by `tests/deploy-manifest.test.ts`). The ledger is two-tier since #214 (ADR-0007 §d): per-case `suites` skips for isolated wobble, plus **file-level quarantines for the runtime-prefetch/navigation-timing family** — the 60s `individualTestTimeout` hangs whose root cause is upstream's client segment-cache race under CPU contention, **fixed upstream after the pinned ref** (vercel/next.js#95301; upstream itself suite-skipped five of these files as "too flaky" — one, cached-navigations, was later re-enabled by the #93798 revert, so its entry rests on the root cause + knext's own evidence). Family entries are bounded (≤15), carry `level:"file"` + full provenance, and expire on the first `NEXTJS_REF` containing the upstream fix. **What it does NOT cover:** the **Bun runtime axis** — this ✅ is the **Node** claim only; a separate Bun lane exists (see the Bun runtime-axis row below) but has **no green run yet** — and **the v1.0 long-run stability gate**, which is a separate and stricter claim than this row. **Nightly record as at 2026-08-24** (`node scripts/compat-window-audit.mjs --fetch`, over every scheduled run's `compat-run-ledger`): the node lane has been green on **26 of the 27 nights** since the window opened on 2026-07-29, each `778 passed / 0 failed / 0 notRun` across all 16 shards, most recently **run 32688792926 (2026-08-24, scheduled, `v16.2.0`, 778 passed / 0 failed)** — and **none of those greens was a re-run** (`runAttempt: 1` throughout). The 27th night, run 30790778590 (2026-08-03), executed **zero** tests: shard 16/16 was lost to a runner disconnect before the harness started, which is CI-infrastructure loss, not a compat failure. **This row's ✅ is therefore well-supported and the v1.0 gate is still NOT met**: that gate additionally requires 14 *consecutive* qualifying nights on one unchanged harness fingerprint, and the longest such run to date is **7** (2026-08-12 → 08-18) — the count restarts on every merge that moves the packed `@getknext/*` bytes. See [`docs/compat/window-node-lane.md`](compat/window-node-lane.md) for the night-by-night record. Revocation has teeth: a shard whose summary carries `failed>0` (or phantom `notRun>0`) **fails the job** (the "Fail shard on red results" gate), a failed scheduled run opens the pinned "Compat nightly RED" issue, and the policy is to flip this row back to ❌ citing the red run (the guard permits the flip-back freely). Graduation history (the multi-round path to green) is recorded in the ADR-0007 addenda. |
| Official suite — Bun runtime axis (`KNEXT_RUNTIME=bun`) | ❌ | — | **Lane exists, first green pending — remainder is PARTLY Bun-version-gated (canary-proven), partly open upstream gaps.** The compat workflow ([`test-e2e-deploy.yml`](../.github/workflows/test-e2e-deploy.yml)) carries a separate Bun lane: a `workflow_dispatch` input (`runtime: bun`) and a **weekly Sunday schedule** (`17 5 * * 0`) plumb `KNEXT_RUNTIME=bun` into `scripts/e2e-deploy.sh`, which boots the standalone `server.js` on **bun** instead of node; every `compat-suite-summary-*.json` artifact carries `"runtime"` so results are lane-attributable, and a red bun weekly opens its own "Compat weekly RED (bun lane)" issue (never the Node credential's). A `bun-version` `workflow_dispatch` input (string, default **pinned to `'1.3.14'`** matching the CI pin, #754 — dispatch materialises input defaults, so the pin holds on schedule AND plain dispatch; the weekly runs the pinned fallback, not `latest`) selects the Bun the lane installs (e.g. `canary`), and bun-lane artifacts additionally carry `"runtimeVersion"` — the **observed** `bun --version` — so a canary run's evidence is version-attributable (node artifacts are unchanged; the key is absent on the node lane). **Campaign state (#188, PR #189, three fix rounds on Bun 1.3.14):** 749→784 of 788 (95.1%→99.5%) — fixed knext-side: the keep-alive reset guard (`bun-keepalive-guard.cjs`, Bun ≤1.3.x resets reused sockets; verified fixed in Bun canary 1.4.0), the standalone bun-condition export heal (`standalone-bun-exports`, nft omits react-dom's `server.bun.js`), plus teardown server-log surfacing and bun-lane cache debug. The **3 remaining red files are documented Bun ≤1.3.14 runtime gaps with minimal repros** (edge-sandbox outbound `fetch()` never resolves: `middleware-fetches-with-any-http-method` + app-static's POST-fetch case; the instrumented not-found `invariant` class: `app-static`, `parallel-routes-root-param-dynamic-child`) — **canary proof (run 28622051531, observed Bun 1.4.0): the invariant class PARTIALLY clears (`parallel-routes-root-param-dynamic-child` green; `app-static` still red) and the edge-sandbox `fetch()` gap PERSISTS on 1.4.0** (not version-gated — needs the documented upstream report and/or a knext-side workaround), plus a new red (`edge-compiler-can-import-blob-assets`) first seen on canary. **The "canary-only / pre-release noise" reading of that file is FALSIFIED (2026-08-24 audit):** it went red on the **stable** lane too — run 30738274907 (2026-08-02 weekly, ledger `runtimeVersion: 1.3.14`), shard 16, `allows to fetch a remote URL` ×2, both 60 000 ms timeouts, i.e. the same edge-sandbox outbound-fetch signature as the rest of the family. It has **not** recurred in the three weeklies since, so it is an **intermittent stable-Bun member of the documented fetch family** — not pre-release noise, and not a fourth mechanism. A stable Bun ≥1.4 bump helps but does not alone produce green. **CURRENT STATE (2026-08-24 audit of the four stable-Bun weeklies with per-shard ledgers — runs 30738274907 / 31297820716 / 31929677335 / 32621148829, 08-02 / 08-09 / 08-16 / 08-23): the lane is red 4 of 4, always on shards 6 and 8, always on the same three files — `app-dir/app-static`, `app-dir/parallel-routes-root-param-dynamic-child`, `middleware-fetches-with-any-http-method` — with NO file outside the documented set except the one 08-02 `edge-compiler-can-import-blob-assets` appearance above. The three most recent are byte-for-byte the same shape: `775 passed / 3 failed`, `failed=1` on shard 6 and `failed=2` on shard 8, `runAttempt: 1` (never re-run). This lane is DETERMINISTICALLY RED, not flaky — a re-run does not turn it green, so #545's "re-run until green" vector cannot operate here.** One nuance worth recording because it was previously listed as unresolved: **within** those files the mechanism alternates run to run — `app-static` reports `kind: assertion` (3 cases) on 08-02 and `kind: timeout` (4–5 cases) on 08-09/16/23, while `parallel-routes-root-param-dynamic-child` does the reverse. All four observations come from the same structured ledger extraction, so this is a real alternation and not a comparison artifact; it is consistent with ONE mechanism (an outbound `fetch()` that sometimes hangs to the 60 s cap and sometimes resolves into a wrong-result assertion), not with two. **Under the current §d manifest (778 tests), the prior dispatch reference point is 774 passed / 4 failed — run 29276122186 (2026-07-13, `workflow_dispatch` bun lane, observed Bun 1.3.14; the first bun-lane run of the 0.2.0 three-tarball packaging, which deployed healthy in the same logs — conclusion `failure` by the fail-on-red design; red shards 6/8/13): the 3 documented red files above reproduced exactly (shards 6+8), plus a 4th file, `edge-async-local-storage` (shard 13, 47/1) — the same edge-sandbox outbound-fetch mechanism (the fixture's edge handlers `await fetch(...)` + `await response.text()`), cross-run wobble (green on prior bun weeklies), now §c.1 per-case quarantined in `$knextQuarantines` with final-post-retry evidence; the reference `nextjs/adapter-bun` excludes that file wholesale in its own manifest.** Prior weekly baseline: 775 passed / 3 failed — run 28734528961 (2026-07-05, scheduled weekly, Bun latest), the failures being exactly the 3 documented red files. (The 2026-07-12 weekly red was the #255/#256 packaging incident failing at Prepare — zero adapter signal, fixed by PR #266.) **No green `runtime=bun` run has been observed**, so this row stays ❌ — the Node ✅ above does NOT extend to Bun. Flipping to ✅ requires the same evidence contract as the Node row (run ID + pinned ref + a real all-green result) from a run whose lane was bun (guard-tested in `tests/compat-matrix.test.ts`). |

## Maintenance & honesty

- **Every ✅ is mechanically gated.** `tests/compat-matrix.test.ts` parses this table and fails if a
  ✅ row's Evidence does not resolve to a real on-disk file, a **hard** `compat-smoke` check id, or
  the `compat-smoke` CI job. Every smoke check is now HARD — the runner has no skip-on-fail path — and the guard asserts that for the four T4 capability checks (g, i, j, k) by SCANNING the runner, so reintroducing a `skip()` reds CI. **Hardness is per lane.** The runner has a second, sanctioned way for a check not to red a run: the `lanes` third argument (`await check(name, fn, ['node'])`, the #281 lane filter), which makes the check a declared no-op on the other lane. The guard reads that argument too, so a check narrowed to one lane **cannot back a ✅ row that reads as unconditional** — and a `lanes` value laundered through a variable fails closed rather than reading as "hard on both". A genuinely runtime-specific check stays expressible: a row that **declares its lane scope with the marker `(lane: node)` / `(lane: bun)` in its Feature cell** may cite a check scoped to that lane. The declaration is a structured marker rather than free prose on purpose — prose such as "the bun lane only runs weekly" is ordinary wording in this table and must never silently narrow a row's claim. For the **official-suite row** it additionally requires the ✅ to cite
  a workflow **run ID**, the **pinned `vercel/next.js` ref**, and an explicit **"N passed / 0
  failed"** result — an evidence-less flip fails CI.
- **The `compat-smoke` caveats that were load-bearing are GONE (Sprint 1 / T4).** It used to run with
  `REDIS_URL=""` (in-memory cache, not Redis) and to treat `next/image` (check g) as **skip-on-fail** —
  which is exactly why ISR and image optimization were ⚠️ despite both being implemented. The job now
  runs a digest-pinned Redis service container, the runner has **no skip-on-fail mechanism**, and each
  of the four rows flips only on its **own named evidence** (transcoded format / action nonce / chunk
  ordering / changed ISR content + `DBSIZE`). What remains genuinely un-smoked is listed per row.
- **Promotion path to ✅ for the partials / gaps.** A ⚠️/❌ row may move to ✅ only when a **red-on-fail**
  check covers it — e.g. an ISR-revalidate assertion (with a real `REDIS_URL`), a hard (non-skip)
  `next/image` assertion, or a streaming-flush assertion. Note that a green official-suite run does
  **not** automatically promote a smoke-gated ⚠️ row: each row keeps its own named evidence.
- **The official-suite claim is scoped by its row.** The ✅ above means exactly what its Notes cell
  says — the deploy-eligible set minus the documented exclusions and the quarantine ledger, Node
  runtime, one observed green run on `main` (#89 wired the harness; #147 graduated it, ADR-0007).
  The claim stays honest only while the nightly stays green: a sustained red nightly must flip the
  row back (the guard permits an honest ❌ regression without ceremony) or annotate it. The
  quarantine + exclusion ledgers in `test/deploy-tests-manifest.knext.json` are the public
  scoreboard — shrinking them to zero is the standing goal (ADR-0007 A3-3).
- **Red-nightly procedure (mechanized, end to end).** Red **test results actually fail the
  workflow**: each shard's final "Fail shard on red results" gate exits 1 when its summary JSON
  carries `failed>0` or `notRun>0` (the run step's `|| true` only swallows the *step* exit so the
  `if: always()` summarize/upload ledger always emits — the *job* verdict is the gate's). A failed
  *scheduled* run then makes the `nightly-red-alert` job create-or-update a pinned **"Compat
  nightly RED"** issue carrying the run link (idempotent — one open alert issue, a comment per red
  night). Both links in the chain are guard-tested in `tests/compat-suite-workflow.test.ts`.
  Policy: the alert issue opens → triage the shard logs → if the red persists, **flip this row
  back to ❌ citing the red run**. The matrix guard enforces evidence only in the ✅ direction
  (evidence IFF ✅), so the honest flip-back is always free.

## Lane-scoped ledger (#281 / #282)

The compat ledger is **lane-scoped**: every case and every `$knextQuarantines` entry is
attributed to exactly one runtime lane — **node** or **bun** — mirroring the Node-credential and
Bun-runtime-axis rows above. Lane isolation is enforced in code
(`tests/compat-lane-ledger.ts` — `laneVerdict` reads only one lane's results), so **a node-lane
failure never reds the bun lane, and vice-versa**. The `compat-smoke` runner filters checks by the
active lane and prints a per-lane summary (`LANE=<lane> passing=… quarantined=… failing=…`).

That whole summary line is **built by `apps/file-manager/scripts/compat-smoke-quarantines.mjs`**
(#512), which derives `quarantined=` from the `$knextQuarantines` ledger rather than printing a
literal. Be precise about what the number means: for the smoke lane it is **0 structurally**, not
"0 so far". The smoke runner has **no quarantine mechanism at all** — a check may only PASS or FAIL
(plus the declared runtime-lane SKIP) — and every `$knextQuarantines` entry is bound by the manifest
guards to an **official-suite test path**, which the smoke runner does not run. A real smoke
quarantine would need both a runner-level quarantine status (a deliberate decision — it re-opens
the skip-on-fail hole those checks exist to close) and its own ledger file; it must **not** be
smuggled into Next's run-tests manifest. What the derivation buys today is **falsifiability**: a
ledger the runner cannot read, or an entry that is neither an official-suite path nor a known smoke
check, **fails the run** instead of degrading to a quiet `0`.

| Lane | Role | Quarantined entries |
| --- | --- | --- |
| node | the Node 778/0 credential | the `runtime-prefetch` §d family (file-level) |
| bun | the Bun runtime axis (first green pending) | the `bun-edge-fetch` family (per-case) |

_(This per-lane block is derived from `renderLaneSummaryMarkdown(summarizeLedger(...))` in
`tests/compat-lane-ledger.ts`; update it when the ledger changes.)_

- **Bounded per mechanism-family.** Each family is capped at `FAMILY_QUARANTINE_CAP`
  (`tests/compat-quarantine-bounds.ts`); exceeding the cap is a **hard CI fail** with an escalation
  message — a growing blanket skip is not a policy (guarded by `tests/deploy-manifest-lanes.test.ts`).
- **Dated + upstream-referenced — never hide a regression.** Every quarantine entry must carry a
  **dated justification** (an ISO date *or* a CI run ID — a timestamped, auditable artifact) **and**
  an **upstream reference** (a `vercel/next.js#NNNNN` issue/PR, a knext `#NNN`, or a GitHub
  issue/pull URL). A **run ID is not** an upstream reference: it timestamps a failure but names no
  cause, and a regression's own red run carries one too — so it counts for the dated half only. An
  entry with no upstream cause is a regression being hidden, and is rejected
  (`quarantineEntryProblems`, guarded by `tests/compat-lane-ledger.test.ts`). A quarantine may only
  ever cover a **known-upstream gap**, and expires on the first `NEXTJS_REF` containing the fix.
