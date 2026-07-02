/**
 * Deployed-platform Cache-Control normalization — a dependency-free CommonJS
 * preload (`node --require` / `bun -r`) for the Next.js standalone server.
 *
 * WHY (#175, compat A3-3 run 28578203671): Next's origin ALWAYS emits
 * shared-cache directives from `getCacheControlHeader`
 * (packages/next/src/server/lib/cache-control.ts) — `s-maxage=2,
 * stale-while-revalidate=31535998` for ISR, `s-maxage=31536000` for
 * revalidate:false, and the `private, no-cache, no-store, max-age=0,
 * must-revalidate` shell for a fallback:true first MISS. Those directives are
 * consumed by the DEPLOYMENT PLATFORM's cache layer; what a deployed client
 * sees is `public, max-age=0, must-revalidate` — and that is exactly what the
 * official deploy-mode compatibility suite asserts (test/e2e/prerender.test.ts
 * `isDeploy` branches).
 *
 * UPSTREAM EVIDENCE this is adapter-serving semantics (not a Vercel-CDN-only
 * artifact): the OFFICIAL reference adapter — nextjs/adapter-bun,
 * src/runtime/server.ts `normalizeCacheControlHeader` +
 * `patchCacheControlHeader` — implements these exact rules in its serving
 * layer. knext deliberately runs Next's own standalone server instead of
 * hand-rolling a runtime ("don't rewrite the runtime twice"), so the same
 * rules are applied as a per-response preload patch:
 *
 *   1. Only GET/HEAD responses are considered.
 *   2. `immutable` values (hashed static assets) pass through untouched.
 *   3. Any `s-maxage=` value → `public, max-age=0, must-revalidate`.
 *   4. The pages-router fallback-shell private value → `public, max-age=0,
 *      must-revalidate`, but ONLY when the response carries an
 *      `x-nextjs-cache` marker (i.e. it IS a prerender-pipeline response) and
 *      the request is not `/_next/data/` (data responses are never shells).
 *   5. Everything else passes through untouched.
 *
 * Fronting knext with your OWN shared cache/CDN that should honor s-maxage?
 * Disable with KNEXT_CACHE_CONTROL_NORMALIZE=0.
 */

'use strict';

const DEPLOY_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const FALLBACK_SHELL_PRIVATE = 'private, no-cache, no-store, max-age=0, must-revalidate';
const INSTALLED = Symbol.for('knext.cacheControlNormalize.installed');

/**
 * Pure normalization rule (mirrors nextjs/adapter-bun
 * normalizeCacheControlHeader).
 *
 * @param {unknown} value raw cache-control header value (string | string[])
 * @param {{ method?: string, url?: string, hasNextCacheMarker?: boolean }} ctx
 * @returns {string} the value to send to the client
 */
function normalizeCacheControl(value, ctx) {
  const { method, url, hasNextCacheMarker } = ctx || {};
  const raw = Array.isArray(value) ? value.join(', ') : String(value ?? '');

  if (method !== 'GET' && method !== 'HEAD') {
    return raw;
  }

  const normalized = raw.trim();
  if (normalized.length === 0) {
    return raw;
  }

  const lower = normalized.toLowerCase();
  const isDataRequest = typeof url === 'string' && url.includes('/_next/data/');

  if (hasNextCacheMarker === true && !isDataRequest && lower === FALLBACK_SHELL_PRIVATE) {
    // Pages-router fallback HTML shells flow through Next's private no-store
    // branch on the first MISS; deployed platforms expose them as public
    // must-revalidate responses instead.
    return DEPLOY_CACHE_CONTROL;
  }

  if (lower.includes('immutable')) {
    return normalized;
  }

  if (lower.includes('s-maxage=')) {
    return DEPLOY_CACHE_CONTROL;
  }

  return normalized;
}

function headerFrom(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

function ctxOf(res, explicitMarker) {
  const req = res.req; // node >= 15.7: ServerResponse#req
  const marker =
    explicitMarker !== undefined && explicitMarker !== null
      ? explicitMarker
      : res.getHeader && res.getHeader('x-nextjs-cache');
  return {
    method: req && req.method,
    url: req && req.url,
    hasNextCacheMarker: typeof marker === 'string' && marker.length > 0,
  };
}

/**
 * Patch http.ServerResponse.prototype so every cache-control write —
 * setHeader() or writeHead(status[, msg], headers) — is normalized per
 * request. Idempotent.
 */
function install() {
  // Deliberately lazy so requiring this module for the pure function does not
  // touch node:http.
  const { ServerResponse } = require('node:http');
  const proto = ServerResponse.prototype;
  if (proto[INSTALLED]) return;
  proto[INSTALLED] = true;

  const originalSetHeader = proto.setHeader;
  proto.setHeader = function setHeader(name, value) {
    if (typeof name === 'string' && name.toLowerCase() === 'cache-control') {
      return originalSetHeader.call(this, name, normalizeCacheControl(value, ctxOf(this)));
    }
    return originalSetHeader.call(this, name, value);
  };

  const originalWriteHead = proto.writeHead;
  proto.writeHead = function writeHead(statusCode, statusMessage, headers) {
    let msg = statusMessage;
    let hdrs = headers;
    if (hdrs === undefined && msg !== null && typeof msg === 'object') {
      hdrs = msg;
      msg = undefined;
    }
    if (hdrs !== null && typeof hdrs === 'object' && !Array.isArray(hdrs)) {
      // Pass the raw marker VALUE — writeHead may carry x-nextjs-cache in the
      // same headers object, before it is queryable via res.getHeader().
      const marker =
        headerFrom(hdrs, 'x-nextjs-cache') ?? (this.getHeader && this.getHeader('x-nextjs-cache'));
      for (const key of Object.keys(hdrs)) {
        if (key.toLowerCase() !== 'cache-control') continue;
        hdrs[key] = normalizeCacheControl(hdrs[key], ctxOf(this, marker));
      }
    }
    if (msg === undefined) {
      return originalWriteHead.call(this, statusCode, hdrs);
    }
    return originalWriteHead.call(this, statusCode, msg, hdrs);
  };
}

// Preload side effect: `node --require <this file>` installs the patch unless
// explicitly disabled (unit tests / bring-your-own-CDN deployments).
if (process.env.KNEXT_CACHE_CONTROL_NORMALIZE !== '0') {
  install();
}

module.exports = { normalizeCacheControl, install, DEPLOY_CACHE_CONTROL };
