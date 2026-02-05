import { unstable_cache } from 'next/cache';

const getChildData = unstable_cache(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { cachedAt: new Date().toISOString(), random: Math.random().toString(36).substring(7) };
  },
  ['child-a-data'],
  { revalidate: 15, tags: ['child-a'] },
);

export default async function ChildAPage() {
  const data = await getChildData();
  return (
    <div className="bg-purple-500/10 border border-purple-500/30 rounded-xl p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🅰️</span>
          <div>
            <h2 className="text-lg font-semibold text-white">Child A</h2>
            <span className="px-2 py-1 bg-purple-500/20 text-purple-300 text-xs rounded-full">
              revalidate: 15s
            </span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-purple-300 font-mono text-sm">{data.cachedAt}</p>
          <p className="text-gray-500 font-mono text-xs">ID: {data.random}</p>
        </div>
      </div>
    </div>
  );
}
