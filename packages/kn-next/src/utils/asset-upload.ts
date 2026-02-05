import { join } from 'node:path';
import { $ } from 'bun';
import type { KnativeNextConfig } from '../config';

/**
 * Uploads static assets to configured storage provider.
 * Assets include _next/static/* and public files.
 */
export async function uploadAssets(config: KnativeNextConfig): Promise<void> {
  const assetsDir = join(process.cwd(), '.open-next', 'assets');

  console.log(`   Syncing to ${config.storage.provider}://${config.storage.bucket}`);

  switch (config.storage.provider) {
    case 'gcs':
      await $`gsutil -m rsync -r ${assetsDir} gs://${config.storage.bucket}`.quiet();
      break;
    case 's3':
      await $`aws s3 sync ${assetsDir} s3://${config.storage.bucket}`.quiet();
      break;
    case 'minio':
      // MinIO uses S3-compatible CLI
      await $`mc cp --recursive ${assetsDir} minio/${config.storage.bucket}`.quiet();
      break;
    case 'azure':
      await $`az storage blob upload-batch -d ${config.storage.bucket} -s ${assetsDir}`.quiet();
      break;
    default:
      throw new Error(`Unsupported storage provider: ${config.storage.provider}`);
  }
}
