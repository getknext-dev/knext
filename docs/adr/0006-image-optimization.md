# ADR-0006: Image optimization for knext

- Status: Accepted
- Date: 2026-06-19
- Deciders: knext architect
- Related: ROADMAP Tier A (A4), CLAUDE.md §8 (Vercel parity — image optimization is the biggest
  buildable-but-unbuilt gap), `.claude/rules/scs-zones.md` (data plane: GCS + Redis)

## Context

`next/image` runtime optimization (the `/_next/image` endpoint: resize, format negotiation to
WebP/AVIF, quality) is **missing** from knext today — the standalone runtime ships **no `sharp`**,
so requests for optimized images fall back to serving the original (or 500). This is the single
biggest Vercel-parity functional gap (CLAUDE.md §8 bucket 2).

Constraints unique to knext:
- **Scale-to-zero:** pods come and go. Optimizing an image is CPU-expensive; doing it on every cold
  pod (per request) wastes the cold-start budget and re-does work. Optimized variants must be
  **cached in a store that survives pod death** — not pod-local disk.
- **Existing data plane:** GCS (object storage, S3-compatible everywhere per ADR-0005) + Redis.
- **Narrow-adapter positioning:** prefer the Next.js-native path over bolting on a general image CDN.

## Decision

**Use Next.js's built-in optimizer (`sharp`) in the standalone runtime, and persist optimized
variants in the object store (GCS/S3) so they survive scale-to-zero — not pod-local cache.**

1. Add `sharp` to the runtime image (distroless Node) so `/_next/image` works natively. No new
   service, no API surface — `next/image` "just works".
2. Back the optimized-image cache with the **object store** so variants survive scale-to-zero:
   first request optimizes + persists the variant to the store keyed by `(src, w, q, accept)`;
   later requests (any pod) reuse the persisted variant. This is the knext-native analogue of the
   reference Bun adapter's `SqliteImageCacheStore` (we use the object store instead of SQLite — see
   `docs/research/adapter-bun-learnings.md`). **See the Correction below for the actual integration
   mechanism** (a directory sync on the pinned Next 16.0.3, not a pluggable hook).
3. Configure `images.formats` (AVIF/WebP), `deviceSizes`/`imageSizes`, and a strict
   `remotePatterns` allowlist (no open SSRF proxy).

## Options considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Next built-in `sharp` + object-store variant cache** | Next-native, zero new API, scale-to-zero-safe, reuses data plane | `sharp` adds image size + native dep | **Chosen** |
| Sidecar optimizer (imgproxy/thumbor) | language-agnostic, offloads CPU | new service to run/secure, not `next/image`-native, more infra | Reject (scope/infra) |
| CDN-resize (Cloudflare Images / Vercel) | no runtime CPU | vendor lock-in, against the no-lock-in stance, not self-hostable | Reject (positioning) |
| Pod-local cache only | trivial | re-optimizes every cold pod — defeats scale-to-zero economics | Reject (correctness) |
| `unoptimized: true` (punt) | nothing to build | not parity; ships large images | Reject |

## Consequences

- `next/image` reaches Vercel parity for resize/format/quality without new infrastructure.
- Optimized variants are computed once and shared across pods → cold starts don't re-optimize.
- **Security:** `remotePatterns` allowlist is mandatory — an unrestricted optimizer is an SSRF/DoS
  vector (cf. the `POST /api/cache/invalidate` lesson; never an open mutating/proxy endpoint).
- **Supply chain:** `sharp` is a native dep → must be in the SBOM/Trivy scan (Tier B / B2).

## Correction (2026-06-22, issue #66) — the integration mechanism

ADR item 2 originally assumed knext could register the image cache the way it registers the ISR
cache (a pluggable handler). **Verification against the pinned runtime found that is false for
Next 16.0.3**, the version knext ships:

- The ISR/data cache **is** pluggable via `next.config.cacheHandler` (knext's Redis handler).
- The **image** optimizer cache is **not** pluggable in 16.0.3: `next/dist/server/next-server.js`
  hardcodes `const { ImageOptimizerCache } = require('./image-optimizer')` and instantiates it
  directly, writing variants to a **pod-local** `<distDir>/cache/images/<cacheKey>/…`. IMAGE-kind
  entries are routed through a dedicated `imageResponseCache` with `incrementalCache:
  imageOptimizerCache`, **never** through `next.config.cacheHandler`. There is no `images.cacheHandler`
  option and `maximumDiskCacheSize` does not yet exist.
- **Next 16.2+ did add the hook** the ADR assumed: the docs for `maximumDiskCacheSize` now state you
  may "implement your own cache handler using `cacheHandler`" for images. So once knext upgrades to
  ≥16.2 this can become an object-store `cacheHandler` that handles `CachedRouteKind.IMAGE` — the
  cleaner end state.

**Caveats of the directory-sync mechanism (acceptable):** (1) the on-disk cache only exists when
`isrFlushToDisk` is true (Next's default) — an app that disables it writes nothing to disk, so the
sync silently no-ops. (2) A variant served before its debounced push completes makes the next cold
pod re-optimize it exactly once (then it persists) — idempotent, no data loss. Both disappear under
the ≥16.2 `cacheHandler` end state.

**Chosen mechanism on the pinned version (no API faking, no interception):** a **directory sync** of
the dir Next already writes. Next's on-disk `cacheKey` is
`hash([CACHE_VERSION, href, width, quality, mimeType])` — i.e. exactly the `(src, w, q, accept)` key
this ADR requires — so the per-variant directory name *is* the content-addressed key. On startup the
runtime **restores** persisted variants from the object store into `.next/cache/images` (warm cache);
while running it **watches** that dir and **pushes** newly-written variants up. Implemented in
`packages/kn-next/src/adapters/image-cache-sync.ts`, wired into the runtime entry
`packages/kn-next/src/adapters/node-server.ts`, guarded by `STORAGE_BUCKET` (no-op → pod-local
fallback when unset). The chosen-option name above remains "Next built-in `sharp` + object-store
variant cache"; only the *binding* is a sync rather than a hook on this version.

## Action items (→ A4-2)

1. [done #43] Add `sharp` to `apps/file-manager/Dockerfile` runtime stage; verify `/_next/image`
   returns resized/format-negotiated output (compat-suite image cases).
2. [done #66] Persist optimized variants in the object store, keyed by `(src,w,q,accept)`, so they
   survive scale-to-zero — via the directory sync described in the Correction (pinned 16.0.3 has no
   pluggable image cache hook). Replace with a `cacheHandler`-based IMAGE handler after upgrading to
   Next ≥ 16.2.
3. [done #43] Set `images.formats`, sizes, and a strict `remotePatterns` allowlist in the app config.
4. Gate on the official compatibility suite image cases (A3).
