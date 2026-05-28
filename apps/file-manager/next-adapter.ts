/**
 * knext-poc-adapter — NextAdapter for apps/file-manager (POC-ADAPTER-P1).
 *
 * Hooks:
 *  - modifyConfig: force output:'standalone' on phase-production-build
 *  - onBuildComplete:
 *      1. Log output counts + routing counts
 *      2. Best-effort upload staticFiles + prerenders to MinIO/S3 keyed by buildId
 *         (guarded by STORAGE_BUCKET env var; skips cleanly if not set)
 *
 * Upload uses getMinioClient() from @knative-next/lib/clients.
 * Files are uploaded under: <buildId>/<pathname> in the configured bucket.
 *
 * Out of scope: request routing, bun --compile, operator changes.
 */
import { createReadStream, existsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { NextAdapter } from 'next';
// AdapterOutputs is not re-exported from the 'next' public barrel; import directly.
import type { AdapterOutputs } from 'next/dist/build/adapter/build-complete';

const adapter: NextAdapter = {
  name: 'knext-poc-adapter',

  modifyConfig(config, { phase }) {
    if (phase !== 'phase-production-build') {
      return config;
    }

    console.log('[knext-poc-adapter] modifyConfig fired for phase-production-build');

    // Ensure standalone output is set (already set in next.config.ts but we
    // enforce it here so the adapter is self-contained in later phases).
    return {
      ...config,
      output: 'standalone',
    };
  },

  async onBuildComplete(ctx) {
    const { buildId, distDir, nextVersion, outputs } = ctx;

    const counts = {
      pages: outputs.pages.length,
      appPages: outputs.appPages.length,
      appRoutes: outputs.appRoutes.length,
      pagesApi: outputs.pagesApi.length,
      prerenders: outputs.prerenders.length,
      staticFiles: outputs.staticFiles.length,
      middleware: outputs.middleware ? 1 : 0,
    };

    const { routes } = ctx;
    const routingCounts = {
      headers: routes.headers.length,
      redirects: routes.redirects.length,
      rewritesBeforeFiles: routes.rewrites.beforeFiles.length,
      rewritesAfterFiles: routes.rewrites.afterFiles.length,
      rewritesFallback: routes.rewrites.fallback.length,
      dynamicRoutes: routes.dynamicRoutes.length,
    };

    console.log('[knext-poc-adapter] onBuildComplete fired');
    console.log(`  buildId      : ${buildId}`);
    console.log(`  distDir      : ${distDir}`);
    console.log(`  nextVersion  : ${nextVersion}`);
    console.log(`  output.output: ${ctx.config.output ?? 'not set'}`);
    console.log(`  cacheHandler : ${String(ctx.config.cacheHandler ?? 'not set')}`);
    console.log('  output counts:');
    for (const [key, count] of Object.entries(counts)) {
      console.log(`    ${key.padEnd(22)}: ${count}`);
    }
    console.log('  routing counts (ctx.routes):');
    for (const [key, count] of Object.entries(routingCounts)) {
      console.log(`    ${key.padEnd(22)}: ${count}`);
    }

    // ── Best-effort artifact upload ─────────────────────────────────────────
    // Upload staticFiles + prerenders to object storage keyed by buildId.
    // Guarded by STORAGE_BUCKET env var — skips cleanly when not configured.
    // This allows local/CI builds to succeed without storage credentials.
    await uploadBuildArtifacts({ buildId, outputs });
  },
};

async function uploadBuildArtifacts({
  buildId,
  outputs,
}: {
  buildId: string;
  outputs: AdapterOutputs;
}): Promise<void> {
  const bucket = process.env.STORAGE_BUCKET;

  if (!bucket) {
    console.log(
      '[knext-poc-adapter] upload skipped: STORAGE_BUCKET not set — set STORAGE_BUCKET to enable artifact upload',
    );
    return;
  }

  console.log(
    `[knext-poc-adapter] starting artifact upload to storage bucket="${bucket}" buildId="${buildId}"`,
  );

  // Dynamically import the minio client to avoid loading it in non-upload builds.
  let putObject: (bucket: string, key: string, stream: Readable) => Promise<unknown>;
  try {
    const { getMinioClient } = await import('@knative-next/lib/clients');
    const client = getMinioClient();
    putObject = (b, k, s) => client.putObject(b, k, s);
  } catch (err) {
    console.log(
      `[knext-poc-adapter] upload skipped: could not load storage client — ${String(err)}`,
    );
    return;
  }

  // PRERENDER type in Next 16.0.3 doesn't have a top-level filePath;
  // the fallback HTML path is nested under fallback.filePath (optional).
  type StaticFile = AdapterOutputs['staticFiles'][number];
  type Prerender = AdapterOutputs['prerenders'][number];
  const artifacts = [
    ...outputs.staticFiles.map((f: StaticFile) => ({
      filePath: f.filePath,
      key: `${buildId}${f.pathname}`,
    })),
    ...outputs.prerenders
      .filter((f: Prerender) => f.fallback?.filePath)
      .map((f: Prerender) => ({ filePath: f.fallback!.filePath!, key: `${buildId}/${f.id}` })),
  ];

  let uploaded = 0;
  let skipped = 0;

  for (const { filePath, key } of artifacts) {
    if (!filePath || !existsSync(filePath)) {
      skipped++;
      continue;
    }
    try {
      // createReadStream returns fs.ReadStream which extends node:stream Readable
      const stream = createReadStream(filePath) as unknown as Readable;
      await putObject(bucket, key, stream);
      uploaded++;
    } catch (err) {
      console.log(`[knext-poc-adapter] upload warning: failed to upload "${key}" — ${String(err)}`);
      skipped++;
    }
  }

  console.log(
    `[knext-poc-adapter] artifact upload complete: uploaded=${uploaded} skipped=${skipped} total=${artifacts.length}`,
  );
}

export default adapter;
