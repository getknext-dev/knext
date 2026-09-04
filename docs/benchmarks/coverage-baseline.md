# @getknext coverage baseline

## Current — merged across both runners (2026-09-04, #884)

The gate is `node scripts/check-coverage.mjs`: it merges the ~336 per-file lcov
reports from `node scripts/bun-test.mjs --coverage` with vitest's single report
and checks the floors in `scripts/lib/coverage-policy.mjs`.

| scope | lines | functions |
|---|---|---|
| global (`packages/*/src/**`, 79 files) | 78.41% (8546/10899) | 79.70% |
| `packages/kn-next/src/**` (59 files) | 78.09% (7531/9644) | 76.88% (492/640) |

**These percentages are not comparable to the 2026-07-24 table below**, and the
difference is a denominator, not a regression: for `packages/kn-next/src/**`,
vitest's v8 provider counts **3430** lines where the merged lcov counts
**9644** — bun's `DA` records are ~2.8x more granular over the same files. That
is why the per-package floor reads 78 here and 90 there. The floors are set just
below today's measurement, per the ratchet convention, so any drop reds.

**What the merge cannot measure, stated rather than hidden:** bun's lcov emits
`SF`/`FNF`/`FNH`/`DA`/`LF`/`LH` and nothing else — no `BRDA`/`BRF`/`BRH`. So
**branch coverage does not survive the merge** and is no longer gated; a branch
percentage computed over the merge would come from vitest's 3 collected files
only, which is exactly the dishonest denominator this gate exists to prevent.
`statements` likewise has no lcov representation. Restoring a branch floor needs
branch records from the bun side, not a smaller denominator.

## Previous — vitest/v8 only (2026-07-24)

Kept for provenance. This is what the numbers meant under the v8 provider, back
when vitest still collected the suite.

| package | lines | branches |
|---|---|---|
| admin | 0.0% (0/94) | 0.0% |
| kn-next | 78.1% (1799/2304) | 72.5% |
| lib | 95.0% (303/319) | 77.6% |
| db | 95.8% (92/96) | 100.0% |
| ui | 100.0% (24/24) | 100.0% |

Note: admin/knext are UNTRACKED local cruft (0 tracked files) — excluded from any gate.

Scope: the coverage gate measures the **shippable `@getknext/*` packages** only
(`include: packages/*/src/**`). `apps/**` (example/template/recipe code) and the
Go operator are intentionally out of this TS line-coverage gate — apps/ is
app-level per the core-vs-app boundary rules; the operator has its own Go
coverage profile (`packages/kn-next-operator`, `go test -coverprofile`).
