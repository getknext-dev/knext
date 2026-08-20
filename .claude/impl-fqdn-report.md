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

---

# ROUND 2 — both reviews addressed (commits `ca6be8b` red → `11ba6c5` green, pushed)

Tree was verified clean before any work and after every mutation. Spec §G's "something is
still mutating this worktree" was **me** — round-1's mutation proofs running during their
review. Everything below ran only on committed-green trees.

## What each item became

| # | item | done |
|---|---|---|
| 1 | code#1 provision-app.sh :169 + :609 | **both** writers rooted (+ the DSN it prints); scan guard covers them; proved RED **separately** (mutations 7 and 8) |
| 2 | spec A gen-secrets.sh, demo manifest/README | rooted; file-manager redis default explicitly **deferred** (see below) |
| 3 | spec B doc recipes | `database-platform.md:169` + `postgres-binding.md:154-155` fixed |
| 4 | code#2 ndots arithmetic | corrected to the LIVE story in all 4 artifacts; "(3 dots)" → 2 |
| 5 | code#5/spec F `_validate.sh` reachability | 88 fixed; real script now runs past it and evaluates my contract |
| 6 | code#3 ZONE deferral in-tree | comments at `main.go:74` + `87-zone-operator.yaml:118` |
| 7 | code#4 tense | now "remains to be proven by the lead's OKE verification" + re-mint requirement |
| 8 | spec C node parsers | `tests/rooted-host-parsers.test.ts` — executed, not path-read |
| 9 | spec D re-mint-before-measuring | blockquote in `appdatabase-api.md` |
| 10 | code#6 dot-count assert | dropped, with a comment explaining why a rooted short name is legal |

## The highest-value finding was real and worse than filed

`provision-app.sh:609` (`rotate-cred`) does not just mint unrooted — it **overwrites a live
`app-db-<app>`**, so an app the operator had minted rooted would silently **revert** to the
search-walking host on its next credential rotation. Both writers are now rooted and each is
mutation-proved **independently** (7 = create only, 8 = rotate only), because a single anchor
count of 2 would not have proven the guard catches either one alone.

## Guard placement — reachability fixed properly

`_validate.sh` is not wired into the monorepo's root `.github/workflows` (the
`packages/scale-zero-pg/.github` copy is subtree residue GitHub does not run; #797 owns the
structural half). So the contract now lives in **two** places: `_validate.sh` (extended over
provision-app.sh, comment states the CI gap) and **`tests/rooted-minted-hosts.test.ts`**, which
runs in root CI today. The test SCANS rather than enumerates and asserts **both halves** — each
artifact must contain a gateway host at all, so a rename cannot turn it into a vacuous pass
(mutation 12 proves that half).

## 88-loadsoak-k6.yaml — the diagnosis was right, and there was a second layer

The parse failure was exactly the unquoted `memory: ${K6_MEM_REQUEST}` inside a `{flow map}`
(the `${` opens a brace; the cpu values beside it were already quoted). Quoted both.

That exposed a **second** pre-existing problem: even as valid YAML the file cannot be
server-validated raw, because `"${K6_MEM_REQUEST}"` is not a valid quantity — it is an envsubst
template. The dry-run loop now renders `${VAR}` placeholders (stand-in `1Mi`, chosen because it
satisfies the quantity regex **and** still parses as a string, so `container.image` unmarshals)
and validates the rendered output. 88 is schema-validated for the first time.

Stated limit, in the code: a defect that exists only in the RAW form and disappears after
substitution is not caught by a rendered check — which is exactly why those values are quoted
at the source.

## Reachability proof (real script, not a lifted snippet)

`sh _validate.sh` now gets **past 88** and reaches my contract. One unrelated, pre-existing
failure sits in between; with only that neutralised **in a throwaway copy**, my contract
**evaluates and PASSES** (66 `ok -` lines). Baseline and post-restore both re-verified.

**NEW PRE-EXISTING DEFECT FOUND — reported, deliberately NOT fixed here.**
`_validate.sh:413` greps for `min_over_time(sum(pggw_active_connections)`, but
`60-prometheus.yaml:162` legitimately evolved to
`min_over_time((sum(pggw_active_connections) - (sum(appdb_warm_hold_active) or vector(0)))[30m:1m])`.
The **rule survives; the check's pattern went stale** and has been failing invisibly because the
script always died at 88 first. `60-prometheus.yaml` is unmodified vs `origin/main` — this is not
mine. I did not fix it: whether to re-pin the old expression or accept the warm-hold subtraction
is an alerting-semantics call for that contract's owner. Worth its own issue; it will block
#797 the moment `_validate.sh` is wired into CI.

## Mutation battery — 16/16 RED, exit-code detection

Round-1's harness misreported a genuine RED because it grepped output; this one uses **exit
codes only**, asserts every anchor occurs exactly N times (aborting otherwise), verifies each
mutation applied, restores via `git checkout --`, and re-verifies baseline + tree-clean at the
end. Baseline was green **before** any mutation.

Go/operator (mine + both reviewers'): short default · unrooted 4-dot default · override ignored ·
`main.go` hardcodes short ignoring the const · override **auto-rooted** instead of verbatim ·
mint bypasses `d.GatewayHost`.
Scan guard: provision-app **create** alone · provision-app **rotate-cred** alone · gen-secrets ·
demo manifest · operator manifest · host removed entirely (vacuity/presence half).
`_validate.sh` (real script): manifest loses the dot · manifest env removed · provision-app
unrooted.
Parsers: expected host loses its root label.

## Verification state

- Go: `go test ./...` green (10 pkgs), `gofmt -l` clean, `go vet` clean.
- New TS: 9 tests green; `biome check` clean.
- Full root `vitest`: 22 files fail — **all environmental, none mine**. This worktree has no
  per-package `node_modules` (`Failed to resolve drizzle-orm/node-postgres`, `Cannot find
  module .../typescript/bin/tsc`) — precisely the cascade `.claude/rules/workflow.md` documents.
  Every failing file is in `packages/db`, `packages/kn-next`, `apps/*`, `examples/*`; I touched
  none of them. CI runs with a real install.
- Not run: kind / OKE. Architect + system-designer gates: lead-owned.

## Deferral list (explicit, per spec A's "then say so")

Now stated **in-tree** (`tests/rooted-minted-hosts.test.ts` docblock), not just in a report:
`apps/file-manager/kn-next.config.ts:17` (app-level redis default — same lever on the other
measured consumer, separate blast radius) · `ZONE_GATEWAY_HOST` (compute-side conninfo) ·
`internal/wake/*` + `_verify-*.sh` (gateway-internal / drill dial targets) · ADRs (historical).

## Two corrected sentences for the PR body (spec E — please edit in)

1. Replace the TDD claim with:
   > **TDD, stated precisely.** The round-1 red commit (`804611d`) failed for the *inverted*
   > contract — it asserted the FQDN-without-dot form that the ndots arithmetic later disproved,
   > and the green commit reversed it. The **rooted** requirement's red-first evidence is the
   > round-2 guard commit (`ca6be8b`), which is red on `provision-app.sh` (both writers),
   > `gen-secrets.sh` and the demo manifest while already passing on the operator manifest.

2. Replace any fleet-wide/measurement claim with:
   > **Scope and measurability.** Operator-minted `app-db-<app>` Secrets are mint-once, so this
   > reaches newly-minted apps; `gen-secrets.sh`'s Secret is apply-reconciled and therefore does
   > reach existing installs on the next run. The benchmarked app is in the *unaffected* set, so a
   > post-merge cold-start row taken without re-minting it measures the old host and proves
   > nothing — re-mint first (`provision-app.sh rotate-cred <app>`, which now writes the rooted
   > host; the hand-made file-manager Secret must be re-applied by hand).

---

# ROUND 3 — code-review R2 + spec-review R2 (pushed, tip `4d8743e`)

Four commits, red-then-green per guard change:
`25e9467` red (predicate) → `69bf22e` green → `4089b60` red (repo-wide scan) → `4d8743e` green.
Tree verified clean before starting and after every mutation.

## R2-1 — the bare form, and a second defect it exposed

The reviewer was right and the hole was slightly bigger than filed. Both scans gated on
`.svc`, so `@pggw-apps:55432` (one label, furthest below ndots:5, walks all five suffixes)
evaded them — and `_verify-scale-ceiling.sh:141` already contains that exact form.

Fixed with **one uniform predicate** — `!h.endsWith('.')` — in both scans:
- the TS extraction is now anchored on **host position** (`@`, `=`, `: "`), which is what
  lets the predicate be uniform without an exclusion list for prose;
- `_validate.sh` is anchored on `@pggw-apps` (bare-inclusive, no longer `pggw-apps\.`) and
  requires a dot immediately before the `:port`.

**The red commit found a second defect nobody reported:** the old predicate also
**false-positived** on a legitimately rooted *short* name — `pggw-apps.<ns>.svc.` contains
`.svc` and doesn't end `.cluster.local.`, so a correctly-rooted custom zone would have been
flagged "NOT rooted", contradicting the operator's own documented custom-zone contract.
(Spec review §H flagged the same thing independently.) Both directions are now pinned.

I converted the reviewer's mutation into **permanent test cases** rather than leaving it as a
one-off proof — a mutation demonstrates a hole once, then evaporates.

## Spec §H — the structural fix, not the three lines

The enumerated `MINTING_ARTIFACTS` list was the cause, exactly as diagnosed. New guard:
**`tests/rooted-cluster-hosts-repo-wide.test.ts`** — `git ls-files` over every tracked text
file, two patterns (connection-URL authorities + bare gateway cluster-DNS in prose, which is
the form `demo/README.md:26` used and no URL regex could see), one uniform predicate.

Deferrals are **fail-closed in both directions** (#784 pattern): an unrooted host matching no
rule fails, **and a rule matching nothing also fails** — so a deferral cannot outlive what it
excused. Mutation-proved both halves.

**It red on 10 files, not 3** — the three §H named plus seven the enumeration could never see:
`getting-started.md`, `scale-zero-pg/README.md`, `knext-handoff-prompt.md`,
`apps/docs/.../scale-to-zero-database.mdx`, and `deploy/{30-knext-secret,10-gateway,81-apps-gateway}.yaml`.
All rooted.

Deferrals, each with a stated reason: app-level redis (incl. the fm default), gateway-internal
`compute-*`, doc placeholder hosts, drill/bakeoff scripts, zone-operator conninfo, TLS SANs,
platform-internal dial targets, rooting-explainer prose, test fixtures, ADRs/benchmarks,
ops runbook, the guards' own fixtures.

**One deferral is a real follow-up, not a dismissal:** `gen-tls.sh` SANs stop at
`…svc`, so under `sslmode=verify-full` a rooted host would not match the certificate. That
mismatch **predates this PR** (it already failed for the 4-dot FQDN) and belongs with the TLS
owner — recorded in the deferral's own reason text so it cannot be lost.

## Spec §I — my parser test would have failed in CI

Verified the reviewer's claim directly: `ioredis` and `pg-connection-string` were plain
directories dated **Jun 20** in the *parent* checkout, while pnpm-managed deps are symlinks
into `.pnpm` dated Aug 19. My round-2 test passed only by resolving stale non-pnpm residue
outside the worktree; on a clean `pnpm install --frozen-lockfile` it would have thrown a
module-resolution error — a red that reads as infra, not as the contract it encodes.

Both are now root devDependencies and resolve from this worktree's own `.pnpm` store. Note
the declared `ioredis` is **6.0.0**, a major bump from the 5.9.2 residue the reviewer measured
— I re-ran against the real declared version rather than assume: the root label still survives.

Also caught in passing: biome's `noExportsInTest` would have failed CI on the extracted
helpers. They are module-private now.

## R2-2 / R2-3

- R2-2: the last "3-entry search path" comment (`gatewayhost_test.go:16`) now says five.
- R2-3: the reachability claim is restated **at the source** (`_validate.sh` comment), not just
  here: that contract has **never executed in a real run**. Two independent reasons — the file
  is unwired from root CI (#797), *and* the script exits at `:411` on a stale anchor. Fixing 88
  unblocked it by one hop; `:411` still sits in front. **Live enforcement is the two root
  tests.** I did not touch `:411`: #777/#791 deliberately reworked that rule
  (`60-prometheus.yaml:151`, "DELIBERATE warm holds are NOT phantoms"), so it is a stale anchor,
  not a lost alert, and deciding what it should now assert is an alerting-semantics call.

## Mutations — 24 RED total, 0 problems

Rounds 1–2 battery re-run: **16/16 still RED**. New round-3 battery: **8/8 RED**:
bare form on the create writer alone · bare form on the rotate-cred writer alone · bare form
through the real `_validate.sh` · doc recipe regressing to short host · doc recipe regressing to
the bare-in-prose form · **a brand-new file introducing an unrooted mint** (the fifth artifact
nobody has written yet) · a deferral going stale · the deferral list deleted entirely.

Exit-code detection throughout, baseline green first, anchors asserted exactly N times or
ABORT, restores verified, tree clean after. One case correctly **aborted** rather than
silently passing (the anchor occurred 3×, not 2× — the help-text DSN also carries it); I fixed
the count and re-ran rather than loosening the assertion.

## Verification

- Go: `go test ./...` green, `gofmt`/`go vet` clean. `sh -n _validate.sh` clean.
- The three guards: 22 tests green. `biome check` clean on all three.
- Full root suite: 286 files, **22 failing — all pre-existing/environmental, none mine**
  (`Failed to resolve drizzle-orm/node-postgres`, `Cannot find module '@vercel/otel'`), in
  packages I never touched. Proved my dep change is not the cause: the lockfile diff is
  **purely additive** (+65/−28, no removals of `drizzle-orm` or `@vercel/otel`).
- Not run: kind / OKE. Design gates: lead-owned.
