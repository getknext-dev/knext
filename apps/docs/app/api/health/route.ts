// Shallow readiness endpoint. The knext operator's Knative readiness probe
// GETs /api/health; without this route every revision answers 404 and never
// goes Ready. It depends on nothing — the docs site has no database or cache
// whose reachability should gate readiness.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
