/**
 * Bun ≤1.3.x keep-alive mitigation — a dependency-free CommonJS preload
 * (`bun -r`) for the Next.js standalone server. Loaded ONLY on the Bun
 * runtime; requiring it under Node is a guaranteed no-op.
 *
 * WHY (#188, compat bun-lane run 28607626868): 30/39 bun-lane failures were
 * `FetchError: … socket hang up` — per-request TCP aborts from the standalone
 * server under Bun 1.3.14. The cache-control-normalize preload was EXONERATED
 * by the one-flag discriminator (KNEXT_CACHE_CONTROL_NORMALIZE=0 reproduced
 * identical hang-ups). The isolated root cause, reduced to a plain `node:http`
 * server with no Next.js involved:
 *
 *   Bun ≤1.3.14 (verified linux-x64 + darwin-arm64) RESETS a reused
 *   keep-alive socket when the next request arrives immediately after the
 *   previous response completed. The harness client (node-fetch@2 over
 *   Node ≥19's keep-alive globalAgent) reuses sockets back-to-back and sees
 *   ECONNRESET → "socket hang up". Single requests and reuse delayed ≥~50ms
 *   succeed — so only small/fast responses (tiny 404s, draft-mode enables,
 *   header dumps, hashed SVGs) lose the race, exactly the failing families.
 *   Bun canary 1.4.0 does NOT reproduce → fixed upstream; this guard
 *   self-disables on ≥1.4.0 (re-verify on the 1.4.0 release, then drop).
 *
 * MITIGATION: advertise `Connection: close` on every response before the app
 * handler runs. Spec-honoring clients (node-fetch, undici, browsers, the
 * Knative activator) then never reuse the socket, so the Bun reuse race is
 * unreachable. This trades keep-alive reuse for correctness on the affected
 * Bun versions only; the Node serving path is untouched (byte-identical).
 *
 * Escape hatches: KNEXT_BUN_KEEPALIVE_GUARD=0 disables the guard outright;
 * KNEXT_BUN_KEEPALIVE_GUARD=1 forces it on a Bun version the ceiling says is
 * fixed (regression insurance). Neither has any effect under Node.
 */

'use strict';

const INSTALLED = Symbol.for('knext.bunKeepaliveGuard.installed');
// First Bun version where the keep-alive reuse reset no longer reproduces
// (verified on oven/bun:canary 1.4.0, 2026-07-02).
const FIXED_MAJOR = 1;
const FIXED_MINOR = 4;

/**
 * @param {string | undefined} version `process.versions.bun`
 * @returns {boolean} true when this Bun version carries the reuse-reset bug
 */
function isAffectedBunVersion(version) {
  if (typeof version !== 'string' || version.length === 0) return false;
  const m = /^(\d+)\.(\d+)(?:\.|$|-)/.exec(version);
  if (!m) return true; // unparseable Bun version → assume affected (fail-safe)
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== FIXED_MAJOR) return major < FIXED_MAJOR;
  return minor < FIXED_MINOR;
}

/**
 * Pure gating rule (unit-tested; the preload side effect below feeds it the
 * real process env/versions).
 *
 * @param {Record<string, string | undefined> | undefined} env
 * @param {Record<string, string | undefined> | undefined} versions
 * @returns {boolean}
 */
function shouldInstall(env, versions) {
  const bunVersion = versions ? versions.bun : undefined;
  // Never patch Node — the Node lane's serving shape stays byte-identical.
  if (typeof bunVersion !== 'string' || bunVersion.length === 0) return false;
  const flag = env ? env.KNEXT_BUN_KEEPALIVE_GUARD : undefined;
  if (flag === '0') return false;
  if (flag === '1') return true;
  return isAffectedBunVersion(bunVersion);
}

/**
 * Prepend a request listener that advertises `Connection: close` before the
 * app handler runs. The handler can still override deliberately (it runs
 * after and the last setHeader wins); Next.js never does.
 *
 * @template {import('node:http').Server} S
 * @param {S} server
 * @returns {S}
 */
function guardServer(server) {
  server.prependListener('request', (_req, res) => {
    try {
      if (!res.headersSent) res.setHeader('Connection', 'close');
    } catch {
      // never let the guard break a request — worst case the response keeps
      // keep-alive semantics and only that socket can hit the Bun race.
    }
  });
  return server;
}

/**
 * Patch http.createServer so every server the standalone runtime creates is
 * guarded. Idempotent.
 */
function install() {
  const http = require('node:http');
  if (http[INSTALLED]) return;
  http[INSTALLED] = true;
  const originalCreateServer = http.createServer;
  http.createServer = function createServer(...args) {
    return guardServer(originalCreateServer.apply(this, args));
  };
}

// Preload side effect: `bun -r <this file>` installs the guard on affected
// Bun versions; under Node (or fixed Bun, or KNEXT_BUN_KEEPALIVE_GUARD=0)
// this is a no-op.
if (shouldInstall(process.env, process.versions)) {
  install();
}

module.exports = { shouldInstall, isAffectedBunVersion, guardServer, install };
