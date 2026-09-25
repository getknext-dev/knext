# Profile-B — unified app-zero + database-zero harness (P4a)

The **lead-local** platform-e2e leg: prove that a Next.js app on Knative and its
scale-to-zero Postgres (scale-zero-pg / szpg) compose — the app's HTTP activation
and the database's TCP wake-on-connect are independent mechanisms joined only by a
`DATABASE_URL` Secret. This directory is **P4a: the environment + the boundary
assertion**. The timed double-zero-wake drill is **P4b** (separate, builds on this).

> **This never gates a PR.** The szpg plane was last proven on a fresh ~100 GB /
> 4-node kind cluster; it does not fit a hosted CI runner, and scale-zero-pg has no
> image publish pipeline, so this harness builds + `kind load`s the gateway itself.
> It is lead-owned and on-demand, the same class as the standing OKE-verify stage.
> Design: [`.claude/research/platform-e2e-design.md`](../../../../../.claude/research/platform-e2e-design.md) §4.

## What it stands up

`setup-profile-b.sh up` creates, on a **uniquely-named** kind cluster with its own
throwaway kubeconfig (cluster work is a queue of one — unique names so a concurrent
drill is never clobbered):

1. **Knative Serving + Kourier + cert-manager**, `config-autoscaler` patched for a
   real cold start (`scale-to-zero-pod-retention-period: 0s`, `stable-window: 6s`).
2. **The szpg plane** in namespace `scale-zero-pg`: Neon-OSS pageserver /
   safekeepers / storage-broker / minio / pswatcher (always-on) + the **`pggw`**
   wake-on-connect gateway scaling the **`compute`** Deployment 0↔1. The gateway
   image is built from `packages/scale-zero-pg/gateway` and `kind load`ed;
   `GW_COMPUTE_TLS` is set to `false` for a laptop cluster.
3. **An `AppDatabase` CR** (`apps.scale-zero-pg.dev`) for `db-demo`, reconciled by
   the szpg appdb-operator into a `DATABASE_URL` Secret.
4. **`kn-next db bind db-demo --secret <appdb-secret>`** — the ONE knext cluster
   write for the DB: a single `kubectl patch nextapp` setting
   `spec.database.secretRef` (ADR-0019 BYO). The knext operator injects
   `DATABASE_URL` into the ksvc.
5. **db-demo as a `NextApp` CR** deployed to Knative (scale-to-zero).

## The boundary assertion (the core of P4a)

After the knext operator reconciles the NextApp and `db bind`, the harness asserts
that **the knext operator wrote NOTHING to the `AppDatabase`** — it is
owned/managed only by the szpg control plane. This proves the ADR-0001 /
data-sovereignty boundary that `nextapp_types.go:531` states in prose: *"knext's
operator never reads or writes AppDatabase."*

- The **detection logic** lives in [`../szpg_boundary.go`](../szpg_boundary.go),
  is **untagged** (runs under a plain `go test ./...`), and is unit-tested +
  mutation-proved by [`../szpg_boundary_test.go`](../szpg_boundary_test.go). It is
  a **fail-closed allowlist**: `metadata.managedFields` may carry ONLY known
  legitimate writers — the szpg `appdb-operator` / `zone-operator` and `kubectl-*`
  — and anything else is a violation. This is deliberate, and stays deliberate
  after #1215: the knext operator's binary is `/manager`, and until #1215 it set
  no explicit field owner, so a real knext write appeared as field manager
  `manager`, which a knext-name rejectlist would miss. The operator now sets an
  explicit identity (`rest.Config.UserAgent` = `kn-next-operator`,
  `internal/controller.OperatorFieldManager`), so a **current** build's write
  lands under that name instead — still not allowlisted, so still caught. The
  allowlist keeps the bare `manager` name flagged too, for AppDatabase objects
  an older operator build may have touched. The `ownerReferences` leg (no
  `NextApp` / `apps.kn-next.dev` owner) is secondary, and — to avoid a vacuous
  pass — the check also confirms szpg IS a writer.
- The **live driver** is [`../szpg_profile_b_test.go`](../szpg_profile_b_test.go),
  behind the `e2e_szpg` build tag (invisible to PR CI). It reads the running
  AppDatabase via `kubectl get -o json` and applies the assertion.

**Scope: this guard is OPERATOR-scope.** It detects the knext **operator** (field
manager `kn-next-operator` since #1215 — `manager` for pre-#1215 builds, still
flagged for backward compatibility) writing an AppDatabase — the ADR-0001 boundary that matters, because the operator
is the single source of truth for cluster state. A knext **CLI** write via
`kubectl` would be allowlisted under the `kubectl` prefix; that is deliberate and
harmless here — `kn-next db bind` patches the **NextApp**, never the AppDatabase,
so no CLI path writes an AppDatabase to begin with. The guard covers the operator
boundary, not a hypothetical CLI-to-AppDatabase write.

```sh
setup-profile-b.sh boundary     # runs the e2e_szpg driver against the live plane
```

## Usage

```sh
# up + wake oracle + boundary + teardown (default):
packages/kn-next-operator/test/e2e/szpg/setup-profile-b.sh all
# or step by step:
packages/kn-next-operator/test/e2e/szpg/setup-profile-b.sh up
packages/kn-next-operator/test/e2e/szpg/setup-profile-b.sh wake      # deploy/_verify-wake.sh
packages/kn-next-operator/test/e2e/szpg/setup-profile-b.sh boundary
packages/kn-next-operator/test/e2e/szpg/setup-profile-b.sh down
```

Env: `CLUSTER_NAME`, `APPDB_NAMESPACE` (default `my-apps`), `APPDB_NAME` (default
`db-demo`), `DB_DEMO_IMAGE` (a real, pullable db-demo digest — required for the
serve/seed steps; the default is the deliberately-unpullable placeholder), `KEEP=1`
(skip teardown for post-mortem).

## Known drill gotchas (baked in)

- `docker.io/minio/mc` and `quay.io/minio/mc` are **both access-denied** for
  anonymous pull, repo-wide (#1403). THROWAWAY drill/CI fixtures were repinned to
  `docker.io/bitnamilegacy/minio-client@<digest>`, which still pulls anonymously;
  the harness pre-pulls + `kind load`s it as cheap insurance against a flaky
  mid-drill pull.
- **This drill currently `ImagePullBackOff`s regardless of the above.**
  `deploy_szpg_plane()` applies the szpg `deploy/` directory verbatim, which
  includes the **live** szpg manifests `50-minio.yaml` (still pins the now-unpullable
  `quay.io/minio/minio`) and `62-backup.yaml` / `55-storage-init.yaml` (still pin the
  bare, now-unpullable `minio/mc:RELEASE.2023-01-28T20-29-38Z`). Those three are
  intentionally out of scope for a knext-side CI fix and are tracked in
  szpg's own review at [getknext-dev/knext#1423](https://github.com/getknext-dev/knext/issues/1423).
  The pre-pull/kind-load above covers only the `mc` CLIENT image used elsewhere in
  the harness — it does not make the storage plane pullable.
- Several `deploy/_verify-*.sh` default `KCTX` / `KSPG_CONTEXT` to the **OKE
  production** context. The harness exports both to the kind context and uses a
  throwaway `KUBECONFIG`, so a "local" drill can never touch a real cluster.

## What is validated where

| Piece | Validated |
|---|---|
| Boundary **detection logic** (allowlist over managedFields / ownerReferences) | **Unit-tested + mutation-proved off-cluster** — `go test ./test/e2e/` on every PR, including the real breach (field manager `manager`) |
| Live **driver detection** against a real apiserver | Validated on a tiny throwaway kind cluster (AppDatabase CRD only): a szpg-managed object PASSES; a write applied as **`--field-manager=manager`** (what a real knext write looks like) FAILS with the breach message |
| `e2e_szpg` driver compiles / vets | `go vet -tags e2e_szpg` (locally green) |
| Full szpg plane stand-up + double-zero wake | **Lead-local only** (~100 GB kind; requires the reproducible run of this script) — see P4b for the timed drill |
