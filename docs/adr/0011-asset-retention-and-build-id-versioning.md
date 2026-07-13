# ADR-0011: Build-id-versioned assets, retention GC, and client→build pinning (skew protection)

- Status: Accepted (amended 2026-07-13: marker-object inversion + pin-with-empty-status fail-safe, #264)
- Date: 2026-06-22
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), ADR-0006 (object-store data plane),
  ADR-0008 (app-namespaced assets + deletion finalizer), issue #93 (skew protection),
  issue #92 (rollback / traffic pinning), issue #75 (asset-upload verification),
  issue #264 (GC hardening: marker inversion)

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
   never fails an already-shipped deploy). Consequently the summary's `reaped` field records the
   **attempted** delete set, not confirmed outcomes — a silently-failed provider delete is still
   listed. It never deletes the only/last build and refuses any
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
- **(DONE, plan P4)** Live-set guarantee proven END-TO-END by the nightly `e2e_gc` suite
  (`test/e2e/asset_gc_e2e_test.go`, `make test-e2e-gc`, `operator-e2e-nightly.yml` job `gc-e2e`):
  on a real kind + Knative + operator + in-cluster MinIO stack, the REAL `kn-next gc` (the exact
  `runAssetGC` wiring `kn-next deploy` runs — extracted to `packages/kn-next/src/cli/gc.ts`)
  keeps a `kn-next rollback --to`-pinned OLDEST revision's prefix on the live-set rule alone
  (retain=1), reaps unpinned out-of-window prefixes, never touches the bare `<app>/` namespace,
  and the fail-safe over-keep skip is proven with an unlabeled live revision. Seeding is via the
  S3 API in the exact layout — it does NOT re-prove that `next build`+upload produces that layout
  (covered by the upload unit suites + the deploy-time BUILD_ID lock-step guard).
- **(FIXED, found while building the e2e)** `listRemoteBuildIds` classified EVERY first segment
  under `<app>/_next/static/` as a prunable build-id — but real `next build` output also places
  the shared, content-hashed `chunks/`, `css/`, `media/` dirs there; outside the retain window
  the GC would have REAPED them, 404ing the current build's own JS/CSS. These reserved segments
  (`chunks`, `css`, `media`, `webpack`, `development`) are now excluded from the candidate set
  across all four providers (regression: asset-prune.test.ts; live: the e2e_gc suite seeds and
  asserts them untouched).

## Amendment (2026-07-13, #264): marker-object inversion + pin-with-empty-status fail-safe

### Context

The reserved-dir deny-list above fixes the *known* shared dirs, but its failure direction was
still DELETION: a FUTURE Next version emitting a NEW shared dir under `.next/static/` (not in the
list, no build-id shape) would re-enter the candidate set and be reaped once it aged out of the
retain window — a data-loss failure on a Next upgrade that nothing in CI would catch. Separately,
the GC treated an EMPTY `status.currentTraffic` as "nothing live ⇒ window-only prune", but if the
CR pins a revision (`spec.traffic.revisionName`, a #92 rollback) while the status is wiped or
lagging, a window-only prune can reap the pinned build.

### Decision

1. **Marker-object inversion.** Every knext upload stages a marker object
   `<app>/_next/static/<BUILD_ID>/.knext-build` (`BUILD_MARKER_FILENAME`, content = the build-id).
   It is written into the staging dir (`stageStandaloneAssets`, BUILD_ID from `.next/BUILD_ID`),
   so it rides each provider's existing bulk upload AND the #75 verify-and-retry pass on ALL four
   providers (GCS, S3, MinIO, Azure) — a deploy whose marker did not land remotely **fails
   loudly**. The pruner (`listRemoteBuildIds`, now listing recursively so markers are visible)
   feeds ONLY marker-carrying prefixes to `selectBuildsToDelete`; every non-marker prefix defaults
   to **KEEP** and is skipped loudly, named in the `kn-next gc` output and the returned
   `PruneSummary.keptUnmarked`. The keep rule is now:

   > **reap iff** (carries `.knext-build`) AND (outside the newest `retain` window) AND (not in
   > the live set). Unknown ⇒ KEEP.

2. **The reserved-dir deny-list STAYS, permanently, as defense-in-depth** (gate ruling). Deleting
   the shared `chunks/` dir is the max-blast-radius failure (404s the CURRENT build's own JS);
   `RESERVED_STATIC_DIRS` keeps those segments out of the candidate set even if a hostile or
   accidental `.knext-build` object appears inside one (regression-tested).

3. **Pin-with-empty-status fail-safe.** When `status.currentTraffic` is empty, `runAssetGC` probes
   `spec.traffic.revisionName` (READ-ONLY). If a pin is set — or the probe itself fails — the GC
   is **skipped entirely** with a loud line naming the pinned revision; it never falls back to a
   window-only prune. Only "status empty AND spec not pinned" proceeds window-only.

### Transition & reclaim (documented over-keep)

- **Mixed buckets:** builds uploaded by a pre-marker knext carry no marker and are **over-kept
  until a marker-carrying re-upload** rotates them out of relevance; each GC run names them.
- **Permanent over-keep for retired apps:** an app that never deploys again never gets markers,
  so its pre-marker prefixes are **never reaped automatically — by design** (the failure direction
  is KEEP). The reclaim path is manual: delete `<app>/_next/static/<id>/` prefixes by hand, or
  delete the `NextApp` CR — the ADR-0008 teardown finalizer wipes the whole `<app>/` namespace.

### Consequences

- The GC's failure direction on unknown input is now uniformly KEEP: unknown dirs, pre-marker
  uploads, listing/parse failures, unresolvable live revisions, and pinned-but-status-empty all
  over-keep, never over-delete. Storage boundedness now depends on uploads writing markers (a
  marker regression surfaces as unbounded keeps + loud per-run naming, not data loss).
- Coverage: marker staging + remote verification per provider (asset-upload.test.ts), marker-gated
  reap / unmarked-keep / hostile-marker-in-reserved-dir per provider (asset-prune.test.ts), the
  pin fail-safe (gc-cli.test.ts), and the nightly e2e_gc suite seeds markers and asserts one
  deliberately unmarked prefix survives a real prune.
- **(DONE, #264 part 2)** `kn-next gc --dry-run` (the full reap/keep plan — would-reap,
  window-kept, live-kept, unmarked-kept, reserved-excluded — computed through the SAME
  `classifyBuilds` path a wet run takes, with an argv-pinned zero-delete proof), the canary-pin
  e2e leg (two-target `status.currentTraffic` protects BOTH the pinned and latest-ready builds
  through a real prune), and the live pin+wiped-status e2e spec (a NextApp pinning a nonexistent
  revision — the PinnedRevisionNotFound/ADR-0014 state — proves the fail-safe skip on a real
  cluster) landed as the second half of #264.
- **Known TOCTOU (named, not fixed):** the GC's status/spec reads and its delete execution are
  not atomic — a pin applied in that narrow window is unprotected for the in-flight run.
  Pre-existing and seconds-narrow; fixing it would need conditional-write/compare-and-delete
  semantics the four object stores do not offer uniformly (documented at `runAssetGC` in
  `packages/kn-next/src/cli/gc.ts`).
