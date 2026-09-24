# #1304 soak runbook: 3 green first-attempt nights per cell before rc.1

**Status as of this writing: NOT dispatched, deliberately.** Two independent
blockers, both outside this runbook's control:

1. **No RC tag is cut.** `.github/compat-credential-ref.json`'s `rcTag` is
   `null`. Per ADR-0056 D1, a credential night on `test-e2e-deploy.yml`
   **refuses** rather than running against `main` while `rcTag` is `null` —
   there is nothing to soak until an RC exists.
2. **The credentialed Next.js version may still move.** #1376/#1307 have an
   open founder decision on whether the credential lane's `NEXTJS_REF` moves
   from `v16.2.0` to the shipped `>=16.3.5` pin. Soaking on a version that is
   about to change wastes CI capacity that would have to be re-spent after
   the move.

Cutting the RC tag, and resolving the Next-version question, are **founder
actions** (ADR-0056: "Cutting an RC is a founder action... bump `rcTag` here
in a reviewed PR"). This runbook exists so that once both are resolved,
checking #1304's exit bar is **one command**, not a fresh investigation.

## The bar (from #1304)

> Before cutting rc.1, each of the wired cells needs 3 consecutive green
> first-attempt dispatches on `main` [now: on the frozen RC ref] with
> bytecode LIVE. Otherwise the windows reset immediately.
>
> Exit: evidence table (run ids per cell) posted on this issue.

"First attempt" excludes any night that was manually re-run
(`gh run rerun`) — a rerun is a materially weaker signal than a clean first
pass, and the bar is explicit about first-attempt green, not
eventually-green.

## The one command

Once an RC tag is cut (`rcTag` is non-null in
`.github/compat-credential-ref.json`) and the Next-version question is
settled:

```bash
node scripts/soak-1304-readiness.mjs
```

Requires `gh` authenticated against `getknext-dev/knext` (or set
`GITHUB_REPOSITORY` to point elsewhere). Optionally set `SOAK_SINCE_ISO` to
bound the run list to nights after the RC was cut (harmless either way,
since the readiness check only ever looks at the **trailing 3 nights** per
cell — an older, unrelated run cannot make a cell falsely "ready").

It will:

1. Refuse (exit 1) if no RC tag is cut — never silently report "ready".
2. For every **wired** credential cell in
   `scripts/compat-window-audit.mjs`'s `CREDENTIAL_CELLS` (today: `node`,
   `bun`, `node-webpack`, `bun-webpack` — the v1.0-scoped 4-cell matrix per
   ADR-0058/#1295 option C), list `test-e2e-deploy.yml` runs and evaluate
   whether the 3 most recent completed nights are all first-attempt green.
3. Print a markdown evidence table (run ids per cell) — **paste this
   directly into a comment on #1304** to satisfy its exit criterion.
4. Exit 0 only when every wired cell is ready.

## What this script does NOT do

- It does not cut the RC tag, decide the Next-version question, or dispatch
  any new runs. It only READS the run history that already exists from the
  scheduled credential crons (ADR-0056: credential nights are `schedule`
  only, never `workflow_dispatch` — a manual dispatch structurally cannot
  produce credential-counting evidence, so there is no "dispatch button" for
  this runbook to press even in principle).
- It does not distinguish bytecode-liveness grading (ADR-0056 Amendment 1
  D4) from a plain green — that signal lives in
  `scripts/compat-window-audit.mjs`'s ledger-based audit, not in `gh run
  list`'s conclusion field. Cross-check `node scripts/compat-window-audit.mjs
  --matrix` alongside this script's output before declaring the bar met; the
  two are complementary, not redundant (this script proves the FIRST-ATTEMPT
  property the window audit does not track, the window audit proves
  bytecode-liveness this script does not track).

## Design / testability

- Pure comparison/streak logic: `scripts/lib/soak-readiness.mjs`, unit-tested
  against fixtures in `tests/soak-1304-readiness.test.ts` (13 cases) and
  mutation-proved (`scripts/mutation-prove-soak-readiness.mjs`, 8/8 caught,
  0 decorative) — no live `gh` call needed to trust the logic.
- CLI wrapper: `scripts/soak-1304-readiness.mjs` — real filesystem read
  (the RC pin), real `gh run list`, real exit code. Live-tested for the
  fail-closed "no RC cut" path (the only path exercisable without a real RC
  tag existing); the live `gh run list` path is unverified beyond that,
  honestly, since there is no RC tag to query against yet.
