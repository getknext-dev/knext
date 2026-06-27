import { NextResponse } from 'next/server';
import {
  appName,
  buildId,
  cacheFilesTotal,
  cacheSizeBytes,
  register,
  scanCacheDir,
  withRedMetrics,
} from '../_metrics/registry';

/**
 * Prometheus scrape endpoint.
 *
 * The registry + metric instances live in ../_metrics/registry (#94) so the
 * RUM ingest route can record Web Vitals into the SAME registry; those series
 * merge automatically into register.metrics() below.
 *
 * Wrapped in withRedMetrics (observability P0): the scrape request itself is
 * counted into the RED series. The wrapper observes BEFORE returning, so the
 * sample for the previous scrape is already present in the body it serializes;
 * the current request's own sample lands in the next scrape (standard for a
 * self-observing /metrics endpoint). Behavior is otherwise unchanged.
 */

export const GET = withRedMetrics('/api/metrics', async () => {
  // Dynamically scan cache on every scrape so Prometheus gets current file count
  const { fileCount, totalSize } = scanCacheDir();
  cacheFilesTotal.labels({ app: appName, build_id: buildId }).set(fileCount);
  cacheSizeBytes.labels({ app: appName, build_id: buildId }).set(totalSize);

  const metrics = await register.metrics();
  return new NextResponse(metrics, {
    headers: { 'Content-Type': register.contentType },
  });
});
