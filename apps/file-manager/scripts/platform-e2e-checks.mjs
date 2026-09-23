/**
 * platform-e2e-checks.mjs — the PURE assertions of the file-manager platform
 * e2e (#1282).
 *
 * Every function here takes observations (HTTP results, kubectl readings) and
 * either returns a short evidence string or THROWS. No function returns a
 * "skip", and none has a default that lets a missing observation pass. The
 * runner (`platform-e2e.mjs`) gathers the observations from a live cluster, and
 * the self-test (`platform-e2e.selftest.mjs`) feeds the same functions from
 * deliberately broken fake servers. So each assertion is proved able to go red,
 * and to go green, in PR CI without a cluster.
 */

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// App markers — stable strings the file-manager renders. Each is copied from
// the app source, not invented. If the app changes, these move with it.
// ---------------------------------------------------------------------------

/** apps/file-manager/src/app/page.tsx — the home page subtitle. */
export const HOME_MARKER = 'Powered by Knative + Next.js';
/** apps/file-manager/src/app/users/page.tsx — seeded by /setup. */
export const SEEDED_USER_EMAIL = 'admin@example.com';
/** apps/file-manager/src/app/cache-tests/on-demand/page.tsx — card classes. */
export const PRODUCTS_CLASS = 'text-green-300';
export const ORDERS_CLASS = 'text-blue-300';
/** The streaming fixture's markers (knext-smoke/stream/page.tsx). */
export const STREAM_SHELL = 'knext-stream-shell';
export const STREAM_FALLBACK = 'knext-stream-fallback';
export const STREAM_LATE = 'knext-stream-late';
/** The page suspends for 800 ms. The late chunk must trail by at least this. */
export const STREAM_MIN_GAP_MS = 300;

/** Seconds in a year: the max-age a content-hashed build asset must carry. */
export const ONE_YEAR_S = 31536000;

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

/**
 * Content types a served asset must carry, by extension. An extension missing
 * from this table is a FAILURE (`expectedContentType` throws), never a pass. A
 * new asset type has to be taught here, not waved through.
 */
export const CONTENT_TYPES = Object.freeze({
  '.js': /^(text|application)\/javascript\b/,
  '.mjs': /^(text|application)\/javascript\b/,
  '.css': /^text\/css\b/,
  '.woff2': /^font\/woff2\b/,
  '.woff': /^font\/woff\b/,
  '.svg': /^image\/svg\+xml\b/,
  '.png': /^image\/png\b/,
  '.ico': /^image\/(x-icon|vnd\.microsoft\.icon)\b/,
  '.json': /^application\/(manifest\+)?json\b/,
  '.webmanifest': /^application\/manifest\+json\b/,
});

/** @param {string} path */
export function extensionOf(path) {
  const clean = path.split(/[?#]/)[0];
  const slash = clean.lastIndexOf('/');
  const dot = clean.lastIndexOf('.');
  return dot > slash ? clean.slice(dot).toLowerCase() : '';
}

/** @param {string} path */
export function expectedContentType(path) {
  const ext = extensionOf(path);
  const re = CONTENT_TYPES[/** @type {keyof typeof CONTENT_TYPES} */ (ext)];
  if (!re) {
    throw new Error(
      `no expected content-type is known for "${ext || '(no extension)'}" (${path}). ` +
        'Add it to CONTENT_TYPES rather than letting an unknown asset pass.',
    );
  }
  return re;
}

/**
 * A content-hashed build asset. Its URL changes whenever its bytes do, so it
 * must be cached forever. Everything under `/_next/static/` is emitted with a
 * hash in its name or directory.
 * @param {string} path
 */
export function isHashedBuildAsset(path) {
  return path.split(/[?#]/)[0].includes('/_next/static/');
}

/**
 * Same-origin asset references in served HTML: scripts, stylesheets, preloads,
 * module preloads and icons. Found by SCANNING, not from a list, so a new chunk
 * is covered automatically. Absolute URLs to other origins are excluded,
 * because this checks what the app itself serves.
 * @param {string} html
 * @returns {string[]} unique paths, in document order
 */
export function extractAssetRefs(html) {
  /** @type {string[]} */
  const found = [];
  const push = (/** @type {string} */ raw) => {
    const v = raw.replace(/&amp;/g, '&');
    if (v.startsWith('/') && !v.startsWith('//')) found.push(v);
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
 * `url(...)` references inside CSS (fonts, images), resolved against the CSS
 * file's own path. Same-origin only.
 * @param {string} css
 * @param {string} cssPath
 */
export function extractCssUrls(css, cssPath) {
  /** @type {string[]} */
  const out = [];
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const ref = m[2].trim();
    if (ref.startsWith('data:') || /^[a-z]+:\/\//i.test(ref) || ref.startsWith('//')) continue;
    const resolved = new URL(ref, `http://x${cssPath}`).pathname;
    out.push(resolved);
  }
  return [...new Set(out)];
}

/**
 * Parse `max-age` from a Cache-Control header, or null when absent.
 * @param {string|undefined} cc
 */
export function maxAgeOf(cc) {
  const m = /(?:^|[,\s])max-age=(\d+)/i.exec(cc ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * One served asset: 200, the right content-type for its extension, a non-empty
 * body, and the cache policy its kind demands:
 *   - a content-hashed build asset: `max-age` of at least a year AND
 *     `immutable`. Anything less makes every navigation re-validate a file
 *     that can never change;
 *   - an unhashed public file: must NOT be `immutable`. Its URL is stable while
 *     its bytes may change on the next deploy, so immutable would pin stale
 *     content in every browser.
 * @param {string} path
 * @param {{ status: number, headers: Record<string, any>, body: Buffer }} res
 */
export function assertAsset(path, res) {
  assert.equal(res.status, 200, `${path}: HTTP ${res.status}, expected 200`);
  const ct = String(res.headers['content-type'] ?? '');
  const want = expectedContentType(path);
  assert.ok(want.test(ct), `${path}: content-type "${ct}" does not match ${want}`);
  assert.ok(res.body.length > 0, `${path}: empty body`);
  const cc = String(res.headers['cache-control'] ?? '');
  if (isHashedBuildAsset(path)) {
    const age = maxAgeOf(cc);
    assert.ok(
      age !== null && age >= ONE_YEAR_S,
      `${path}: hashed build asset cache-control "${cc}" lacks max-age>=${ONE_YEAR_S}`,
    );
    assert.ok(
      /\bimmutable\b/i.test(cc),
      `${path}: hashed build asset cache-control "${cc}" lacks immutable`,
    );
  } else {
    assert.ok(
      !/\bimmutable\b/i.test(cc),
      `${path}: UNHASHED file served immutable ("${cc}") — a redeploy could never replace it in a browser cache`,
    );
  }
  return `${ct.split(';')[0]} cc="${cc}" ${res.body.length}B`;
}

/**
 * The asset set as a whole must be real: the page references at least one
 * script and one stylesheet (a page with neither is not the app), and, because
 * the root layout uses `next/font`, at least one self-hosted `.woff2`.
 * @param {string[]} paths every asset path that was checked
 */
export function assertAssetCoverage(paths) {
  const exts = new Set(paths.map(extensionOf));
  assert.ok(
    exts.has('.js') || exts.has('.mjs'),
    `no JavaScript asset referenced (saw: ${[...exts].join(', ') || 'none'})`,
  );
  assert.ok(exts.has('.css'), `no stylesheet referenced (saw: ${[...exts].join(', ') || 'none'})`);
  assert.ok(
    exts.has('.woff2'),
    `no .woff2 font reached from the page or its CSS — the layout uses next/font (saw: ${[...exts].join(', ')})`,
  );
  return `${paths.length} assets, types: ${[...exts].sort().join(' ')}`;
}

// ---------------------------------------------------------------------------
// RSC streaming
// ---------------------------------------------------------------------------

/**
 * The streaming fixture must STREAM, which a final body alone cannot show: a
 * buffered response reproduces it byte for byte. So this asserts on chunk
 * arrival:
 *   - chunked transfer, since an HTTP/1.1 stream of unknown length can arrive
 *     no other way;
 *   - the shell and the Suspense FALLBACK arrive before the resolved content,
 *     in an earlier chunk;
 *   - the resolved content trails the fallback by at least STREAM_MIN_GAP_MS.
 * @param {{ status: number, headers: Record<string, any>, chunks: { at: number, text: string }[] }} res
 */
export function assertStreamed(res) {
  assert.equal(res.status, 200, `stream fixture: HTTP ${res.status}`);
  const te = String(res.headers['transfer-encoding'] ?? '');
  assert.ok(
    /\bchunked\b/i.test(te),
    `stream fixture: transfer-encoding "${te}" is not chunked — the response was not streamed`,
  );
  const firstChunkWith = (/** @type {string} */ needle) => {
    let seen = '';
    for (let i = 0; i < res.chunks.length; i++) {
      seen += res.chunks[i].text;
      if (seen.includes(needle)) return i;
    }
    return -1;
  };
  const shell = firstChunkWith(STREAM_SHELL);
  const fallback = firstChunkWith(STREAM_FALLBACK);
  const late = firstChunkWith(STREAM_LATE);
  assert.ok(shell >= 0, 'stream fixture: the shell marker never arrived');
  assert.ok(fallback >= 0, 'stream fixture: the Suspense fallback never arrived');
  assert.ok(late >= 0, 'stream fixture: the resolved (late) content never arrived');
  assert.ok(
    late > fallback && late > shell,
    `stream fixture: resolved content arrived in chunk #${late}, not after the fallback (#${fallback}) and shell (#${shell}) — buffered, not streamed`,
  );
  const gap = res.chunks[late].at - res.chunks[fallback].at;
  assert.ok(
    gap >= STREAM_MIN_GAP_MS,
    `stream fixture: resolved content trailed the fallback by only ${gap}ms (< ${STREAM_MIN_GAP_MS}ms)`,
  );
  return `chunked; fallback chunk #${fallback} @${res.chunks[fallback].at}ms → resolved chunk #${late} @${res.chunks[late].at}ms (+${gap}ms)`;
}

/**
 * The RSC flight payload for a page is served as `text/x-component`.
 * @param {{ status: number, headers: Record<string, any>, text: string }} res
 */
export function assertRscFlight(res) {
  assert.equal(res.status, 200, `RSC flight: HTTP ${res.status}`);
  const ct = String(res.headers['content-type'] ?? '');
  assert.ok(
    ct.includes('text/x-component'),
    `RSC flight: content-type "${ct}" is not text/x-component`,
  );
  assert.ok(res.text.length > 0, 'RSC flight: empty payload');
  return `${ct} ${res.text.length}B`;
}

// ---------------------------------------------------------------------------
// Platform features
// ---------------------------------------------------------------------------

/**
 * `POST /api/cache/invalidate` is a mutating endpoint. It must refuse without a
 * token AND with a wrong one (security.md), and accept the right one.
 * @param {{ none: { status: number }, wrong: { status: number }, right: { status: number, text: string } }} obs
 */
export function assertInvalidationAuth({ none, wrong, right }) {
  assert.equal(
    none.status,
    401,
    `invalidate WITHOUT a token returned ${none.status}, expected 401 — an open mutating endpoint`,
  );
  assert.equal(
    wrong.status,
    401,
    `invalidate with a WRONG token returned ${wrong.status}, expected 401`,
  );
  assert.equal(
    right.status,
    200,
    `invalidate with the right token returned ${right.status}, expected 200`,
  );
  const json = JSON.parse(right.text);
  assert.equal(
    json.success,
    true,
    `invalidate with the right token did not report success: ${right.text}`,
  );
  return '401 without token, 401 wrong token, 200 with token';
}

/**
 * Pull the ISO `generatedAt` rendered in the span carrying `cls`.
 * @param {string} html
 * @param {string} cls
 */
export function generatedAt(html, cls) {
  const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(
    `${esc}[^>]*>\\s*(?:<!--[^>]*-->)?\\s*(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d+Z)`,
  ).exec(html);
  if (!m) throw new Error(`no generatedAt timestamp found in the span with class ${cls}`);
  return m[1];
}

/**
 * On-demand invalidation took effect, and ONLY for its tag: after busting
 * `products`, the products timestamp changed and the orders timestamp (tag
 * `orders` only) did not. Orders is the control. A pod recycle would refresh
 * both.
 * @param {{ before: { products: string, orders: string }, after: { products: string, orders: string } }} obs
 */
export function assertTagInvalidation({ before, after }) {
  assert.notEqual(
    after.products,
    before.products,
    `products generatedAt did not change after invalidating its tag (${before.products})`,
  );
  assert.equal(
    after.orders,
    before.orders,
    `orders generatedAt changed (${before.orders} → ${after.orders}) — something other than revalidateTag('products') refreshed the page`,
  );
  return `products ${before.products} → ${after.products}; orders unchanged ${after.orders}`;
}

/**
 * ISR: two back-to-back reads after a priming read carry a cache-state header
 * and neither is a MISS. The value must later CHANGE, proving revalidation.
 * @param {{ reads: { cacheState: string|undefined }[], first: string, later: string }} obs
 */
export function assertIsr({ reads, first, later }) {
  assert.ok(reads.length >= 2, 'ISR: fewer than two cached reads observed');
  for (const [i, r] of reads.entries()) {
    assert.ok(
      r.cacheState,
      `ISR: read #${i + 1} carried no x-nextjs-cache header — the ISR path was not taken`,
    );
    assert.notEqual(
      r.cacheState,
      'MISS',
      `ISR: read #${i + 1} was a MISS — the route is not cached`,
    );
  }
  assert.notEqual(later, first, `ISR: the value never changed (${first}) — no revalidation`);
  return `${reads.map((r) => r.cacheState).join('/')} then revalidated ${first} → ${later}`;
}

/**
 * ISR keys in Redis, by NAME, with a TTL outliving the 1 s revalidate window.
 * @param {{ keys: string[], ttls: number[] }} obs
 */
export function assertIsrKeysInRedis({ keys, ttls }) {
  assert.ok(
    keys.length > 0,
    'no Redis key matches the ISR route — the page cache never reached the in-cluster Redis',
  );
  for (const [i, ttl] of ttls.entries()) {
    assert.ok(
      Number.isFinite(ttl) && ttl > 1,
      `ISR key ${keys[i]} has TTL=${ttl}; it must exceed the 1s revalidate window (never -1/-2)`,
    );
  }
  return `${keys.length} ISR key(s), TTLs ${ttls.join(',')}`;
}

/**
 * `next/image`: negotiated format (a passthrough would answer image/png) and
 * genuinely re-encoded (smaller than the source).
 * @param {{ source: { status: number, body: Buffer }, optimized: { status: number, headers: Record<string, any>, body: Buffer } }} obs
 */
export function assertImageOptimized({ source, optimized }) {
  assert.equal(source.status, 200, `image source: HTTP ${source.status}`);
  assert.equal(optimized.status, 200, `/_next/image: HTTP ${optimized.status}`);
  const ct = String(optimized.headers['content-type'] ?? '');
  assert.equal(
    ct.split(';')[0],
    'image/webp',
    `/_next/image did not honour Accept: image/webp (got "${ct}")`,
  );
  assert.ok(
    optimized.body.length > 0 && optimized.body.length < source.body.length,
    `/_next/image output ${optimized.body.length}B is not smaller than the source ${source.body.length}B — not re-encoded`,
  );
  return `image/webp ${optimized.body.length}B from ${source.body.length}B`;
}

/**
 * Deep health with BOTH live dependencies must be `ok`: `degraded`/`waking`
 * would mean the app cannot reach the in-cluster Postgres or Redis.
 * @param {{ status: number, text: string }} res
 */
export function assertDeepHealthOk(res) {
  assert.equal(res.status, 200, `/api/health/deep: HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  const json = JSON.parse(res.text);
  assert.equal(
    json.status,
    'ok',
    `/api/health/deep status "${json.status}" (expected ok with live Postgres + Redis): ${res.text.slice(0, 400)}`,
  );
  return `ok ${res.text.slice(0, 160)}`;
}

/**
 * Prometheus exposition text with a request counter family.
 * @param {string} text
 * @param {RegExp} family e.g. /^kn_next_http_requests_total\b/m
 */
export function assertPrometheusText(text, family) {
  assert.ok(
    /^# TYPE \S+ (counter|gauge|histogram|summary)/m.test(text),
    'not Prometheus exposition text (no # TYPE line)',
  );
  assert.ok(family.test(text), `metric family ${family} absent from the scrape`);
  return `${text.split('\n').length} lines, has ${family}`;
}

/**
 * Scale-to-zero reached: the revision Deployment wants 0 replicas AND no pod
 * of it is left. `spec.replicas` flipping is not the same as the pod being gone.
 * @param {{ specReplicas: number|null, pods: number }} obs
 */
export function isScaledToZero({ specReplicas, pods }) {
  return specReplicas === 0 && pods === 0;
}

/**
 * The woken request: 200 with the real home page (not an activator error page),
 * inside a generous ceiling. The ceiling is pass/fail, never ratcheted.
 * @param {{ status: number, text: string, ms: number, ceilingMs: number }} obs
 */
export function assertWoken({ status, text, ms, ceilingMs }) {
  assert.equal(status, 200, `wake-from-zero request returned ${status}`);
  assert.ok(
    text.includes(HOME_MARKER),
    'wake-from-zero response is not the file-manager home page',
  );
  assert.ok(ms <= ceilingMs, `wake-from-zero took ${ms}ms, over the ${ceilingMs}ms ceiling`);
  return `woke in ${ms}ms (ceiling ${ceilingMs}ms)`;
}

/**
 * A rollout under load dropped nothing: every request completed 2xx, the
 * serving revision really changed, and load actually overlapped the rollout.
 * @param {{ results: { status?: number, error?: string }[], before: string, after: string, minRequests: number }} obs
 */
export function assertRolloutClean({ results, before, after, minRequests }) {
  assert.ok(before && after, 'rollout: revision names missing');
  assert.notEqual(after, before, `rollout: the ready revision did not change (${before})`);
  assert.ok(
    results.length >= minRequests,
    `rollout: only ${results.length} requests overlapped the rollout (need >= ${minRequests})`,
  );
  const bad = results.filter((r) => r.error || !(r.status && r.status >= 200 && r.status < 300));
  assert.equal(
    bad.length,
    0,
    `rollout: ${bad.length}/${results.length} requests failed: ${bad
      .slice(0, 5)
      .map((b) => b.error ?? `HTTP ${b.status}`)
      .join('; ')}`,
  );
  return `${results.length} requests across ${before} → ${after}, 0 failed`;
}

// ---------------------------------------------------------------------------
// App functionality
// ---------------------------------------------------------------------------

/**
 * Find the server-action id the CLIENT uses for `exportName`, by scanning the
 * client JavaScript for vinext's `createServerReference(`<hex>#<name>`, …)`
 * literal. Exactly one distinct id must be found. Zero means the upload form is
 * not wired to a server action. More than one means ambiguity, which is refused
 * rather than guessed.
 * @param {string[]} jsTexts
 * @param {string} exportName
 */
export function findServerActionId(jsTexts, exportName) {
  const re = new RegExp(`[\`'"]([0-9a-f]{8,}#${exportName})[\`'"]`, 'g');
  const ids = new Set();
  for (const t of jsTexts) for (const m of t.matchAll(re)) ids.add(m[1]);
  assert.equal(
    ids.size,
    1,
    `expected exactly one client server-action id for ${exportName}, found ${ids.size}: ${[...ids].join(', ')}`,
  );
  return /** @type {string} */ ([...ids][0]);
}

/**
 * The upload action's RSC response: 200 flight payload, `success: true`, no error.
 * @param {{ status: number, headers: Record<string, any>, text: string }} res
 */
export function assertUploadAccepted(res) {
  assert.equal(res.status, 200, `upload action: HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  const ct = String(res.headers['content-type'] ?? '');
  assert.ok(
    ct.includes('text/x-component'),
    `upload action: content-type "${ct}" is not an RSC payload`,
  );
  assert.ok(
    /"success"\s*:\s*true/.test(res.text),
    `upload action did not return {success:true}: ${res.text.slice(0, 300)}`,
  );
  assert.ok(
    !/"error"\s*:/.test(res.text),
    `upload action returned an error: ${res.text.slice(0, 300)}`,
  );
  return `RSC ${res.text.length}B, success:true`;
}

/**
 * The uploaded file really landed: the database row points at the object, and
 * the object's bytes equal what was sent.
 * @param {{ dbRow: string, expectedPath: string, sent: Buffer, stored: Buffer }} obs
 */
export function assertUploadStored({ dbRow, expectedPath, sent, stored }) {
  assert.ok(
    dbRow.includes(expectedPath),
    `files row does not reference ${expectedPath} (row: "${dbRow}") — object storage write failed, metadata-only fallback`,
  );
  assert.ok(
    Buffer.compare(sent, stored) === 0,
    `stored object differs from the uploaded bytes (${stored.length}B vs ${sent.length}B)`,
  );
  return `row → ${expectedPath}; ${stored.length}B byte-identical`;
}

// ---------------------------------------------------------------------------
// HTTP-driving checks. They take a `request(path, opts)` function (the client
// from platform-e2e-http.mjs) and nothing else. The nightly points that client
// at the cluster; the self-test points it at broken fake servers. So the SAME
// code is what gets proved able to go red.
// ---------------------------------------------------------------------------

/**
 * @typedef {(path: string, opts?: { method?: string, headers?: Record<string,string>, body?: Buffer|string }) =>
 *   Promise<{ status: number, headers: Record<string, any>, body: Buffer, text: string, chunks: { at: number, text: string }[] }>} RequestFn
 */

/** The `public/` files the app ships (apps/file-manager/public + the app-router favicon). */
export const PUBLIC_FILES = Object.freeze([
  '/file.svg',
  '/globe.svg',
  '/next.svg',
  '/knext-smoke.png',
  '/favicon.ico',
]);

/**
 * KNOWN DEFECT #1284: the vinext build emits the font URL as an absolute path on
 * the BUILD machine (`/…/apps/file-manager/.vinext/fonts/<hash>/x.woff2`), which
 * 404s when served. This is NOT a skip. The reference must STILL be broken: the
 * check goes RED the moment it is served (fixed), forcing this exemption to be
 * deleted, and a ref that is neither broken nor fixed is still an ordinary
 * failure. Any other asset gets no exemption.
 */
export const KNOWN_DEFECT_FONT_PATH = /^\/.+\/\.vinext\/fonts\//;

/**
 * Every same-origin asset the served home page references, plus every
 * `url()` its stylesheets and inline `<style>` blocks reference (that is where
 * the next/font `.woff2` files are). Each one is checked with `assertAsset`,
 * then the set as a whole with `assertAssetCoverage`.
 * @param {RequestFn} request
 */
export async function checkStaticAssets(request) {
  const home = await request('/');
  assert.equal(home.status, 200, `GET / HTTP ${home.status}`);
  const refs = extractAssetRefs(home.text);
  const all = new Set(refs);
  /** @type {string[]} */
  const evidence = [];
  /** @type {string[]} */
  const pending = [...refs];
  /** @type {Map<string, string>} */
  const origin = new Map(refs.map((r) => [r, 'GET /']));
  const enqueue = (/** @type {string} */ u, /** @type {string} */ from) => {
    if (all.has(u)) return;
    all.add(u);
    origin.set(u, from);
    pending.push(u);
  };
  for (const m of home.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    for (const u of extractCssUrls(m[1], '/')) enqueue(u, 'inline <style> on /');
  }
  while (pending.length) {
    const p = /** @type {string} */ (pending.shift());
    const res = await request(p);
    if (KNOWN_DEFECT_FONT_PATH.test(p)) {
      assert.equal(
        res.status,
        404,
        `${p} now returns HTTP ${res.status}: known defect #1284 (build path leaked into the font URL) looks FIXED. Delete KNOWN_DEFECT_FONT_PATH from platform-e2e-checks.mjs so this asset is checked normally.`,
      );
      evidence.push(`${p}: KNOWN DEFECT #1284 still 404 (build path leaked into the font URL)`);
      continue;
    }
    try {
      evidence.push(`${p}: ${assertAsset(p, res)}`);
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : err} (referenced by ${origin.get(p) ?? 'unknown'})`,
      );
    }
    if (extensionOf(p) === '.css') for (const u of extractCssUrls(res.text, p)) enqueue(u, p);
  }
  return { summary: assertAssetCoverage([...all]), evidence };
}

/** @param {RequestFn} request @param {readonly string[]} [paths] */
export async function checkPublicFiles(request, paths = PUBLIC_FILES) {
  const out = [];
  for (const p of paths) out.push(`${p} ${assertAsset(p, await request(p))}`);
  return out.join('; ');
}

/** @param {RequestFn} request */
export async function checkStreaming(request) {
  return assertStreamed(await request('/knext-smoke/stream'));
}

/** @param {RequestFn} request */
export async function checkImageOptimization(request) {
  const src = '/knext-optimize-fixture.png';
  const source = await request(src);
  const optimized = await request(`/_next/image?url=${encodeURIComponent(src)}&w=128&q=75`, {
    headers: { accept: 'image/webp,image/*,*/*' },
  });
  return assertImageOptimized({ source, optimized });
}

/**
 * POST the invalidation endpoint without a token, with a wrong one, then with
 * the right one, and assert the auth verdict.
 * @param {RequestFn} request
 * @param {string} token
 * @param {string} tag
 * @param {() => Promise<void>} [betweenUnauthAndAuth] runs after the two refused calls
 */
export async function checkInvalidationEndpoint(request, token, tag, betweenUnauthAndAuth) {
  const post = (/** @type {Record<string,string>} */ headers) =>
    request('/api/cache/invalidate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ tag }),
    });
  const none = await post({});
  const wrong = await post({ authorization: `Bearer ${token}x` });
  if (betweenUnauthAndAuth) await betweenUnauthAndAuth();
  const right = await post({ authorization: `Bearer ${token}` });
  return assertInvalidationAuth({ none, wrong, right });
}
