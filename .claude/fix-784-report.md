# Fix round — PR #784 (feat/precompile-closure-sbom)

Worktree: `.claude/worktrees/agent-a28ecd87b9e13215c` · branch `feat/precompile-closure-sbom`
Commit: **f4e2035** — `fix(supply-chain): the closure-gate scan matches its claim, and the numbers are the measured ones (#764)` (one commit, **not pushed**).

## Approach

Three moves, TDD throughout: (1) extract the workflow scan out of the spec into
`tests/helpers/vinext-artifact-scan.ts` behaviour-preservingly, so its matchers can be tested on
**synthetic, not-yet-real** lanes; (2) write the failing tests for the two escape routes and the
allowlist typo, confirm each reds for the expected reason; (3) implement, then correct every comment
that over-claimed or carried a wrong figure. No architectural change — the gate's shape is
unchanged, only its reach and its honesty.

## All seven findings — done

| # | Finding | What landed |
|---|---------|-------------|
| CODE-1 | scan read only ci.yml, matched `build.sh\|test:image\|docker build` | scan now globs **every `.github/workflows/*.yml`** (20 files today, asserted equal to the dir listing) and the matcher also takes `bun\|npm\|pnpm\|yarn\|npx run build`. Generalised from "has `needs: vinext-precompile-closure`" to "**has a job running `scripts/precompile-closure-audit.mjs` in its transitive `needs` closure**" — the only form expressible for a lane in another workflow file. Non-vacuity kept (real scan must still find `bun-exec-alpine-image`) plus a new assertion that the ci.yml gate is `vinext-precompile-closure`. |
| CODE-1 (docs) | three softened/over-claiming comments | test header, `ci.yml` gate comment and threat model now state exactly what the scan guarantees — **ordering only**, and blind to a reusable workflow / composite action / shell wrapper, with "extend `tests/helpers/vinext-artifact-scan.ts` in the same PR" as the standing instruction. |
| CODE-2 | "60 vs 408", "~500 on disk", "~5× headroom" | re-measured here: trivy fs → **60** npm packages, `installedPackages()` → **210**, syft → **409** npm components, `find -name package.json` → **527**. Every site now states each number as *what it counts* and MIN_INSTALLED_PACKAGES=100 as **~2× headroom** (MIN_NPM_COMPONENTS ~4×). Fixed in `scripts/lib/precompile-closure.mjs`, `scripts/precompile-closure-audit.mjs`, `ci.yml`, the threat model **and** two leftover `408`s in the two spec files (incl. the 408-package fixture, now 210). |
| CODE-3 | `readAllowlist` ignored unknown keys | unknown keys **throw**; allowed set `[id, justification, added, expires, note]` exported as `ALLOWLIST_ENTRY_KEYS`; the allowlist's own `$schema-note` documents it. |
| CODE-4 | wrong justifications | both entries rewritten: image-size 2.0.2 is a **direct, exactly-pinned dep of vinext** (`vinext/package.json` `dependencies`), imported **server-side** at `dist/server/metadata-route-build-data.js:5` and inlined into the binary — accepted because the buffer comes from `fs.readFileSync(route.filePath)` over repo-owned metadata images, never request data, with an explicit "drop, don't renew, if that ever changes". Entry 1's subject corrected to the advisory's actual text (**JXL/HEIF parser infinite loops**, verified via `gh api`); dates/expiry untouched. |
| SPEC-A | attestation gap unrecorded | stated as **still OWED** in three places: threat model ("What is still owed"), the ci.yml gate comment, and ADR-0042 C6 itself. |
| SPEC-B | stale ADR lines | `(built: the vinext-precompile-closure CI gate, #764 …)` marker on **both** ADR-0042 C6 and the `:158` "re-open only if the scan gate is first re-established" line, each carrying the still-owed attestation caveat. |
| SPEC-C | scope unnamed | threat model "**Scope**" paragraph + the same sentence in ci.yml and the test header: the gate covers the in-repo `examples/bun-exec` closure, the only vinext app today; a **user** app on the vinext target has no equivalent closure gate. |

## Tests

Added `tests/helpers/vinext-artifact-scan.ts` (new) and 6 new cases in
`tests/precompile-closure-gate-ci.test.ts` + 2 in `tests/precompile-closure-audit.test.ts`:

- scans EVERY workflow file, not just ci.yml (escape route 1) — glob equals the dir listing;
- catches a vinext publish lane in a **non-ci.yml** synthetic workflow, and reports it **unguarded**;
- catches a ci.yml-shaped lane compiling via `bun run build` in `examples/bun-exec` (escape route 2);
- a synthetic lane that *does* have the audit in its `needs` closure is **not** reported unguarded (the both-halves assertion);
- real-tree non-vacuity + "each real one runs the audit in its needs closure" + "the real ci.yml gate is `vinext-precompile-closure`";
- `readAllowlist` THROWS on a typo'd `expiress`, and accepts the documented `note` key.

**Each failed first, for the right reason** (3 red in the wiring spec: `[]` where the lane was
expected; 1 red in the audit spec: no throw), then went green.

## Verification

- `tests/precompile-closure-gate-ci.test.ts` 12/12 · `tests/precompile-closure-audit.test.ts` 20/20 · `tests/bun-exec-alpine-image-ci.test.ts` 15/15 — **47 passed**.
- `node scripts/mutation-prove-ci-blocking-gates.mjs` → **40 disarms went red, 0 stayed green**, `{"declared":40,"run":40}`, tree clean after.
- **Mutation-proved the new guard, four ways** (anchor-asserting node script, aborts on ≠1 occurrence — never `perl`); tree restored and verified clean after each:
  1. delete `needs: vinext-precompile-closure` from ci.yml → **2 red**;
  2. remove the `run build` alias alternative from the matcher → **2 red**;
  3. narrow the glob back to `ci.yml` only → **1 red**;
  4. disable the unknown-key throw → **1 red**.
- `biome check --diagnostic-level=error` clean on all changed files (only pre-existing `no-console` *warnings* in the audit script); `tsc --noEmit` clean for the touched files.
- Live re-measurement against this worktree's installed tree: `{npmComponents:409, installed:210, covered:210, coverage:1}`; `trivy fs` cyclonedx → 60 npm components; real allowlist still parses (active now = both ids, active 2026-11-20 = `[]`).

## Deferred / not done (and why)

- **The cosign attestation itself is NOT implemented** — deliberately. There is no vinext image
  digest to attest today (no publish lane), so the fix asked for, and delivered, is that the
  obligation is *recorded in three places* rather than remembered. That remains ADR-0042 C6's open
  half.
- **Reusable-workflow / composite-action / shell-wrapper compile paths are still invisible** to the
  scan. That is a matcher limit, now stated in the test header, the ci.yml comment and the threat
  model rather than papered over; closing it would mean resolving `uses:` targets, which is a bigger
  change than this review round.
- **One pre-existing failure in the wider suite**: `tests/bun-exec-example-suite-collection.test.ts`
  → "the ROOT config collects them too" fails with `vitest list` exiting 1 in this worktree. I
  verified it **reproduces at `HEAD~1`** (before this commit) and touches nothing in this diff — it
  is a worktree/environment condition, not a regression from this round. Rest of `tests/`:
  1708 passed / 1 failed (that one).
