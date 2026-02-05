import { unstable_cache } from 'next/cache';

const getChildData = unstable_cache(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { cachedAt: new Date().toISOString(), random: Math.random().toString(36).substring(7) };
  },
  ['child-b-data'],
  { revalidate: 45, tags: ['child-b'] },
);

export default async function ChildBPage() {
  const data = await getChildData();
  return (
    <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🅱️</span>
          <div>
            <h2 className="text-lg font-semibold text-white">Child B</h2>
            <span className="px-2 py-1 bg-blue-500/20 text-blue-300 text-xs rounded-full">
              revalidate: 45s
            </span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-blue-300 font-mono text-sm">{data.cachedAt}</p>
          <p className="text-gray-500 font-mono text-xs">ID: {data.random}</p>
        </div>
      </div>
    </div>
  );
}
