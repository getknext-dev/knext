import { NextResponse } from 'next/server';

// See cdn-soundness-app/proxy.js. A matcher written WITHOUT a locale prefix:
// with i18n, Next inserts the detected or default locale before matching, so
// the preload cannot test the raw path alone.
export function proxy(request) {
  const res = NextResponse.next();
  res.headers.set('x-mw-ran', request.nextUrl.pathname);
  return res;
}

export const config = { matcher: ['/dashboard'] };
