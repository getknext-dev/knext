export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ route: 'hello', ok: true });
}
