# Sprint 2 plan of record — MERGE · VERIFY · HARDEN

Synthesized from `.claude/sprint2-plan-architect.md` (phases, standing exit criteria, lanes)
and `.claude/sprint2-plan-sysdesign.md` (designs with evidence; T-numbers below are its).

## Standing exit criteria (every task)
SE-1 the artifact compiles in CI · SE-2 red-first test · SE-3 every new guard ships a committed
prover or a dated exemption · SE-4 no test-only identifier on a published subpath · SE-5 docs in
the same PR · test after each task, suite green before each push.

## Phase 1 — pre-merge (stack FROZEN above #909; work builds on branches, PRs open post-merge)

| id | task | key design fact | exit criteria |
|---|---|---|---|
| M1 | ONE squashed integration PR vs main, all-green at its own head | #890 is red in its own right — never merge in base order | founder has one green thing to merge |
| M3 | **FOUNDER MERGE** — waited on; day-7 unmerged = discovered-fact, gates return | human-only | stack on main |
| V1 | fire compat-vinext.yml ONCE (it 404s until on the default branch — use the PR-trigger path) | starts ADR-0044 Am.2's clock → V2 due at this close | a published number |
| T3a | scaffold ships the shallow `/api/health` route — **today a scaffolded app 404s its own readiness+liveness probe (nextapp_controller.go:755-759) → never Ready, restart-loop**; the boot log even prints `WARMED:/api/health status=404` and nothing reads it | #910 | scaffolded app goes Ready on kind; red-first |
| T4a | reconcile the runtime-entry copies INTO the templates — apps/docs (+47 lines) and file-manager (+56) carry the `/_next/image` intercept the templates LACK → **every scaffolded app silently loses image optimization** (third #895-class defect); then pin ALL copies by scan | #911 | scan-pin reds on any drift; scaffolded app optimizes images |
| T1 | byte cap (ADR-0044 Option C) — **collapsed to a flag**: srvx `maxRequestBodySize` is counted-bytes → 413 (`_body-limit.mjs`), wired at `knext-bun-entry.mjs.hbs:150` AND the `:9091` Bun.serve (`:196`, today open at Bun's 128 MB default on the exact co-resident path ADR-0044 calls unbounded). **Experiment FIRST**: does Bun's native cap count chunked bodies / distrust a lying Content-Length? Default 8 MiB (1Gi ÷ cc20); env `KNEXT_MAX_REQUEST_BYTES`, NO CRD field (no #548 trigger) | due at THIS close once V1 fires | chunked-body 413 proved; mutation prover committed; startup delta ≈ 0 |
| G0 | #902 prover lane resolves bun:test — FIRST in lane G (provers written before it are inert) | — | a bun:test guard proved through the lane |
| S1 | #904 undici bump (`>=7.29.0 <8`, picomatch shape) — scheduled grype ambush | — | bun-exec closure gate green on current DB |

## Phase 2 — post-merge (opens on M3)

- **T2 id flow (D8→D6→D7), collapsed**: vinext already reads `NEXT_DEPLOYMENT_ID` for `?dpl=`
  (vinext next-config.js:424) and the UUID static prefix exists only because the templates never
  set `generateBuildId`. T2a `generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID ?? null` in
  both templates + repoint deploy.ts:442-460's guard at `.output/public/_next/static/` (delete
  the ENOENT skip) → T2b #892 marker (now safe: marker key ≡ protection key by construction)
  → T2c reclaim真 log/test → T2d `NEXT_DEPLOYMENT_ID` via spec.env (mind #186 reserved names).
  T2 fires the CLI trigger mechanically — acknowledged up front.
- **T3b/R3 #894**: post-compile smoke — boot the binary, assert health(200)/metrics/TERM within
  budget; host-arch target locally, cross-target proved in the alpine e2e; fail-never-skip.
- **R1/R2**: committed mutation scripts for both drain gates (post-G0); template↔copy scan-pin.
- **G1–G5**: provers for the nine sprint-1 guards; coverage branch/statement drop becomes a
  DATED exception (it is prose today, coverage-baseline.md:21-27); §4.2 residuals
  (compat-smoke.mjs:53-54 pnpm text, validate.ts:55-56); no self-skipping guard survives.
- **T6 hardening**: T6a the pack beforeAll can silently install PUBLISHED @getknext/lib against
  local core (assert installed versions; `--ignore-scripts`; try/finally pack dirs) · T6b
  `KNEXT_TEST_SEAMS` unconditional throw under NODE_ENV=production · T6c `singleExec` string
  identity vs symlink/relative spelling → realpath both · T6d apps/docs optimizer lacks the
  sharp direct-pass. S2 native-integrity expiry+fail-closed env · S5 metric-docs residual.
- **V4** #850 window re-anchor to a packed-closure hash · **D9** temp-dir *lifetime* guard.

## OUT (with reasons)
#891 (needs lane GREEN, not a run) · #872 close (founder) · #794 · zones/gRPC/PWA · arm64
(--arch cut again, #893 stamp only) · any new public surface while the stack waits.

## Founder items
Merge M1 (the one green squashed PR) · Am.3 time backstop on ADR-0044 · apply the §4 rules
draft (E5 wording fix included) · close #872 · #853 npm token · GHCR visibility.

## Refuse-to-close-sprint-without (system designer)
1. The byte cap enforced on the binary, chunked case proved (a third renewal is a decision to
   ship without the control). 2. A scaffolded app that boots, goes READY, optimizes images and
   caches ISR. 3. The id flow closed end to end, lock-step guard failing loudly.

## T1 experiment result (run before any code, as designed)
Bun 1.4.0 `maxRequestBodySize: 1000`, measured: honest 500B → 200 · honest 5000B → 413 ·
**chunked 5000B (no Content-Length) → 413 — the cap COUNTS bytes** · lying `Content-Length: 100`
with 5000B sent → handler sees exactly 100 bytes (200), the excess never reaches the app.
Verdict: the srvx `maxRequestBodySize` flag satisfies every ADR-0044 Decision-4 constraint that
applies in-process; implement as the flag + tests (chunked 413 included) + prover. T1 WAITS on
agent/s2-scaffold-parity landing (same template file).
