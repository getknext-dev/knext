# techdebt-1 hand-off (2026-09-25)

Sequential tech-debt implementer for six issues (#1371, #1316, #1318, #1352,
#1374, #1365), plus review-round fixes on three of them (#1388/#1392/#1397
findings, then a second #1400 finding). Wrapping up at ~token budget per
coordinator instruction. All work is pushed; nothing uncommitted, nothing
unpushed, working tree is clean.

## Branches (one per issue, all off origin/main, all pushed)

- `fix/1371-api-retry-flaky-clock` — PR #1387
- `fix/1316-fingerprint-createrequire-workflow-scan` — PR #1388
- `fix/1318-bun-lockstep-guards` — PR #1392
- `tech-debt/1352-actionlint-composite-actions` — PR #1397
- `tech-debt/1374-freeze-guard-bootstrap-failclosed` — PR #1399
- `tech-debt/1365-vinext-ledger-listing-retry` — PR #1400

## PR status at hand-off

| PR | Issue | State (last known) | Notes |
|---|---|---|---|
| **#1387** | #1371 | Approved, coordinator says going to merge | No action needed from here. |
| **#1388** | #1316 | OPEN, review fix pushed (commit `220e41f0`) | Fixed 4 gaps the #1388 review found: aliased `createRequire` import, transitive/multi-hop alias chains (fixpoint loop), `.call`/`.apply`/`.bind` on a tracked name, `import.meta.require`. 106/106 tests pass, mutation-proved (4 independent mutations, each reds its test). Also fixed a pre-existing `tsc` type-predicate error in this file (`tests/compat-window-fingerprint.test.ts:631`) flagged separately by the coordinator. **Awaiting re-review.** |
| **#1392** | #1318 | OPEN, review fix pushed (commit `b5a00c4c`) | Fixed the blanket `.test.*` extension exclude that hid a real image selection (`tests/e2e-native-rebuild-musl.docker-e2e.test.ts:28`). Replaced with a `LINE_EXEMPT_MARKER` ("oven-bun-pin-exempt") per-line escape hatch; narrowed `bun-keepalive-guard.cjs`'s exemption from whole-file to line-scoped. 7 real lines needed the marker (verified exhaustively via a full-repo scan script, not just reasoned about). Mutation-proved with the reviewer's exact repro (bump the real image to 1.4.0 — now reds). **Awaiting re-review.** |
| **#1397** | #1352 | OPEN, review fix pushed (commit `19550f63`) + PR comment added | actionlint 1.7.12 rejects a composite `action.yml` passed as a bare CLI arg — verified live with the actual pinned binary (installed at `/opt/homebrew/bin/actionlint` on this machine, exact version match). Fix: never hand actionlint an `action.yml` path; when a composite action changes, re-lint every WORKFLOW that `uses:` a local composite action instead. Added a `describe.skipIf(!actionlintAvailable)` suite that builds a real git-repo fixture and runs the real step script + real actionlint binary against it (registered in `declared-test-skips.test.ts`). Left a PR comment noting that making the gate required also needs the `paths:` filter swapped for an always-run early-exit job plus a `merge_group:` trigger (not implemented — orthogonal, and the required-check decision itself is the founder's per the original issue). **Awaiting re-review.** |
| **#1399** | #1374 | Approved, coordinator says going to merge | No action needed from here. |
| **#1400** | #1365 | OPEN, review fix pushed (commit `bf976abb`) | The `#1365` retry reused the coarse `isAuthOrApiError` bucket, which put 401 and a plain 403 in the SAME "never retry" class as 5xx/429/a rate-limited 403 — so the retry fired on exactly the wrong errors, and a JSON parse failure (no HTTP status) fell into "retry" by elimination. Added `classifyListingError` (`'fatal' \| 'retryable' \| 'local'`) with the exact split the review specified, plus `retryAfterMs` to honour a `Retry-After` hint when `gh` surfaces one. Rewrote test fixtures to use realistic `gh` stderr text (`Command failed: gh run list ... HTTP 502: ...`) instead of raw Node network-error strings, per the review's explicit ask. 102/102 tests pass, mutation-proved (2 independent mutations). **Awaiting re-review.** |

## What's NOT done

- Nothing is deferred from the six original issues or the four review rounds
  above — every finding raised was fixed, tested, and mutation-proved.
- **Making any of these gates a required branch-protection check** is
  explicitly out of scope everywhere it came up (#1352/#1397's `on:` trigger,
  #1374's freeze-guard) — it's a repo-settings decision reserved for the
  founder in the original issues, not something a PR can do.
- #1397's PR body/comment flags a follow-up (early-exit job + `merge_group:`
  trigger) needed IF the gate is later made required — not implemented,
  intentionally, since it's a separate change orthogonal to the fix itself.

## Environment notes for whoever picks this up

- This worktree's `node_modules` was effectively empty (only `.vite`) —
  `bun test` worked via Node's ancestor `node_modules` resolution from the
  repo root, but `bun run typecheck` (pinned `typeRoots: ["./node_modules/@types"]`,
  no ancestor walk) needed `@types/bun`/`@types/node` symlinked in manually:
  ```
  mkdir -p node_modules/@types
  ln -sf ../../../../../node_modules/@types/bun node_modules/@types/bun
  ln -sf ../../../../../node_modules/@types/node node_modules/@types/node
  ```
  (relative depth assumes this exact worktree path,
  `.claude/worktrees/<name>/node_modules/@types/` — 5 levels up to repo root).
  After that, `bun run typecheck` is clean except two PRE-EXISTING, unrelated
  errors in `packages/lib/src/clients.ts` (`@cerbos/grpc`, `pg` modules not
  found) — not touched by any of this work, present before and after every
  commit here.
- `actionlint` 1.7.12 is installed locally at `/opt/homebrew/bin/actionlint`
  (Homebrew), which is why #1397's fixture tests could run for real rather
  than being permanently skipped in this environment.
- No docker was used anywhere in this work, per the standing constraint.

## Constraints respected throughout

- Never touched: `.github/compat-credentialed-next-version.json`,
  `tests/nextjs-credential-lockstep.test.ts`, the early-warning lane workflow,
  `packages/kn-next/src/cli/**`, templates, `apps/file-manager/**`, vinext
  entries — all reserved for other agents per the original task brief.
- All git operations stayed inside this worktree; branch switches used
  `git checkout -b ... origin/main` per issue, `git stash push -u -m <tag>` +
  immediate SHA capture + `git stash apply <sha>` (never bare `stash pop`)
  when moving uncommitted work between branches in the same worktree, each
  stash entry dropped right after applying.
- Every fix is TDD: failing test (or a live reproduction of the reviewer's
  exact repro) written/confirmed first, then the minimal fix, then a
  mutation that reverts the fix and confirms the new test(s) go red for the
  right reason, then restore-and-reverify-green.
- `git -c commit.gpgsign=false` used throughout per the shared toolchain
  convention in this repo; no force-push, no push to `main`, no history
  rewrite.
