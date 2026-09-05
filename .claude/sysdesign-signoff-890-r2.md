SIGN-OFF

# System-Designer re-gate — PR #890, fix round (fcd45f2)

## Verdict: SIGN-OFF (with one residual to fix in this PR, and one inherited defect that must be fixed before the stack merges)

## The blocking finding is resolved

`uploadAssets` now dispatches on the RESOLVED builder (`config.build ?? DEFAULT_BUILDER_ID`), and the
vinext branch (`stageNitroPublicAssets`, asset-upload.ts:598) sources `.output/public` and stages into
`.knext-upload/`. Verified against all three legs of the original block:

1. **Normal case** — no longer throws standalone advice on the default path.
   `asset-upload-standalone.test.ts:135` runs `uploadAssets` with `build` *absent* (deleted from the
   object, so it tests absence and not `undefined`) and asserts the bulk-upload argv contains
   `.knext-upload` and NOT `.output/public`. That is a genuine dispatch guard: deleting the ternary
   reds it while every `build:'turbopack'`-pinned sibling stays green.
2. **Mixed tree / artifact destruction** — the artifact root is never written.
   `asset-upload-stage.test.ts:163` stages **twice** and asserts `.output/public` is byte-identical,
   which pins that the `rmSync` targets the staging dir and not the artifact. The remaining `rmSync`
   in `stageStandaloneAssets` is now reachable only under `build:'turbopack'`, which never produces
   `.output`. Deploy's parallel window is therefore read-only over the tree docker COPYs.
3. **Marker/GC** — deliberately unmarked, documented in code and warned at runtime; fail-safe
   over-keep is the correct direction under ADR-0011 (never over-delete), and #892 carries the debt.

The `DEFAULT_BUILDER_ID` consolidation is the right boundary move: the default is load-bearing in
three places (artifact resolution, the CR wire value, the staging root) and they can no longer drift.

## Answers to the five attack questions

1. **`.knext-upload/` safety — mostly, with one gap.** It is outside the Dockerfile COPY set
   (`Dockerfile.hbs` COPYs only `${BINARY}`, `.output/public`, `native`), it is never itself an object
   key (keys are paths *relative to* the staging dir; `providerOps`/`verifyAndRetry`/`appKeyPrefix`
   are fully parameterised on `assetsDir`), and no runtime reader can see it (the asset-root resolver
   in `runtime-contract.mjs.hbs` keys strictly on `.output/public`). **Gap:** it is in neither the
   root `.gitignore` nor `templates/app/.dockerignore.hbs` — see the residual below.
2. **Key space holds.** Nitro's `.output/public` already merges `_next/static/**` and the app's public
   files into exactly the bucket key space (`examples/bun-exec/README.md:35`), so relative path ==
   object key, the `<app>/` prefix still scopes every key, and the verify-and-retry diff is unchanged
   — the standalone suite's "complete listing ⇒ zero single-file retries" assertion is reused for the
   nitro leg and passes.
3. **Parallel tasks.** No write to a path docker COPYs remains. `.output/buildx-metadata.json` is
   written by the docker task itself and is outside `.output/public`. The one remaining concurrent
   write into the build *context* (not the COPY set) is `.knext-upload` — residual below.
4. **Omitting `spec.runtime` for vinext breaks nothing.** The operator has exactly one consumer
   (`nextapp_controller.go:1000`) and it is already `Build != "vinext"`-guarded; the CRD field is
   `omitempty`, enum-only, no server-side default; nothing in `preview.ts`/`db-bind.ts` reads it back.
   Both halves are pinned (`cr-builder-build-axis.test.ts:66` omit-on-vinext, `:79` still-emitted-on-
   turbopack), so the omission cannot silently become universal.
5. **No shape-blind caller left.** `uploadAssets` is the only caller of either staging function, and
   it is now the dispatch point; no other module reads `.output/public`.

Sovereignty/security: no zone-DB access, no new mutating endpoint, no secret path, no ingress or
digest-pinning change. Core-vs-app boundary untouched (this is CLI asset plumbing, not PWA/MFE code).

## Residual to fix in this PR (small, one line each)

**`.knext-upload/` is written inside the docker build context and is excluded from nothing.** Deploy's
build context is the tracing root (`requireBuildContext`), which contains `cwd`. The old staging dir
`.output/public` was invisible to that walk because the scaffold's `.dockerignore` excludes `.output`;
`.knext-upload` is not excluded, so from the second deploy onward buildx's local-source walk enumerates
a full copy of the app's static assets **while the upload task is `rmSync`-ing and re-`cpSync`-ing that
exact tree**. The failure mode is a loud, intermittent `failed to solve: … no such file or directory`
during context transfer — no image corruption, which is why this is a residual and not a re-block —
plus context bloat and cache churn. It is also absent from the root `.gitignore`, whose own comment
records the "staging output wedged `git add` with a SIGKILL" incident.
**Smallest fix:** add `.knext-upload` to `packages/kn-next/templates/app/.dockerignore.hbs` and the
root `.gitignore` (strictly better: stage into `mkdtempSync(tmpdir())` so the staging area is outside
the build context by construction — the provider shell-outs already take an absolute `assetsDir`).

## Inherited from the base branch — not this PR's diff, but blocking for the stack

`templates/app/.dockerignore.hbs` excludes **`.output`** and **`knext-exec*`**, while
`templates/app/Dockerfile.hbs` COPYs **`.output/public`** and **`${BINARY}` (= `knext-exec-linux-x64`)**.
For the flat `kn-next create` layout (context == app root) that is an unbuildable image, and
`create-scaffold.test.ts:944` actively pins the exclusions. Both files come from `agent/bun-toolchain`
(PR #890's base), so this gate does not block on it — but #890 is what makes vinext the *only* builder,
so it makes this the universal path. Verify and fix before the stack lands.

## Failure mode the tests still do not cover

The vinext asset lifecycle **after** upload: prefixes are unmarked so `kn-next gc` can never reap them
(unbounded bucket growth), and deploy's push-failure `reclaimBuildPrefix` is keyed on the deploy tag,
which is never a vinext static id — so a failed-push deploy leaves permanently orphaned objects and the
reclaim silently no-ops. Both are fail-safe (over-keep) and tracked by #892, but nothing exercises the
GC or the reclaim leg against a vinext key space, which is where an eventual #892 fix will need a red
test first.
