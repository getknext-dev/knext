import { cacheTag } from 'next/cache';
import { connection } from 'next/server';

// The cached unit: a timestamp computed ONCE per cache entry. Two requests that
// share the entry return the same `t`; two that do not return different ones.
async function stamp() {
  'use cache';
  cacheTag('uc-stamp');
  return { t: Date.now(), pid: process.pid };
}

export async function GET() {
  // Keep the route dynamic: the cache under test is the 'use cache' entry, not
  // a statically prerendered response.
  await connection();
  return Response.json(await stamp());
}
