DONE

# Lever 1 — root the platform-minted gateway hostname (appdb)

Branch `fix/appdb-fqdn-dsn` (from `origin/main` @ 9a1aa50), worktree
`/Users/banna/alpheya/pocs/knext/.claude/worktrees/agent-a6bb3259f2a40347c`.
Commits: `804611d` (red) → `b89cea3` (green) → `39926d9` (corrected form + docs).
NOT pushed, no PR.

## The brief's step 2 was defective and was corrected mid-task

`pggw-apps.scale-zero-pg.svc.cluster.local` (no trailing dot) has **4 dots**, which is
below `ndots:5`, so the resolver **still** walks the whole search path — the change as
originally briefed would have made every wasted attempt longer while eliminating none.
Landed form is the **rooted** `pggw-apps.scale-zero-pg.svc.cluster.local.`

Arithmetic as now stated in code/docs: default `ndots:5` + the 3-entry search path
(`<ns>.svc.cluster.local`, `svc.cluster.local`, `cluster.local`) means any name with
fewer than 5 dots is tried against all 3 entries first — 3 attempts, 6 queries with
A+AAAA — before the name as given. Only the rooted form is absolute and skips it.

## 1. Enumeration — where the platform mints/defaults a gateway host

Changed (app-consumed DSN path):

| Site | Was | Now |
|---|---|---|
| `gateway/internal/appdb/ports.go` (new `DefaultGatewayHost` const) | inline literal | `pggw-apps.scale-zero-pg.svc.cluster.local.` |
| `gateway/cmd/appdb-operator/main.go:69` → new `gatewayHostFromEnv()` | `env("APPDB_GATEWAY_HOST", "pggw-apps.scale-zero-pg.svc")` | `env("APPDB_GATEWAY_HOST", appdb.DefaultGatewayHost)` |
| `deploy/83-appdb-operator.yaml` `APPDB_GATEWAY_HOST` | `pggw-apps.scale-zero-pg.svc` | rooted FQDN — **this is the deployed path; it overrides the binary default** |

The DSN string itself is built at `gateway/internal/appdb/reconcile.go:92` from
`Deps.GatewayHost`; `DATABASE_URL_RO` is derived from it by port swap only
(`k8s.go` `EnsureSecretROKey` → `roDSN`), so both keys inherit the rooted host.
`CreateSecret` (`k8s.go:65`) just stores what it is handed.

Found and deliberately **NOT** changed (each one enumerated, with the reason):

- `gateway/cmd/zone-operator/main.go:74` — `ZONE_GATEWAY_HOST`, same short default, and
  `deploy/87-zone-operator.yaml:118` sets it explicitly. It is threaded into Postgres
  **subscription/FDW conninfo** (`internal/zone/reconcile.go:328,491`), i.e. resolved by
  *compute* pods, not app pods. Same lever applies and it is a cheap follow-up, but it is
  a different env var, a different consumer and a different test surface — out of this
  issue's scope rather than overlooked.
- `internal/wake/*` targets (`compute-ro.scale-zero-pg.svc`, etc.) — gateway-internal dial
  targets, never inside an app-consumed Secret.
- ADRs (`adr-0003:312`, `adr-0006:67`) — historical decision records; left as written.
- `docs/operations.md:2311,2487` — zone-replication conninfo examples, tied to the
  unchanged zone path.
- knext-side prose (`docs/guides/postgres-binding.md`, `docs/guides/database-platform.md`,
  `packages/scale-zero-pg/demo/README.md`) — prose only, excluded per the brief.

## 2. Consumer compat for the trailing dot — verified, not assumed

- **lib/pq (the operator's own warm-hold dial): VERIFIED.** `TestLibPQPreservesRootedHost`
  runs `pq.ParseURL` on a rooted-host DSN; the conninfo comes back
  `host='pggw-apps.scale-zero-pg.svc.cluster.local.'` — root label intact, no mangling.
  (First run of this test was red because I asserted `host=<h>` while lib/pq emits
  single-quoted pairs; the assertion was corrected to match lib/pq's real output form —
  the *behaviour* under test never changed.)
- **Warm-hold DSN rewrite: VERIFIED.** `SQLDialer.dsnWithTimeout` appends
  `connect_timeout` by string surgery; `TestWarmHoldDSNRewriteKeepsRootedHost` proves the
  host survives and lib/pq still parses the result.
- **node-postgres / ioredis: NOT runnable in the Go module — deferred to OKE.** Verified by
  reading the consumption path: the app reads `DATABASE_URL` verbatim from the Secret into
  `pg.Pool`; neither driver normalises the host, both hand it to `getaddrinfo`, and
  glibc/musl both honour the root label. Runtime proof = the lead's OKE verification (a
  fresh app pod connecting through a rooted DSN). No fallback to the 5-label form was
  needed, since nothing in verifiable scope choked.

## 3. Tests added (all mutation-proved)

- `gateway/internal/appdb/gatewayhost_test.go` — rooted default; minted `DATABASE_URL`
  host through the real reconcile path; derived `DATABASE_URL_RO` keeps it; lib/pq compat;
  warm-hold rewrite compat.
- `gateway/cmd/appdb-operator/main_test.go` — **both halves**: default is rooted when the
  env is unset; an explicit `APPDB_GATEWAY_HOST` is returned **verbatim** (4 cases incl. a
  custom zone rooted, the same unrooted, a short name, and a literal IP — none auto-rooted).
- `deploy/_validate.sh` — scanning (not enumerating) contract on the deployed manifest:
  `APPDB_GATEWAY_HOST` must be present *and* rooted; the presence check exists so removing
  the env cannot make the rootedness check silently pass.

Mutation proofs (anchor asserted exactly once, substitution verified applied, restore
verified — Python, never a silent `perl`; the tree was committed green first so the
`git checkout` restores could not eat uncommitted work):

| Mutation | Result |
|---|---|
| default reverted to old `…svc` | RED (5 tests across both packages) |
| default → **unrooted 4-dot** form (the defective briefed form) | RED |
| `gatewayHostFromEnv` ignores the env override | RED (all 4 override cases) |
| mint hardcodes a host, bypassing `Deps.GatewayHost` | RED |
| manifest value loses its trailing dot | `_validate.sh` check RED |

## 4. Docs (rule 2b, same PR)

`docs/appdatabase-api.md` (contract table + new **why-the-trailing-dot** paragraph with the
ndots arithmetic, a pointer to the knext cold-start ledger, and the minted-once scope note),
`docs/connecting.md` (writer + RO examples), `docs/getting-started.md`,
`docs/drills/tier-warm-drill.md` (stated default).

## 5. Honest scope

- **This does not reach the fleet.** `app-db-<app>` Secrets are minted **once** and the
  create path is idempotent (never overwrites a live password), so only apps provisioned
  **after** the operator upgrade get the rooted DSN. Existing apps keep the short host until
  their Secret is deleted and re-minted — a credential event, not a DNS tweak.
- **The filemanager Secret is hand-made and unaffected** by this change.
- **The measured win is unproven here.** These tests prove the *form*; that the rooted form
  actually removes the search-path round-trips on a fresh pod is an OKE measurement, not
  something a unit test can assert.
- `docs/benchmarks/cold-start-ledger.md` does not exist on `origin/main` yet (it lands with
  PR #795); the doc reference is written to resolve once that merges.

## 6. Verification state

- `go test ./...` in `packages/scale-zero-pg/gateway`: **all green** (10 packages).
  `KUBEBUILDER_ASSETS` not needed. No suite required env it lacked before.
- `gofmt -l .` clean, `go vet ./...` clean, `sh -n _validate.sh` clean.
- `deploy/_validate.sh` **cannot be run end-to-end here**: it dies earlier at a
  **pre-existing, unrelated** failure — `88-loadsoak-k6.yaml` fails kubectl's YAML parse at
  line 50, in a file this branch does not touch. The new check was therefore exercised and
  mutation-proved standalone (lifted verbatim), not via a full script run. Worth a look
  independently of this PR.
- Not run: kind / OKE. Gates not run (this package requires architect + system-designer
  sign-off — lead-owned).
