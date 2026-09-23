import { after } from 'next/server';

// Nested background work: an `after()` callback that, once SIGTERM has already
// landed, schedules MORE work with `after(promise)`. vinext hands that promise
// to the execution context's `waitUntil` — a registration made WHILE the drain
// is already awaiting. The SIGTERM e2e asserts `NESTED-RAN` is logged before
// `DRAINED cleanly`: a drain that snapshots its pending set once concludes as
// soon as the outer callback returns, and the nested work is lost on exit.
export const dynamic = 'force-dynamic';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function GET(req: Request) {
  const ms = Math.min(Number(new URL(req.url).searchParams.get('ms')) || 2000, 10_000);
  after(async () => {
    await sleep(ms);
    after(sleep(ms).then(() => console.log(`NESTED-RAN ms=${ms}`)));
    console.log(`OUTER-RAN ms=${ms}`);
  });
  return Response.json({ scheduled: true, nested: true, ms });
}
