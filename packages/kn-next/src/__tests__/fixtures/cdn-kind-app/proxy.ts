import { type NextRequest, NextResponse } from "next/server";

// Scoped by the matcher to /protected/* and /variant, so every other fixture
// path stays unmatched (and so edge-cacheable by default).
//
// - /protected/*: cookie-gated. Without `session=ok` the visitor is sent to
//   /login; with it the static page is served. A Vary-ignoring CDN that stored
//   the authenticated response would hand the protected body to everyone.
// - /variant: rewritten by cookie to one of two ISR pages. A CDN that stored
//   variant A under /variant would serve it to a variant-B visitor.
export function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;
    if (pathname.startsWith("/protected")) {
        if (request.cookies.get("session")?.value !== "ok") {
            return NextResponse.redirect(new URL("/login", request.url));
        }
        return NextResponse.next();
    }
    if (pathname === "/variant") {
        const v = request.cookies.get("v")?.value === "b" ? "b" : "a";
        return NextResponse.rewrite(new URL(`/variant-${v}`, request.url));
    }
    return NextResponse.next();
}

export const config = { matcher: ["/protected/:path*", "/variant"] };
