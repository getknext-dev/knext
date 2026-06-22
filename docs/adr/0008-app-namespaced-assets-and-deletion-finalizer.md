# ADR-0008: App-namespaced object-store assets + NextApp deletion finalizer

- Status: Accepted
- Date: 2026-06-22
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), `.claude/rules/scs-zones.md` (data
  sovereignty), issue #74 (deletion finalizer), issue #33 (control-plane consolidation), ADR-0006
  (object-store data plane)

## Context

ADR-0001 makes the operator the single writer of cluster state. The **deploy** path already complied
(`deploy.ts` applies only the `NextApp` CR; #33), but **teardown** did not: `cleanup.ts` deleted k8s
objects and cleared object storage out-of-band, and nothing cleaned an app's external state on
delete — so repeated deploy/delete cycles **leaked** object-store assets and Redis keys.

Implementing the operator-side cleanup surfaced a deeper problem: the CLI uploaded `next build`
static assets to the **object-store bucket root** (keys like `_next/static/...`), with no per-app
namespace. A per-app deletion finalizer therefore had no scoped prefix to delete — "delete this
app's assets" degenerated to "delete the bucket root", which is unsafe in a shared bucket and would
violate data sovereignty (a zone must never touch another zone's data).

## Decision

1. **Namespace object-store assets under the app name.** The CLI uploads to `<bucket>/<app>/…`
   (`appKeyPrefix(config) = "<config.name>/"`), and the served `assetPrefix` is `<publicUrl>/<app>`
   (`getAssetPrefix(config)`). Both derive from `config.name`, so upload location and serve location
   move in **lock-step**. This is the load-bearing contract.
2. **The operator finalizer is the single teardown authority.** A finalizer
   (`apps.kn-next.dev/external-cleanup`) on `NextApp` runs scoped external cleanup on delete, then
   removes itself. The CLI `cleanup.ts` emits **only** a `NextApp` CR delete — no direct k8s/storage
   mutation (mirrors the deploy half; closes #33).
3. **Cleanup is strictly app-scoped (cross-app safety is non-negotiable):** object store =
   `ListObjectsV2(Prefix="<app>/")` + `DeleteObjects` (an **empty prefix is refused** — never a
   bucket-wide delete); Redis = `SCAN MATCH "<KeyPrefix>:*"` + batched `DEL` (**never `FLUSHDB`**).
   The operator's `<app>/` prefix must equal the CLI's `appKeyPrefix` — guarded by a non-tautological
   test that builds keys with the real uploader scheme and asserts a sibling app's keys are never
   selected.
4. **External cleanup is best-effort and bounded.** A 30s timeout wraps the attempt; on an
   unreachable store/Redis the operator logs, emits a `Warning` Event, and **still removes the
   finalizer** — a `NextApp` is never wedged in `Terminating` because an external dependency is down.

## Consequences

- **Per-app isolation in shared buckets** — a data-sovereignty win: each app owns the `<app>/` key
  space and the finalizer can only ever delete within it.
- **The CLI↔operator prefix contract is load-bearing.** A change to either side (`appKeyPrefix` or
  `appStoragePrefix`) that diverges would silently re-break cleanup; both sides have tests that fail
  on divergence. Any future change must keep them in lock-step.
- **Behavior change for already-deployed apps:** an app previously serving assets from the bucket
  root must be redeployed to pick up the `<app>/` scheme (assets and `assetPrefix` move together).
- The operator gains `aws-sdk-go-v2/s3` + `go-redis` deps for the real cleaner; non-S3 storage
  providers and non-Redis caches no-op with a logged warning until implemented.
- The deletion branch runs **before** spec validation, so even an invalid-image `NextApp` can still
  be deleted (no wedge path).

## Action items
- (Done in #74) finalizer + scoped `ExternalCleaner` + app-namespaced uploads + CLI CR-only teardown.
- (Follow-up) migrate `Spec.Cache.URL` to a `secretKeyRef` rather than a plaintext spec field.
- (Follow-up) exercise the real S3/Redis client error mapping (the unit tests use fakes).
