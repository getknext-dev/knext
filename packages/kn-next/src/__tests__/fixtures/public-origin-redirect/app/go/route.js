import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// The common shape: an absolute redirect built from `request.url`.
export function GET(request) {
  return NextResponse.redirect(new URL('/article/one?from=go', request.url));
}
