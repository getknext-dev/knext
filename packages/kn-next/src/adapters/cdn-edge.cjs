/**
 * CDN cache tier at the response seam — cache-correct edge directives and cache
 * tags for a CDN the USER runs in front of the app (ADR-0068, D4/D5). A
 * dependency-free CommonJS module, loaded by `cache-control-normalize.cjs` (the
 * `node --require` / `bun -r` header preload) and bundled into it, so it ships in
 * every launch path that preload already ships in.
 *
 * INERT unless the operator rendered `KNEXT_CDN_PROVIDER` (from `spec.cdn`):
 * `loadCdnConfig` returns `null`, the preload installs none of this, and the
 * response headers are byte-identical to what they were before this module
 * existed (zero-diff, guarded by `cdn-zero-diff.test.ts`).
 *
 * ## What it does
 *
 * Per response, an allowlist (D4.1, conditions 1-11) decides whether the edge may
 * cache it. ONLY a response that passes EVERY condition gets an edge directive and
 * a `Cache-Tag`; anything not positively allowed is left exactly as the compat
 * normaliser leaves it, which no CDN caches. The browser-facing `Cache-Control`
 * keeps the compat-normalised value on rows that have an edge-only header.
 *
 * ## The tag seam (D5.1) — the interface the cache handler calls
 *
 * Next strips `x-next-cache-tags` from the response in non-minimal mode, so the
 * tags are NOT readable off the response. Instead this module opens a
 * request-scoped `AsyncLocalStorage` store when `http.Server` emits `'request'`,
 * and exposes a recorder on `globalThis` (ADR-0027: anchored under a namespaced
 * `Symbol.for` key, never a module-level binding, because Next duplicates modules
 * across webpack layers):
 *
 *     const seam = globalThis[Symbol.for('knext.core.cdn.requestTags')];
 *     seam?.record({ kind: 'page' | 'route' | 'fetch', tags: string[] });
 *
 * The cache handler calls it from `get` (hit) and `set` (render) with the entry's
 * resolved Next tags (the split `x-next-cache-tags`, including the implicit
 * `_N_T_<path>` tags). `kind` is `page` or `route` for the request's OWN entry and
 * `fetch` for a fetch-kind (data) entry. Only own-entry tags satisfy condition 8:
 * fetch tags alone are not enough, because on an ISR miss they can be recorded
 * before the first flush while the page entry's `set` (which carries the path
 * tag) lands after it. `record` returns `false` outside a request and is a no-op
 * when the seam is absent (CDN off), so wiring it costs a non-CDN app nothing.
 * HANDOFF (#2259): the call sites in `cache-handler.js` are owned by another team
 * this sprint; until they land, no tags are recorded and so NOTHING is
 * edge-cached (fail closed).
 *
 * ## Fail closed, everywhere
 *
 * No request state, no recorded own tags, tag overflow, a missing / corrupt /
 * unparseable routing artifact, a non-canonical request path, an unparseable
 * header shape: all mean "no edge directive", counted under a closed `reason`
 * set (`knext_cdn_edge_decision_total`).
 */

'use strict';

const crypto = require('node:crypto');
const nodePath = require('node:path');

const ROUTING_ARTIFACT_NAME = 'knext-cdn-routing.json';
const SEAM_KEY = Symbol.for('knext.core.cdn.requestTags');
const DECISIONS_KEY = Symbol.for('knext.core.cdn.edgeDecisions');
const STATE = Symbol.for('knext.core.cdn.requestState');
const ORIGIN_CC = Symbol.for('knext.core.cdn.originCacheControl');
const TAG_PREFIX_RE = /^[0-9a-f]{12}$/;
const NEXT_CONSTANT_BUILD_ID = 'build-TfctsWXpff2fKS';
const MAX_RECORDED_TAGS = 4096;
const DRAFT_COOKIES = ['__prerender_bypass', '__next_preview_data'];

/**
 * Provider rows (ADR-0068 D2). Data, not code branches: one row per CDN.
 *
 * - `edgeHeader`: the edge-only directive header, or `null` when the CDN reads the
 *   directive from `Cache-Control` itself (`s-maxage`).
 * - `tagHeader`: where tags go, or `null` when the CDN has no tag purge.
 * - `maxTags` / `maxTagBytes` (per tag) / `maxTotalBytes`: the provider's limits.
 * - `keysOnQuery`: whether the default cache key includes the query string; an
 *   `_rsc` URL may only be edge-cached where it does (D4.3).
 */
const PROVIDER_ROWS = Object.freeze({
  cloudflare: Object.freeze({
    edgeHeader: 'cloudflare-cdn-cache-control',
    tagHeader: 'cache-tag',
    maxTags: Infinity,
    maxTagBytes: Infinity,
    maxTotalBytes: 16384,
    keysOnQuery: true,
  }),
  'google-cloud-cdn': Object.freeze({
    edgeHeader: 'cdn-cache-control',
    tagHeader: 'cache-tag',
    maxTags: 50,
    maxTagBytes: 120,
    maxTotalBytes: 4096,
    keysOnQuery: true,
  }),
  cloudfront: Object.freeze({
    edgeHeader: null,
    tagHeader: 'cache-tag',
    maxTags: 50,
    maxTagBytes: Infinity,
    maxTotalBytes: Infinity,
    keysOnQuery: false,
  }),
  'azure-front-door': Object.freeze({
    edgeHeader: null,
    tagHeader: null,
    maxTags: Infinity,
    maxTagBytes: Infinity,
    maxTotalBytes: Infinity,
    keysOnQuery: false,
  }),
  emulator: Object.freeze({
    edgeHeader: 'cloudflare-cdn-cache-control',
    tagHeader: 'cache-tag',
    maxTags: Infinity,
    maxTagBytes: Infinity,
    maxTotalBytes: 16384,
    keysOnQuery: true,
  }),
});

// ---------------------------------------------------------------------------
// Config (the operator's KNEXT_CDN_* env)
// ---------------------------------------------------------------------------

function splitList(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('/'));
}

function intIn(value, min, max, fallback) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return fallback;
  const n = Number(value);
  return n >= min && n <= max ? n : fallback;
}

/**
 * Read the operator's `KNEXT_CDN_*` env. `null` means CDN mode is off: the
 * provider is unset, unknown, or the tag prefix is not the 12-hex value the
 * operator derives (a runtime must not honour a prefix the operator did not
 * derive — D3). Off is the zero-diff state.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} [warn]
 */
function loadCdnConfig(env, warn) {
  const provider = env.KNEXT_CDN_PROVIDER;
  if (provider === undefined || provider === '') return null;
  const row = PROVIDER_ROWS[provider];
  if (!row) {
    if (warn) warn(`CDN_EDGE: disabled — unknown KNEXT_CDN_PROVIDER ${JSON.stringify(provider)}`);
    return null;
  }
  const prefix = env.KNEXT_CDN_TAG_PREFIX;
  if (typeof prefix !== 'string' || !TAG_PREFIX_RE.test(prefix)) {
    if (warn) warn('CDN_EDGE: disabled — KNEXT_CDN_TAG_PREFIX is not the operator-derived 12 hex digits');
    return null;
  }
  return {
    provider,
    row,
    prefix,
    htmlTtlSeconds: intIn(env.KNEXT_CDN_HTML_TTL_SECONDS, 1, 3600, 30),
    swrSeconds: intIn(env.KNEXT_CDN_SWR_SECONDS, 0, 3600, 0),
    excludePaths: splitList(env.KNEXT_CDN_EXCLUDE_PATHS),
    includePaths: splitList(env.KNEXT_CDN_INCLUDE_PATHS),
  };
}

// ---------------------------------------------------------------------------
// Tags (D5.2)
// ---------------------------------------------------------------------------

function hex(input, n) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, n);
}

/**
 * Every emitted tag is ASCII, lowercase, comma-free and fixed-length:
 * app `kn-<p>`, build `kn-<p>-b<12 hex sha256(buildId)>`, and one
 * `kn-<p>-t<16 hex sha256(tag)>` per Next tag. The purge side applies the same
 * function to the tag `revalidateTag` receives, so the two cannot drift.
 *
 * @param {string} prefix the 12-hex app prefix
 * @param {string | undefined} buildId omitted from the set when `undefined`
 * @param {readonly string[]} nextTags
 */
function encodeTags(prefix, buildId, nextTags) {
  const out = [`kn-${prefix}`];
  if (buildId) out.push(`kn-${prefix}-b${hex(buildId, 12)}`);
  const seen = new Set();
  for (const tag of nextTags) {
    const t = `kn-${prefix}-t${hex(tag, 16)}`;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Whether an encoded tag set fits the row's count and byte limits (D5.4). */
function tagsFit(row, tags) {
  if (tags.length > row.maxTags) return false;
  let total = Math.max(0, tags.length - 1); // commas
  for (const t of tags) {
    if (t.length > row.maxTagBytes) return false;
    total += t.length;
  }
  return total <= row.maxTotalBytes;
}

// ---------------------------------------------------------------------------
// Paths (D4.1 conditions 7, 10, 11)
// ---------------------------------------------------------------------------

/** The wire request-target cut at the first `?` — never a parsed value. */
function rawPathOf(target) {
  if (typeof target !== 'string') return undefined;
  const q = target.indexOf('?');
  return q === -1 ? target : target.slice(0, q);
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function whatwgPath(raw) {
  try {
    return new URL('http://n' + raw).pathname;
  } catch {
    return null;
  }
}

function isUnreservedCode(c) {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x2d ||
    c === 0x5f ||
    c === 0x7e
  );
}

/**
 * Condition 11: the request's RAW pathname is canonical, so that a normalisation
 * Next performs has nothing left to change. Returns `true` only when ALL hold:
 * it starts with `/`; equals its own WHATWG-normalised form (no `/./`, `/../`,
 * `\`); contains no `//`; no percent-encoded `.` `/` `\` `%`; no percent-encoded
 * unreserved character; decodes without error and the decoded form has no `.` or
 * `..` segment. Percent-encoded non-ASCII (`/blog/caf%C3%A9`) stays canonical.
 *
 * @param {unknown} raw the wire request-target cut at the first `?`
 */
function isCanonicalRawPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.charCodeAt(0) !== 0x2f) return false;
  if (raw.includes('\\') || raw.includes('//')) return false;
  const encoded = raw.match(/%[0-9A-Za-z]{2}|%/g) || [];
  for (const e of encoded) {
    if (e.length !== 3 || !/^%[0-9A-Fa-f]{2}$/.test(e)) return false;
    const code = parseInt(e.slice(1), 16);
    if (code === 0x2e || code === 0x2f || code === 0x5c || code === 0x25) return false;
    if (isUnreservedCode(code)) return false;
  }
  const decoded = safeDecode(raw);
  if (decoded === null) return false;
  for (const seg of decoded.split('/')) if (seg === '.' || seg === '..') return false;
  return whatwgPath(raw) === raw;
}

/**
 * Prefix match at a SEGMENT boundary: `/blog` covers `/blog` and `/blog/x`, never
 * `/blogger`. `/` covers everything.
 */
function underPrefix(pathname, prefix, caseInsensitive) {
  let p = prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  let path = pathname;
  if (caseInsensitive) {
    p = p.toLowerCase();
    path = path.toLowerCase();
  }
  if (p === '/') return path.startsWith('/');
  return path === p || path.startsWith(p + '/');
}

// ---------------------------------------------------------------------------
// Routing artifact (condition 10) — written by the adapter's onBuildComplete
// ---------------------------------------------------------------------------

/**
 * Parse `knext-cdn-routing.json`. Strict: anything unexpected, or a `sourceRegex`
 * that does not compile, is `{ ok: false }` — and then NOTHING non-immutable is
 * edge-cached (fail closed).
 *
 * Shape: `{ version: 1, basePath: string, i18n: null | { locales: string[] },
 * middleware: "none" | Array<{ source?, sourceRegex? }> }`.
 *
 * @param {string} text
 */
function parseRoutingArtifact(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== 1) {
    return { ok: false, reason: 'unknown_shape' };
  }
  const basePath = doc.basePath;
  if (typeof basePath !== 'string' || (basePath !== '' && !basePath.startsWith('/'))) {
    return { ok: false, reason: 'bad_base_path' };
  }
  const i18n = doc.i18n;
  if (i18n !== null && (typeof i18n !== 'object' || Array.isArray(i18n) || !Array.isArray(i18n.locales))) {
    return { ok: false, reason: 'bad_i18n' };
  }
  // Request-dependent routing rules (rewrites / redirects / headers with a `has`
  // or `missing` condition) are matched exactly like middleware (Amendment 1).
  // The field is REQUIRED: an artifact from a writer that did not know about
  // them cannot say there are none, so it is rejected (fail closed).
  const conditional = doc.conditional;
  const matchers = [];
  let matchAll = false;
  let hasRules = false;
  if (conditional === 'unknown') {
    matchAll = true; // the build supplied no routing output: assume the worst
    hasRules = true;
  } else if (Array.isArray(conditional)) {
    for (const rule of conditional) {
      if (rule === null || typeof rule !== 'object') return { ok: false, reason: 'bad_conditional' };
      hasRules = true;
      if (typeof rule.sourceRegex !== 'string') {
        matchAll = true; // a rule we cannot test is treated as matching everything
        continue;
      }
      try {
        matchers.push(new RegExp(rule.sourceRegex, 'i'));
      } catch {
        return { ok: false, reason: 'bad_regex' };
      }
    }
  } else {
    return { ok: false, reason: 'bad_conditional' };
  }
  const mw = doc.middleware;
  if (mw === 'none') {
    return { ok: true, basePath, i18n, none: !hasRules, matchers, matchAll };
  }
  if (!Array.isArray(mw)) return { ok: false, reason: 'bad_middleware' };
  if (mw.length === 0) matchAll = true; // middleware present with no matchers = every path
  for (const m of mw) {
    if (m === null || typeof m !== 'object') return { ok: false, reason: 'bad_matcher' };
    if (typeof m.sourceRegex !== 'string') {
      matchAll = true; // a matcher we cannot test is treated as matching everything
      continue;
    }
    try {
      matchers.push(new RegExp(m.sourceRegex, 'i'));
    } catch {
      return { ok: false, reason: 'bad_regex' };
    }
  }
  return { ok: true, basePath, i18n, none: false, matchers, matchAll };
}

/** Candidate pathnames Next might test a middleware matcher against. */
function middlewareCandidates(raw, basePath) {
  const set = new Set();
  const add = (p) => {
    if (typeof p === 'string') set.add(p);
  };
  const decoded = safeDecode(raw);
  if (decoded === null) return null;
  const norm = whatwgPath(raw);
  if (norm === null) return null;
  const normDecoded = safeDecode(norm);
  if (normDecoded === null) return null;
  for (const p of [raw, decoded, norm, normDecoded]) add(p);
  if (basePath) {
    for (const p of [...set]) {
      if (p === basePath) add('/');
      else if (p.startsWith(basePath + '/')) add(p.slice(basePath.length));
    }
  }
  for (const p of [...set]) {
    const m = /^\/_next\/data\/[^/]+\/(.*)\.json$/.exec(p);
    if (m) {
      let page = '/' + m[1];
      if (page === '/index') page = '/';
      else if (page.endsWith('/index')) page = page.slice(0, -'/index'.length);
      add(page);
    }
  }
  for (const p of [...set]) {
    if (p.length > 1 && p.endsWith('/')) add(p.slice(0, -1));
    else if (p.length > 1) add(p + '/');
  }
  return [...set];
}

/**
 * Condition 10: is the path matched by the app's middleware/proxy matcher? Matching
 * OVER-matches on purpose (case-insensitive, `has`/`missing` ignored, the raw +
 * decoded + WHATWG-normalised + data-route candidates, i18n with any matcher =
 * every path), so Next's middleware having run implies this returns `true`.
 *
 * @param {{ none: boolean, matchers: RegExp[], matchAll: boolean, basePath: string, i18n: unknown }} artifact
 * @param {string} raw the (canonical) raw pathname
 */
function middlewareMatches(artifact, raw) {
  if (artifact.none) return false;
  if (artifact.matchAll || artifact.i18n) return true;
  const candidates = middlewareCandidates(raw, artifact.basePath);
  if (candidates === null) return true; // decoding failed: counts as matched
  for (const c of candidates) for (const re of artifact.matchers) if (re.test(c)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The allowlist (D4.1)
// ---------------------------------------------------------------------------

function ccTokens(value) {
  const raw = Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value);
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function sMaxAgeOf(tokens) {
  for (const t of tokens) {
    const m = /^s-maxage\s*=\s*"?(\d+)"?$/.exec(t);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * The paths an exclusion is tested against: the decoded path, and the same with
 * the basePath stripped, and with the locale prefix stripped too (segment-bounded;
 * the locale only when the app has i18n).
 */
function fenceCandidates(decoded, artifact) {
  const out = [decoded];
  if (!artifact) return out;
  const bases = [decoded];
  const bp = artifact.basePath;
  if (bp) {
    if (decoded === bp) out.push('/'), bases.push('/');
    else if (decoded.startsWith(bp + '/')) {
      const rest = decoded.slice(bp.length);
      out.push(rest);
      bases.push(rest);
    }
  }
  const locales = artifact.i18n && Array.isArray(artifact.i18n.locales) ? artifact.i18n.locales : [];
  if (locales.length > 0) {
    const lower = locales.map((l) => String(l).toLowerCase());
    for (const b of bases) {
      const seg = /^\/([^/]+)(\/.*)?$/.exec(b);
      if (seg && lower.includes(seg[1].toLowerCase())) out.push(seg[2] || '/');
    }
  }
  return [...new Set(out)];
}

/**
 * Decide whether a response may be edge-cached. PURE: every input is passed in.
 *
 * @param {{
 *   cfg: NonNullable<ReturnType<typeof loadCdnConfig>>,
 *   artifact: ReturnType<typeof parseRoutingArtifact> | null,
 *   method: string | undefined,
 *   status: number,
 *   originCacheControl: unknown,
 *   hasSetCookie: boolean,
 *   hasAuthorization: boolean,
 *   hasDraftCookie: boolean,
 *   rawTarget: string | undefined,
 *   rsc: { header: boolean, router: boolean, param: boolean },
 *   contentType: string | undefined,
 *   ownTags: readonly string[],
 *   fetchTags: readonly string[],
 *   buildId: string | undefined,
 * }} i
 * @returns {{ edge: false, result: 'skipped' | 'immutable', reason: string }
 *   | { edge: true, edgeMaxAge: number, swr: number, tags: string[] }}
 */
function decideEdge(i) {
  const { cfg } = i;
  const skip = (reason) => ({ edge: false, result: 'skipped', reason });
  if (i.method !== 'GET' && i.method !== 'HEAD') return skip('method');
  if (i.status !== 200) return skip('status');
  const tokens = ccTokens(i.originCacheControl);
  const immutable = tokens.includes('immutable');
  if (immutable) {
    // Hashed build assets keep Next's own `public, max-age=…, immutable`; never
    // tagged, never purged, nothing added.
    return { edge: false, result: 'immutable', reason: 'immutable' };
  }
  const sMaxAge = sMaxAgeOf(tokens);
  if (sMaxAge === undefined) return skip('no_shared_directive');
  for (const t of tokens) {
    const name = t.split('=')[0];
    if (name === 'private' || name === 'no-store' || name === 'no-cache') return skip('private_or_no_store');
  }
  if (i.hasSetCookie) return skip('set_cookie');
  if (i.hasAuthorization || i.hasDraftCookie) return skip('auth_or_draft');

  // Condition 11 (and the basis for 7 and 10): a canonical raw path only.
  const raw = rawPathOf(i.rawTarget);
  if (raw === undefined || !isCanonicalRawPath(raw)) return skip('non_canonical_path');

  // Condition 7: /api/cache/ and excludePaths, against the decoded pathname. They
  // are written against the app's own routes, but the wire path also carries the
  // basePath and, with i18n, a locale prefix, so each is tested against the path
  // with those stripped as well as against the raw path.
  const decoded = safeDecode(raw);
  if (decoded === null) return skip('excluded_path');
  const fenced = fenceCandidates(decoded, i.artifact && i.artifact.ok ? i.artifact : null);
  if (fenced.some((c) => underPrefix(c, '/api/cache', true))) return skip('excluded_path');
  for (const p of cfg.excludePaths) {
    if (fenced.some((c) => underPrefix(c, p, true))) return skip('excluded_path');
  }

  // Condition 10: middleware-matched paths only through includePaths.
  if (!i.artifact || !i.artifact.ok) return skip('routing_artifact_missing');
  let included = false;
  for (const p of cfg.includePaths) if (underPrefix(decoded, p, false)) included = true;
  if (!included && middlewareMatches(i.artifact, raw)) return skip('middleware_matched');

  // Condition 9: the RSC rule (D4.3), both directions and the content type.
  const rscRequest = i.rsc.header || i.rsc.router;
  if (rscRequest && !i.rsc.param) return skip('rsc_without_rsc_param');
  if (i.rsc.param && !i.rsc.header) return skip('rsc_param_without_rsc_header');
  const isFlight = typeof i.contentType === 'string' && i.contentType.toLowerCase().startsWith('text/x-component');
  if (i.rsc.param) {
    if (!isFlight) return skip('rsc_content_type_mismatch');
    if (!cfg.row.keysOnQuery) return skip('rsc_not_query_keyed');
  } else if (isFlight) {
    return skip('rsc_content_type_mismatch');
  }

  // An unresolved build id means no build tag: a tag set a build-scoped purge
  // cannot reach. Not edge-cacheable.
  if (!i.buildId) return skip('build_id_unresolved');

  // Condition 8: the request's OWN page/route entry tags, incl. `_N_T_`.
  if (!i.ownTags.some((t) => typeof t === 'string' && t.startsWith('_N_T_'))) return skip('tags_missing');
  const nextTags = [...i.ownTags, ...i.fetchTags];
  const tags = encodeTags(cfg.prefix, i.buildId, nextTags);
  if (!tagsFit(cfg.row, tags)) return skip('tag_overflow');

  // D4.2: edge max-age = min(Next's s-maxage, htmlTTLSeconds).
  const edgeMaxAge = Math.min(sMaxAge, cfg.htmlTtlSeconds);
  if (!(edgeMaxAge > 0)) return skip('zero_ttl');
  return { edge: true, edgeMaxAge, swr: cfg.swrSeconds, tags };
}

/** The headers an `edge: true` decision adds, as `[name, value]` pairs. */
function edgeHeaders(cfg, decision) {
  const swr = decision.swr > 0 ? `, stale-while-revalidate=${decision.swr}` : '';
  const out = [];
  if (cfg.row.edgeHeader) {
    out.push([cfg.row.edgeHeader, `max-age=${decision.edgeMaxAge}${swr}`]);
  } else {
    // No edge-only header: the directive rides in Cache-Control itself. A
    // deliberate deviation from the compat value, only on these opt-in rows;
    // `must-revalidate` is dropped because it would disable SWR at the cache.
    out.push(['cache-control', `public, max-age=0, s-maxage=${decision.edgeMaxAge}${swr}`]);
  }
  if (cfg.row.tagHeader) out.push([cfg.row.tagHeader, decision.tags.join(',')]);
  return out;
}

// ---------------------------------------------------------------------------
// Decision counters (knext_cdn_edge_decision_total{result,reason})
// ---------------------------------------------------------------------------

function counters() {
  if (!globalThis[DECISIONS_KEY]) globalThis[DECISIONS_KEY] = new Map();
  return globalThis[DECISIONS_KEY];
}

function countDecision(result, reason) {
  const key = `${result}\u0000${reason}`;
  const m = counters();
  m.set(key, (m.get(key) || 0) + 1);
}

/** Snapshot: `[{ result, reason, count }]`. */
function edgeDecisionSnapshot() {
  return [...counters().entries()].map(([k, count]) => {
    const [result, reason] = k.split('\u0000');
    return { result, reason, count };
  });
}

/** Prometheus text exposition for `knext_cdn_edge_decision_total`. */
function renderEdgeDecisionMetrics() {
  const lines = [
    '# HELP knext_cdn_edge_decision_total Responses by CDN edge-cache decision and the reason.',
    '# TYPE knext_cdn_edge_decision_total counter',
  ];
  for (const { result, reason, count } of edgeDecisionSnapshot()) {
    lines.push(`knext_cdn_edge_decision_total{result="${result}",reason="${reason}"} ${count}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Request state + the tag seam (D5.1)
// ---------------------------------------------------------------------------

function headerOf(headers, name) {
  if (!headers) return undefined;
  const v = headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

function hasDraftCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string') return false;
  return cookieHeader.split(';').some((part) => {
    const name = part.split('=')[0].trim();
    return DRAFT_COOKIES.includes(name);
  });
}

function rscInfo(headers, rawTarget) {
  let header = false;
  let router = false;
  for (const key of Object.keys(headers || {})) {
    const k = key.toLowerCase();
    if (k === 'rsc') header = true;
    else if (k.startsWith('next-router-') || k === 'next-url') router = true;
  }
  const q = typeof rawTarget === 'string' ? rawTarget.indexOf('?') : -1;
  let param = false;
  if (q !== -1) {
    for (const pair of rawTarget.slice(q + 1).split('&')) {
      if (pair === '_rsc' || pair.startsWith('_rsc=')) param = true;
    }
  }
  // `RSC: 1` specifically is what makes a request a flight request.
  const rscOne = String(headerOf(headers, 'rsc') || '') === '1';
  return { header: rscOne, router: router || (header && !rscOne), param };
}

/**
 * Snapshot the request AS IT ARRIVED, at `'request'` emit time. Next mutates
 * `req.url` (basePath strip, data-route rewrites) and headers while routing, so a
 * decision made at `writeHead` time must not read the live request.
 */
function captureRequest(req) {
  const h = req.headers || {};
  return {
    rawTarget: req.url,
    method: req.method,
    hasAuthorization: h.authorization !== undefined,
    hasDraftCookie: hasDraftCookie(headerOf(h, 'cookie')),
    rsc: rscInfo(h, req.url),
    own: [],
    fetch: [],
  };
}

/**
 * The seam the cache handler records tags through. `als` is created lazily so
 * requiring this module for its pure functions never touches
 * `node:async_hooks`.
 */
function ensureSeam() {
  if (globalThis[SEAM_KEY]) return globalThis[SEAM_KEY];
  const { AsyncLocalStorage } = require('node:async_hooks');
  const als = new AsyncLocalStorage();
  const seam = {
    als,
    /**
     * @param {{ kind: 'page' | 'route' | 'fetch', tags: readonly string[] }} rec
     * @returns {boolean} whether a request store was active
     */
    record(rec) {
      const s = als.getStore();
      if (!s || !rec || !Array.isArray(rec.tags)) return false;
      const bucket = rec.kind === 'page' || rec.kind === 'route' ? s.own : rec.kind === 'fetch' ? s.fetch : null;
      if (!bucket) return false;
      for (const t of rec.tags) {
        if (typeof t === 'string' && bucket.length < MAX_RECORDED_TAGS) bucket.push(t);
      }
      return true;
    },
  };
  globalThis[SEAM_KEY] = seam;
  return seam;
}

// ---------------------------------------------------------------------------
// Build id + routing artifact discovery (runtime)
// ---------------------------------------------------------------------------

/**
 * Directories that may hold `.next/knext-cdn-routing.json`, most specific first:
 *
 * - beside the entry script (`server.js` run with `--require`; in a compiled
 *   self-contained executable the entry lives in the EMBEDDED filesystem, so this
 *   is `$bunfs/root/<app>/.next` and the file is read from the binary itself);
 * - the embed root the self-contained entry publishes;
 * - the standalone directory a disk-mode compiled executable serves
 *   (`KNEXT_STANDALONE_DIR`, else the directory the executable sits in);
 * - the working directory (the standalone server chdirs to its own directory).
 */
function defaultDistDirs() {
  const dirs = [];
  const argv1 = process.argv && process.argv[1];
  if (typeof argv1 === 'string' && argv1) dirs.push(nodePath.join(nodePath.dirname(argv1), '.next'));
  if (typeof globalThis.__knextEmbedRoot === 'string') dirs.push(nodePath.join(globalThis.__knextEmbedRoot, '.next'));
  const standalone = process.env.KNEXT_STANDALONE_DIR;
  if (typeof standalone === 'string' && standalone) dirs.push(nodePath.join(standalone, '.next'));
  if (process.execPath) dirs.push(nodePath.join(nodePath.dirname(process.execPath), '.next'));
  dirs.push(nodePath.join(process.cwd(), '.next'));
  return [...new Set(dirs)];
}

function readFirst(fs, dirs, names) {
  for (const dir of dirs) {
    for (const name of names) {
      try {
        return { text: fs.readFileSync(nodePath.join(dir, name), 'utf8'), dir };
      } catch {
        // try the next candidate
      }
    }
  }
  return null;
}

/**
 * The CDN controller: config + lazily loaded routing artifact + build id.
 *
 * @param {{ env: Record<string, string | undefined>, fs?: any, distDirs?: () => string[], log?: (l: string) => void, warn?: (l: string) => void, now?: () => number }} opts
 */
function createController(opts) {
  const warn = opts.warn || (() => {});
  const log = opts.log || (() => {});
  const cfg = loadCdnConfig(opts.env, warn);
  if (!cfg) return null;
  const fs = opts.fs || require('node:fs');
  const distDirs = opts.distDirs || defaultDistDirs;
  const now = opts.now || Date.now;

  let artifact = null;
  let artifactDir = null;
  let lastFailure = -Infinity;
  let logged = false;
  function ensureArtifact() {
    if (artifact && artifact.ok) return artifact;
    if (now() - lastFailure < 5000) return artifact;
    const found = readFirst(fs, distDirs(), [ROUTING_ARTIFACT_NAME]);
    if (!found) {
      artifact = { ok: false, reason: 'missing' };
      lastFailure = now();
    } else {
      artifact = parseRoutingArtifact(found.text);
      artifactDir = found.dir;
      if (!artifact.ok) lastFailure = now();
    }
    if (!logged || (artifact.ok && logged !== 'ok')) {
      logged = artifact.ok ? 'ok' : 'fail';
      if (artifact.ok) {
        log(`CDN_EDGE: provider=${cfg.provider} routing artifact loaded (${artifactDir})`);
      } else {
        warn(
          `CDN_EDGE: routing artifact ${artifact.reason} — NOTHING but immutable assets will be edge-cached ` +
            `(reason=routing_artifact_missing); searched ${JSON.stringify(distDirs())}`,
        );
      }
    }
    return artifact;
  }

  let buildIdCache;
  let buildIdFailedAt = -Infinity;
  function buildId() {
    if (buildIdCache) return buildIdCache;
    // Resolved once; an unresolved id is retried (the embedded filesystem or the
    // staged tree may not have been readable at the very first request).
    if (now() - buildIdFailedAt < 5000) return undefined;
    let id;
    const dirs = artifactDir ? [artifactDir] : distDirs();
    const found = readFirst(fs, dirs, ['BUILD_ID', 'BUILD_ID.']);
    if (found) id = found.text.trim() || undefined;
    if (id === NEXT_CONSTANT_BUILD_ID) id = undefined;
    if (!id) {
      for (const name of ['KNEXT_BUILD_ID', 'NEXT_DEPLOYMENT_ID']) {
        const v = (opts.env[name] || '').trim();
        if (v && v !== NEXT_CONSTANT_BUILD_ID) {
          id = v;
          break;
        }
      }
    }
    if (id) buildIdCache = id;
    else buildIdFailedAt = now();
    return id;
  }

  return {
    cfg,
    ensureArtifact,
    /** Decide for a response; counts the decision. */
    decide(state, res, status, headersObj) {
      const get = (name) => {
        if (headersObj) {
          for (const k of Object.keys(headersObj)) if (k.toLowerCase() === name) return headersObj[k];
        }
        return res.getHeader ? res.getHeader(name) : undefined;
      };
      const artifact = ensureArtifact();
      const decision = decideEdge({
        cfg,
        artifact,
        method: state.method,
        status,
        originCacheControl: res[ORIGIN_CC],
        hasSetCookie: get('set-cookie') !== undefined,
        hasAuthorization: state.hasAuthorization,
        hasDraftCookie: state.hasDraftCookie,
        rawTarget: state.rawTarget,
        rsc: state.rsc,
        contentType: String(get('content-type') || ''),
        ownTags: state.own,
        fetchTags: state.fetch,
        buildId: buildId(),
      });
      if (decision.edge) countDecision('edge', 'allowed');
      else countDecision(decision.result, decision.reason);
      return decision;
    },
  };
}

module.exports = {
  ROUTING_ARTIFACT_NAME,
  SEAM_KEY,
  DECISIONS_KEY,
  STATE,
  ORIGIN_CC,
  PROVIDER_ROWS,
  loadCdnConfig,
  encodeTags,
  tagsFit,
  rawPathOf,
  isCanonicalRawPath,
  underPrefix,
  parseRoutingArtifact,
  middlewareMatches,
  decideEdge,
  edgeHeaders,
  edgeDecisionSnapshot,
  renderEdgeDecisionMetrics,
  captureRequest,
  ensureSeam,
  createController,
  countDecision,
};
