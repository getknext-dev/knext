import { getDbPool } from '@getknext/lib/clients';
import { cacheLife, cacheTag } from 'next/cache';

/** The tag that invalidates the stats alone (`POST /api/cache/invalidate`). */
export const FILE_STATS_TAG = 'file-stats';

export interface FileStats {
  count: number;
  totalBytes: number;
  /** When the value was computed: equal across reads that share the entry. */
  computedAt: string;
}

/**
 * How many files are stored and how many bytes they take, cached with
 * `'use cache'`.
 *
 * The entry lives in the app's shared Redis store, not in the process, so every
 * pod serves the same value and a pod that wakes from zero reads it instead of
 * querying Postgres. It is tagged `files` (the upload action already
 * invalidates that tag, so a new upload refreshes the stats) and
 * `file-stats` (to invalidate the stats alone).
 *
 * A database failure throws rather than returning zeros: an error is never
 * cached, while a returned value would be served to every pod until the tag is
 * invalidated.
 */
export async function getFileStats(): Promise<FileStats> {
  'use cache';
  cacheTag('files', FILE_STATS_TAG);
  cacheLife('hours');
  const { rows } = await getDbPool().query(
    'SELECT COUNT(*)::int AS count, COALESCE(SUM(size), 0)::bigint AS total_bytes FROM files',
  );
  const row = rows[0] ?? {};
  return {
    count: Number(row.count ?? 0),
    totalBytes: Number(row.total_bytes ?? 0),
    computedAt: new Date().toISOString(),
  };
}
