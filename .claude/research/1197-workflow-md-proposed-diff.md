# Proposed `.claude/rules/workflow.md` diff — name the file-manager e2e round (#1197 / T1)

**Status:** PROPOSAL ONLY. Rules files are not an agent's to edit — this is written for the
maintainer to apply (or reject). Trigger-class; file it at sprint close per the 2026-09-22 amendment.

## Why

T1 gives the file-manager end-to-end round a name, an entry point (`bun run --filter file-manager
e2e`), and a CI aggregator (`file-manager-e2e-round`). `workflow.md`'s pipeline ("The pipeline (per
task)") lists kind integration (step 3) and OKE verify (step 4) but does not name this round, so
there is no written scoping rule for when it applies. This inserts it as a named stage and records
the path-scoping rule, so the stage is a documented expectation rather than tribal knowledge.

## Proposed change

In `## The pipeline (per task)`, insert a new stage between step 3 (kind integration) and step 4
(OKE verify), and renumber the subsequent steps:

```diff
 3. **Integration test on kind** — the k8s integration gate. Lead-owned, gates the PR.
+3a. **file-manager e2e round** — the named app-level end-to-end round
+    (`bun run --filter file-manager e2e`): build → compile single-exec → serve+routes+ISR over
+    real HTTP (`compat-smoke`) → authenticated ISR invalidation over HTTP (401 without token, 200
+    with) → prod-image build+probe. It is a NAME + a scoping rule over legs that already gate every
+    PR fail-closed — not new fidelity. On CI it is the `file-manager-e2e-round` aggregator job,
+    which asserts on `needs.*.result` with `if: always()` (a bare `needs:` would SKIP the dependent
+    when an upstream fails, which reads as neutral — the false-green hazard). It is **path-scoped at
+    the aggregator** via a merge-base `git diff --name-only`, NEVER via `paths:` on `ci.yml` (#673
+    took stacked PRs to zero jobs). The app-affecting path classes are:
+
+    ```
+    packages/kn-next/src/adapters/**        packages/kn-next/src/cli/*build*
+    packages/kn-next/src/generators/**      packages/kn-next/src/config.ts
+    packages/kn-next/src/loader.ts          packages/lib/src/**
+    packages/db/src/**                      packages/kn-next-operator/**
+    apps/file-manager/**                    packages/kn-next/templates/app/**
+    **/Dockerfile*
+    *-entry.mjs   runtime-contract.mjs   node-server.ts   vinext-compile*
+    ```
+
+    (The CLI-build glob is `*build*`, not `build*` — it must catch the bun
+    single-executable ship target `vinext-build.ts` and `project-build.ts`, and
+    `packages/lib` + `packages/db` are bundled INTO the app.)
+
+    A diff touching none of these reports **"N/A" green with the reason** (a docs/CI/script-only
+    PR). The scope list is the single source of truth in
+    `apps/file-manager/scripts/e2e-round-paths.mjs`; the leg registry (which legs, and which CI job
+    proves each) is `apps/file-manager/scripts/e2e-round-legs.mjs`, and
+    `apps/file-manager/e2e-round.test.ts` reds if the registry and the aggregator's `needs:` list
+    drift. It does NOT prove graceful-shutdown drain for this app (the app emits no standalone tree;
+    its drain/image proofs are the containerised `standalone-drain-bun-image` and
+    `bun-exec-alpine-image` CI jobs).
 4. **Verify on OKE** for any feature or critical update. ...
```

(Steps 4–10 keep their existing text; only the numbering shifts, or leave step 3a as a sub-step of
3 to avoid renumbering — maintainer's call.)

## Notes for the reviewer

- The aggregator adds a **name and a scoping rule, not new coverage**. The honest trade-off is in
  the design doc (`.claude/research/file-manager-e2e-round-design.md` §3).
- Tier 2 (the cluster leg — connecting the nightly `scale-to-zero-cache` lane to the signed
  file-manager image) is deliberately a separate future PR, not part of this stage yet.
