import { draftMode } from 'next/headers';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// The Draft Mode entry route shape: enable Draft Mode (a host-only bypass
// cookie), then redirect to the article with a URL built from `request.url`.
// If the redirect leaves the app's host, the browser drops the cookie and the
// article renders its published prerender instead of the draft.
export async function GET(request) {
  (await draftMode()).enable();
  return NextResponse.redirect(new URL('/article/one', request.url));
}
