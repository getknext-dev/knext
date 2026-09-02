/**
 * knext's image optimization for the vinext target (ADR-0048, holding the
 * ADR-0006 gap closed on the single executable).
 *
 * ## Why this INTERCEPTS rather than registers
 *
 * vinext has an optimizer slot — `setImageOptimizer()`, state anchored on
 * `globalThis` — and registering one looks like the obvious way in. It does
 * not work, and the reason is worth stating exactly, because two plausible
 * approaches were tried and measured before the real gate was found.
 *
 * vinext's own types say image optimization is
 * `InitImageOptimization = "cloudflare-images" | "none"` — there is no third
 * option — and its request handler gates the route like this:
 *
 *     if (isImageOptimizationPath(url.pathname) && env?.ASSETS && getImageOptimizer())
 *
 * `env.ASSETS` is the **Cloudflare Workers assets binding**. On the node/bun
 * platform it is undefined, so that branch is dead *regardless* of whether an
 * optimizer is registered. Passing `images: { optimizer }` to the plugin does
 * nothing (the option is read on the Cloudflare init path); calling
 * `setImageOptimizer()` from the server entry also does nothing. Both were
 * tried here and both left `/_next/image` returning 181,277 bytes of
 * `image/png` — byte-identical to the source — even with `Accept: image/webp`.
 *
 * So the route is intercepted BEFORE vinext sees it. knext owns the server
 * entry, which makes this a knext-side fix that needs nothing from upstream.
 *
 * Without it, adopting vinext would silently REGRESS image optimization, which
 * `CLAUDE.md` records as having been the project's biggest functional gap until
 * ADR-0006 closed it. Losing it again by changing build systems would be a real
 * regression wearing the costume of a migration.
 *
 * ## Why sharp is loaded through `createRequire`, not `import()`
 *
 * `sharp` is a native module. `bun build --compile` cannot bake a `.node`
 * binary into the executable, so a static import puts an unresolvable
 * dependency in the bundle graph — the same failure ioredis caused, where the
 * binary built cleanly and then died at boot.
 *
 * The obvious fix — `await import(computedSpecifier)`, opaque enough that no
 * bundler can follow it — DOES NOT WORK, and failing to know that cost real
 * time here. rolldown does not leave an unanalysable dynamic import alone; it
 * replaces it with a stub that throws `Cannot find module as expression is too
 * dynamic`. The opacity that defeats bundling also defeats resolution.
 *
 * `createRequire` is resolution the bundler does not rewrite, and it is the
 * same mechanism `@getknext/lib` already uses for ioredis. Resolution is
 * anchored on `process.cwd()` rather than `import.meta.url`, because inside a
 * compiled binary the module URL points at an embedded virtual path with no
 * `node_modules` above it — the deployed image puts sharp beside the binary,
 * which is what cwd finds.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

/** vinext's optimizer contract. Structural — vinext does not export the type. */
export interface KnextImageOptimizer {
    transformImage: (
        body: ReadableStream,
        options: {
            width: number;
            format: string;
            quality: number;
            /**
             * What the bytes ACTUALLY are, as opposed to what was asked for.
             * Required, because every fail-open path has to label the original
             * bytes honestly. Labelling a PNG `image/avif` because avif was
             * requested produces a response the browser cannot decode — a
             * worse outcome than the unoptimized image the fallback exists to
             * provide. That defect was live here until a byte-count check
             * caught it.
             */
            sourceFormat: string;
        },
    ) => Promise<Response>;
}

/**
 * Kept computed so a bundler cannot add sharp to the static graph. This alone
 * is NOT what makes it load — see the docblock; `createRequire` is.
 */
const SHARP_SPECIFIER = ["sh", "arp"].join("");

/** Formats knext will transcode to. Anything else falls back to the source. */
const SUPPORTED = new Set(["webp", "avif", "jpeg", "png"]);

type SharpModule = {
    default?: unknown;
} & ((input: Buffer) => {
    resize: (opts: { width: number; withoutEnlargement: boolean }) => {
        toFormat: (
            format: string,
            opts: { quality: number },
        ) => { toBuffer: () => Promise<Buffer> };
    };
});

let sharpModule: SharpModule | null | undefined;

/**
 * Resolve sharp once. `undefined` = not yet tried, `null` = unavailable.
 * Cached either way, so a missing sharp costs one failed resolve rather than
 * one per request.
 */
async function loadSharp(provided?: SharpModule): Promise<SharpModule | null> {
    // A directly-passed sharp wins and is never cached into `sharpModule`: the
    // caller owns it, and caching it here would let one entry's collaborator
    // leak into another's.
    if (provided) return provided;
    if (sharpModule !== undefined) return sharpModule;
    try {
        // Anchored on cwd: inside a compiled binary `import.meta.url` is an
        // embedded virtual path with no node_modules above it, so resolving
        // from there finds nothing even when sharp sits beside the binary.
        const require = createRequire(join(process.cwd(), "noop.js"));
        const mod = require(SHARP_SPECIFIER) as {
            default?: SharpModule;
        } & SharpModule;
        sharpModule = (mod.default ?? mod) as SharpModule;
    } catch (error) {
        sharpModule = null;
        // Say so, ONCE. Failing open is right — a broken optimizer must not
        // break the page — but failing open SILENTLY means image optimization
        // can be off in production and nothing ever reports it. That is not
        // hypothetical: this exact fallback masked a load failure here, and
        // the only symptom was a response that looked fine and was 96x too
        // big. Silence is what made it expensive to find.
        console.warn(
            `[knext] image optimization disabled: could not load sharp (${
                error instanceof Error ? error.message : String(error)
            }). /_next/image will serve unoptimized originals.`,
        );
    }
    return sharpModule;
}

/**
 * The transform itself, kept separate from the routing so it can be tested
 * without a server.
 *
 * Fails OPEN: any transform error returns the original bytes rather than an
 * error status. A broken optimizer must degrade to the behaviour that existed
 * before it — an unoptimized image — never to a broken page.
 */
export function knextImageOptimizer(
    /** sharp, when the caller has it. See `ImageRouteOptions.sharp`. */
    provided?: SharpModule,
): KnextImageOptimizer {
    return {
        async transformImage(body, { width, format, quality, sourceFormat }) {
            const source = Buffer.from(await new Response(body).arrayBuffer());

            const target = normaliseFormat(format);
            if (!target) return passthrough(source, sourceFormat);

            const sharp = await loadSharp(provided);
            if (!sharp) return passthrough(source, sourceFormat);

            try {
                const out = await sharp(source)
                    .resize({ width, withoutEnlargement: true })
                    .toFormat(target, { quality })
                    .toBuffer();
                return new Response(new Uint8Array(out), {
                    headers: {
                        "content-type": `image/${target}`,
                        // Matches what vinext's passthrough sets, so switching
                        // between them does not change caching behaviour.
                        "cache-control": "public, max-age=31536000, immutable",
                        "x-content-type-options": "nosniff",
                    },
                });
            } catch {
                return passthrough(source, sourceFormat);
            }
        },
    };
}

/** vinext passes a mime-ish string; sharp wants a bare format name. */
function normaliseFormat(format: string): string | null {
    const bare = format.replace(/^image\//, "").toLowerCase();
    return SUPPORTED.has(bare) ? bare : null;
}

function passthrough(source: Buffer, format: string): Response {
    return new Response(new Uint8Array(source), {
        headers: {
            "content-type": format.startsWith("image/")
                ? format
                : `image/${format}`,
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
        },
    });
}

/** Formats a browser may ask for, best first. Order is the preference order. */
const NEGOTIABLE = ["avif", "webp"] as const;

/**
 * Pick the output format from the request's `Accept` header, exactly as Next's
 * own optimizer does: honour what the browser advertises, and fall back to the
 * source format when it advertises nothing useful. Returning the source format
 * is what makes an old client keep working rather than get a file it cannot
 * decode.
 */
export function negotiateFormat(
    accept: string | null,
    sourceFormat: string,
): string {
    const header = (accept ?? "").toLowerCase();
    for (const candidate of NEGOTIABLE) {
        if (header.includes(`image/${candidate}`)) return candidate;
    }
    return sourceFormat;
}

/**
 * `/_next/image` requests knext answers itself.
 *
 * A relative, same-origin `url` only. An absolute one is passed straight
 * through to the app: fetching an arbitrary URL from inside the pod is an SSRF
 * surface, and Next gates it on a configured `remotePatterns` allowlist that
 * this layer does not have. Passing through is the conservative miss — the
 * image still renders, just unoptimized.
 */
export interface ImageRouteOptions {
    /**
     * Fetch a same-origin path through the app's own pipeline, so the source
     * image resolves the same way any other static asset does. Injected rather
     * than assumed, because the entry knows how to reach the asset root and
     * this module deliberately does not.
     */
    fetchSource: (path: string) => Promise<Response>;

    /**
     * sharp itself, passed in by the entry.
     *
     * DIRECT-PASS rather than a module-state seam, per architecture.md §4, and
     * here it is not merely preferred — it is the only thing that works inside a
     * `bun build --compile` binary. Measured on bun 1.4.0: a compiled binary
     * cannot resolve a package from disk AT ALL. `createRequire(cwd)('sharp')`
     * fails with `Cannot find module 'sharp'` even when sharp and every one of
     * its dependencies sit top-level in a flat `node_modules` beside the
     * executable, and even though the identical call succeeds uncompiled. So the
     * runtime-resolve path below can never serve the compiled target; sharp has
     * to be in the bundle, which means the ENTRY has to hand it over.
     *
     * Optional: the node/uncompiled targets leave it unset and keep using the
     * runtime resolve, which is what keeps sharp out of their static graph.
     */
    sharp?: SharpModule;
}

/** Requests this layer answers. Anything else is not ours. */
export function isImageRequest(url: URL): boolean {
    return url.pathname === "/_next/image";
}

/**
 * Handle one `/_next/image` request, or return `null` to mean "not mine, let
 * the app have it". `null` rather than a thrown error keeps every miss — bad
 * params, absolute URL, missing source, absent sharp — on the same pass-through
 * path, so a miss can never turn a working page into a broken one.
 */
export async function handleImageRequest(
    request: Request,
    { fetchSource, sharp }: ImageRouteOptions,
): Promise<Response | null> {
    const url = new URL(request.url);
    if (!isImageRequest(url)) return null;

    const src = url.searchParams.get("url");
    // `//host` is protocol-relative and therefore NOT same-origin, despite
    // starting with a slash. Rejecting it here is the difference between a
    // same-origin fetch and an outbound one.
    if (!src || !src.startsWith("/") || src.startsWith("//")) return null;

    const width = Number(url.searchParams.get("w"));
    const quality = Number(url.searchParams.get("q") ?? 75);
    if (!Number.isFinite(width) || width <= 0) return null;

    let source: Response;
    try {
        source = await fetchSource(src);
    } catch {
        return null;
    }
    if (!source.ok || !source.body) return null;

    const sourceFormat =
        (source.headers.get("content-type") ?? "").replace(/^image\//, "") ||
        "png";
    const format = negotiateFormat(request.headers.get("accept"), sourceFormat);

    return knextImageOptimizer(sharp).transformImage(source.body, {
        width,
        format,
        sourceFormat,
        quality: Number.isFinite(quality) ? quality : 75,
    });
}
