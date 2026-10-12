import { revalidateTag } from 'next/cache';

export async function POST(request) {
  const mode = new URL(request.url).searchParams.get('mode');
  if (mode === 'max') revalidateTag('uc-stamp', 'max');
  else revalidateTag('uc-stamp', { expire: 0 });
  return Response.json({ ok: true, mode });
}
