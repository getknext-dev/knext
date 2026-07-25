# @getknext coverage baseline (2026-07-24)

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
