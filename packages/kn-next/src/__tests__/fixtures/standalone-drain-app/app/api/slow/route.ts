import { after } from "next/server";

export const dynamic = "force-dynamic";

/**
 * A deliberately slow handler that registers an `after()` callback.
 *
 * The e2e puts a request here IN FLIGHT, then delivers SIGTERM. The drain
 * guarantee has two observable halves:
 *   1. this handler's response must still COMPLETE (the connection is not reset)
 *      — proved by the JSON body arriving with the slept-for duration;
 *   2. the `after()` callback must still RUN during the drain — proved by the
 *      `AFTER_SENTINEL_RAN:<id>` line reaching the container's stdout (Next runs
 *      registered after() work as part of its graceful `server.close()`).
 *
 * The id echoes the request's own query param so the assertion cannot pass on a
 * stale marker from an earlier request.
 */
export async function GET(req: Request) {
    const url = new URL(req.url);
    const ms = Number(url.searchParams.get("ms") ?? "4000");
    const id = url.searchParams.get("id") ?? "noid";
    after(() => {
        console.log(`AFTER_SENTINEL_RAN:${id}`);
    });
    await new Promise((resolve) => setTimeout(resolve, ms));
    return Response.json({ ok: true, sleptMs: ms, id });
}
