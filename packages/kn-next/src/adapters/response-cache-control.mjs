/**
 * Deployed-platform Cache-Control normalization at the RESPONSE level — the
 * runtime-agnostic half shared by both vinext server entries.
 *
 * WHY: Next's origin always emits shared-cache directives (`s-maxage=2,
 * stale-while-revalidate=…` for ISR, `s-maxage=31536000` for revalidate:false,
 * the private no-store shell for a fallback first MISS). A deployed platform
 * hands clients `public, max-age=0, must-revalidate` instead, and the official
 * deploy-mode compatibility suite asserts exactly that. The rule itself lives in
 * `cache-control-normalize.cjs` (imported, never copied).
 *
 * Two seams use it:
 *   - the compiled vinext executable, at `Bun.serve` (`bun-serve-cache-control.mjs`);
 *   - vinext on Node (`build: 'vinext'`, `runtime: 'node'`), as the srvx
 *     middleware below. The `node:http` preload cannot cover that path: srvx/node
 *     writes response headers with `res.writeHead(status, statusText, rawHeaders)`
 *     where `rawHeaders` is a FLAT ARRAY, and the preload rewrites `setHeader` and
 *     object-form `writeHead` only.
 *
 * Same off switch everywhere: `KNEXT_CACHE_CONTROL_NORMALIZE=0` (for an app
 * fronted by its own shared cache/CDN that should see `s-maxage`).
 *
 * Importing `cache-control-normalize.cjs` also runs its `node:http` preload
 * patch (under the same switch). It only affects a `node:http` server that
 * writes headers through `setHeader` or object-form `writeHead`, which then gets
 * the same deployed semantics.
 */
import normalizer from "./cache-control-normalize.cjs";

const { normalizeCacheControl } = normalizer;

/**
 * Normalize a response's Cache-Control in place for the request that produced
 * it. Best-effort and never throws: a response with immutable headers keeps its
 * origin value rather than breaking.
 *
 * @param {unknown} request
 * @param {unknown} response
 */
export function normalizeResponse(request, response) {
    try {
        const headers =
            response && typeof response === "object"
                ? /** @type {{ headers?: Headers }} */ (response).headers
                : undefined;
        if (!headers || typeof headers.get !== "function") return response;
        const value = headers.get("cache-control");
        if (value === null) return response;
        const marker = headers.get("x-nextjs-cache");
        const rq = /** @type {{ method?: string, url?: string } | undefined} */ (request);
        const next = normalizeCacheControl(value, {
            method: rq?.method,
            url: rq?.url,
            hasNextCacheMarker: typeof marker === "string" && marker.length > 0,
        });
        if (next !== value) headers.set("cache-control", next);
    } catch {
        // Immutable headers or a non-Response: leave it.
    }
    return response;
}

/**
 * Turn vinext's own deploy Cache-Control switch on by default.
 *
 * vinext emits the deploy value for the cacheable responses it computes itself
 * (ISR/SSG pages, `/_next/data`, and the first request for a `fallback: true`
 * page) when `VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1`; it reads the variable on every
 * request. Measured: without it, that fallback first request carries NO
 * Cache-Control at all, which the rule above (it rewrites an existing header)
 * cannot supply. The two layers are complementary: vinext's switch covers
 * responses vinext computes, the rule above covers headers the app sets itself.
 *
 * An explicit value (including `0`) is never overridden, and
 * `KNEXT_CACHE_CONTROL_NORMALIZE=0` leaves it unset, so one knext switch turns
 * both layers off.
 *
 * @param {Record<string, string | undefined>} env
 */
export function applyVinextDeployDefault(env) {
    if (!env || env.VINEXT_NEXT_DEPLOY_CACHE_CONTROL !== undefined) return;
    if (env.KNEXT_CACHE_CONTROL_NORMALIZE === "0") return;
    env.VINEXT_NEXT_DEPLOY_CACHE_CONTROL = "1";
}

/**
 * An srvx middleware applying the rule to every response the rest of the chain
 * returns. Put it FIRST in the list so it is the outermost layer. Under
 * `KNEXT_CACHE_CONTROL_NORMALIZE=0` it passes responses through untouched. A
 * throw from the chain propagates unchanged.
 *
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {(request: Request, next: () => unknown) => Promise<unknown>}
 */
export function cacheControlMiddleware(env) {
    const enabled = !(env && env.KNEXT_CACHE_CONTROL_NORMALIZE === "0");
    return async (request, next) => {
        const response = await next();
        return enabled ? normalizeResponse(request, response) : response;
    };
}
