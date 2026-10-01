'use server';

import { getDbPool, getMinioClient } from '@getknext/lib/clients';
import { revalidatePath, revalidateTag } from 'next/cache';

export async function uploadFile(formData: FormData) {
  const file = formData.get('file') as File;

  if (!file) {
    return { error: 'No file provided' };
  }

  try {
    const db = getDbPool();

    // Try to upload to object storage if available
    let storagePath = null;
    try {
      const minio = getMinioClient();
      const bucketName = 'assets';

      const bucketExists = await minio.bucketExists(bucketName);
      if (!bucketExists) {
        await minio.makeBucket(bucketName, 'us-east-1');
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      await minio.putObject(bucketName, file.name, buffer, buffer.length);
      storagePath = `${bucketName}/${file.name}`;
    } catch (storageError) {
      // #1777 round 3: distinguish "the minio SDK itself failed to load"
      // (`require('minio')` resolution failure — the webpack-standalone
      // defect this round fixes) from an ordinary storage/network error
      // (no reachable MinIO in this environment, which IS expected here and
      // must not be conflated with it). Both land in this catch — the outer
      // catch's generic "Failed to upload file" cannot tell them apart
      // (self-contained-e2e.test.ts's upload assertion, #1784). A distinct,
      // greppable marker on ONLY the module-resolution case lets a test
      // assert the SDK loaded without needing a live MinIO target.
      const code = (storageError as { code?: string } | undefined)?.code;
      if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
        console.error('[minio-sdk-load-failed]', storageError);
      } else {
        console.warn('Object storage unavailable, storing metadata only:', storageError);
      }
    }

    // Store file metadata in database
    await db.query(
      `INSERT INTO files (name, size, mime_type, storage_path, uploaded_at) 
       VALUES ($1, $2, $3, $4, NOW()) 
       ON CONFLICT (name) DO UPDATE SET size = $2, uploaded_at = NOW()`,
      [file.name, file.size, file.type || 'application/octet-stream', storagePath],
    );

    // Invalidate the files cache tag - this refreshes FilesContent
    revalidateTag('files', 'default'); // Next.js 16 requires profile param
    revalidatePath('/'); // Also revalidate the path as backup

    return { success: true };
  } catch (error) {
    console.error('Upload error:', error);
    return { error: 'Failed to upload file' };
  }
}
