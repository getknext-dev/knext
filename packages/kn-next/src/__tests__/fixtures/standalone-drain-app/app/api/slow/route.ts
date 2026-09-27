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
 *
 * `afterMs` (optional, default 0) makes the `after()` callback do real async
 * work AFTER the response: it logs `AFTER_SENTINEL_START:<id>`, waits `afterMs`,
 * and only then logs `AFTER_SENTINEL_RAN:<id>`. With a synchronous callback the
 * marker prints the instant the response finishes, so a shutdown that never
 * waits for `after()` work would still pass; with `afterMs` the final marker
 * exists only if the process stayed up for that work to finish. Unset, the
 * callback logs straight away, which is what the disk-mode sibling relies on.
 */
export async function GET(req: Request) {
    const url = new URL(req.url);
    const ms = Number(url.searchParams.get("ms") ?? "4000");
    const afterMs = Number(url.searchParams.get("afterMs") ?? "0");
    const id = url.searchParams.get("id") ?? "noid";
    after(async () => {
        if (afterMs > 0) {
            console.log(`AFTER_SENTINEL_START:${id}`);
            await new Promise((resolve) => setTimeout(resolve, afterMs));
        }
        console.log(`AFTER_SENTINEL_RAN:${id}`);
    });
    await new Promise((resolve) => setTimeout(resolve, ms));
    return Response.json({ ok: true, sleptMs: ms, id });
}
