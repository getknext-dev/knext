// Bench-only route: 50 synthetic rows, no external dependency.
export const dynamic = "force-dynamic";

export function GET() {
  const items = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}` }));
  return Response.json({ items });
}
