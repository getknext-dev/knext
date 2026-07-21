// RuntimeContract §1 — shallow health. No PG/Redis dial (ADR-0026): a liveness
// probe must not fail just because a downstream is briefly unreachable.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', target: 'bun-exec' });
}
