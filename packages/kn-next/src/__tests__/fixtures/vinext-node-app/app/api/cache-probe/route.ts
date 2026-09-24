export const dynamic = "force-dynamic";

/**
 * Emits the ORIGIN Cache-Control shape Next's ISR pipeline produces
 * (`s-maxage=…, stale-while-revalidate=…`) as an app-set header. The node entry's
 * Cache-Control middleware must rewrite it to the deployed client-facing value
 * `public, max-age=0, must-revalidate`, or leave it under
 * `KNEXT_CACHE_CONTROL_NORMALIZE=0`.
 *
 * The body reports vinext's own deploy switch as THIS process sees it, since the
 * entry defaults `VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1` at runtime and no header
 * alone can show that.
 */
export async function GET() {
    return new Response(
        JSON.stringify({
            vinextDeploy: process.env.VINEXT_NEXT_DEPLOY_CACHE_CONTROL ?? null,
        }),
        {
            headers: {
                "content-type": "application/json",
                "cache-control": "s-maxage=2, stale-while-revalidate=31535998",
            },
        },
    );
}
