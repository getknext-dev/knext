import { unstable_cache } from 'next/cache';

const getLayoutData = unstable_cache(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      cachedAt: new Date().toISOString(),
      random: Math.random().toString(36).substring(7),
    };
  },
  ['nested-layout-data'],
  { revalidate: 60, tags: ['layout'] },
);

export default async function NestedLayout({ children }: { children: React.ReactNode }) {
  const layoutData = await getLayoutData();

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white mb-2">📦 Nested Layouts</h1>
        <p className="text-gray-400">Testing cache behavior across nested layouts</p>
      </div>

      <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-4 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🏗️</span>
            <div>
              <h2 className="text-lg font-semibold text-white">Parent Layout</h2>
              <span className="px-2 py-1 bg-indigo-500/20 text-indigo-300 text-xs rounded-full">
                revalidate: 60s | tag: layout
              </span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-indigo-300 font-mono text-sm">{layoutData.cachedAt}</p>
            <p className="text-gray-500 font-mono text-xs">ID: {layoutData.random}</p>
          </div>
        </div>
      </div>

      <div className="border-l-2 border-indigo-500/30 pl-6">{children}</div>
    </div>
  );
}
