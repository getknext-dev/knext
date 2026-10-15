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

const TAG = /^uc-(2pod|user-[a-z0-9-]{1,32})$/;

export async function POST(request: Request) {
    if (!authorized(request.headers.get("authorization"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    // `?tag=` picks ONE allow-listed tag (`uc-2pod`, every entry; or
    // `uc-user-<user>`, one user's entry), read only after the caller is
    // authenticated. Anything else is refused rather than passed to Next.
    const tag = new URL(request.url).searchParams.get("tag") ?? "uc-2pod";
    if (!TAG.test(tag)) {
        return Response.json({ error: "tag not allowed" }, { status: 400 });
    }
    // Immediate expiry (not stale-while-revalidate): the next read on ANY pod
    // must recompute.
    revalidateTag(tag, { expire: 0 });
    return Response.json({ ok: true, tag, servedBy: hostname() });
}
