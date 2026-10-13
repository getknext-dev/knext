import { connection } from 'next/server';

// A 'use cache' function, run on every request: `connection()` makes the route
// dynamic, so each GET reaches the `cacheHandlers` store (no Redis in the test:
// a miss, then a dropped write).
async function stamp() {
  'use cache';
  return `${Date.now()}#${Math.random().toString(36).slice(2, 10)}`;
}

export async function GET() {
  await connection();
  return Response.json({ stamp: await stamp() });
}
