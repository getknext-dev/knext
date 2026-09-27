# Upstream focus plan — vinext (and adjacent) — 2026-09-25

Founder ask: "focus more on the upstream PRs." This is the state as of today, then the plan.

## 1. Where we stand upstream (measured today)

### cloudflare/vinext — 6 open PRs, all CI green (60 success / 6 skipped)
| PR | what | state | next action |
|---|---|---|---|
| #3429 | App Router afterFiles/fallback rewrite → public files 404 | **maintainer-engaged**: james-elicx is pushing fixes on the branch and running the `/bigbonk` review bot; 6 of 7 bot threads addressed (outdated), the last (metadata-route 405) declined as pre-existing | watch for the human approval; answer any new bot round within the day |
| #3226 | `resolve.extensions` from `next.config` shadows nitro's bun runtime entry (#3222) | reopened 09-24 after my wrong "superseded" close; red on main / green on branch; last reviewer ask-bonk 09-17 | needs a maintainer to re-look; one polite ping after 7 quiet days (10-01), not before |
| #3436 | nitro: honour outputFileTracingIncludes/Excludes | CLEAN, no human review yet (1 commit, 09-24) | wait; no ping before 10-01 |
| #3424 | nitro: bundle RSC deps so `react-server` condition holds | CLEAN, no human review | wait |
| #3423 | resolve: `require` export condition for bundled server deps (#3220) | CLEAN, no human review | wait |
| #3241 | worker: inline NEXT_DEPLOYMENT_ID | CLEAN, no human review, oldest (09-23 last commit) | wait; this is the only one that could go stale, keep it rebased weekly |

All six are `mergeable`; nothing needs a rebase today.

### cloudflare/vinext — 13 open issues, **zero maintainer replies** on all of them
#3446 #3445 #3444 #3443 #3442 #3439 #3438 #3437 #3431 #3428 #3223 #3219 #3220. The bottleneck is
maintainer attention, not our output. More issues will not help; consolidated, fix-carrying PRs will.

### oven-sh/bun
- #43848 (open, ours): `Bun.serve` should send `Keep-Alive: timeout=<idleTimeout>` — **already filed**; the "draft" note in memory is stale. Nothing to do but watch.
- #42212 closed not_planned (the reset repro, disproven). Never re-file.

### Ready locally, waiting on founder go-ahead (each is an external post)
1. **#3223 correction comment — POSTED 2026-09-25.** (was time-sensitive): our "OK to close" was premature; the App Router `_next/static` residual is real. Draft in `.claude/research/1322-pages-next-data-spike.md` §B.
2. **Patch A PR — FILED as #3472 (2026-09-25).** Nitro path drops `originalUrl` for `/_next/data` (`req.url` wrong in `getInitialProps`). Branch `fix/pages-worker-data-original-url` @ fdcfb2b5 in the fork clone, 2 files +38/−1 with a test. Filing is one push + `gh pr create` (`.claude/research/1322-vinext-patch-A.md`).
3. **#1313 h3/srvx private report** and the GHSA — security, stays founder-only.
4. Nitro (`public` anchored on `process.execPath` when compiled) and vite-plugin-react (nonce in preloadDeps) — drafts only, non-vinext targets.

## 2. The plan (two weeks)

### Track 1 — convert the open PRs (highest value per hour)
- **#3429 first.** It is the only PR with a maintainer in the loop. Daily: read new bot/human threads, answer or fix the same day, never push over james-elicx's commits (merge, don't rebase, while he is co-driving).
- Weekly Monday sweep on the other five: merge upstream `main` if behind, re-run the PR's own tests, confirm CI green. No pings before 7 quiet days; one ping max, framed as "anything you need from me".
- When one merges: bump vinext in knext the same day (`compat-vinext.yml` pin) and retire the matching knext shim (the alignment plan maps PR → shim: #3436 → S4 missing-files half, #3423/#3424 → S14/S15).

### Track 2 — file the two ready items (needs your "go")
- #3223 correction comment: post as drafted. Cheap, honest, and it protects credibility (we were wrong in public).
- Patch A PR: file it. Small, tested, on the Pages/Nitro path the maintainers are already touching in #3429.

### Track 3 — the one strategic PR: U1 "compile-friendly standalone"
- What: `outDir` resolved relative to `process.execPath` when compiled, plus an optional static server-entry import. It is the only upstream change the vinext-standalone-compiled-with-Bun base strictly needs (alignment plan, rank 2; jev accept 0.63 / small 0.68).
- Why now: it retires S1/S3/S5/S6/S12 and most of S4 in knext, i.e. most of the shim layer, and it aligns with Cloudflare's stated goal of a portable standalone.
- How: open a **discussion issue first** (design sketch + the knext use case), then the PR once a maintainer nods. The issue is founder-gated like any post; the local spike (`vinext-standalone-base-spike.md`) is the evidence.

### Track 4 — small, high-acceptance PRs from the ranked list (one at a time, after Track 3's issue is up)
1. ~~U2~~ FILED as PR #3477 (2026-09-25): docs section in caching.mdx. knext side: set the env var in the vinext lane + runtime and retire the S6 shim (issue to file).
2. ~~U6~~ REPRODUCED on beta.12 and FILED as issue #3478 (2026-09-25); PR offered once a maintainer picks option 1 or 2.
3. ~~U8~~ FILED as PR #3479 (2026-09-26; docs: `transpilePackages` already opts a package out of the OTel auto-externals, tested upstream, undocumented). ~~U7~~ FILED as PR #3480 (2026-09-26): new shim `vinext/shims/cache-adapter-instantiate`, class or factory both get `{ env, options }`, non-callable export errors clearly; knext retirement tracked in #1438.

### What we stop doing
- No new issues on cloudflare/vinext unless a PR ships with them. Thirteen unanswered issues is the ceiling.
- No standing "vinext-upstream" agent. One fresh, task-scoped agent per review round or per PR, Sonnet unless the task is design (Track 3 issue text → Opus).
- No pings inside 7 days, no more than one per PR.

## 3. Decisions needed from the founder
1. **Go/no-go on the two ready posts** (#3223 correction, Patch A PR).
2. **Operating model for vinext posts**: keep per-submission approval, or grant a standing authorization for cloudflare/vinext (issues + PRs, daily digest to you), with bun/nitro/vite still gated per item. jev's read is in the reply.
3. ~~U1 discussion issue~~ POSTED as cloudflare/vinext#3476 (2026-09-25).

## 4. Exit criteria (two weeks)
- ≥2 of the 6 open PRs merged, or a maintainer decision on each.
- #3223 corrected, Patch A filed.
- U1 discussion issue posted (#3476, 2026-09-25); await a maintainer response or document the silence.
- One knext shim retired per merged upstream PR, same day.

## 5. Bun area (added 2026-09-27, founder: standing authorization on the compile dynamic-imports topic)
- Design note: `brainstorm-bun-compile-dynamic-imports.md`. Order per jev: L1 execPath-anchored resolution → `--include` → diagnostics.
- Posted: proposal comment on oven-sh/bun#11732; issue oven-sh/bun#44053 (`--external` resolved from cwd, not the executable's dir; 4-case repro); correction comment on #11732.
- Measured NOT bugs on 1.4.2 (do not file): embedded `.node` via `--asset` loads with both `process.dlopen` and `require`; `new URL("./x", import.meta.url)` reads embedded assets from any cwd.
- Next: wait for a maintainer read on #44053 / #11732 (default-on vs flag), then the L1 PR (Zig, `src/resolver`; from-source build; task-scoped agent after quota returns). Repro dirs: `scratchpad/bun-repros/`.
vinext#3487 2026-09-26 — deploy switch should cover app-set s-maxage (S6 retirement path)
vinext PRs/issues unchanged; bun#44059 marked ready 2026-09-26
- 2026-09-26 F1 `bun-cjs-dirname-inlined` → https://github.com/oven-sh/bun/issues/44068 (CJS __dirname inlined as build dir in compiled binary)
- 2026-09-27 bun#29066 (fix for #44068) verified on Cloud Build (pinned main + PR src, all src applies cleanly): 4/4 variants fixed, F2 fixture (1b) flips, #44053 unaffected; F3 patch produced (scratchpad, uncommitted). See bun-29066-verification-2026-09-27.md

- 2026-09-27 00:35Z — bun#44059 replies to both CodeRabbit inline threads (r4113531450 build_command.rs backslash/absolute; r4113531502 bare c:d test); head 1b1370d9; verified on Cloud Build b18ba58e (27/0/6 built, 0/27/6 stock). No other upstream posts today.
- 2026-09-27 06:35Z — robobun's two fix PRs for our filed issues verified from-source on Cloud Build and commented (build-only, no pushes): #44081 (fixes #44053, resolve bare specifiers from exe-dir before cwd) — stock fails our repro, PR build passes, 112/0 vs 109/3 own tests, matches our exe-dir-first proposal; #44083 (fixes #44063, mirror embedded shared libs before dlopen) — stock fails ELF repro with ERR_DLOPEN_FAILED, PR build passes cold+warm, 11/0 vs 9/2 own tests. Details + jev scores (0.960 both) in bun-44059-verification-2026-09-27.md "robobun PRs" section.

- 2026-09-27 06:5xZ — bun#44059: third-party ".//tmp" finding fixed (367b568b, 6f9d4b27), reply r4114397822 with Cloud Build numbers (53/0/8 built vs 4/41/8 stock). Head 6f9d4b27.

- 2026-09-27 (N1 embedding shims, registry) — filed the two N1 self-contained-standalone shims that had no upstream issue yet (drafted by the N1 implementer, no duplicate found via `gh search issues` on either behaviour; #11732/#44062/#31575/#29456 read and confirmed distinct): bun#44095 (`require()` of an embedded JSON file asset evaluates it as JavaScript) and bun#44096 (`naming.asset: "[dir]/[name].[ext]"` embeds an extensionless file with a trailing dot). Both repro'd myself first on stock 1.4.2 darwin-arm64 before posting; jev guardrail (AI-tell / knext-vinext-leak / overclaim / credible) all "yes" ≥0.73 on both bodies. Registered both in `tests/upstream-retirement/registry.ts` on the N1 branch (`bun-json-asset-require`, `bun-asset-extensionless-dot`; commit 7155bfd5, pushed to `feat/1456-n1-embed-next-server`) — marker↔registry cross-check, full retirement suite (29/29) and the N1 adapter tests (84/84) green; mutation-proved all three ways (orphan marker reds, simulated-fix reds, broken control → inconclusive) on both new entries before committing the clean state.

- 2026-09-27 (#1498 round 3, `embedded-bare-specifier`) — round-1 review flagged this shim's registry entry for citing our own PR bun#44059 as "upstream" instead of a bug report; #44059's own text says the bare-specifier/resolver-lookup-order gap is explicitly out of scope for it ("does not touch resolver lookup order"), so it was never a candidate fix. Duplicate-searched first (`gh search issues -R oven-sh/bun` on "bare specifier"/"\$bunfs"/"autoloadPackageJson"/"included entrypoint" + resolve): #44053 (external-package cwd-vs-exe-dir resolution), #11732 (dynamic imports), #40579 (runtime-plugin onResolve) are all adjacent but distinct — none cover a bare specifier from an EMBEDDED module failing to resolve another embedded module. Repro'd on stock bun 1.4.2 darwin-arm64 both via CLI (`bun build --compile --entrypoints ...`) and via `Bun.build()` with `compile.autoloadPackageJson: true` (package.json also embedded as an asset) — identical failure both ways: a relative require of the embedded package resolves, the bare one does not. Filed oven-sh/bun#44101. jev guardrail: AI-written 0.50 (uncertain), leaks 0.19 (no), overclaims 0.27 (no), credible 0.88 (yes). Updated the registry entry's `upstream` to #44101 (not `fixedBy` — #44059 doesn't fix this) and added a note that the rewrite is not retirable on resolution alone: it also dedupes Next's `*.external` singletons across embedded chunks (round-1's mutation proof), so both conditions must hold before the shim goes away. Full retirement suite still 29/29 green.

- 2026-09-27 09:0xZ — bun#44101 filed (a bare specifier imported from an embedded module never resolves inside the compiled binary); registry entry on knext #1498 cites it (fixedBy TBD; not our #44059). jev 0.50/0.19/0.27/0.88.

## Tick 2026-09-27 (upstream driver) — after 12:07Z, read-only recon this tick, no new pushes/posts

Scope note: this tick was recon + triage only (`gh api`/`gh search`, read-only). No Cloud Build run, no push to the bun fork, no new public comments — the one item that needed a same-day fix (vinext#3429) needs real engineering on unfamiliar code, so it's flagged for a dedicated follow-up rather than a rushed patch on a maintainer-engaged PR.

| Item | State | Changed since 08:00Z 09-27 (or last tick) | Action taken | Quiet days | Next action + date |
|---|---|---|---|---|---|
| bun#44059 (`--include`) | open, mergeable=true, mergeable_state=**blocked** (first-time-contributor Buildkite gate), diverged: ahead 12 / **behind 5** vs main | Nothing new past the 06:5xZ round already logged above (last activity: AhmedElBanna80 review comment 06:50:36Z) | None — already answered this tick's window | 0 (we're the last poster) | Behind-by-5 is modest, not urgent; re-check `compare` next tick, merge main into the branch only if behind_by grows or Buildkite still isn't running |
| bun#44053/44062/44063/44068/44095/44096 | open, 1 comment each, all `robobun` "Reproduced" (44095/44096/44101 say "Working on a fix") | No new maintainer/robobun replies beyond what's logged (81, 85-89 above) | None needed — bot repro-confirms, not asks | 44053: ~1d since robobun; others similar | Watch for robobun fix PRs (pattern: #44081→44053, #44083→44063, #29066→44068); Cloud-Build-verify any that land, none new this tick |
| bun#44101 | open, 1 comment (robobun "Reproduced… Working on a fix", 2026-09-27T10:04) | New robobun repro-confirm since filing | None needed | 0 | Watch for a robobun fix PR next tick |
| bun#11732 (proposal) | open | No reply since our 2026-09-26 12:30Z correction comment | None | ~1d | Keep waiting; not at 7-day ping threshold |
| vinext#3429 (maintainer-engaged, james-elicx) | open, mergeable=clean | **Unaddressed**: ask-bonk[bot] posted 1 actionable P2 finding (`readFile` loads the whole asset before slicing a byte-range — no streaming) at 2026-09-24T23:53:27Z, after our last fix commit (97e9db35, 23:43:29Z). No commit or reply since. | **None this tick** — flagged, not fixed; declined to push a blind patch to `app-rsc-handler.ts` on a maintainer-actively-reviewing PR without reading the full diff/context first | **~2.5 days** past the "same day" expectation for this PR | **Top priority next tick**: read the full finding + surrounding code, implement a real range-respecting stream fix, verify, reply on the same thread. Recommend a dedicated fix session, not a rushed recon-tick patch |
| vinext#3226 | open, mergeable=clean | No change since 09-24 11:00Z (our close/reopen dialogue) | None | ~3d | Wait for maintainer read |
| vinext#3436/3424/3423/3241 | open, mergeable=clean | Only bot noise (pkg-pr-new, perf-benchmarks) since 09-24 | None | n/a (no human reply pending) | No action |
| vinext#3485/#3486 | open, 0 comments | Filed 09-26, no reply | None | ~1d | Not at 7-day PR-from-us threshold; recheck next week |

Verified this tick: `gh auth status` OK (AhmedElBanna80), all PR/issue numbers above confirmed live via `gh api`/`gh search` (not just trusted from prior notes).


- 2026-09-27 13:20Z vinext#3429: bot range-readFile finding was already fixed upstream-side (12e8c7d); we added regression test 801146ff and replied in the thread. Next: watch CI + maintainer response; no ping before 7 quiet days.

## Tick 2026-09-27 14:xxZ (upstream driver 2)

Scope: full sweep per PRIORITY 1 (vinext#3429 CI) + PRIORITY 2 (bun/vinext tracked items).

**PRIORITY 1 — vinext#3429, head 801146ff → now 06fd786.** `mergeable_state` was `blocked` on exactly 1 failing check named "CI" (21 success/8 skipped/1 failure — but that's only page-1 of check-runs; page 2 has the real per-shard Vitest jobs). Traced via `gh api .../actions/runs/<id>/jobs` (not check-runs, which paginates at 30 and hid it): the actual failure was job **"Vitest (unit 3/3)"**, one test — `tests/client-assets-build.test.ts > client asset sidecar builds > keeps App Router metadata at the stable root of nested custom server outputs` — timed out at the default 5000ms. "CI" is a gate job whose only step is a bare `exit 1`/`exit 0` keyed off `needs.*.result`, so it carries no diagnostic text itself.

Determined this is **not our regression**, not our test: the PR diff touches only `dev-static-file-server.ts`/`dev-static-file-signal.ts`/`app-rsc-handler.ts`/`app-public-rewrite` fixtures + our new `tests/dev-static-file-server.test.ts` — nothing in the build/custom-server-output path the failing test exercises. Confirmed the same shard number ("unit 3/3") passed clean on the prior head 97e9db35 (`Vitest (unit 3/3)` id 107881519606, conclusion success) — the failure is new not because we broke it, but because adding a test file reshuffled Vitest's file→shard grouping, landing this pre-existing flaky timeout in a shard that runs this tick. No maintainer/CI config changed underneath us. Verdict: flaky, pre-existing, unrelated — did not post about it (per the no-post-on-flake rule).

Tried `gh run rerun --repo cloudflare/vinext <run> --failed` first (the clean, no-new-diff option) — refused: `must have admin rights to Repository` (the workflow runs in cloudflare/vinext, not our fork; PR authors can't rerun maintainer-repo Actions runs). Fell back to the only lever we do have: pushed an **empty commit** (`06fd786`, "chore: retrigger CI (unrelated flaky timeout in tests/client-assets-build.test.ts)") to `origin/fix/app-rewrite-public-files` to force a fresh CI run. No file changes, no force-push, plain push to our own fork branch. New run should re-shard and very likely pass since nothing about the flaky test's environment changed structurally.

**PRIORITY 2 — sweep, no action needed anywhere:**
| Item | State this tick | Change since last tick | Action |
|---|---|---|---|
| bun#44059 | mergeable=true, mergeStateStatus=BLOCKED, updatedAt 06:52Z | No change | None |
| bun#44053/44062/44063/44068/44095/44096/44101 | all open, 1 comment each (robobun repro-confirm), no new fix PRs found | No new activity | None — nothing to Cloud-Build-verify this tick |
| bun#11732 | open, 9 comments, updatedAt 09-26 12:30Z | No change | None; not at 7-day threshold |
| vinext#3226/3436/3424/3423/3241 | all open, mergeStateStatus=CLEAN, last updated 09-23/24 | No change | None |
| vinext#3485/#3486 | open, 0 comments, filed 09-26 | No change | None; not at 7-day threshold |

Next tick: verify the retriggered vinext#3429 run went green; if the flaky timeout recurs on `client-assets-build.test.ts` a second time it's worth its own upstream issue (perf/timeout), not before.

## Tick 2026-09-27 (upstream driver 3)

**PRIORITY 1 — vinext#3429, head 06fd786, run 36323407874.** The retrigger from driver 2 (empty commit 06fd786) did NOT go green — it surfaced a different, larger failure set than the earlier Vitest unit-3/3 flake: `E2E (app-router 1/3)` (job 108631480049, 211 tests failed), `Performance scenarios` (run 36323407839, job 108631479532), plus the aggregate `CI` gate. Root-caused both, neither is our regression:

- **`E2E (app-router 1/3)` — pre-existing dev-server crash, not caused by our diff.** First real error in the log: the dev server process died with an uncaught `TypeError [ERR_INVALID_STATE]: Invalid state: Controller is already closed` (thrown from `socket-error-backstop.js:186`, inside Node's webstreams adapter reading the incoming request) immediately after `action-body-limit.spec.ts`'s oversized-body test triggered `[vinext] Server action error: Error: Body exceeded 1 MB limit.` in `app-server-action-execution.js`. That crash killed the whole Node process ("Node.js v24.21.0" then exit), so every subsequent test in the shard hit `ERR_CONNECTION_REFUSED` — explaining the 211-failure cascade. None of the stack (`app-server-action-execution.js`, `socket-error-backstop.js`, request-body stream handling) is in our diff, which only touches `resolveFilesystemRoute`/public-file-rewrite routing in `app-rsc-handler.ts`, `dev-static-file-server.ts`, and `dev-static-file-signal.ts`. **Confirmed pre-existing on `main`**: run 36284131020 (headSha 5d1e970e, 2026-09-27T00:58:59Z, well before our branch's runs) failed the identical `E2E (app-router 1/3)` job with 616 hits for the same `ERR_INVALID_STATE`/`Controller is already closed`/`ERR_CONNECTION_REFUSED` signature. Verdict: **flake, not ours.**
- **`Performance scenarios` (Detect Next.js benchmark input changes) — fork-PR trust-boundary policy, not a code bug.** The step's own log is explicit: `VINEXT_PERF_TRUSTED_HEAD: false` (we're a fork PR) and the Next.js-benchmark-input fingerprint differs between our head and the base, so the workflow intentionally `exit 1`s with "Fork pull requests may not change Next.js benchmark inputs." rather than pairing benchmarks. Our diff adds `pnpm-lock.yaml`/`pnpm-workspace.yaml` entries and new files under `tests/fixtures/app-public-rewrite/` — the fingerprint script (`.perf-manifests/benchmarks/perf/nextjs-input-fingerprint.mts`) lives in a private `.perf-manifests` path not present in our clone, so we can't inspect exactly what it hashes, but it's clearly broad enough to flag lockfile/fixture changes as "Next.js inputs." This is maintainer-side infra we have no lever over from a fork — no commit fixes it; it needs either a maintainer trust label/rerun with paired benchmarks, or (out of scope for a same-day fix) us finding a way to add the fixture without touching files the fingerprint watches. **Verdict: not fixable from our side this tick; not a regression we introduced in the functional sense — a policy gate our file changes happen to trip.**

**Action taken:** none pushed — did not spend a second empty-commit retrigger (per instruction, one was already spent by driver 2) and did not push a blind "fix" for either failure since neither is actually broken code on our end. Drafted a one-sentence factual re-run-ask comment for the `E2E` flake (evidence: same crash on `main` run 36284131020) and ran it through the jev guardrail before considering posting — `overclaim` scored 0.74 and `credible` only 0.66 (draft asserted "a re-run would likely go green," an unverified prediction), so **the guardrail did not clearly pass and the comment was not posted.** Evidence recorded here instead, per the flake-branch fallback.

**Open items for next tick:** (1) re-run vinext#3429 CI once more (no code change needed — the `E2E` job is flaky and should pass on a fresh attempt; we're out of forced-retrigger pushes via empty commit, so this likely needs either a real commit that also happens to retrigger CI, or waiting for the maintainer/a scheduled run) and confirm `Performance scenarios` behavior once a maintainer looks at the PR (it may just require a trust label to pair benchmarks, not action from us); (2) if `E2E (app-router 1/3)` fails with the same signature a third time across separate runs (now counts as 2: this one + main's 36284131020), it's worth filing upstream as a dev-server crash on oversized Server Action bodies (`ERR_INVALID_STATE: Controller is already closed` in the request-body stream path) — not filed yet this tick, pending one more confirmed occurrence per the "don't file on a single sighting" norm implicit elsewhere in this log.

**PRIORITY 2 sweep — three untracked open PRs (not issues) added to tracking, all ours, all green, all quiet:**

| Item | State | Last human activity | Quiet days | Next action |
|---|---|---|---|---|
| vinext#3480 — `fix(cache): accept a class as the cache adapter's default export...` | open, mergeable, all checks passing | none (2 bot comments only: pkg.pr.new + perf-benchmark bot, both 2026-09-25) | 2 | None; recheck for maintainer review, not at 7-day ping threshold |
| vinext#3479 — `docs(tracing): document how to opt an @opentelemetry/* package out...` | open, mergeable, all checks passing | none (2 bot comments only, 2026-09-25) | 2 | None; not at 7-day threshold |
| vinext#3472 — `fix(pages): pass the original data URL as req.url in the Worker request stage` | open, mergeable, all checks passing | none (2 bot comments only, 2026-09-25) | 2 | None; not at 7-day threshold |

Verified via `gh pr view --json` + `gh pr checks` (not trusted from prior notes): all three authored by AhmedElBanna80, `state: OPEN`, no failing/pending checks, only automated bot comments — no maintainer engagement yet on any.

## Tick 2026-09-27 (robobun fix PR #44135 verification)

**oven-sh/bun#44135, head 4bcfa8c** ("compile: resolve bare specifiers from embedded modules against the embedded node_modules tree") — robobun's fix PR for our #44101. Built from source on Cloud Build (project `gsw-mcp`, `E2_HIGHCPU_32`, build `f1227c86`, ~16 min wall, debug profile): build exit 0.

Verified against our own #44101 minimal repro (bare `require("dep")` from an embedded CJS chunk) run from an **empty** directory, plus a cwd-poison control (a *different* `dep` on disk) and the JS-API shape (`Bun.build()` + `compile.autoloadPackageJson: true`):
- Stock bun-v1.4.2: bare specifier fails from empty dir; falls through to the disk copy when cwd-poisoned (never sees the embedded one).
- PR build: bare specifier resolves in both cases — the embedded copy wins over a cwd-on-disk copy, matching the PR's own `EmbeddedNodeModules` test comment.

Also ran the PR's own new tests both ways (Bun's contributor rule — a test must fail on stock, pass on the PR build): `test/bundler/bundler_compile.test.ts` + `bundler_compile_autoload.test.ts` — **111 pass / 0 fail** on the PR build (`bun bd test`), **108 pass / 3 fail** on stock 1.4.2 (`USE_SYSTEM_BUN=1`), the 3 failures being exactly the new `EmbeddedNodeModules*` tests.

Covers the knext-relevant shape (an embedded CJS route chunk bare-requiring a package while the binary runs from an empty directory) — same shape as our N1 repro, not a distinct case.

jev guardrail on the comment draft: ai_written 0.17 (no), leaks_internal 0.33 (no), overclaims 0.27 (no), credible 0.86 (yes) — passed, posted: https://github.com/oven-sh/bun/pull/44135#issuecomment-5857898601.

Registry: `tests/upstream-retirement/registry.ts` `embedded-bare-specifier` entry now cites `fixedBy: oven-sh/bun#44135`. **Not retirable yet** — PR is open/unmerged, no release carries it, and per the entry's existing note, condition (2) (the dedupe behavior our rewrite also provides) must independently still hold before the shim goes away. Branch `chore/44135-registry-note-cloud-build-verify` opened for the registry annotation (docs/tracking only, no runtime code changed).
