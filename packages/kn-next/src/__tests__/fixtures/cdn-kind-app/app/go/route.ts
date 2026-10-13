import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// An absolute redirect built from `request.url`: with publicHosts set, the
// public-origin preload rewrites its Location per X-Forwarded-Host and marks the
// response `Vary: Host, X-Forwarded-Host`, which a Vary-ignoring CDN drops.
export function GET(request: Request) {
    return NextResponse.redirect(new URL("/tagged", request.url));
}
