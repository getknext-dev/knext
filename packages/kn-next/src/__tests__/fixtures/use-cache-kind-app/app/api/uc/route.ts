import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";

/**
 * Counts how many times `compute()` actually ran IN THIS PROCESS. Anchored on
 * `globalThis` (not a module `let`): Next may evaluate a route module more than
 * once per process, and a per-copy counter would under-report.
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

// The cached unit. The body runs ONLY on a miss: two requests that share the
// entry return the same `nonce`/`computedBy`, whichever pod serves them.
async function compute() {
    "use cache";
    cacheTag("uc-2pod");
    cacheLife("hours");
    bumpComputes();
    return {
        nonce: randomUUID(),
        computedAt: Date.now(),
        // The pod name: the pod that PRODUCED the entry.
        computedBy: hostname(),
    };
}

export async function GET() {
    // Keep the route dynamic: the cache under test is the 'use cache' entry, not
    // a statically prerendered response.
    await connection();
    const cached = await compute();
    return Response.json(
        {
            cached,
            // The pod that SERVED this response, and how many entries it has built.
            servedBy: hostname(),
            computesInThisPod: computes(),
        },
        { headers: { "cache-control": "no-store" } },
    );
}
