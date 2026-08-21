# ADR-0047: Object storage is optional — the in-image static tier

- Status: Accepted (2026-08-21; architect design gate ran pre-implementation on the row-3b brief,
  verdict PROCEED with six conditions — `.claude/architect-design-storage.md`)
- Date: 2026-08-21
- Deciders: knext architect (design gate), lead
- Related: ADR-0006 (image optimization — amended by this ADR), ADR-0011 (asset retention /
  skew protection — amended by this ADR), ADR-0008 (app-namespaced assets: contract conditional on
  assets existing), ADR-0014 (rollback), ADR-0028 (containerConcurrency), ADR-0041 (scaffolder),
  ADR-0043 §3 (narrowing a check removes coverage silently), #547/#548 (CRD version skew),
  `docs/ux/ergonomics-ledger.md` row 3b (the measurement this exists to answer)

## Context

The ergonomics ledger's row-3 sitting measured the config-authoring wall for the binding persona
(a Next.js developer with zero cloud/Kubernetes knowledge): a minimal deploy hard-required BOTH a
container registry AND an object-storage bucket (`'storage' is required`, `config.ts:258`
non-optional). Each placeholder implies an account, a provisioning step, and CLI auth the persona
has never done; Vercel's hello-world needs neither. The registry has no in-pod dodge — an image
must live somewhere — but the storage requirement was **a validator, not an architecture**: the
CRD has permitted an absent `spec.storage` since day one (`nextapp_types.go:55` is a nillable
pointer, both operator consumers nil-guarded), and `templates/app/Dockerfile.hbs` has always
COPY'd `.next/static` + `public` into the image as the non-CDN fallback. Only the CLI forbade the
mode. Serving statics from the pod is exactly `next start` semantics — the path the image was
already built for; nothing is rewritten ("don't rewrite the runtime twice" is not in play).

## Decision

`storage` becomes **optional by absence** in `KnativeNextConfig`. Omission is a first-class,
**explicitly announced** deploy mode: no asset upload, no `assetPrefix` (emitted HTML references
relative `/_next/static/...` paths), statics served from the container image. Absence is the ONLY
spelling of the state — there is deliberately **no `provider: "none"` sentinel** and no
`storage: false`. The type system is the primary guard: storage-dereferencing code paths take a
narrowed `StorageBackedConfig`, reached only through the `hasStorage()` type guard, so an
unguarded `config.storage` dereference is a compile error, not a runtime crash.

## Options considered

| Shape | Old-operator behaviour | Verdict |
|---|---|---|
| **`storage?` absent (chosen)** | Valid on every shipped CRD; both operator consumers (`nextapp_controller.go:1128`, `finalizer.go:130`) already nil-guard; nothing to prune or strict-reject | **Chosen** |
| `provider: "none"` sentinel | A *new value* in a field an old operator forwards verbatim into pod env. The `Provider != ""` gate passes `"none"`, so an older operator injects `STORAGE_PROVIDER=none, GCS_BUCKET_NAME=""` — a *silent misconfiguration*, not a rejection | Rejected |
| Explicit `storage: false` | Same new-value problem plus a type change on an existing field | Rejected |

The sentinel is worse on exactly the axis the #547/#548 version-skew rules care about: absence is
a state every past operator already understands; a new enum value is a state only the new operator
understands, and the failure is silent rather than loud. Two spellings of one state is also how
the two validation mirrors (`cli/validate.ts`, `loader.ts`) drift.

## Consequences

- **Skew protection splits two ways (see the ADR-0011 amendment).** Rollback gets SAFER: a pinned
  revision serves assets from its own image, so no retention window can reap them — the
  `retain=N` over-delete failure class disappears. In-flight skew gets WEAKER: once an old
  revision is scaled to zero and revision-GC'd, a chunk fetch already in flight from a browser
  still on that build 404s — the object store was exactly what covered that window. The
  `deploymentId` half (build-id in the image, `?dpl=` client pinning, skew-triggered reload on
  navigation) is storage-independent and still applies.
- **Image-optimization variant cache goes pod-local (see the ADR-0006 amendment).** `sharp` is in
  the runtime image, `/_next/image` works; only cross-pod variant persistence is lost.
- **Static traffic now counts against `containerConcurrency` (ADR-0028) and holds pods warm**,
  which touches the scale-to-zero economics knext sells — negligible for a starter, material at
  scale, and the honest reason the offload path exists.
- **GC becomes an announced no-op**: `kn-next gc` reports "no object storage configured — nothing
  to reap" and exits 0 — never a crash, never a claimed reap.
- **The failure mode this design buys is silent degradation**, so the mode is never silent: every
  storage-less deploy and build prints the mode notice at info (image-served assets, no CDN
  offload, no cross-deploy retention, in-flight skew window, docs growth path), and `doctor`
  reports the mode (ADR-0043 §3: a dropped `storage` block must not look identical to a
  deliberate choice).
- The scope boundary holds: knext makes storage optional; it does NOT provision storage (or ask
  to). "knext provisions the bucket" would be PaaS drift — a different decision with a different
  answer.

## Action items (the design gate's six conditions — all landed in the same PR)

1. Announce the mode at info on every storage-less deploy, with the docs link; `doctor` reports
   the mode ("storage-mode" check).
2. BOTH validation mirrors accept absence (`validate.ts`, `loader.ts`); a test reds if either
   still rejects it.
3. Every consumer is nil-safe via the type-level scan (`storage?` + `StorageBackedConfig` +
   `hasStorage`), with intentional announced no-ops — never a crash. `gc` reports
   nothing-to-reap, exit 0.
4. Behavioural guards, mutation-proved: the scaffold Dockerfile ships `.next/static` + `public`
   into the runner image (deleting the COPY line reds the suite), and the no-assetPrefix chain is
   pinned (deploy sets no `ASSET_PREFIX` without storage and clears an inherited one; the
   scaffold's `next.config.ts` gates `assetPrefix` on that env).
5. Docs in the same PR: `multi-cloud` gains "Starting without object storage";
   `skew-protection`, `rollback`, and `cli` gain the "with object storage configured" qualifier
   and the mode's honest trade-offs. User-facing tone, no ADR/issue numbers on the docs site.
6. `kn-next create` scaffolds `storage` commented out with the plain-language growth path, so the
   persona's `create → deploy` path has one remaining prerequisite (the registry) instead of two.
   The registry half is out of scope here (its lever is guidance, a later iteration).
