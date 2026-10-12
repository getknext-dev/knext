/**
 * CDN cache-tag encoding (ADR-0068 D5.2) — INTERNAL.
 *
 * Every tag knext emits to a CDN is ASCII, lowercase, comma-free and
 * fixed-length, so a Next tag containing a comma or a non-ASCII character can
 * neither split nor corrupt a `Cache-Tag` header, and every tag fits inside
 * Google's 120-byte limit:
 *
 *   app tag    `kn-<p>`                              every edge-cacheable response
 *   build tag  `kn-<p>-b<first 12 hex sha256(id)>`   one per build
 *   Next tag   `kn-<p>-t<first 16 hex sha256(tag)>`  one per Next tag, including
 *                                                    the implicit `_N_T_<path>` ones
 *
 * `<p>` is the operator-derived prefix (first 12 hex of
 * sha256("<namespace>/<name>"), rendered as `KNEXT_CDN_TAG_PREFIX`).
 *
 * The purge side applies THE SAME FUNCTION to the tag `revalidateTag` receives
 * that the response side applied when it emitted the header — that is the whole
 * point of the encoding living in one place. The header preload (CDN-1) must
 * produce byte-identical output; `cdn-purge-tags.test.ts` pins independently
 * generated vectors that both sides have to meet.
 *
 * Dependency-free: `node:crypto` only (works on Node and Bun, compiled or not).
 */

import { createHash } from 'node:crypto';

function sha256hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** `kn-<p>` — the tag every edge-cacheable (non-immutable) response carries. */
export function appTag(prefix) {
  return `kn-${prefix}`;
}

/** `kn-<p>-b<12 hex>` — identifies the build that rendered a response. */
export function buildTag(prefix, buildId) {
  return `kn-${prefix}-b${sha256hex(buildId).slice(0, 12)}`;
}

/** `kn-<p>-t<16 hex>` — one Next cache tag, exactly as `revalidateTag` receives it. */
export function nextTag(prefix, tag) {
  return `kn-${prefix}-t${sha256hex(tag).slice(0, 16)}`;
}
