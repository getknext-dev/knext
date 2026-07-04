# ADR-0005 — Object-storage backend: configurable, MinIO-optional

- **Status:** ACCEPTED (2026-07-04) — the durable object store is a **configured
  S3 endpoint**, not bundled MinIO. The pageserver (page offload) and safekeepers
  (WAL offload) read `{endpoint, bucket, region}` from the `storage-objstore`
  ConfigMap and their access/secret from the `storage-s3-creds` Secret. In-cluster
  MinIO is the **optional local-dev / on-prem default**; a managed cluster points
  the same seam at the cloud's native object store.
- **Date:** 2026-07-04
- **Deciders:** architecture owner (ratify); evidence by `deploy/_verify-objstore.sh`
  on the OKE cluster (context `context-ckmva7v7zvq`), OCI Object Storage S3-compat
  vs in-cluster MinIO.
- **Closes:** #105 (configurable object-storage backend). **v1.0 gate.**
- **Relates to:** #4 / ADR (OCI Object Storage as the *backup* target — this ADR
  extends the same posture to the *live page/WAL store*).

---

## Context

The founding goal is "easy to host on any cloud or on-prem." The storage plane's
durability rests entirely on an S3 object store (pageserver layer uploads under
`/pageserver`, safekeeper WAL offload under `/safekeeper`). The MVP hardcoded that
store to a single in-cluster **MinIO** Deployment.

Two problems made "hardcoded MinIO" a v1.0 blocker:

1. **Supply-chain risk.** MinIO archived its community repositories. A platform
   whose promise is portability must not be married to an archived dependency for
   its single durability tier.
2. **Cloud-native mismatch.** On a managed cluster (OKE, EKS, GKE) the right object
   store is the cloud's own — durable, replicated, lifecycle-managed — not a
   single-replica MinIO Pod on a PVC that is itself un-replicated.

The pageserver and safekeepers already speak the **S3 API** (they use neon's
`remote_storage` S3 backend), so the backend is swappable *at the protocol level*
— the only coupling was the hardcoded `endpoint='http://minio:9000'` string.

## Decision

**Parameterize the object store; make MinIO optional.**

- A `storage-objstore` **ConfigMap** carries the non-secret target:
  `OBJSTORE_ENDPOINT`, `OBJSTORE_BUCKET`, `OBJSTORE_REGION`. It is created by
  `deploy/gen-secrets.sh` (default = in-cluster MinIO; override via
  `STORAGE_OBJSTORE_*` env for an external endpoint). It is **not** a checked-in
  manifest, so `kubectl apply -f deploy/` never clobbers an external override —
  the same "run gen-secrets before apply" contract that already governs
  `storage-s3-creds`.
- The S3 **access/secret stay in the `storage-s3-creds` Secret** (`user` /
  `password` → `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). For an external
  backend these are the cloud's S3 credentials (e.g. an OCI **Customer Secret
  Key**), mirroring the proven `backup-s3-target` pattern from #4.
- The `remote_storage` TOML line is **appended by the pageserver's seed-config
  init container** from those env vars (TOML has no interpolation); the safekeeper
  builds its `--remote-storage` inline the same way. Both 53 (primary) and 57
  (standby) pageservers, and 52 (safekeepers), are covered — a mixed backend would
  split durability.
- **Bucket creation is endpoint-agnostic:** it moved from the MinIO-only Job into
  `55-storage-init`'s `ensure-bucket` initContainer (`mc mb --ignore-existing`,
  SigV4 + path-style, tolerant of a managed S3 that pre-creates the bucket and
  denies `CreateBucket`).
- **MinIO is gated OPTIONAL:** `deploy/50-minio.yaml` is the local-dev/on-prem
  default, **digest-pinned** to the archived last-good build. For an external
  backend, point `storage-objstore` at it and **do not apply 50-minio.yaml** (a
  documented apply-set; see operations.md "Object-storage backend").

### Path-style is automatic (the load-bearing detail)

neon's `remote_storage` S3 backend forces **path-style addressing** whenever a
custom `endpoint` is set (which it always is here). This is exactly what makes
both MinIO *and* OCI's S3 Compatibility API work with **no separate
force-path-style flag** — a virtual-host-style client would fail against both.
Region is set to the S3 region (e.g. `me-abudhabi-1` for OCI Abu Dhabi).

## Posture (which backend, where)

| Environment | Object store | How |
|---|---|---|
| Local dev / laptop | in-cluster MinIO (default) | apply `50-minio.yaml`; no override |
| On-prem / air-gapped | self-hosted S3 — **SeaweedFS, Ceph RADOS Gateway, Garage** | point `storage-objstore` at it; skip `50-minio.yaml` |
| Managed cloud | the cloud's native object store (e.g. **OCI Object Storage** S3-compat) | Customer Secret Key + external endpoint; skip `50-minio.yaml` |

All three speak the same S3 API (SigV4, path-style). The maintained on-prem
alternatives replace archived MinIO without changing anything above the wire.

## Evidence

`deploy/_verify-objstore.sh` stands up a throwaway storage plane whose pageserver
+ safekeeper offload to a **configured** endpoint, writes rows, forces a layer
upload (`remote_consistent_lsn` advances past the marker), **wipes the pageserver
PVC** (empties its layer cache), re-attaches, and reads every row back through a
static compute — a successful read on an empty-cache pageserver proves GetPage@LSN
was served from object-store-fetched layers. Run against **OCI Object Storage
S3-compat with NO in-cluster MinIO**, and against MinIO for the baseline.
Numbers: `docs/BENCHMARKS.md` ("Object-storage backend: OCI vs MinIO").

## Consequences

- **Portability restored.** No hard dependency on an archived project; any
  S3-compatible store works, cloud-native or on-prem.
- **Backward compatible.** Default is unchanged in-cluster MinIO; an existing
  plane keeps working after `gen-secrets.sh` seeds the (MinIO-valued) ConfigMap.
- **One durability seam, uniformly applied.** Primary + standby pageserver and the
  safekeeper quorum all read the same target — no split-brain object store.
- **Operator responsibility (external).** The external store's durability,
  versioning, and lifecycle are the cloud's/operator's to configure; the platform
  no longer pretends a single MinIO PVC is a durable tier.
- **Not in scope:** per-tenant buckets, bucket encryption/KMS wiring, and an
  operator that provisions the bucket automatically — all post-MVP.
