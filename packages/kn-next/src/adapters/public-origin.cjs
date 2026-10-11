/**
 * Allowlisted public origin for redirects — a dependency-free CommonJS preload
 * (`node --require` / `bun -r`, and compiled into the standalone single
 * executable) for the Next.js standalone server.
 *
 * WHY: Next's standalone server builds `request.url` from its BIND address
 * (next/dist/server/next-server.js `attachRequestMeta`,
 * lib/router-utils/resolve-routes.js), never from the request's `Host`. In a
 * pod the server binds the wildcard — `server.js` uses `HOSTNAME || '0.0.0.0'`
 * and the supervisor sanitizes HOSTNAME to empty — so a route handler's
 * `NextResponse.redirect(new URL('/x', request.url))` answers
 * `Location: http://0.0.0.0:PORT/x`. A browser that follows it lands on an
 * unroutable origin and drops every host-only cookie (the Draft Mode bypass
 * cookie among them).
 *
 * WHAT: a `Location` header whose origin is a wildcard bind address
 * (`0.0.0.0` or `[::]`, any port) is rewritten to a public origin built ONLY
 * from the operator-supplied allowlist `KNEXT_PUBLIC_ORIGINS`:
 *   - host:   the request's `X-Forwarded-Host`, then its `Host`, but only when
 *             the value matches an allowlist entry exactly (case-insensitive,
 *             port included); otherwise the FIRST allowlist entry;
 *   - scheme: `X-Forwarded-Proto` when it is exactly `http` or `https`;
 *             otherwise `https`.
 * No header value outside the allowlist can reach the Location: a header is
 * only ever used as a KEY into the allowlist, and the emitted host is the
 * allowlist's own spelling. Every other Location (a real host, a relative
 * path) passes through untouched, and path/query/fragment are kept verbatim.
 *
 * WHY ONLY `Location` (not `request.url`): Next computes the request origin in
 * more than one place — the router's `initURL` and, separately, the URL handed
 * to middleware (from the server's `fetchHostname`). Rewriting one of them
 * would make the two disagree, and Next treats a middleware rewrite whose
 * origin differs from `initURL` as an EXTERNAL proxy. The response header is
 * the one place a single, narrow rewrite fixes the user-visible bug.
 *
 * WHERE: on `http.ServerResponse.prototype` — `setHeader`, `appendHeader` and
 * `writeHead` (object and array forms) — the same hook points as
 * `cache-control-normalize.cjs`, so it covers every server the process creates
 * on both Node and Bun's `node:http`, with Next's own server unmodified. The
 * three request headers the rule reads are snapshotted when the request
 * ARRIVES (`http.Server.prototype.emit('request')`, the hook
 * `request-body-cap.cjs` uses), because Next defaults `x-forwarded-host` and
 * `x-forwarded-proto` on the live request before the handler runs.
 *
 * CONFIG: `KNEXT_PUBLIC_ORIGINS` — comma-separated `host[:port]` entries; an
 * `http://` / `https://` prefix and a trailing `/` are accepted and stripped
 * (the scheme still comes from the rule above). Anything else in an entry
 * (path, userinfo, wildcard, a wildcard bind address) drops that entry with a
 * warning. UNSET or empty → nothing is installed and behaviour is unchanged.
 * The effective allowlist is announced once at boot on stdout:
 * `PUBLIC_ORIGINS:<host,host,…> (env)`.
 */

'use strict';

const PUBLIC_ORIGINS_ENV = 'KNEXT_PUBLIC_ORIGINS';
const INSTALLED = Symbol.for('knext.publicOrigin.installed');

/**
 * An absolute URL whose origin is a wildcard bind address, with an optional
 * port, ending where the authority ends. Anchored, so `0.0.0.0.evil.com` and
 * `user@0.0.0.0` never match.
 */
const ORIGIN_HOST = /^https?:\/\/(\[[^\]/?#]*\]|[^/?#:@[\]]+)(?::\d+)?(?=[/?#]|$)/i;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_ENTRY = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])(?::(\\d{1,5}))?$`);

/**
 * Wildcard bind addresses in the form `new URL(...).hostname` yields, so every
 * spelling (`[::0]`, `[0:0:0:0:0:0:0:0]`, `0`, `0x0`, `[::ffff:0.0.0.0]`)
 * collapses onto one of these.
 */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '[::]', '[::ffff:0:0]']);

/** The URL-canonical hostname of a bare host (no scheme, no port); undefined if unparseable. */
function canonicalHostname(host) {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

function isWildcardHost(host) {
  const canonical = canonicalHostname(host);
  return canonical !== undefined && WILDCARD_HOSTS.has(canonical);
}

/** Length of the wildcard-bind origin at the start of `value`, or 0. */
function wildcardOriginLength(value) {
  const m = ORIGIN_HOST.exec(value);
  return m && isWildcardHost(m[1]) ? m[0].length : 0;
}

const VARY_TOKENS = ['X-Forwarded-Host', 'Host', 'X-Forwarded-Proto'];

/**
 * Merge the headers the rewrite depends on into a Vary value, keeping what was
 * there. Returns the existing value unchanged if it already covers them.
 *
 * @param {unknown} existing string | string[] | number | undefined
 */
function mergeVary(existing) {
  const current = (Array.isArray(existing) ? existing : [existing])
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .join(', ');
  const present = current.split(',').map((t) => t.trim().toLowerCase());
  if (present.includes('*')) return current;
  const missing = VARY_TOKENS.filter((t) => !present.includes(t.toLowerCase()));
  if (missing.length === 0) return current;
  return current === '' ? missing.join(', ') : `${current}, ${missing.join(', ')}`;
}

/**
 * Parse the allowlist. Pure.
 *
 * @param {string | undefined} raw
 * @returns {{ hosts: string[], invalid: string[] }}
 */
function parsePublicOrigins(raw) {
  const hosts = [];
  const invalid = [];
  if (raw === undefined || raw === null) return { hosts, invalid };
  for (const part of String(raw).split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const host = entry
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');
    const m = HOST_ENTRY.exec(host);
    const port = m && m[1] !== undefined ? Number(m[1]) : undefined;
    const bare = m ? host.replace(/:\d+$/, '') : host;
    if (!m || (port !== undefined && (port < 1 || port > 65535)) || isWildcardHost(bare)) {
      invalid.push(entry);
      continue;
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { hosts, invalid };
}

/** First value of a (possibly repeated, possibly comma-joined) header, lower-cased. */
function firstToken(value) {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string') return undefined;
  const token = v.split(',')[0].trim().toLowerCase();
  return token === '' ? undefined : token;
}

function headerOf(headers, name) {
  return headers && typeof headers === 'object' ? headers[name] : undefined;
}

/**
 * The public origin for one request. Header values are only ever used as keys
 * into `hosts`; what is returned is always an allowlist entry.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string[]} hosts non-empty allowlist
 */
function resolvePublicOrigin(headers, hosts) {
  let host = hosts[0];
  for (const candidate of [
    firstToken(headerOf(headers, 'x-forwarded-host')),
    firstToken(headerOf(headers, 'host')),
  ]) {
    if (candidate !== undefined && hosts.includes(candidate)) {
      host = candidate;
      break;
    }
  }
  const protoRaw = headerOf(headers, 'x-forwarded-proto');
  const proto = typeof protoRaw === 'string' ? protoRaw.trim().toLowerCase() : undefined;
  const scheme = proto === 'http' || proto === 'https' ? proto : 'https';
  return `${scheme}://${host}`;
}

/**
 * Rewrite one Location value. Pure; returns the input unchanged unless it is an
 * absolute URL on a wildcard bind origin and the allowlist is non-empty.
 *
 * @param {unknown} value string or string[] (as `setHeader` accepts)
 * @param {Record<string, string | string[] | undefined>} headers request headers
 * @param {string[]} hosts the allowlist
 */
function rewriteLocation(value, headers, hosts) {
  if (!hosts || hosts.length === 0) return value;
  if (Array.isArray(value)) return value.map((v) => rewriteLocation(v, headers, hosts));
  if (typeof value !== 'string') return value;
  const len = wildcardOriginLength(value);
  if (len === 0) return value;
  return resolvePublicOrigin(headers, hosts) + value.slice(len);
}

const ARRIVAL = Symbol.for('knext.publicOrigin.arrivalHeaders');

/**
 * Snapshot the three headers the rule reads, AS THEY ARRIVED. Next defaults
 * them on the live request before any handler runs (base-server.js:
 * `x-forwarded-host ??= host`, `x-forwarded-proto ??= <socket TLS ? https :
 * http>`), so reading them at response time would see Next's synthesized
 * `http` instead of "no proxy said anything" — and the https default would
 * never apply.
 */
function snapshotArrival(req) {
  if (!req || req[ARRIVAL]) return;
  const h = req.headers || {};
  req[ARRIVAL] = {
    'x-forwarded-host': h['x-forwarded-host'],
    host: h.host,
    'x-forwarded-proto': h['x-forwarded-proto'],
  };
}

/**
 * The request headers a response answers: the arrival snapshot when the
 * request came through an http.Server this preload saw, else the live headers
 * (ServerResponse#req, Node ≥15.7 and Bun).
 */
function requestHeadersOf(res) {
  const req = res && res.req;
  if (!req) return {};
  return req[ARRIVAL] || req.headers || {};
}

/**
 * Map the value of every `name` entry in a writeHead headers argument through
 * `fn`, copying on change. Handles the object, [[k, v], ...] and flat
 * [k, v, k, v] shapes.
 */
function mapHeadHeaders(hdrs, name, fn) {
  const is = (k) => typeof k === 'string' && k.toLowerCase() === name;
  if (Array.isArray(hdrs)) {
    if (hdrs.length > 0 && Array.isArray(hdrs[0])) {
      return hdrs.map((pair) => (Array.isArray(pair) && is(pair[0]) ? [pair[0], fn(pair[1])] : pair));
    }
    const out = hdrs.slice();
    for (let i = 0; i + 1 < out.length; i += 2) {
      if (is(out[i])) out[i + 1] = fn(out[i + 1]);
    }
    return out;
  }
  if (hdrs !== null && typeof hdrs === 'object') {
    let out = hdrs;
    for (const key of Object.keys(hdrs)) {
      if (!is(key)) continue;
      const next = fn(hdrs[key]);
      if (next !== hdrs[key]) {
        if (out === hdrs) out = { ...hdrs };
        out[key] = next;
      }
    }
    return out;
  }
  return hdrs;
}

const REWRITTEN = Symbol.for('knext.publicOrigin.rewritten');

/** Whether a rewrite changed a Location value (string or string[]). */
function differs(a, b) {
  return Array.isArray(a) ? a.length !== b.length || a.some((v, i) => v !== b[i]) : a !== b;
}

/**
 * Install the rewrite on `http.ServerResponse.prototype` (idempotent). Installs
 * nothing when the allowlist is empty.
 *
 * @param {{ env?: Record<string, string | undefined>, log?: (line: string) => void, warn?: (line: string) => void }} [opts]
 * @returns {{ hosts: string[] }}
 */
function install(opts) {
  const env = (opts && opts.env) || process.env;
  const log = (opts && opts.log) || ((line) => process.stdout.write(`${line}\n`));
  const warn = (opts && opts.warn) || ((line) => process.stderr.write(`${line}\n`));
  const http = require('node:http');
  const proto = http.ServerResponse.prototype;
  if (proto[INSTALLED]) return proto[INSTALLED];

  const { hosts, invalid } = parsePublicOrigins(env[PUBLIC_ORIGINS_ENV]);
  for (const entry of invalid) {
    warn(
      `PUBLIC_ORIGINS: INVALID — dropped ${PUBLIC_ORIGINS_ENV} entry ${JSON.stringify(entry)} ` +
        '(expected host[:port], optionally prefixed with http:// or https://)',
    );
  }
  const state = { hosts };
  if (hosts.length === 0) {
    if (invalid.length > 0) {
      warn(
        `PUBLIC_ORIGINS: ${PUBLIC_ORIGINS_ENV} has no valid entry — redirects keep the server's bind origin`,
      );
    }
    return state;
  }
  proto[INSTALLED] = state;
  log(`PUBLIC_ORIGINS:${hosts.join(',')} (env)`);

  // Snapshot the request headers before any listener (Next) can default them.
  const serverProto = http.Server.prototype;
  const originalEmit = serverProto.emit;
  serverProto.emit = function emitWithArrivalSnapshot(event, req) {
    if (event === 'request') snapshotArrival(req);
    return originalEmit.apply(this, arguments);
  };

  const originalSetHeader = proto.setHeader;

  // Rewrite one Location value for `res`, remembering that it happened so the
  // response can be marked `Vary` (the origin now depends on request headers).
  function rewriteTracked(res, value) {
    const next = rewriteLocation(value, requestHeadersOf(res), hosts);
    if (differs(value, next)) res[REWRITTEN] = true;
    return next;
  }
  proto.setHeader = function setHeader(name, value) {
    if (typeof name === 'string' && name.toLowerCase() === 'location') {
      return originalSetHeader.call(this, name, rewriteTracked(this, value));
    }
    return originalSetHeader.call(this, name, value);
  };

  if (typeof proto.appendHeader === 'function') {
    const originalAppendHeader = proto.appendHeader;
    proto.appendHeader = function appendHeader(name, value) {
      if (typeof name === 'string' && name.toLowerCase() === 'location') {
        return originalAppendHeader.call(this, name, rewriteTracked(this, value));
      }
      return originalAppendHeader.call(this, name, value);
    };
  }

  const originalWriteHead = proto.writeHead;
  proto.writeHead = function writeHead(_statusCode, statusMessage) {
    // A Location set earlier through a path this preload did not see.
    if (typeof this.getHeader === 'function' && !this.headersSent) {
      const current = this.getHeader('location');
      if (current !== undefined) {
        const next = rewriteTracked(this, current);
        if (differs(current, next)) originalSetHeader.call(this, 'location', next);
      }
    }
    // Same arity as the caller: writeHead(status), (status, headers),
    // (status, message) or (status, message, headers).
    const args = Array.prototype.slice.call(arguments);
    const at = args.length >= 3 ? 2 : args.length === 2 && typeof statusMessage !== 'string' ? 1 : -1;
    if (at !== -1) {
      args[at] = mapHeadHeaders(args[at], 'location', (v) => rewriteTracked(this, v));
    }
    // The Location now depends on Host / X-Forwarded-*: tell caches. Done here,
    // at the last moment, so a Vary the app sets later cannot clobber it.
    if (this[REWRITTEN] && !this.headersSent) {
      const given = [];
      if (at !== -1) {
        mapHeadHeaders(args[at], 'vary', (v) => {
          given.push(v);
          return v;
        });
      }
      const existing = typeof this.getHeader === 'function' ? this.getHeader('vary') : undefined;
      const merged = mergeVary([existing, ...given].flat());
      originalSetHeader.call(this, 'vary', merged);
      if (at !== -1) args[at] = mapHeadHeaders(args[at], 'vary', () => merged);
    }
    return originalWriteHead.apply(this, args);
  };
  return state;
}

// Preload side effect: `node --require <this file>` installs the rewrite.
// Requiring it from a test with KNEXT_PUBLIC_ORIGIN_NO_AUTOINSTALL=1 does not.
if (process.env.KNEXT_PUBLIC_ORIGIN_NO_AUTOINSTALL !== '1') {
  install();
}

module.exports = {
  PUBLIC_ORIGINS_ENV,
  parsePublicOrigins,
  resolvePublicOrigin,
  rewriteLocation,
  install,
};
