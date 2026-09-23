import { after } from 'next/server';

// Responds at once, then schedules background work with `after()` that only
// finishes `?ms=` later (default 2000). The SIGTERM e2e
// (test/alpine-image.docker-e2e.test.ts) signals while that work is pending and
// asserts `AFTER-RAN` is logged BEFORE `DRAINED cleanly` — security.md: run
// `after()` callbacks before exit.
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const ms = Math.min(Number(new URL(req.url).searchParams.get('ms')) || 2000, 10_000);
  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    console.log(`AFTER-RAN ms=${ms}`);
  });
  return Response.json({ scheduled: true, ms });
}
