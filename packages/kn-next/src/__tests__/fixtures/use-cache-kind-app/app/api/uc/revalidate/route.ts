import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { revalidateTag } from "next/cache";

// A mutating route: Bearer-authenticated and fail-closed. No token configured
// means NOBODY is authorised (never "open when unset").
function authorized(header: string | null): boolean {
    const expected = process.env.CACHE_INVALIDATE_TOKEN;
    if (!expected || !header?.startsWith("Bearer ")) return false;
    const given = Buffer.from(header.slice("Bearer ".length));
    const want = Buffer.from(expected);
    return given.length === want.length && timingSafeEqual(given, want);
}

export async function POST(request: Request) {
    if (!authorized(request.headers.get("authorization"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Immediate expiry (not stale-while-revalidate): the next read on ANY pod
    // must recompute.
    revalidateTag("uc-2pod", { expire: 0 });
    return Response.json({ ok: true, servedBy: hostname() });
}
