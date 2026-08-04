import { NextResponse } from "next/server";
export function middleware() {
    const r = NextResponse.next();
    r.headers.set("x-devfix", "1");
    return r;
}
export const config = { matcher: ["/((?!_next/static).*)"] };
