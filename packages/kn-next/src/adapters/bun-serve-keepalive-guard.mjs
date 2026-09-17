/**
 * Bun `Bun.serve` keep-alive mitigation — a dependency-free, Bun-only ESM module
 * that stamps `Connection: close` on every response served through `Bun.serve`.
 * The sibling of `bun-keepalive-guard.cjs` (the NODE lane's `node:http` guard),
 * for the `Bun.serve` transport the vinext runtime serves through.
 *
 * WHY (root cause in `.claude/vinext-nitro-reset-rootcause.md`): the compiled
 * vinext single-exec and the uncompiled nitro-bun output both serve via nitro's
 * bun preset → `srvx/bun` → `Bun.serve`. Bun has the SAME class of keep-alive
 * socket-REUSE reset the node:http guard already isolated (#188), but on the
 * `Bun.serve` transport: when a client reuses a keep-alive socket for an
 * immediate back-to-back request, Bun resets it → `socket hang up`, no HTTP
 * response, clean server log, ~1 ms. It dominates the vinext-lane "silent socket
 * reset" failure cluster (~79 fixtures). The node guard patches
 * `node:http.createServer`, which `Bun.serve` never calls, so it is a structural
 * no-op here — this module reaches the `Bun.serve` seam instead.
 *
 * MITIGATION (identical to the node lane, different transport): wrap the `fetch`
 * handler `Bun.serve` is given so every returned `Response` carries
 * `Connection: close`. Spec-honoring clients (node-fetch, undici, browsers, the
 * Knative activator) then never reuse the socket, so the Bun reuse race is
 * unreachable. This trades keep-alive reuse for correctness on the `Bun.serve`
 * path only.
 *
 * VERSION CEILING — deliberately NONE. Unlike the node:http guard (which records
 * the reuse-reset as fixed at Bun 1.4.0 and self-disables at ≥1.4.0), the
 * `Bun.serve` path is MEASURED still-broken at Bun 1.4.2 on linux-x64 (compat run
 * 34485558152, reset fixtures still failing). The upstream fix and therefore the
 * safe ceiling are UNKNOWN as of Bun 1.4.2 on this transport, so this guard is
 * ALWAYS on when running under Bun. Re-verify on a future Bun release before
 * adding a ceiling; do not copy the node guard's `FIXED_MINOR` here.
 *
 * The bug is linux-x64-timing-specific and does NOT reproduce on darwin, so this
 * cannot be validated locally — validation is the compat lane re-run.
 *
 * Escape hatch: `KNEXT_BUN_KEEPALIVE_GUARD=0` disables the guard outright (the
 * same env var the node guard reads, so one switch covers both transports).
 * Under Node — where `globalThis.Bun` is absent — this module is a guaranteed
 * no-op regardless of the env var.
 *
 * SHIPS in BOTH vinext artifacts:
 *   - the COMPILED single executable: `vinext-compile.mjs` injects an
 *     `import` of this module as the FIRST statement of the nitro entry, so it
 *     patches `globalThis.Bun.serve` before `srvx/bun` calls it (ESM evaluates a
 *     module's imports depth-first in source order, so the first import runs
 *     first). A `bun --preload` cannot reach a compiled binary, which is why the
 *     compiled path needs bundle injection.
 *   - the UNCOMPILED nitro output (the KNEXT_COMPILE=0 diagnostic boot):
 *     `bun --preload <this file>` installs the patch before the entry evaluates.
 */

const INSTALLED = Symbol.for('knext.bunServeKeepaliveGuard.installed');

/**
 * Pure gating rule (unit-tested; the module-load side effect below feeds it the
 * real process env). There is NO version ceiling — see the header. The only
 * inputs are "are we on Bun" and the escape-hatch env var.
 *
 * @param {Record<string, string | undefined> | undefined} env
 * @param {{ serve?: unknown } | undefined} bun `globalThis.Bun`
 * @returns {boolean}
 */
export function shouldInstall(env, bun) {
  // Never touch a non-Bun runtime: `Bun.serve` is the whole subject. Under Node
  // there is no `globalThis.Bun`, so the vinext bundle running on Node (it never
  // does — the bun preset is bun-only — but be defensive) is untouched.
  if (!bun || typeof bun.serve !== 'function') return false;
  const flag = env ? env.KNEXT_BUN_KEEPALIVE_GUARD : undefined;
  // The ONLY off switch. Any other value (including "1") leaves the guard on,
  // because the safe ceiling on this transport is unknown.
  if (flag === '0') return false;
  return true;
}

/**
 * Stamp `Connection: close` on a response, in place, best-effort. Returns the
 * same object so it composes in a return position. Never throws: a guard that
 * breaks a response is worse than the keep-alive race it prevents.
 *
 * @param {unknown} response
 * @returns {unknown}
 */
export function stampConnectionClose(response) {
  try {
    const headers =
      response && typeof response === 'object'
        ? /** @type {{ headers?: { set?: unknown } }} */ (response).headers
        : undefined;
    if (headers && typeof headers.set === 'function') {
      /** @type {{ set: (k: string, v: string) => void }} */ (headers).set(
        'Connection',
        'close',
      );
    }
  } catch {
    // Immutable/guarded headers, or a non-Response return — leave it be. Worst
    // case that one response keeps keep-alive semantics and only its socket can
    // hit the Bun race.
  }
  return response;
}

/**
 * Wrap a `Bun.serve` `fetch` handler so every response it produces (sync or
 * async) is stamped. Preserves `this` and all arguments (req, server).
 *
 * @template {(...args: unknown[]) => unknown} F
 * @param {F} fetchHandler
 * @returns {F}
 */
export function wrapFetch(fetchHandler) {
  const wrapped = function (...args) {
    const result = fetchHandler.apply(this, args);
    if (result && typeof result.then === 'function') {
      return result.then(stampConnectionClose);
    }
    return stampConnectionClose(result);
  };
  return /** @type {F} */ (wrapped);
}

/**
 * Return a shallow clone of the `Bun.serve` options with its `fetch` handler
 * wrapped. Options without a `fetch` function are returned untouched (a
 * routes-only server is not the srvx/nitro shape and is left alone rather than
 * guessed at). The original options object is never mutated.
 *
 * @param {unknown} options
 * @returns {unknown}
 */
export function wrapServeOptions(options) {
  if (!options || typeof options !== 'object') return options;
  const opts = /** @type {{ fetch?: unknown }} */ (options);
  if (typeof opts.fetch !== 'function') return options;
  return {
    ...opts,
    fetch: wrapFetch(/** @type {(...a: unknown[]) => unknown} */ (opts.fetch)),
  };
}

/**
 * Patch `bun.serve` so every server it starts stamps `Connection: close`.
 * Idempotent (guarded by a `Symbol.for` marker on the Bun object, which survives
 * the webpack-layer module duplication ADR-0027 warns about). A no-op when
 * `shouldInstall` says so.
 *
 * @param {{ serve?: (...a: unknown[]) => unknown, [k: symbol]: unknown } | undefined} bun `globalThis.Bun`
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {boolean} whether the patch was (or already was) installed
 */
export function install(bun, env) {
  if (!shouldInstall(env, bun)) return false;
  // `bun` is a truthy object with a `serve` function here (shouldInstall).
  const target = /** @type {{ serve: (...a: unknown[]) => unknown, [k: symbol]: unknown }} */ (bun);
  if (target[INSTALLED]) return true;
  target[INSTALLED] = true;
  const originalServe = target.serve;
  target.serve = function serve(options, ...rest) {
    return originalServe.call(this, wrapServeOptions(options), ...rest);
  };
  return true;
}

// Module-load side effect: importing this module (bundled into the compiled
// entry, or `bun --preload`ed) installs the patch on Bun; under Node or with
// KNEXT_BUN_KEEPALIVE_GUARD=0 it is a no-op.
install(
  /** @type {any} */ (typeof globalThis !== 'undefined' ? globalThis.Bun : undefined),
  typeof process !== 'undefined' ? process.env : undefined,
);
