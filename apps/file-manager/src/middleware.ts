import { type NextRequest, NextResponse } from 'next/server';

/**
 * knext smoke middleware.
 *
 * Minimal passthrough that stamps `x-knext-smoke: 1` on every response so the
 * compat-smoke suite (scripts/compat-smoke.mjs) can prove that Next.js
 * middleware actually executes under the knext adapter / standalone server.
 *
 * Keep this trivial and side-effect-free. It must not block, redirect, or
 * mutate request bodies.
 */
export function middleware(_request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set('x-knext-smoke', '1');
  return response;
}

// Broad matcher: run on all routes except Next internals and the image
// optimizer endpoint (so the header doesn't interfere with binary responses).
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
