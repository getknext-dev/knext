# ADR-0011: Build-id-versioned assets, retention GC, and client→build pinning (skew protection)

- Status: Accepted
- Date: 2026-06-22
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), ADR-0006 (object-store data plane),
  ADR-0008 (app-namespaced assets + deletion finalizer), issue #93 (skew protection),
  issue #92 (rollback / traffic pinning), issue #75 (asset-upload verification)

## Context

*Version skew* happens when a browser still running build **A** (its HTML + chunk graph already
loaded) requests `_next/static/<A>/…` assets after the server has rolled forward to build **B**.
If those assets are gone, the user hits `ChunkLoadError` / hydration failures. Vercel solves this
with "skew protection": each client is pinned to the build it started on, and that build's assets
are retained for a window.

Two facts about knext's current data plane make this tractable:

1. **Assets are served from the durable object store**, not pod-local disk (`assetPrefix =
   <publicUrl>/<app>`, ADR-0008). A cold/scaled-to-zero pod of build B can still serve build A's
   chunks if they exist in the store.
2. **Upload is already additive.** No provider's bulk upload carries a prune/delete/mirror flag
   (`aws s3 sync --delete`, `gsutil rsync -d`, `mc mirror --remove`, …), and Next nests chunks under
   the build id, so a new deploy does **not** clobber a prior build's `_next/static/<A>/…`. A #92
   canary (rev A + rev B) therefore already serves A's chunks.

The real gaps: (1) the additive / build-id-scoped behaviour was unprotected by tests and could
regress; (2) nothing reaped old builds → unbounded storage growth; (3) clients were not pinned to a
build, so a query-string/`deploymentId` mechanism was missing.

## Decision

1. **Build-id scoping is a locked contract.** Static chunks live under
   `<app>/_next/static/<BUILD_ID>/…`. Regression tests assert upload is additive (no prune flag on
   any provider) and that two build-ids coexist after a second deploy.

2. **Deterministic BUILD_ID + client→build pinning.** `kn-next deploy` sets
   `NEXT_DEPLOYMENT_ID = <deploy tag>` **before** `next build`. `next.config.ts` reads it into BOTH:
   - `deploymentId` — Next appends `?dpl=<id>` to asset/RSC requests and emits a skew signal, so a
     browser on build A keeps requesting build A's assets; and
   - `generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null` — **this is load-bearing**
     (defect A). Verified against Next 16 source: `deploymentId` ONLY sets the `?dpl=` query param;
     the `_next/static/<BUILD_ID>/` directory is otherwise a **random nanoid** via
     `generateBuildId(config.generateBuildId, nanoid)`. Without forcing `generateBuildId`, the
     uploaded static prefix would be a random id that does NOT equal the deploy tag the GC prunes by,
     so the "just-deployed build is protected" guarantee would silently fail. Forcing it makes
     `.next/BUILD_ID` == `NEXT_DEPLOYMENT_ID` == the deploy tag == the `_next/static/<tag>/` prefix
     (`null` falls back to Next's nanoid for local `next dev`). `deploy.ts` additionally reads
     `.next/BUILD_ID` after the build and **fails the deploy** if it is not the tag — a guard against
     Next ever changing this. Build id ⇔ image ⇔ static prefix stay in lock-step.

3. **Bounded, build-id-aware, live-aware retention GC.** A pure function
   `selectBuildsToDelete({ remoteBuildIds, timestamps, liveBuildIds, retain })`
   (`packages/kn-next/src/utils/asset-gc.ts`) returns the build-ids safe to delete:

   > **keep iff** (within the newest `retain` window) **OR** (build-id EXACTLY in the live set).

   `retain` defaults to `3`, configurable via `storage.assetRetention`.

   **Resolving the live set correctly (defect B).** A Knative revision name does NOT contain the
   build-id — revisions are auto-named `<app>-<NNNNN>` and the deployed image is **digest-pinned**, so
   the build-id cannot be recovered from the revision name or the image. An earlier design matched a
   remote build-id if it was a **substring** of a live revision name; that is wrong and is an
   **over-DELETE safety bug** — a genuinely live (rolled-back/canary) build older than the retain
   window would not be recognized as live and would be **reaped**. The fix is a real, resolvable link:

   - the operator stamps `apps.kn-next.dev/build-id: <buildId>` onto the Knative Service's **revision
     (pod) template** (`Spec.Template.ObjectMeta.Labels`), which Knative propagates to every Revision
     (CLI passes the tag as `spec.buildId` in the CR);
   - `deploy.ts` reads `Status.CurrentTraffic[].revisionName` (READ-ONLY), then for each live
     revision reads that **label** via
     `kubectl get revision <name> -o jsonpath={.metadata.labels.apps\.kn-next\.dev/build-id}`
     (READ-ONLY, ADR-0001) to recover the **exact** live build-id;
   - `selectBuildsToDelete` matches the live set by **exact equality** (never substring).

   **Fail-safe:** if ANY live revision cannot be resolved to a non-empty build-id (label missing /
   read error), `resolveLiveBuildIds` returns `{ ok: false }` and `deploy.ts` **skips the GC
   entirely** — over-keep, never over-delete. This guarantees a **#92 pinned / canary / rolled-back**
   build is **never reaped, even when older than the window**. The deploy-time pruner
   (`pruneOldBuilds`) deletes strictly under `<app>/_next/static/<id>/`, best-effort (a GC failure
   never fails an already-shipped deploy). It never deletes the only/last build and refuses any
   delete URI not scoped to `_next/static/<id>/`.

4. **Authority split (load-bearing).** The ADR-0008 deletion finalizer's bare-`<app>/` delete is
   **TEARDOWN-ONLY** (whole-NextApp removal) and must NEVER be used as a deploy-time prune. The new
   GC is the **sole** build-id-pruning authority, and it only ever touches the
   `_next/static/<id>/` sub-namespace under `<app>/`. The two never overlap, so a deploy can never
   wipe the bare `<app>/` namespace.

## Options considered

| Option | Pins client | Bounded storage | Protects #92 rollback | Verdict |
|---|---|---|---|---|
| Do nothing (rely on additive uploads only) | No | No (unbounded) | Incidentally | Rejected — unbounded growth, no pinning |
| Time-only retention (TTL on objects) | No | Yes | No (could expire a live build) | Rejected — can reap a live build |
| **`deploymentId` + window-OR-live GC (chosen)** | Yes | Yes (keep newest N) | Yes (live set from Status.CurrentTraffic) | **Chosen** |
| Operator-owned GC | Yes | Yes | Yes | Deferred — keeps prune authority in the CLI/data-plane for now; revisit if the operator gains a storage client |

## Consequences

- Old clients keep working across a deploy for the retention window; storage is bounded to ~`retain`
  builds plus any live build.
- A rollback (#92) that pins an *old* revision is safe: the operator-stamped `build-id` label on that
  revision resolves to its exact build-id, which is in the live set → kept (even outside the window).
- Storage-cost vs safety is one knob (`storage.assetRetention`).
- The GC fails CLOSED on uncertainty: a listing/parse failure, OR any live revision that cannot be
  resolved to a build-id, skips GC (keeps everything). The live set is matched by **exact equality**,
  so it can only ever *add* keeps — the corrected design can over-keep, never over-delete.

## Action items / what is NOT covered here (honest scope)

- **Unit-tested now:** additive/no-prune lock, build-id-scoped keys, two-builds coexist, the pure GC
  selection logic with **exact** live-set matching, the deploy-time prune argv scoping (gcs + azure),
  `parseLiveRevisionNames`, the fail-safe `resolveLiveBuildIds`, `spec.buildId` CR rendering, and the
  `deploymentId`/`generateBuildId` wiring. **Envtest:** the operator stamps
  `apps.kn-next.dev/build-id` onto the revision template (and omits it when `Spec.BuildID` is empty).
- **Deferred to nightly e2e (#89/#38 harness), NOT a PR gate:** actually serving an old client's
  chunks during a *live* canary in a real browser — that requires a cluster + browser and cannot be
  asserted in a unit test. This ADR does not claim that path is verified by the unit suite.
