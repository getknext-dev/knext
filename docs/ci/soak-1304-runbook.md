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

Requires `gh` authenticated against `getknext-dev/knext` (its default
transport is `scripts/compat-window-audit.mjs`'s own `fetchLedgers`, the
same one every other credential-window consumer in this repo uses).
Optionally set `SOAK_FETCH_LIMIT` (default 100, matching
`compat-window-audit.mjs`'s own `DEFAULT_FETCH_LIMIT`) to widen or narrow
how many recent `test-e2e-deploy.yml` runs are fetched.

It will:

1. Refuse (exit 1) if no RC tag is cut — never silently report "ready".
2. Fetch every scheduled night's ledger via `compat-window-audit.mjs`'s
   `fetchLedgers` (the same fetch+artifact-reconciliation this repo's
   compat-matrix tracker already relies on — no night silently vanishes
   from the count).
3. For every **wired** credential cell in `CREDENTIAL_CELLS` (today:
   `node`, `bun`, `node-webpack`, `bun-webpack` — the v1.0-scoped 4-cell
   matrix per ADR-0058/#1295 option C), grade its nights with
   `auditWindow({ scope: 'credential' })` — ADR-0056 rule 6 (credential
   mode + a real RC-tag-shaped `knextRef`) and rule 7 (bytecode caching
   PROVEN LIVE per shard, for the cell's runtime) are enforced THERE, plus
   an additional check that the night's `knextRef` matches the CURRENT
   `rcTag` specifically (not just any RC-tag-shaped ref — closes the "RC
   tag got bumped, stale evidence still counts" gap a naive time-window
   filter would miss).
4. Evaluate whether the 3 most recent qualifying nights are all
   first-attempt green (rule 6 already disqualifies a rerun, so this is
   enforced twice, structurally).
5. Print a markdown evidence table (run ids per cell) — **paste this
   directly into a comment on #1304** to satisfy its exit criterion.
6. Exit 0 only when every wired cell is ready.

## What this script does NOT do

- It does not cut the RC tag, decide the Next-version question, or dispatch
  any new runs. It only READS the run history that already exists from the
  scheduled credential crons (ADR-0056: credential nights are `schedule`
  only, never `workflow_dispatch` — a manual dispatch structurally cannot
  produce credential-counting evidence, so there is no "dispatch button" for
  this runbook to press even in principle).
- It does not reimplement `compat-window-audit.mjs`'s grading rules — it
  calls that module's own `auditWindow`/`fetchLedgers` directly, so a rule
  change there (e.g. a future rule 8) is picked up automatically, with no
  second place to keep in sync.

## Design / testability

- Pure comparison/streak logic AND the `auditWindow` -> readiness mapping:
  `scripts/lib/soak-readiness.mjs`, unit-tested against fixtures in
  `tests/soak-1304-readiness.test.ts` (19 cases) and mutation-proved
  (`scripts/mutation-prove-soak-readiness.mjs`, 11/11 caught, 0 decorative)
  — no live `gh` call needed to trust the logic.
- `auditWindow`/`fetchLedgers` themselves are `scripts/compat-window-audit.mjs`'s
  own, separately-tested exports (rule 6 credential/RC-tag-shape enforcement,
  rule 7 bytecode-liveness enforcement, lane/runtime/builder scoping) — this
  script does not duplicate any of that grading.
- CLI wrapper: `scripts/soak-1304-readiness.mjs` — real filesystem read
  (the RC pin), real `gh` calls (via `fetchLedgers`'s default transport),
  real exit code. Live-tested for the fail-closed "no RC cut" path (the
  only path exercisable without a real RC tag existing); the live fetch
  path is unverified beyond that, honestly, since there is no RC tag to
  query against yet.
