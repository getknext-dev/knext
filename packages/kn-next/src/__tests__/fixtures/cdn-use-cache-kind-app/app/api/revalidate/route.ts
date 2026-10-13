import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";

// The purge e2e's trigger: `revalidateTag` for this fixture's 'use cache' tag.
// A mutating route, so Bearer-authenticated and fail-closed: no token
// configured means NOBODY is authorised (never "open when unset").
const TAGS = new Set(["cdn-e2e-uc"]);

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
    const tag = new URL(request.url).searchParams.get("tag") ?? "";
    if (!TAGS.has(tag)) {
        return Response.json({ error: "unknown tag" }, { status: 400 });
    }
    // Immediate expiry, not stale-while-revalidate: the next read must render.
    revalidateTag(tag, { expire: 0 });
    return Response.json({ ok: true, tag });
}
