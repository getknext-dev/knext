import { NextResponse } from 'next/server';

// Scoped to /mw so every other fixture case is unaffected. It rewrites the
// LIVE request's x-forwarded-host (via x-middleware-request-*), which is what
// an app's own middleware can do. The public-origin preload must keep deciding
// on the headers that ARRIVED, not on this mutation.
export function proxy(request) {
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', 'www.example.com');
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/mw/:path*'] };
