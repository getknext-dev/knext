import { NextResponse } from 'next/server';
import { observeWebVital, withRedMetrics } from '../_metrics/registry';
import { allowRumRequest } from './rate-limit';
import { parseBeacon, routeTemplateFor } from './validate';

// NOTE: an App Router route module may export ONLY HTTP-method handlers and the
// allowed route-segment config — `next build` type-checks this and rejects any
// extra export. The limiter singleton + its test-reset helper therefore live in
// ./rate-limit, not here.

/**
 * POST /api/rum — Web Vitals (RUM) ingest (#94).
 *
 * This is a mutating/ingest endpoint, documented as an explicit, justified
 * exception in docs/security/mutating-endpoints.md. A browser beacon cannot
 * carry the Bearer secret, so instead of being an open write primitive it is
 * neutered by FOUR layers:
 *   1. Same-origin / cluster-local — reachable only as broadly as the app
 *      itself (operator NetworkPolicy, #90); no new external surface.
 *   2. Fixed-schema lossy aggregator — the handler can ONLY observe() one of a
 *      closed set of pre-declared histograms. It cannot create series, set
 *      arbitrary values, write storage, or revalidate cache.
 *   3. Server-enforced bounded label cardinality — metric/rating come from
 *      closed allow-lists and route is mapped to a server-side template; no
 *      user/session/IP/raw-URL ever becomes a label (see ./validate).
 *   4. Rate-limit (in-process token bucket) + payload-size cap (413) + strict
 *      shape validation (400).
 *
 * Responses: 204 (recorded), 400 (malformed/disallowed), 413 (oversized),
 * 429 (rate-limited). There is intentionally NO GET handler.
 */

// Payload cap — a single Web Vitals beacon is tiny; reject anything larger.
const MAX_BODY_BYTES = 2_048;

// Wrapped in withRedMetrics (observability P0): the ingest request is counted
// into the server-side RED series under the bounded route="/api/rum" label. The
// wrapper is behavior-preserving — it returns this handler's own Response (the
// 204/400/413/429 contract is unchanged) and only adds instrumentation.
export const POST = withRedMetrics('/api/rum', async (request: Request): Promise<Response> => {
  // Layer 4: rate-limit first — cheapest rejection, protects everything below.
  if (!allowRumRequest()) {
    return new NextResponse(null, { status: 429 });
  }

  // Layer 4: payload-size cap. Prefer the declared length; fall back to the
  // actual read length so a lying/absent header can't bypass the cap.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  if (raw.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  // Layer 4: strict shape — malformed JSON → 400.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  // Layer 3: validate against closed allow-lists; null → reject.
  const beacon = parseBeacon(body);
  if (!beacon) {
    return new NextResponse(null, { status: 400 });
  }

  // Layer 3: map the reported pathname to a bounded route template. Raw IDs,
  // UUIDs and query strings can never become labels.
  const route = routeTemplateFor(beacon.pathname);

  // Layer 2: the only effect available — observe() one pre-declared histogram.
  observeWebVital({
    metric: beacon.metric,
    route,
    rating: beacon.rating,
    value: beacon.value,
  });

  return new NextResponse(null, { status: 204 });
});
