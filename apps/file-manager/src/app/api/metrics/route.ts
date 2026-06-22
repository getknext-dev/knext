import { NextResponse } from 'next/server';
import {
  appName,
  buildId,
  cacheFilesTotal,
  cacheSizeBytes,
  register,
  scanCacheDir,
} from '../_metrics/registry';

/**
 * Prometheus scrape endpoint.
 *
 * The registry + metric instances live in ../_metrics/registry (#94) so the
 * RUM ingest route can record Web Vitals into the SAME registry; those series
 * merge automatically into register.metrics() below.
 */

export async function GET() {
  // Dynamically scan cache on every scrape so Prometheus gets current file count
  const { fileCount, totalSize } = scanCacheDir();
  cacheFilesTotal.labels({ app: appName, build_id: buildId }).set(fileCount);
  cacheSizeBytes.labels({ app: appName, build_id: buildId }).set(totalSize);

  const metrics = await register.metrics();
  return new NextResponse(metrics, {
    headers: { 'Content-Type': register.contentType },
  });
}
