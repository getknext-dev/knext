// As /cc/private, with `no-store` as the only thing that keeps it off the edge.
export const revalidate = 3600;

export async function GET() {
    return new Response("NO-STORE-BODY", {
        headers: {
            "content-type": "text/plain",
            "cache-control": "no-store, s-maxage=3600",
        },
    });
}
