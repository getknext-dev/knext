import { connection } from 'next/server';
import { getFileStats } from './file-stats';

/**
 * GET /api/files/stats — file count and total size, from a `'use cache'`
 * function (see `./file-stats.ts`). The route itself stays dynamic; the
 * cached unit is the function's entry in the shared Redis store.
 */
export async function GET() {
  await connection();
  try {
    const stats = await getFileStats();
    return Response.json(stats, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[files/stats] failed to read the file stats:', error);
    return Response.json(
      { error: 'File stats unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
