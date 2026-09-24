/**
 * Deployed-platform Cache-Control normalization at the `Bun.serve` seam, for the
 * compiled vinext executable (#1322, compat group G1).
 *
 * WHY: Next's origin always emits shared-cache directives (`s-maxage=2,
 * stale-while-revalidate=…` for ISR, `s-maxage=31536000` for revalidate:false,
 * the private no-store shell for a fallback first MISS). A deployed platform
 * hands clients `public, max-age=0, must-revalidate` instead, and the official
 * deploy-mode compatibility suite asserts exactly that. knext's Node runtimes
 * apply the rule through `cache-control-normalize.cjs` (the same rules as the
 * official reference adapter-bun's `normalizeCacheControlHeader`) by patching
 * `node:http`. The vinext executable serves through nitro's bun preset →
 * `srvx/bun` → `Bun.serve`, which never touches `node:http`, so it served the
 * origin values. This module applies the SAME pure rule — imported, not
 * copied, via `response-cache-control.mjs` — to every `Response` a
 * `Bun.serve` `fetch` handler returns.
 *
 * Same off switch as the Node runtime: `KNEXT_CACHE_CONTROL_NORMALIZE=0` (for an
 * app fronted by its own shared cache/CDN that should see `s-maxage`).
 *
 * Importing `cache-control-normalize.cjs` also runs its `node:http` preload
 * patch (under the same switch). Inside the executable that only affects a
 * `node:http` server the app may start itself, which then gets the same
 * deployed semantics.
 *
 * SHIPS in the compiled executable: `vinext-compile.mjs` injects an `import` of
 * `bun-serve-cache-control-install.mjs` right after the keep-alive guard, so the
 * patch is on `Bun.serve` before `srvx/bun` calls it. This module itself has no
 * side effects, so tests can import it without patching their own process.
 */
import { applyVinextDeployDefault, normalizeResponse } from "./response-cache-control.mjs";

// The runtime-agnostic half lives in response-cache-control.mjs (vinext on Node
// uses it too); re-exported so both seams share one implementation.
export { applyVinextDeployDefault, normalizeResponse };

const INSTALLED = Symbol.for("knext.bunServeCacheControl.installed");

/**
 * @param {Record<string, string | undefined> | undefined} env
 * @param {{ serve?: unknown } | undefined} bun `globalThis.Bun`
 */
export function shouldInstall(env, bun) {
    if (!bun || typeof bun.serve !== "function") return false;
    return !(env && env.KNEXT_CACHE_CONTROL_NORMALIZE === "0");
}

/**
 * Wrap a `Bun.serve` `fetch` handler (sync or async) so every response is
 * normalized for its request. Preserves `this` and all arguments.
 */
export function wrapFetch(fetchHandler) {
    return function wrapped(...args) {
        const request = args[0];
        const result = fetchHandler.apply(this, args);
        if (result && typeof result.then === "function") {
            return result.then((r) => normalizeResponse(request, r));
        }
        return normalizeResponse(request, result);
    };
}

/**
 * A shallow clone of the `Bun.serve` options with `fetch` wrapped.
 *
 * Only responses from `options.fetch` are normalized. Responses from
 * `Bun.serve`'s `routes` table or its `error` handler are not. That is fine
 * today because srvx serves everything through `fetch` and sets neither.
 */
export function wrapServeOptions(options) {
    if (!options || typeof options !== "object") return options;
    if (typeof options.fetch !== "function") return options;
    return { ...options, fetch: wrapFetch(options.fetch) };
}

/** Patch `bun.serve`. Idempotent; a no-op when `shouldInstall` says so. */
export function install(bun, env) {
    if (!shouldInstall(env, bun)) return false;
    if (bun[INSTALLED]) return true;
    bun[INSTALLED] = true;
    const originalServe = bun.serve;
    bun.serve = function serve(options, ...rest) {
        return originalServe.call(this, wrapServeOptions(options), ...rest);
    };
    return true;
}
