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
2. Back the optimized-image cache with the **object store** via the adapter's image cache handler
   (mirrors how the ISR/data cache is Redis-backed): first request optimizes + writes the variant to
   the store keyed by `(src, w, q, accept)`; later requests (any pod) read the cached variant. This
   is the knext-native analogue of the reference Bun adapter's `SqliteImageCacheStore` (we use the
   object store instead of SQLite — see `docs/research/adapter-bun-learnings.md`).
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

## Action items (→ A4-2)

1. Add `sharp` to `apps/file-manager/Dockerfile` runtime stage; verify `/_next/image` returns
   resized/format-negotiated output (compat-suite image cases).
2. Implement the object-store image cache handler (`(src,w,q,accept)` key) in the adapter; wire via
   `images.loader`/cache config.
3. Set `images.formats`, sizes, and a strict `remotePatterns` allowlist in the app config.
4. Gate on the official compatibility suite image cases (A3).
