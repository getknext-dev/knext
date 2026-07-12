# Operator e2e suites — taxonomy, modes, and the shared-cluster safety model

Every suite in this directory runs against a **live cluster** and lives behind a
dedicated Go build tag so the suites never register two Ginkgo runners in one
binary. This file is the map: which tag runs what, in which mode, from which CI
lane, and which guardrails keep a run from damaging a shared cluster.

Everything below is checked against the code — file/line pointers are given so
staleness is detectable. When you add or change a suite, update this file in the
same PR.

## Suite taxonomy (six build tags)

Verified against the `//go:build` lines of each file.

| Build tag | Files | What it proves | Make target | Modes |
|---|---|---|---|---|
| `e2e` | `e2e_test.go`, `e2e_suite_test.go` (`e2e \|\| e2e_scale`), `suite_hooks_e2e_test.go` (`e2e && !e2e_scale`) | Kubebuilder manager suite: `make deploy`s the operator, asserts the controller pod runs and the protected metrics endpoint serves. | `make test-e2e` (creates **and deletes** its kind cluster) | kind only |
| `e2e_scale` | `scale_suite_test.go`, `suite_hooks_scale_test.go`, `scale_to_zero_cache_test.go` (#38), `scale_from_zero_test.go` (#39) | Scale-to-zero: bytecode-cache survival across scale-to-zero and cold-start activation, on a real Knative install. | `make test-e2e-scale` | kind only |
| `e2e_bundle` | `install_bundle_test.go` (#117) | The client install artifact: applies `dist/install.yaml` (manager image overridden to a locally-built one), operator goes Available, reconciles a digest-pinned `NextApp` with **honest** Ready semantics (unpullable placeholder ⇒ `Ready=False/KnativeServiceNotReady`; set `BUNDLE_APP_IMAGE` to a real serving digest for the `Ready=True` path). | `make test-e2e-bundle` | kind only |
| `e2e_cli` | `cli_e2e_test.go` | The REAL built `kn-next` CLI (plain Node, never Bun) runs `doctor` / `db bind` / `status` against a live operator; asserts exit codes and `--json` contracts. No app workload ever runs (deliberately unpullable image). | `make test-e2e-cli` | kind **or** existing-cluster |
| `e2e_rollback` | `rollback_e2e_test.go` (#92, Tier-B "rollback demoed") | `kn-next rollback` pin / canary / clear on a servable app with two real revisions; the operator reconciles the ksvc traffic split and real HTTP routes to the pinned revision. | `make test-e2e-rollback` | kind **or** existing-cluster |
| `e2e_gc` | `asset_gc_e2e_test.go` (plan P4, ADR-0011) | The asset-GC live-set guarantee end-to-end: in-cluster MinIO, seeded ADR-0008 key layout, pinned-oldest revision survives `kn-next gc`, unpinned-old reaped, reserved `chunks/css/media` + bare `<app>/` untouched, fail-safe over-keep skip proven first. Needs the `aws` CLI. | `make test-e2e-gc` | kind **or** existing-cluster |

Shared, tag-independent helpers (CLI runner, kube-context pinning, bundle
override, webhook-readiness wait, namespace creation/teardown) live in
`../utils/` and are unit-tested without a cluster (`go test ./test/utils/`).

## The two provisioning modes

- **Self-contained kind mode (default, `KNEXT_E2E_KUBE_CONTEXT` unset).** The
  suite builds the operator image locally, loads it into the kind cluster
  (`KIND_CLUSTER`, default `kn-next-operator-test-e2e`), and applies the
  rendered install bundle. `make test-e2e-rollback` / `make test-e2e-gc` create
  the kind cluster if missing (`setup-test-e2e`); `make test-e2e-cli` /
  `make test-e2e-bundle` / `make test-e2e-scale` expect it to exist. All of
  bundle/cli/rollback/gc additionally require cert-manager + Knative (+ Kourier
  for cli/rollback/gc) on the cluster — the CI workflows show the exact install
  steps. The cli/rollback/gc suites also build the CLI themselves, so run
  `pnpm install --frozen-lockfile` at the repo root first.
- **Existing-cluster mode (`KNEXT_E2E_KUBE_CONTEXT=<context>`).** cli, rollback
  and gc only. No install: the suite pins a rendered, minified `KUBECONFIG` for
  that context (`utils.PinKubeContext` — the user's global current-context is
  never touched), requires the operator to already be installed, and confines
  every write to one fresh, randomly-suffixed namespace that it fully deletes
  afterwards. This mode is designed for shared clusters (e.g. a live OKE), which
  is exactly why the teardown ownership guard below exists. Note: unlike the cli
  suite, rollback and gc DO run real app pods there.

## Environment variables (Go suites)

| Variable | Consumed by | Meaning |
|---|---|---|
| `KNEXT_E2E_KUBE_CONTEXT` | cli / rollback / gc | Non-empty selects existing-cluster mode against that kube context. |
| `KNEXT_E2E_NAMESPACE` | cli / rollback / gc | Overrides the generated `e2e-<suite>-<hex>` app namespace — the reclaim path for a namespace an aborted run left behind. Teardown of it is subject to the ownership guard below. |
| `KNEXT_E2E_FORCE_TEARDOWN` | all namespace teardowns (`test/utils/teardown_guard.go`) | `1`/`true`: explicit **human** override of the teardown ownership guard, for deliberate reclaim of a namespace the guard would refuse (e.g. one created before the ownership label existed). Loud (warning on stderr); never set in CI. |
| `KNEXT_E2E_CURL_IMAGE` | scale (+ any in-cluster HTTP probe pod via `utils.CurlImage`) | Overrides the pinned `curlimages/curl` probe image when docker.io is unreachable/throttled. |
| `SCALE_TEST_IMAGE` | scale | Digest-pinned app image for the scale-to-zero specs (CI resolves it; `:latest` is rejected by the operator). |
| `ROLLBACK_TEST_IMAGE` | rollback | Overrides the digest-pinned `helloworld-go` default; must honor `PORT` and `TARGET` the same way. |
| `BUNDLE_APP_IMAGE` | bundle | A real, pullable, digest-pinned serving image to assert the `Ready=True` happy path instead of the honest-NotReady default. |
| `CERT_MANAGER_INSTALL_SKIP` | `e2e` / `e2e_scale` suite hooks | `true` skips the suite's own cert-manager install (already provided by the environment). |
| `KIND` / `KIND_CLUSTER` | Makefile | kind binary and cluster name (default `kn-next-operator-test-e2e`). |
| `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `AWS_REGION`, `AWS_EC2_METADATA_DISABLED` | gc (set **by the suite itself**) | Point the `aws` CLI and the CLI-under-test at the loopback port-forward of the suite's own in-cluster MinIO. Do not set these yourself. |

(TS-side env like `KNEXT_DB_LIVE` belongs to the `packages/db` integration lane,
not these Go suites.)

## Which CI lane runs each tag

| Tag | Workflow / job | Trigger |
|---|---|---|
| `e2e` | none — local-only (kubebuilder scaffold suite) | `make test-e2e` |
| `e2e_scale` | `operator-e2e-nightly.yml` → job `scale-to-zero-cache` | nightly cron + `workflow_dispatch` |
| `e2e_cli` | `operator-e2e-nightly.yml` → job `cli-e2e` | nightly cron + `workflow_dispatch` |
| `e2e_rollback` | `operator-e2e-nightly.yml` → job `rollback-e2e` | nightly cron + `workflow_dispatch` |
| `e2e_gc` | `operator-e2e-nightly.yml` → job `gc-e2e` | nightly cron + `workflow_dispatch` |
| `e2e_bundle` | `operator-bundle-e2e.yml` | PRs touching `packages/kn-next-operator/**`, push to `main`, `workflow_dispatch` |

## Safety model

These suites are explicitly designed to be runnable against shared clusters, so
the guardrails are part of the contract, not decoration:

1. **Teardown ownership guard (`test/utils/teardown_guard.go`).** The label
   `kn-next.dev/e2e-owned=true` **is** the teardown authorization. It is stamped
   only when a suite *creates* its namespace (`utils.CreateOwnedNamespace`, a
   single `kubectl create` — a pre-existing namespace collides with
   AlreadyExists and is **never adopted or labeled**). Every namespace deletion
   goes through `utils.NamespaceDeletedConfirmed`, which consults the guard
   first:
   - **existing-cluster mode requires the label** — name prefixes never
     authorize teardown there (a teammate's hand-made `e2e-foo` namespace on a
     shared cluster must survive a `KNEXT_E2E_NAMESPACE` typo);
   - in self-contained kind mode the generated `e2e-*` prefix is an accepted
     fallback (the whole cluster is throwaway);
   - refusal is loud (names the namespace, the missing label, and the
     override) and deterministic — the suites fail fast on it instead of
     retrying; `KNEXT_E2E_FORCE_TEARDOWN=1` is the explicit human escape hatch.
   The decision is a pure function (`DecideTeardown`) with table tests in
   `test/utils/teardown_guard_test.go`.
2. **Confirmed namespace deletion.** `NamespaceDeletedConfirmed` requires a
   NotFound read after the delete — a transient error can never fake a completed
   cleanup — and the namespace must be fully gone **before** any operator-bundle
   delete (a NextApp still finalizing in a terminating namespace deadlocks the
   CRD's instance-cleanup finalizer).
3. **gc endpoint gate.** Before **every** `kn-next gc` invocation the gc suite
   asserts the S3 endpoint is `http://127.0.0.1:<forwarded-port>` **and** that a
   canary object written through it appears inside the in-cluster MinIO pod's
   `/data` — an inherited endpoint deleting from a real bucket is the
   catastrophic failure mode it forecloses (`asset_gc_e2e_test.go`,
   `assertEndpointIsTestMinIO`).
4. **Webhook-readiness wait (#233).** Deployment `Available` does not imply the
   validating webhook serves; `utils.WaitForWebhookReady` dry-run-applies a
   NextApp until the webhook *answers* (a genuine admission rejection counts as
   ready), so no suite races the cert mount / TLS bind / caBundle injection —
   and no admission assertion is weakened.
5. **Digest-pinned images everywhere.** The operator rejects `:latest`; the
   cli/bundle default app image is additionally a deliberately unpullable
   all-zeros digest, so those suites never run an app workload on the target
   cluster.
