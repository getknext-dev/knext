/**
 * In-process request-body byte cap — a dependency-free CommonJS preload
 * (`node --require` / `bun -r`, and compiled into the standalone single
 * executable) for the Next.js standalone server.
 *
 * WHY: `containerConcurrency` bounds concurrent REQUESTS, never BYTES per
 * request. One route handler that buffers its body (`await req.json()`,
 * `await req.formData()`) can be handed an arbitrarily large body and OOMKill
 * the pod — SIGKILL, so the graceful drain, Next's `after()` callbacks and the
 * DB-pool drain are all skipped, and every co-resident in-flight request dies
 * with it. Next itself caps Server Action bodies (`serverActions.bodySizeLimit`,
 * 1 MB) but NOT route handlers, and the co-resident-pod path never meets a
 * front proxy at all. This file is the platform control for every body the
 * standalone server receives.
 *
 * WHERE: the standalone `server.js` creates its server with
 * `http.createServer(requestListener)` (next/dist/server/lib/start-server.js).
 * The cap is installed on `http.Server.prototype.emit`, gating the `'request'`
 * event BEFORE any listener runs — so it covers every server the process
 * creates regardless of how the listener is attached, adds no hop, no port and
 * no child process (the "front socket" shape a proxy would need), and runs Next's
 * own server unmodified ("don't rewrite the runtime twice"). `'upgrade'`
 * (WebSocket / 101) is a different event and is never touched.
 *
 * HOW (counted bytes, never a trusted header):
 *   1. A declared `Content-Length` above the cap is refused before the handler
 *      runs — the body is never read.
 *   2. Otherwise every body chunk is COUNTED as it arrives (the request's
 *      `push`, which both Node's HTTP parser and Bun's node:http compat layer
 *      feed), so a chunked body with no `Content-Length` — or a lying one — is
 *      bounded by what actually arrives. The count is on the stream's intake,
 *      not a `'data'` listener: attaching a listener would switch the stream to
 *      flowing mode and steal the body from the handler.
 *   3. On exceed: `413 Payload Too Large` with `Connection: close`, the handler's
 *      body stream is errored (a pending `req.json()` rejects rather than seeing
 *      a truncated body — no partial processing), and the rest of the body is
 *      DISCARDED (never buffered) for a bounded linger before the connection is
 *      torn down — see LINGER_MS for why it is not closed at once. If the handler already started a response (a
 *      stream that answers before reading its body), a status can no longer be
 *      sent, so the socket is destroyed instead.
 *
 * CONFIG: `KNEXT_MAX_REQUEST_BYTES` — the SAME knob, default, and semantics the
 * compiled vinext entry uses (runtime-contract.mjs `resolveMaxRequestBytes`):
 *   - unset          → 8 MiB (8388608). Memory limit 1Gi ÷ containerConcurrency
 *                      20, with headroom; above Next's 1 MB Server Action limit
 *                      so two layers never answer at one threshold.
 *   - non-negative integer → that many bytes.
 *   - `0`            → uncapped, deliberately, logged loudly at boot.
 *   - anything else (including empty) → the default, with a warning. A manifest typo must never
 *                      remove a control.
 * The effective cap is announced once at boot on stdout:
 * `REQUEST_BYTE_CAP:<bytes|none> (<source>)`.
 */

'use strict';

const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES_ENV = 'KNEXT_MAX_REQUEST_BYTES';
const INSTALLED = Symbol.for('knext.requestBodyCap.installed');
const GATED = Symbol.for('knext.requestBodyCap.gated');
const TOO_LARGE_BODY = 'Payload Too Large\n';

/**
 * Resolve the effective cap from an env object. Pure — mirrors
 * runtime-contract.mjs `resolveMaxRequestBytes` (a lockstep test pins them).
 *
 * `bytes` is `undefined` when explicitly uncapped. An EMPTY value is invalid,
 * not uncapped (`Number('')` is 0) — the security-relevant direction.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ bytes: number | undefined, source: 'default' | 'env' | 'uncapped' | 'invalid', warning?: string }}
 */
function resolveRequestByteCap(env) {
  const raw = env[MAX_REQUEST_BYTES_ENV];
  if (raw === undefined) {
    return { bytes: DEFAULT_MAX_REQUEST_BYTES, source: 'default' };
  }
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    return {
      bytes: DEFAULT_MAX_REQUEST_BYTES,
      source: 'invalid',
      warning:
        `${MAX_REQUEST_BYTES_ENV}=${JSON.stringify(raw)} is not a non-negative integer — ` +
        `falling back to the ${DEFAULT_MAX_REQUEST_BYTES}-byte default. Set 0 to uncap deliberately.`,
    };
  }
  const bytes = Number(trimmed);
  if (bytes === 0) {
    return {
      bytes: undefined,
      source: 'uncapped',
      warning:
        `${MAX_REQUEST_BYTES_ENV}=0 — request bodies are UNCAPPED. This pod will buffer a body ` +
        'of any size a route handler reads; with containerConcurrency > 1 one oversized body is ' +
        "an OOM kill of every in-flight request rather than a 413.",
    };
  }
  return { bytes, source: 'env' };
}

/**
 * Parse a Content-Length header value. Returns NaN when absent or malformed
 * (the HTTP parser has already rejected truly malformed framing; anything it
 * let through is left to the counted path).
 */
function declaredLength(req) {
  const raw = req.headers && req.headers['content-length'];
  if (typeof raw !== 'string' || !/^\s*\d+\s*$/.test(raw)) return Number.NaN;
  return Number(raw);
}

/**
 * How long a refused connection keeps DISCARDING the rest of an oversized body
 * after the 413 is written, before it is torn down. Closing a socket that still
 * has unread bytes makes the kernel send a TCP reset, and a client that is still
 * uploading then sees ECONNRESET/EPIPE instead of the 413 — measured: most
 * refusals of a multi-megabyte body were lost that way without this. Discarded
 * bytes are never buffered, and the bound keeps a refused client from holding
 * the connection (nginx's `lingering_close` does the same).
 */
const LINGER_MS = 2000;

/** Tear the connection down once the peer finishes sending, or after LINGER_MS. */
function lingerThenClose(socket) {
  if (!socket || socket.destroyed) return;
  const close = () => {
    if (!socket.destroyed) socket.destroy();
  };
  const timer = setTimeout(close, LINGER_MS);
  if (typeof timer.unref === 'function') timer.unref();
  socket.once('close', () => clearTimeout(timer));
  socket.once('end', close);
  // The HTTP server calls destroySoon() after a `Connection: close` response
  // finishes, which would reset the socket while the client is still sending.
  // Half-close instead and let the timer (or the peer's own FIN) finish it.
  socket.destroySoon = function lingeringDestroySoon() {
    if (this.writable) this.end();
  };
  if (typeof socket.resume === 'function') socket.resume();
}

/** Answer 413 and close; never throws. */
function refuse(req, res) {
  // Writes the handler may still attempt on this response after it was ended
  // here would otherwise surface as an unhandled 'error' event.
  if (typeof res.on === 'function') res.on('error', () => {});
  const socket = req.socket;
  if (!res.headersSent && !res.writableEnded) {
    try {
      res.shouldKeepAlive = false;
      res.writeHead(413, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(TOO_LARGE_BODY.length),
        connection: 'close',
      });
      res.end(TOO_LARGE_BODY);
    } catch {
      /* socket already gone — nothing to answer */
    }
    lingerThenClose(socket);
    return;
  }
  // A response is already in flight — a status can no longer be sent.
  if (socket && !socket.destroyed) socket.destroy();
}

/**
 * Gate one request. Returns true when the request may reach the listeners.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} cap
 */
function gateRequest(req, res, cap) {
  if (req[GATED]) return true;
  req[GATED] = true;

  const declared = declaredLength(req);
  if (declared > cap) {
    // The listeners never see this request. Discard its body as it arrives
    // (flowing mode with no 'data' listener drops chunks) — never buffered.
    if (typeof req.on === 'function') req.on('error', () => {});
    if (typeof req.resume === 'function') req.resume();
    refuse(req, res);
    return false;
  }

  let seen = 0;
  let exceeded = false;
  const originalPush = req.push;
  req.push = function cappedPush(chunk, encoding) {
    // After the cap fired, every further chunk is DISCARDED. Returning true
    // keeps the parser reading so the connection can drain (see LINGER_MS)
    // instead of stalling with unread bytes.
    if (exceeded) return true;
    if (chunk !== null && chunk !== undefined) {
      seen += typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
      if (seen > cap) {
        exceeded = true;
        const err = new Error(`request body exceeds ${cap} bytes`);
        err.code = 'KNEXT_REQUEST_BODY_TOO_LARGE';
        err.status = 413;
        err.statusCode = 413;
        refuse(req, res);
        // Error the handler's body stream: a pending read rejects instead of
        // resolving with a truncated body. The socket is NOT destroyed with it
        // (IncomingMessage's own _destroy would) — refuse() owns its teardown.
        req._destroy = function destroyStreamOnly(error, callback) {
          callback(error);
        };
        if (typeof req.destroy === 'function') req.destroy(err);
        return true;
      }
    }
    return originalPush.call(this, chunk, encoding);
  };
  return true;
}

/**
 * Install the cap on `http.Server.prototype.emit` (idempotent).
 *
 * @param {{ env?: Record<string, string | undefined>, log?: (line: string) => void, warn?: (line: string) => void }} [opts]
 * @returns {{ bytes: number | undefined, source: string }}
 */
function install(opts) {
  const env = (opts && opts.env) || process.env;
  const log = (opts && opts.log) || ((line) => process.stdout.write(`${line}\n`));
  const warn = (opts && opts.warn) || ((line) => process.stderr.write(`${line}\n`));
  const http = require('node:http');
  const proto = http.Server.prototype;
  if (proto[INSTALLED]) return proto[INSTALLED];

  const cap = resolveRequestByteCap(env);
  // Same boot-log shape as the compiled vinext entry, so one grep finds the cap
  // on every target.
  if (cap.warning) warn(`REQUEST_BYTE_CAP: ${cap.source.toUpperCase()} — ${cap.warning}`);
  log(`REQUEST_BYTE_CAP:${cap.bytes ?? 'none'} (${cap.source})`);
  const state = { bytes: cap.bytes, source: cap.source };
  proto[INSTALLED] = state;
  if (cap.bytes === undefined) return state;

  const originalEmit = proto.emit;
  proto.emit = function cappedEmit(event, req, res) {
    if (event === 'request' && req && res && !gateRequest(req, res, cap.bytes)) {
      return true;
    }
    return originalEmit.apply(this, arguments);
  };
  return state;
}

// Preload side effect: `node --require <this file>` installs the cap.
// Requiring it from a test with KNEXT_REQUEST_BODY_CAP_NO_AUTOINSTALL=1 does not.
if (process.env.KNEXT_REQUEST_BODY_CAP_NO_AUTOINSTALL !== '1') {
  install();
}

module.exports = {
  DEFAULT_MAX_REQUEST_BYTES,
  MAX_REQUEST_BYTES_ENV,
  resolveRequestByteCap,
  gateRequest,
  install,
};
