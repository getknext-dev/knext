// A cached route whose own Cache-Control says `private` next to `s-maxage`: the
// `private` is the only thing that must keep it off the edge.
export const revalidate = 3600;

export async function GET() {
    return new Response("PRIVATE-BODY", {
        headers: {
            "content-type": "text/plain",
            "cache-control": "private, s-maxage=3600",
        },
    });
}
