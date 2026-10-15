import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";

/**
 * A `'use cache'` function that takes the SUBJECT as an argument -- the shape of
 * a per-user lookup. Next derives the cache key from the function id plus the
 * serialized arguments, so two users must land on two entries; the two-pod test
 * reads both users on both pods and fails if one is served the other's entry.
 *
 * Same per-process build counter as ../../route.ts (one `Symbol.for` key on
 * `globalThis`), so `/api/uc/stats` counts these builds too.
 */
const COMPUTES = Symbol.for("knext.e2e.useCacheKind.computes");

function bumpComputes(): number {
    const bag = globalThis as unknown as Record<symbol, number>;
    bag[COMPUTES] = (bag[COMPUTES] ?? 0) + 1;
    return bag[COMPUTES];
}

function computes(): number {
    return (globalThis as unknown as Record<symbol, number>)[COMPUTES] ?? 0;
}

// Runs ONLY on a miss for THIS user. `uc-2pod` lets the test reset every entry;
// `uc-user-<user>` invalidates one user without touching the other.
async function profileFor(user: string) {
    "use cache";
    cacheTag("uc-2pod", `uc-user-${user}`);
    cacheLife("hours");
    bumpComputes();
    return {
        user,
        nonce: randomUUID(),
        computedAt: Date.now(),
        computedBy: hostname(),
    };
}

const SUBJECT = /^[a-z0-9-]{1,32}$/;

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ user: string }> },
) {
    await connection();
    const { user } = await params;
    if (!SUBJECT.test(user)) {
        return Response.json({ error: "bad user" }, { status: 400 });
    }
    const cached = await profileFor(user);
    return Response.json(
        { cached, servedBy: hostname(), computesInThisPod: computes() },
        { headers: { "cache-control": "no-store" } },
    );
}
