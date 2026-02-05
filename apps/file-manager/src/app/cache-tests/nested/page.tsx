import { unstable_cache } from 'next/cache';
import Link from 'next/link';

const getPageData = unstable_cache(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      cachedAt: new Date().toISOString(),
      random: Math.random().toString(36).substring(7),
    };
  },
  ['nested-page-data'],
  { revalidate: 30, tags: ['nested-page'] },
);

export default async function NestedPage() {
  const pageData = await getPageData();

  return (
    <div className="space-y-6">
      <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📄</span>
            <div>
              <h2 className="text-lg font-semibold text-white">Page Content</h2>
              <span className="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded-full">
                revalidate: 30s | tag: nested-page
              </span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-green-300 font-mono text-sm">{pageData.cachedAt}</p>
            <p className="text-gray-500 font-mono text-xs">ID: {pageData.random}</p>
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <Link
          href="/cache-tests/nested/child-a"
          className="px-4 py-2 bg-purple-500/20 text-purple-300 rounded-lg hover:bg-purple-500/30 transition-colors"
        >
          Child A
        </Link>
        <Link
          href="/cache-tests/nested/child-b"
          className="px-4 py-2 bg-blue-500/20 text-blue-300 rounded-lg hover:bg-blue-500/30 transition-colors"
        >
          Child B
        </Link>
      </div>

      <div className="p-4 bg-blue-500/10 border border-blue-500/30 rounded-xl">
        <h3 className="text-blue-300 font-semibold mb-2">🔍 What to Test</h3>
        <ul className="text-gray-300 text-sm space-y-1 list-disc list-inside">
          <li>Parent layout and page have different revalidation times</li>
          <li>Navigate to Child A/B - layout stays, page changes</li>
          <li>Compare timestamps between layout and page</li>
        </ul>
      </div>
    </div>
  );
}
