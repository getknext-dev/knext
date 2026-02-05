import FileList from '@/components/FileList';
import UploadForm from '@/components/UploadForm';
import { getDbPool } from '@knative-next/lib';
import { unstable_cache, unstable_noStore } from 'next/cache';
import { Suspense } from 'react';

// Get files from database with caching and tags
const getFiles = unstable_cache(
  async () => {
    unstable_noStore(); // Prevent static prerendering
    try {
      const db = getDbPool();
      const result = await db.query(
        'SELECT id, name, size, mime_type, storage_path, uploaded_at FROM files ORDER BY uploaded_at DESC',
      );
      return result.rows;
    } catch (error) {
      console.error('Error fetching files:', error);
      return []; // Return empty array on error
    }
  },
  ['files-list'], // Cache key
  {
    tags: ['files'], // Tag for cache invalidation
    revalidate: 60, // Revalidate every 60 seconds as fallback
  },
);

// Files list component wrapped in Suspense
async function FilesContent() {
  const files = await getFiles();
  return <FileList files={files} />;
}

// Loading skeleton - matches file list item structure
function FilesLoading() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="animate-pulse flex items-center gap-4 p-3 bg-white/5 rounded-lg">
          {/* File icon skeleton */}
          <div className="w-10 h-10 bg-white/10 rounded" />
          {/* File details skeleton */}
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-white/10 rounded w-3/4" />
            <div className="h-3 bg-white/10 rounded w-1/2" />
          </div>
          {/* Actions skeleton */}
          <div className="w-20 h-8 bg-white/10 rounded" />
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  return (
    <div className="p-8">
      <div className="max-w-6xl mx-auto">
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl shadow-2xl border border-white/20 p-8">
          <h1 className="text-4xl font-bold text-white mb-2">File Manager</h1>
          <p className="text-purple-200 mb-8">Powered by Knative + Next.js</p>

          <div className="grid md:grid-cols-2 gap-8">
            <div>
              <h2 className="text-2xl font-semibold text-white mb-4">Upload File</h2>
              <UploadForm />
            </div>

            <div>
              <h2 className="text-2xl font-semibold text-white mb-4">Your Files</h2>
              <Suspense fallback={<FilesLoading />}>
                <FilesContent />
              </Suspense>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
