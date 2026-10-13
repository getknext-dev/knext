import { hostname } from "node:os";
import { connection } from "next/server";

// Same key as ../route.ts: the per-process count of entries this pod has built.
const COMPUTES = Symbol.for("knext.e2e.useCacheKind.computes");

// Reads the counter WITHOUT touching the cache, so the test can take an exact
// baseline per pod and stays re-runnable against the same pods.
export async function GET() {
    await connection();
    const bag = globalThis as unknown as Record<symbol, number>;
    return Response.json(
        { servedBy: hostname(), computesInThisPod: bag[COMPUTES] ?? 0 },
        { headers: { "cache-control": "no-store" } },
    );
}
