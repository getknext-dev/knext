import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { $ } from 'bun';
import type { KnativeNextConfig, StorageConfig } from '../config';

/**
 * Returns the asset prefix URL from the storage configuration.
 * This is cloud-agnostic — the user declares `publicUrl` in their config.
 *
 * Used as Next.js `assetPrefix` so browsers load static assets
 * (_next/static/*) from the user's object storage bucket.
 */
export function getAssetPrefix(storage: StorageConfig): string {
  return storage.publicUrl;
}

/**
 * Recursively collects all file paths under a directory.
 */
function collectFiles(dir: string, baseDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, baseDir));
    } else {
      files.push(relative(baseDir, fullPath));
    }
  }
  return files;
}

/**
 * Uploads static assets to configured storage provider.
 * Assets include _next/static/* and public files.
 *
 * For GCS: also sets public read access, cache-control headers,
 * and verifies all files were uploaded successfully.
 */
export async function uploadAssets(config: KnativeNextConfig): Promise<void> {
  const assetsDir = join(process.cwd(), '.open-next', 'assets');

  console.info(`   Syncing to ${config.storage.provider}://${config.storage.bucket}`);

  switch (config.storage.provider) {
    case 'gcs': {
      // Upload with cache-control headers for immutable _next/static assets
      await $`gsutil -m -h "Cache-Control:public, max-age=31536000, immutable" cp -r ${assetsDir}/* gs://${config.storage.bucket}/`.quiet();
      // Ensure bucket has public read access for browser fetches
      await $`gsutil iam ch allUsers:objectViewer gs://${config.storage.bucket}`.quiet();

      // Post-upload verification: ensure all local files exist in GCS
      const localFiles = collectFiles(assetsDir, assetsDir);
      const gcsListResult = await $`gsutil ls -r gs://${config.storage.bucket}/**`.text();
      const gcsFiles = new Set(
        gcsListResult
          .split('\n')
          .filter((line) => line.startsWith('gs://'))
          .map((line) => line.replace(`gs://${config.storage.bucket}/`, '')),
      );

      const missing = localFiles.filter((f) => !gcsFiles.has(f));

      if (missing.length > 0) {
        console.info(
          `   ⚠️  ${missing.length} file(s) missing after bulk upload, retrying individually...`,
        );
        for (const file of missing) {
          const localPath = join(assetsDir, file);
          const gcsPath = `gs://${config.storage.bucket}/${file}`;
          await $`gsutil -h "Cache-Control:public, max-age=31536000, immutable" cp ${localPath} ${gcsPath}`.quiet();
        }
        console.info(`   ✅ Uploaded ${missing.length} missing file(s)`);
      }
      break;
    }
    case 's3':
      await $`aws s3 sync ${assetsDir} s3://${config.storage.bucket} --cache-control "public, max-age=31536000, immutable"`.quiet();
      break;
    case 'minio':
      // MinIO uses S3-compatible CLI
      await $`mc cp --recursive ${assetsDir}/* minio/${config.storage.bucket}/`.quiet();
      break;
    case 'azure':
      await $`az storage blob upload-batch -d ${config.storage.bucket} -s ${assetsDir}`.quiet();
      break;
    default:
      throw new Error(`Unsupported storage provider: ${config.storage.provider}`);
  }
}
