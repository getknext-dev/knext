import { NextResponse } from 'next/server';

// Records, on the RESPONSE, every pathname Next ran this proxy/middleware on.
// The CDN soundness test asserts: proxy ran => the preload refused to edge-cache
// the request, or counted it as matched.
export function proxy(request) {
  const res = NextResponse.next();
  res.headers.set('x-mw-ran', request.nextUrl.pathname);
  return res;
}

export const config = { matcher: ['/dashboard', '/dashboard/:path*'] };
