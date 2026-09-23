// A request that is genuinely in flight when SIGTERM arrives: it sleeps
// server-side for `?ms=` (default 3000, capped at 60s). The drain case asserts
// it still completes; the hardcap case uses a sleep longer than the grace.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const ms = Math.min(
        Number(new URL(req.url).searchParams.get("ms")) || 3000,
        60_000,
    );
    await new Promise((resolve) => setTimeout(resolve, ms));
    return Response.json({ ok: true, sleptMs: ms });
}
