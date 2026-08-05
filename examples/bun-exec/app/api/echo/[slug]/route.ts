// A DYNAMIC route handler — the handler-side counterpart to app/item/[id].
// Same reason: param binding through an embedded route table is the dimension
// the self-containment proof was missing.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return Response.json({ echoed: slug });
}
