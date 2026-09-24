/**
 * storage-mode-checks.mjs — assertion functions for the storage-mode leg of the
 * nightly platform e2e (#1292, follow-up to #1283/#1291).
 *
 * #1291 fixed `kn-next deploy`/`preview` to thread `ASSET_PREFIX` /
 * `NEXT_DEPLOYMENT_ID` into a Dockerfile that rebuilds the app IN-IMAGE, and
 * added a pre-apply guard (`verifyBuiltImageLockstep`) proven against real
 * docker images. What it did NOT prove is that a LIVE, deployed app actually
 * serves assets from the configured bucket and that the served build id lines
 * up with the deploy tag — that is this file's job, plus
 * `storage-mode-e2e.mjs` (the live runner) and `storage-mode-e2e.selftest.mjs`
 * (the mutation-proof harness that proves these functions go red).
 *
 * Every function here is PURE (no network, no process) so the selftest can
 * exercise it against synthetic fixtures without a cluster. Fetching happens
 * in the runner and is passed in as data, never performed here.
 */

/**
 * Same-origin-style extraction, but for asset references that point at an
 * ABSOLUTE bucket URL (storage mode) rather than a same-origin path. Scans by
 * regex over the same tag shapes `extractAssetRefs` in `platform-e2e-checks.mjs`
 * covers (script src, stylesheet/preload/modulepreload/icon link href), so a
 * new chunk type is picked up automatically rather than needing a fixed list.
 *
 * @param {string} html
 * @param {string} prefix absolute URL prefix the reference must start with
 * @returns {string[]} unique matching URLs, in document order
 */
export function extractBucketAssetRefs(html, prefix) {
  /** @type {string[]} */
  const found = [];
  const push = (/** @type {string} */ raw) => {
    const v = raw.replace(/&amp;/g, '&');
    if (v.startsWith(prefix)) found.push(v);
  };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = m[0];
    const rel = /\brel="([^"]+)"/.exec(tag)?.[1] ?? '';
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (
      href &&
      /\b(stylesheet|preload|modulepreload|icon|shortcut|apple-touch-icon|manifest)\b/.test(rel)
    ) {
      push(href);
    }
  }
  return [...new Set(found)];
}

/**
 * Asserts the served HTML references at least one asset under
 * `<bucketUrl>/<name>/...` — the exact shape `getAssetPrefix()`
 * (`packages/kn-next/src/utils/asset-upload.ts`) computes. An image built
 * WITHOUT `ASSET_PREFIX` serves image-local relative paths instead (the #1283
 * regression), which this catches because `extractBucketAssetRefs` then finds
 * nothing under the bucket prefix.
 *
 * @param {{ html: string, bucketUrl: string, name: string }} args
 * @returns {{ prefix: string, refs: string[] }}
 */
export function assertAssetPrefixReferenced({ html, bucketUrl, name }) {
  const prefix = `${bucketUrl.replace(/\/+$/, '')}/${name}/`;
  const refs = extractBucketAssetRefs(html, prefix);
  if (refs.length === 0) {
    throw new Error(
      `no asset in the served HTML references the storage bucket prefix "${prefix}" — ` +
        'the app is serving image-local relative asset paths instead, which is exactly ' +
        'what an image built WITHOUT ASSET_PREFIX produces (#1283)',
    );
  }
  return { prefix, refs };
}

/**
 * @param {string} url
 * @returns {string}
 */
export function extensionOfUrl(url) {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  const clean = path.split(/[?#]/)[0];
  const slash = clean.lastIndexOf('/');
  const dot = clean.lastIndexOf('.');
  return dot > slash ? clean.slice(dot).toLowerCase() : '';
}

/** @type {Record<string, RegExp>} */
const CONTENT_TYPES = Object.freeze({
  '.js': /^(text|application)\/javascript\b/,
  '.mjs': /^(text|application)\/javascript\b/,
  '.css': /^text\/css\b/,
  '.woff2': /^font\/woff2\b/,
  '.woff': /^font\/woff\b/,
  '.svg': /^image\/svg\+xml\b/,
  '.png': /^image\/png\b/,
  '.json': /^application\/(manifest\+)?json\b/,
});

/**
 * Fetches each of `urls` through `fetchOne` and asserts every one is a real
 * 200 with the content-type its extension implies — never a bucket-listing
 * 404/403 masquerading as reachable, and never `application/octet-stream`
 * (the default MinIO serves for an object with no declared content-type,
 * which every provider's `bulkUpload` in `asset-upload.ts` sets explicitly).
 *
 * @param {{ urls: string[], fetchOne: (url: string) => Promise<{ status: number, headers: Record<string, string | string[] | undefined> }> }} args
 * @returns {Promise<string>} evidence summary
 */
export async function assertAssetUrlsServeOk({ urls, fetchOne }) {
  if (!urls.length) throw new Error('assertAssetUrlsServeOk: no urls given to check');
  /** @type {string[]} */
  const evidence = [];
  for (const url of urls) {
    const res = await fetchOne(url);
    if (res.status !== 200) {
      throw new Error(`GET ${url} -> HTTP ${res.status}, expected 200 from the object store`);
    }
    const ct = String(res.headers['content-type'] ?? res.headers['Content-Type'] ?? '');
    const ext = extensionOfUrl(url);
    const expected = CONTENT_TYPES[ext];
    if (expected && !expected.test(ct)) {
      throw new Error(`GET ${url} -> content-type "${ct}", expected to match ${expected}`);
    }
    evidence.push(`${url} 200 ${ct}`);
  }
  return evidence.join('; ');
}

/**
 * Extracts the `<buildId>` segment from a `.../_next/static/<buildId>/...`
 * asset URL and asserts it equals the given deploy `tag`. This is the live
 * proof of ADR-0011's skew-protection lock-step (`NEXT_DEPLOYMENT_ID` ===
 * deploy tag === Next's `generateBuildId()` output === the served static
 * prefix) — `verifyBuiltImageLockstep` (#1291) proves this against the BUILT
 * image before it ships; this proves it against what a browser actually gets.
 *
 * @param {{ refs: string[], tag: string }} args
 * @returns {string}
 */
export function assertBuildIdMatchesTag({ refs, tag }) {
  const withBuildId = refs
    .map((u) => /\/_next\/static\/([^/]+)\//.exec(u)?.[1])
    .filter((v) => Boolean(v));
  if (withBuildId.length === 0) {
    throw new Error(
      `none of the referenced asset URLs carry a "/_next/static/<buildId>/" segment: ${JSON.stringify(refs)}`,
    );
  }
  const distinct = [...new Set(withBuildId)];
  if (distinct.length > 1) {
    throw new Error(`asset URLs disagree on the build id: ${JSON.stringify(distinct)}`);
  }
  const buildId = distinct[0];
  if (buildId !== tag) {
    throw new Error(
      `served static prefix build id "${buildId}" != deploy tag "${tag}" — the image was ` +
        'built without (or with the wrong) NEXT_DEPLOYMENT_ID build-arg (#1283)',
    );
  }
  return `build id "${buildId}" == deploy tag`;
}
