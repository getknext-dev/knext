export const dynamic = "force-dynamic";

/**
 * A handler that emits the ORIGIN Cache-Control shape Next's ISR pipeline
 * produces — the shared-cache directives (`s-maxage=…, stale-while-revalidate=…`)
 * that `getCacheControlHeader` writes and a deployment platform's cache layer is
 * meant to consume. See `packages/kn-next/src/adapters/cache-control-normalize.cjs`.
 *
 * The compat-gated preload (#175) rewrites that origin value to the deployed
 * client-facing form `public, max-age=0, must-revalidate` — which is what the
 * official deploy-mode compatibility suite asserts. This route lets the
 * docker-e2e prove the SUPERVISOR (`node-server.ts`) actually injects that
 * preload into the standalone child: request this route through the shipped
 * image and the client-facing Cache-Control must be the NORMALIZED value, not
 * the `s-maxage=` origin value set here.
 */
export async function GET() {
    return new Response(JSON.stringify({ ok: true, probe: "cache-control" }), {
        headers: {
            "content-type": "application/json",
            // The origin ISR directive shape (mirrors Next's getCacheControlHeader
            // for a revalidate:N route). The preload must rewrite this away.
            "cache-control": "s-maxage=2, stale-while-revalidate=31535998",
        },
    });
}
