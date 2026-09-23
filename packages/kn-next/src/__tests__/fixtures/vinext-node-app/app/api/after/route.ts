import { after } from "next/server";

// Responds at once, then schedules background work with `after()` that only
// finishes `?ms=` later (default 2000). The drain case sends SIGTERM while that
// work is still pending and asserts `AFTER-RAN` is logged BEFORE the drain
// reports `DRAINED cleanly` — i.e. shutdown waited for it (security.md).
export const dynamic = "force-dynamic";

export function GET(req: Request) {
    const ms = Number(new URL(req.url).searchParams.get("ms")) || 2000;
    after(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        console.log(`AFTER-RAN ms=${ms}`);
    });
    return Response.json({ scheduled: true, ms });
}
