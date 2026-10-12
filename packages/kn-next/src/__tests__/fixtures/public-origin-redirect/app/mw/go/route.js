import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Same shape as /go; lives under /mw so the proxy (middleware) only touches it.
export function GET(request) {
  return NextResponse.redirect(new URL('/article/one?from=mw', request.url));
}
