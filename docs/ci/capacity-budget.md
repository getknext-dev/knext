# CI capacity budget (#1301)

knext runs on the GitHub Free plan: a **20 concurrent-job** cap across the
whole repository. This doc records the measured problem, the decisions made
against it, and where each is enforced by a test — so the budget is a checked
fact, not a paragraph someone has to keep believing.

## The measured problem (system-designer gate TD1/TD8)

- Scheduled crons fire roughly **5 hours late** and bunch up around **08:30
  UTC**, regardless of how evenly the literal cron times are spread across the
  day.
- The **6 credential cells** (node, bun, node-webpack, bun-webpack — all in
  `test-e2e-deploy.yml` — plus bun-vinext in `compat-vinext.yml`; node-vinext
  is `wired: false`) together cost **about 1.2–1.3k job-minutes a night**, on
  top of **about 0.5k** for early-warning + the other nightlies. That
  saturates the 20-job cap for roughly **90 minutes**.
- One feature branch ran **12 full `workflow_dispatch` runs of
  `test-e2e-deploy.yml` in a day** (about 1.8k job-minutes) — a single branch
  can outspend an entire credential night.

## Decisions

### 1. Stagger the crons — fix literal collisions

Two exact collisions existed before this issue (both accidental, not
by-design lanes):

| Cron (UTC) | Before | After |
|---|---|---|
| `17 3 * * *` | `test-e2e-deploy.yml` (node early-warning credential lane — **left untouched**, it is cross-referenced by `docs/compat/window-node-lane.md`, `docs/release/compat-honesty-gate.md`, `docs/wayfinder/w6-compat-flakiness.md`, and several tests), `operator-e2e-nightly.yml`, `secret-scan-nightly.yml` — **three workflows on one minute** | `operator-e2e-nightly.yml` → `29 3 * * *`; `secret-scan-nightly.yml` → `53 3 * * *` |
| `41 5 * * *` | `image-pin-resolution-nightly.yml` (**left untouched**), `retracted-figure-resolution-nightly.yml` — **two workflows on one minute** | `retracted-figure-resolution-nightly.yml` → `53 5 * * *` |

`test-e2e-deploy.yml`'s own 6 credential/early-warning crons were already
staggered ≥60–90 minutes apart before this issue (`17 1`, `17 3`, `47 4`, `47
5`, `17 22`, `47 23`) and are unchanged here.

Enforced by `tests/ci-capacity-budget.test.ts` (`no two scheduled crons across
all workflows share the exact same UTC minute-of-day`) — mechanical, not
self-reported.

**What staggering does NOT fix, stated rather than implied**: GitHub's
own ~5-hour scheduling delay is outside this repo's control, so the literal
times above are a **necessary, not sufficient**, mitigation — the 08:30 UTC
pile-up can still recur regardless of how the crons are written. The
`max-parallel` and concurrency decisions below are what actually bound the
job count once several crons land in the same window.

### 2. `max-parallel: 8` on every credential shard matrix

Both 16-way shard matrices (`test-e2e-deploy.yml`'s `deploy-tests` job,
`compat-vinext.yml`'s `deploy-tests` job) previously had no `max-parallel`,
so GitHub would schedule as many of the 16 shard jobs concurrently as the
20-job cap allowed — leaving almost no headroom for anything else running in
the same window. Capping each credential run to **8 concurrent shard jobs**
means one full run's peak footprint is `8 (shards) + 2 (credential-ref +
build-next, serialized ahead of the shards) ≈ 10` jobs, leaving room for a
second lane (or another nightly) to run in the same window without exhausting
the cap.

Enforced by `tests/ci-capacity-budget.test.ts` (`deploy-tests` strategy
carries `max-parallel: 8` in both files).

### 3. A branch 16-shard smoke mode

A `workflow_dispatch` input, `smoke` (boolean, default `false`,
**dispatch-only** — `github.event.inputs` is empty on every scheduled run, so
no cron can ever select it, mirroring the existing `sandboxFetchDebug`
pattern). When `smoke=true`, the workflow selects
`test/deploy-tests-manifest.smoke.knext.json` instead of the real credential
manifest (`test/deploy-tests-manifest.knext.json`) via the workflow-level
`KNEXT_DEPLOY_MANIFEST` env decision.

The smoke manifest keeps the **same 16-way shard split** (so no branching
infrastructure code is needed and the artifact/summary contract stays
identical) but narrows `rules.include` to a small representative corpus
subset (`test/e2e/app-dir/**`) while copying `suites` / `rules.exclude` /
`$knextQuarantines` / `$knextExclusions` byte-for-byte from the real
manifest — a branch smoke dispatch still honors every known quarantine and
architectural exclusion the credential lane does, it simply selects far fewer
files to actually run.

The smoke manifest is **derived, never hand-maintained**:
`scripts/lib/smoke-manifest.mjs` exports the derivation,
`scripts/generate-smoke-manifest.mjs` writes the committed copy, and
`tests/ci-capacity-budget.test.ts` re-derives it from the live main manifest
and diffs against the committed file — so an edit to the credential
manifest's exclude/suites ledger that isn't mirrored into the smoke file reds
CI rather than silently drifting.

This directly targets the measured "12 dispatches in a day" cost: a routine
branch dispatch (`smoke=true`) now runs a fraction of the file count a full
credential-equivalent dispatch does, at the same shard/job topology.

### 4. Per-branch concurrency — dispatches only, never credential crons

`test-e2e-deploy.yml` and `compat-vinext.yml` each carry a workflow-level
`concurrency` block whose **group** is keyed on `github.event_name`:

- `workflow_dispatch` runs against the same `ref` share a group and
  **cancel** a superseded dispatch — a second dispatch on a branch stops
  paying for the first one's remaining shards.
- Every other event (`schedule` — i.e. every credential and early-warning
  cron) gets a group keyed on `github.run_id`, which by construction no other
  run can ever share — so **no credential/early-warning night is ever
  grouped with anything**, and none can be cancelled by another scheduled
  run or by a dispatch. This is deliberate: a cancelled pending credential
  run resets its 14-night window (jev 0.83) — see the hand-off note this
  issue inherited. `cancel-in-progress` is likewise gated to
  `workflow_dispatch` only.

Enforced by `tests/ci-capacity-budget.test.ts`, in the same style as
`tests/ci-concurrency-group.test.ts` (`ci.yml`'s PR-scoped group).

## What this budget does not claim

- It does not make the GitHub-side scheduling delay disappear — see the
  staggering caveat above.
- It does not reduce the **credential** run's cost (still the real 16-shard
  suite, `max-parallel: 8` only bounds concurrency, not total job-minutes) —
  a credential night still runs every selected file, because reducing the
  credential lane's selection would be reducing the compatibility evidence
  itself, which is exactly what this issue does not touch.
- The 08:30 UTC pile-up class is bounded, not eliminated: multiple *other*
  nightlies (not credential cells) can still land inside the same delayed
  window as a credential run. `max-parallel: 8` per credential run is what
  keeps a single credential night from itself exhausting the cap; it is not
  a global scheduler.
