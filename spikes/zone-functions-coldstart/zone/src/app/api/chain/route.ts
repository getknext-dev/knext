import { callFn, defaultHttpVersion, type HttpVersion } from '../../../lib/fn';
import { wakeState } from '../../../lib/wake';

export const dynamic = 'force-dynamic';

// GET /api/chain?fn=fn-go-h1[&http=1.1|2]
// The zone's server-side hop to a function, timed inside the zone. The bench
// measures the end-to-end time from a client pod; this body explains it.
export async function GET(req: Request) {
  const zoneUptimeAtReqMs = performance.now();
  const url = new URL(req.url);
  const fn = url.searchParams.get('fn') || 'fn-go-h1';
  const http = (url.searchParams.get('http') as HttpVersion | null) || defaultHttpVersion(fn);
  const base = {
    fn,
    http,
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
    zoneUptimeAtReqMs,
    wake: wakeState(),
  };
  try {
    const r = await callFn(fn, http);
    return Response.json({ ok: true, ...base, ...r });
  } catch (err) {
    const e = err as Error & { code?: unknown; cause?: unknown };
    return Response.json(
      {
        ok: false,
        ...base,
        error: String(e?.message ?? e),
        code: e?.code ?? null,
        cause: String(e?.cause ?? ''),
      },
      { status: 502 },
    );
  }
}
