# Spec review — PR #920 vs issue #892 + sprint-2 T2

## Criteria checklist

| criterion | verdict | evidence |
|---|---|---|
| #892 AC1a — a vinext deploy stages a marker | **met** | `asset-upload.ts:626-647` (`stageNitroPublicAssets` → `resolveVinextStaticId` → writes `.knext-build` into the STAGING copy only); `vinext-asset-gc.test.ts` "the staged upload carries the marker into the remote key set" |
| #892 AC1b — `kn-next gc` reaps a vinext build outside the retain window and not live | **met (observed, not inferred)** | `vinext-asset-gc.test.ts` "reaps a vinext build that left the retain window and is not live" — asserts `store.staticKeys()` for t1/t2 is empty AND `keptUnmarked == []`. `gc.ts:99` wires the CLI verb to the same `pruneOldBuilds` |
| #892 AC1c — a LIVE vinext build's prefix survives the same run | **met** | same file, "a LIVE vinext build's prefix SURVIVES the same run" — `store.keys` still contains `shop/_next/static/t1/chunks/main.js` |
| #892 AC2 — fail-safe: unresolvable id over-kept, never reaped | **met** | `resolveVinextStaticId` returns `{ok:false}` on 0/>1 candidates (`asset-upload.ts:678-698`); marker path warns and stages nothing; test "an UNRESOLVABLE build id is over-kept, never reaped"; mutation row 8 inverts the fail-safe and goes red |
| #892 — marker key ≡ protection key, mutation-proved | **met** | both consumers call `resolveVinextStaticId` (`deploy.ts:514`, `asset-upload.ts:628`); `deploy.ts:526-538` aborts unless static prefix == deploy tag == image tag == `spec.buildId`; prover rows 3/4/5 |
| T2a — `generateBuildId` in BOTH templates | **met** | `packages/kn-next/templates/app/next.config.ts.hbs` and `turbo/generators/templates/zone/next.config.ts.hbs` both carry `generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID ?? null`; `skew-build-id-templates.test.ts` scans both with one comment-stripping predicate proved non-vacuous against 3 controls first |
| T2a — deploy guard repointed at `.output/public/_next/static/`, no skip | **met (deviation, defensible)** | new vinext block `deploy.ts:513-539` has NO skip path and runs under `--skip-build`; it is an ADDITIONAL block — the standalone leg keeps its `.next/BUILD_ID` ENOENT warn-skip (correct: standalone is the shape that writes BUILD_ID; vinext is the default target, so no deploy skips silently any more). Tests: `deploy-orchestrator.test.ts:353-422` (5 cases) |
| T2b — marker staged, over-delete inexpressible | **met** | guard runs BEFORE `uploadAssets` (`deploy.ts:514` < `:568`); `asset-upload-stage.test.ts` (19 pass) pins marker location + staging-copy-only |
| T2c — REAL observed reclaim | **met** | `vinext-asset-gc.test.ts` "T2c — reclaim真": keys exist before (`expect(before.length).toBeGreaterThan(0)`), gone after `reclaimBuildPrefix`, sibling build untouched, marker deleted with its chunks. Store is mutable: `runCapture` renders `gsutil ls -r` from a live key set, `runQuietAllowFail` applies a prefix delete |
| T2d — `NEXT_DEPLOYMENT_ID` via `spec.env`, minding #186 | **met** | `cr-builder.ts:334-340` + `DEPLOYMENT_ID_ENV` const-computed key; `cr-builder-env.test.ts:93-175` (6 cases incl. CRD-rejected-name check). Verified against #186: the CEL denylist is `HOSTNAME/PORT/K_SERVICE/K_REVISION/K_CONFIGURATION` (`nextapp_types.go:90`) — `NEXT_DEPLOYMENT_ID` is not in it, is a C_IDENTIFIER, and is NOT operator-injected (`grep NEXT_DEPLOYMENT_ID` over `internal/` returns nothing), so `appendUserEnv` (`nextapp_controller.go:1239`) keeps it. CLI-side collision is warned, not silent (`deploy.ts:403-414`) |
| Mutation proof honest | **met** | all 12 anchors verified to occur EXACTLY once in the branch's files and to target the new behaviour (checked independently); preflight refuses on !=1 occurrence, byte-identical mutants, or no-op substitution; verdict is exit code, ANSI-stripped only for reporting |
| "Closes #892" honest | **yes** | merging resolves both AC bullets |

## Independent test run (worktree `agent/s2-skew-chain` @ d8d70a9, clean, == origin)
All 12 changed spec files run individually: 189 pass / 0 fail (vinext-asset-gc 7, skew-build-id-templates 3, cr-builder-env 11, deploy-orchestrator 19, asset-upload-stage 19, cli-dispatch-contract 83, …). Whole-directory single-process runs fail on both branches (Redis ECONNREFUSED / cross-file `mock.module` bleed) — environmental, not this PR.

## Non-blocking observations (no criterion unmet)
1. **The mutable store models GCS only.** `gsutil ls -r` + `gsutil -m rm -r` prefix semantics are faithful to `listRemoteBuildIds`/`deleteBuildPrefix`. s3/minio remain argv-shape-only; **azure** is the one worth a follow-up — its delete is `az storage blob delete-batch --pattern "<prefix>*"`, glob semantics rather than prefix, and the "deletes nothing while logging success" class #892 exists to catch is unproved there.
2. **`spec.secrets.envMap` collision.** If a user maps `NEXT_DEPLOYMENT_ID` through `secrets.envMap`, the operator drops the CR's `spec.env` entry with a Warning (`appendUserEnv`) and knext's id does NOT win. The CLI's collision warning covers `config.env` only. Pre-existing #186 precedence; worth a doc line.
3. **Behaviour change self-declared**: a vinext app emitting no `_next/static` prefix now aborts the deploy.
4. **No kind/OKE verification** — lead-owned stage, correctly flagged in the PR body.
5. CLI-surface escalation trigger fired and is acknowledged per the task graph.

## Verdict: APPROVE
