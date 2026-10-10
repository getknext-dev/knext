import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// A redirect to ANOTHER site: its origin is not the bind address, so it must
// reach the browser exactly as written.
export function GET() {
  return NextResponse.redirect('https://other.example.org/landing?x=1');
}
