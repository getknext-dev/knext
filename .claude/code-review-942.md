# Adversarial code review — PR #942 (workflow-install lockfile guard + release-lane bun fix)

Branch `agent/s3-lockfile-guard` vs `agent/s2-tail`. **Verdict: ISSUES_FOUND** (1 substantive, 4 minor/advisory).

## Verified clean (attacked, held)

| Q | Result |
|---|--------|
| 1 credentials | `grep TOKEN\|secrets.\|environment:\|registry-url\|permissions` diffed across both refs of `release.yml`: **identical**, line-shift only. `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` still only on the publish job's changesets step; version job still has no `publish-script` and no credential. `changesets/action` pin unchanged. |
| 1 setup-bun pin | `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0`. Resolved upstream: `gh api repos/oven-sh/setup-bun/git/ref/tags/v2.2.0` → `commit 0c5077e5…` (lightweight tag, no deref needed). **Value correct.** Same SHA as every other lane in the repo. Allowlist addition carries an explicit scope argument (`release-action-pins.test.ts:53-58`); the test still asserts form+scope only — value stays with the nightly. |
| 2 builds | Measured `bun run --filter` exit codes: no-match → **1**, failing script → **3** (propagated), missing script → **1**, success → 0. A typo'd or renamed filter cannot silently skip a build. |
| 2 version job | `bun install --frozen-lockfile` **tolerates** a workspace-member version bump (constructed workspace, bumped `p/a` 1.0.0→2.0.0, exit 0). So `changeset version` not touching `bun.lock` does not break the next install. |
| 2 publish job | `@changesets/cli@3.0.1` `getPublishTool()`: anything not npm/pnpm/yarn falls back to `npm_exports` → publishes with **`npm publish`**, so setup-node's `.npmrc` + `NODE_AUTH_TOKEN` propagate exactly as before. No `bun publish`, so no provenance/`publishConfig` regression. |
| 2 .npmrc | `bun install` with `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` and **NODE_AUTH_TOKEN unset** → exit 0, installs fine. |
| 2 GHP | `rename-for-ghp.mjs` does its own `workspace:` resolution from package.json and publishes via `npm publish` from staging dirs — untouched by the pnpm→bun move. |
| 3 guard | No composite actions, no reusable-workflow `jobs.*.uses`, no `cd <dir> && <installer>` in any `run:` block, no `yarn` — the structural blind spots below are **latent, not live**. Guard runs in CI (`scripts/bun-test.mjs`, alongside 113 other `bun:test` files in `tests/`). |
| 4 PENDING_FIXES | Self-enforcement is real: `scanWorkflow` re-parses the workflow **content**; the entry matches on (workflow, jobId, exact command). When #917 changes the command, no hit carries `pendingFix` → the staleness `it` reds. |
| 6 prover fix | Genuine fix, not a weakening. `mutate()` threw from `markerComment()` because `.lock` is in no `COMMENT_PREFIX` map — the mutation never planted. `{ commentPrefix: '//' }` makes it plant; the marker lands inline after the JSON value (JSONC-legal), and `changesets-cli-action-compat.test.ts:158` reads `bun.lock` as **text via regex**, so the red is the major-version mismatch, not a parse error. 22/22 now scored. |

---

## F1 — MEDIUM-HIGH · `bun pm pack` rewrites `workspace:^` from **bun.lock**, not package.json → the publish-blocking audit/SBOM silently audits the PREVIOUS release's sibling

`scripts/audit-published.mjs:128-140` (and the matching comment at `.github/workflows/release.yml:119-121`) claim the pack rewrites `workspace:^` "EXACTLY what `changeset publish` does". **Measured, not assumed** — constructed bun workspace, `@y/b` depends on `@y/a: workspace:^`:

| bun.lock records | package.json on disk | `bun pm pack` emits |
|---|---|---|
| `1.0.0` | `2.0.0` | `"@y/a": "^1.0.0"` ← **stale** |
| `2.0.0` (fresh lock) | `2.0.0` | `"@y/a": "^2.0.0"` |

The source is the **lockfile**, not the manifest and not the `node_modules` symlink. And the lockfile drifts by construction on every release:

- `bun.lock` records a `"version"` per workspace member (`packages/kn-next` → `0.3.1`, `packages/lib` → `0.3.1`, `packages/db` → `0.3.1`).
- `@changesets/cli@3.0.1` has **no bun/lockfile handling anywhere in `dist/`** (only hit for `bun` is `package-manager-detector` in `getPublishPlan.mjs`, the publish path) — `changeset version` bumps package.json and leaves `bun.lock` at the old version.
- `bun install --frozen-lockfile` in the publish job does **not** refresh it (proved above).

Failure scenario, on the very next release (0.3.1 → 0.4.0):
1. audit job packs → `@getknext/core-0.4.0.tgz` declares `"@getknext/lib": "^0.3.1"`.
2. `npm install <3 tarballs> --omit=dev` (`audit-published.mjs:167-171`) — local lib is 0.4.0, does not satisfy `^0.3.1` → npm **fetches `@getknext/lib@0.3.1` from the registry** and nests it.
3. The publish-blocking supply-chain gate audits, and the CycloneDX SBOM records, the **old** lib. Exit 0. Nothing says so.

It only goes loud in the case that cannot happen in practice (old version absent from the registry → E404). This is a regression vs `pnpm pack`, which resolved from the workspace manifests. It also makes `security.md`'s "SBOM per published npm package … over the production closure" false for the sibling edges.

**Fix options** (cheapest first): (a) reuse `rename-for-ghp.mjs`'s `resolveWorkspaceSpecifier` to rewrite `workspace:` from package.json before packing; or (b) after packing, assert every tarball's `@getknext/*` range is satisfied by the co-packed sibling's version and `die()` otherwise — a 6-line guard that makes the whole class loud.

---

## F2 — LOW · M8 proves less than its claim

`scripts/mutation-prove-workflow-install-lockfile.mjs` M8 claims the ledger "cannot outlive the defect it documents", but mutates the entry's `workflow` to `does-not-exist.yml` — an entry pointing at nothing trivially matches nothing. It never simulates **the fix landing**. Stronger, and it does red: anchor on `compat-vinext.yml`'s `pnpm install --frozen-lockfile` line and replace with `bun install --frozen-lockfile` (subject `workflow` → that file). That is the actual #917 outcome.

## F3 — LOW · the `echo` skip is a whole-line bypass

`tests/workflow-install-lockfile.test.ts`, in `scanWorkflow`: `if (command.startsWith('echo ') …) continue;` drops the **entire line**. `echo "installing…" && pnpm install --frozen-lockfile` and `echo x; npm ci` are silently exempt. M7 only proves the benign case. Match the installer regex against the line with quoted segments blanked, rather than skipping on the leading token.

## F4 — LOW/advisory · installer aliases are enumerated inside a guard that argues against enumeration

`INSTALLERS` misses `pnpm i`, `bun i`, and `yarn install --immutable`/`--frozen-lockfile` entirely — the same defect spelled differently passes. No live instances today (checked), so latent. `pnpm\s+(install|i)\b` and a yarn entry close it.

## F5 — LOW/advisory · Q7 lane gap, answered

`declared == run` is compared only by `scripts/lib/prover-lane.mjs`, which runs **only** in `mutation-prover-nightly.yml` — `tests/mutation-prover-lane.test.ts:263` asserts that on purpose ("scheduled, NOT a PR gate"). The PR-time half audits prover *structure*: anchors resolve exactly once (`:577`), every file a prover reads exists (`:725`). Both were **green** here — `bun.lock` existed and the anchor matched once — while `mutate()` still threw, because the miss was neither: the harness could not produce a marker for a `.lock` extension. So the class survives the fix, which is per-call (`{ commentPrefix: '//' }`) rather than in `COMMENT_PREFIX` (`.json` and `.lock` are both still absent). A PR-time assertion that every `mutate()` subject's extension is either in `COMMENT_PREFIX`, passed a `commentPrefix`, or has the marker embedded would close it. No sweep of the other provers for this specific cause is evidenced in the diff.

## Nit

`lockfileReachable()` uses `existsSync` on the working tree while the corpus comes from `git ls-files` — an untracked local lockfile makes the guard green locally and red in CI. Safe direction, but inconsistent.
