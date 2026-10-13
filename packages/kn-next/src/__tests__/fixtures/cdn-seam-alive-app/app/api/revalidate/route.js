import { revalidatePath } from 'next/cache';

// Test fixture only: revalidates /tagged through Next's own revalidatePath.
// Mutating, so it is Bearer-authenticated and fails closed without a token.
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const token = process.env.SEAM_ALIVE_REVALIDATE_TOKEN;
  if (!token || request.headers.get('authorization') !== `Bearer ${token}`) {
    return new Response('unauthorized', { status: 401 });
  }
  revalidatePath('/tagged');
  return Response.json({ revalidated: '/tagged' });
}
