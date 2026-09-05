ISSUES_FOUND

# Adversarial code review — optional storage (ADR-0047), branch `feat/optional-storage` @ 3fcf640

Reviewed against the design gate's six conditions (`.claude/architect-design-storage.md`
§Conditions), diffed vs merge-base `1074119`. Every claim below was re-executed in the worktree,
not taken from the implementer report. Two conditions have holes; the rest held under attack.

## Blocking findings

### F1 — Condition 1 unmet on the `preview` route: a storage-less preview deploys silently
`kn-next preview` builds, pushes, and applies a NextApp CR — it is a deploy — yet
`preview.ts` never prints `NO_STORAGE_MODE_NOTICE` (the only call sites are `deploy.ts:372` and
`build.ts:159`), and it does not clear an inherited `ASSET_PREFIX` the way `deploy.ts:378` does.
`preview.ts:315` just skips the prefix silently. Before this PR the loader hard-required
`storage`, so a storage-less preview was unreachable; this PR makes it reachable and leaves it
unannounced — exactly the state condition 1 exists to forbid ("a dropped or mistyped `storage`
block must not look identical to a deliberate choice"). A user who typos their storage block and
runs `preview` gets a silent image-served preview; with a stale `ASSET_PREFIX` in the shell env,
preview's `next build` bakes bucket URLs into HTML that nothing uploads. Fix: mirror deploy's
`!hasStorage` branch (notice + `delete process.env.ASSET_PREFIX`) in preview, with a test pinned
the same way `deploy-no-storage.test.ts` pins deploy's.

### F2 — Condition 5 hole: `getting-started.mdx` still teaches the wall this PR removes, and now states a falsehood
The gate named four files and all four are properly qualified (verified; no ADR/issue numbers in
any of them). But the brief's sweep across `apps/docs` finds the quickstart — the binding
persona's actual entry page — untouched:
- `getting-started.mdx:10-11`: Prerequisites still hard-require "an object-storage bucket
  (`gcs`, `s3`, or `minio`)".
- `getting-started.mdx:74-75`: "The minimum valid config requires `name`, `registry`, and a
  `storage` block with `provider`, `bucket`, and `publicUrl`" — **factually false against
  `loader.ts`/`validate.ts` in this same diff**.
- `getting-started.mdx:146,152`: deploy "uploads static assets to your bucket" / gc "Deletes old
  asset prefixes from your bucket", unconditional.
Row 3b's needle is the persona's `create → deploy` path; the scaffold now defaults to no-storage
but the quickstart still walls them on a bucket and misstates the validator. The dogfooded docs
site is part of delivery (workflow step 5), and a docs statement the PR's own code contradicts is
a must-fix in the same PR.

## Non-blocking, fix or acknowledge

- **F3** — `kn-next build` runs `next build` (`build.ts:69`) but only `deploy` clears an
  inherited `ASSET_PREFIX` in no-storage mode. The mode's stated guarantee ("relative asset
  paths") is unenforced on the `build` route. Same one-line fix as F1's second half.
- **F4** — `eks.mdx:70-71` and `gke.mdx:48-49` say unconditionally "knext uploads build output
  (static assets) to an object store". They are setup guides for the offload path, so context
  softens it, but the same one-clause qualifier the four named files got would finish the sweep.

## Condition 4 — status, stated precisely
The mutation clause is met and I re-proved it myself (below). The behavioural clause — a
storage-less config **builds, deploys, and serves** `_next/static` with no `assetPrefix` in the
emitted HTML — is *not* proven anywhere yet: the in-suite tests assert generated-file content
(real `writeScaffold` output, mutation-killed, so not decoration — but still file content, not a
built image or served HTML) plus hermetic env pins. The implementer flags this honestly; it is
the lead-owned kind/OKE integration stage (workflow steps 3–4), which gates the PR. **The PR must
not merge before that stage runs on this branch** — recorded here so the deferral cannot quietly
become an exemption.

## What survived the attack (all re-executed, exit-code-branched)

- **Condition 2, both mirrors, proved independently with specificity**: restored the
  hard-require in `validate.ts` only → validate-specific tests red (exit 1), loader tests green
  (exit 0); same inverted for `loader.ts`. Anchors asserted exactly-once before each mutation;
  restores verified via `git diff --quiet`; suite green after each restore. `provider:"none"`
  sentinel rejected (pinned).
- **Condition 3, type-level scan clean**: `storage?: StorageConfig` at the source type
  (`config.ts:265`), no `as` cast, no non-null assertion — zero `storage!` in src, zero
  `as StorageBackedConfig`; every remaining `config.storage.` deref sits behind a guard
  (`validate.ts` inside `if (config.storage)`, `cr-builder.ts:120` ternary, `build.ts:57`
  ternary, `preview.ts:315` `hasStorage`). Bucket-touching functions take `StorageBackedConfig`.
  `gc`: exit 0 asserted AND zero `runCapture` calls before the no-op (cluster-read-free, pinned).
  `--bucket` without a block is a loud UsageError.
- **Condition 4's mutation**: deleted the `Dockerfile.hbs` `.next/static` COPY line myself →
  red (exit 1) on the specific test; restored clean; green.
- **Condition 1 on `deploy`/`build`/`doctor`**: notice at `deploy.ts:372` sits before the
  dry-run branch (`:401`) — dry-run announces (also pinned in `deploy-no-storage.test.ts:198`);
  inherited `ASSET_PREFIX` clear pinned (`:208`); `build.ts:159` announces; `doctor`'s
  `storage-mode` check reports both modes as pass and skips config-less cwd (tests verified).
- **Condition 6, run live**: `create` in a scratch dir via the real dispatcher — 13 files,
  storage fully commented out with the plain-language growth path + docs URL, registry the one
  remaining prerequisite, parting line is the persona's real path (cd → install → dev →
  doctor → deploy, `test:seam` last, no jargon). Exit 0.
- **Green claims re-verified**: `packages/kn-next` vitest **1646/1646, exit 0** (fresh run);
  root `pnpm typecheck` **exit 0**. The environmental-failure claims check out structurally:
  `tests/compat-window-fingerprint`, `tests/mutation-residue-scan`, `examples/bun-exec` have
  zero grep hits on any changed module — no import-graph overlap.
- **ADR-0047** present and faithful to the gate (absence-only, no sentinel, honest
  skew/containerConcurrency consequences); ADR-0006 and ADR-0011 both carry dated amendment
  sections + status-line updates.
- Worktree left clean (only the untracked impl report).

## Verdict
Hold the PR on F1 (condition 1) and F2 (condition 5). Both are small, well-bounded fixes; the
architecture, both mirrors, the type-level guard, gc, scaffold, and ADR trail are sound. Re-review
after the fix round can be narrow: preview's announce path + its test, getting-started.mdx (and
optionally F3/F4), then the lead's kind/OKE behavioural stage before merge.

# Round 2 — fix commit 199b395

APPROVE

All round-1 findings verified fixed by re-execution, not by reading the claim.

## F1 (blocking) — fixed and proved live
`preview.ts:176` now mirrors deploy's `!hasStorage` branch inside `runPreviewDeploy`, before the
preflight and before `buildAndPush`. I drove the REAL `runPreviewDeploy` with the real logger
(bun, no vitest mocks; only cluster/build stubbed) under my round-1 scenario — storage-less
config + `ASSET_PREFIX=https://stale-bucket.example.com/app` in the env: the full
`NO_STORAGE_MODE_NOTICE` printed at info (docs link included), `ASSET_PREFIX` was `undefined`
**during** `buildAndPush` (i.e. cleared before `next build` would read it) and after, and the
preview completed with the CR applied. With the round-1-verified scaffold gate
(`assetPrefix: process.env.ASSET_PREFIX || ""`), no bucket URL can reach the built HTML.
`preview-no-storage.test.ts` pins all of it, including the timing (prefix captured inside the
`buildAndPush` stub) and the with-storage regression pins (no notice, prefix left alone).

**Mutation M10 re-run by me**: dead-coded the `!hasStorage(previewConfig)` branch (anchor
asserted exactly-once) → `preview-no-storage.test.ts` red (exit 1) while
`deploy-no-storage.test.ts` stayed green (exit 0 — the kill is preview-specific); restored via
git checkout, `git diff --quiet` clean, test file green again (exit 0).

## F2 (blocking) — fixed, swept clean
`getting-started.mdx`: prerequisites now mark the bucket **optional** with the growth-path link
(and pick up `azure`, fixing the round-1 nit); the validator sentence now reads "just `name` and
`registry`" — matches `loader.ts:26` exactly (neither mirror was touched in 199b395, so the
round-1 mutation proofs stand); the deploy and gc table rows carry "with object storage
configured" and gc's no-storage row states the nothing-to-reap report; the provider Callout is
conditioned on "If you configure `storage`". Full-file sweep for residue: the only remaining
`bucket` hits are the example config's own value inside the now-"Optional"-marked block (line 90)
and the `-b/--bucket` flag enumeration (line 126) — the flag errors loudly without a storage
block, so neither is an unconditional claim.

## Non-blocking items — both addressed
- **F3**: `build.ts:65` clears an inherited `ASSET_PREFIX` before `next build` in no-storage
  mode, pinned by a new timing-asserting test in `gc-build-no-storage.test.ts` (prefix captured
  during the build step, undefined) — the claimed M12 target.
- **F4**: `eks.mdx:70` and `gke.mdx:48` both gained the "With object storage configured,"
  qualifier.

## Green re-verified
`packages/kn-next` vitest **1650/1650 (148 files), exit 0** — 1646 + the 4 new pins. Worktree
clean at 199b395 after all mutation restores (only the untracked impl report).

## Verdict
APPROVE. The one remaining pre-merge obligation is unchanged from round 1 and is not the
implementer's: the lead-owned kind/OKE behavioural stage (build → deploy → serve, emitted-HTML
assertion) must run on this branch before merge.
