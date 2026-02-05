import { unstable_cache } from 'next/cache';

// Revalidate every 10 seconds
export const revalidate = 10;

async function getServerTime() {
  // Simulate API call
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    time: new Date().toISOString(),
    random: Math.random().toString(36).substring(7),
  };
}

// Cached function with 30-second revalidation
const getCachedData30s = unstable_cache(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      label: '30s cache',
      time: new Date().toISOString(),
      random: Math.random().toString(36).substring(7),
    };
  },
  ['time-based-30s'],
  { revalidate: 30, tags: ['time-based'] },
);

// Cached function with 60-second revalidation
const getCachedData60s = unstable_cache(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      label: '60s cache',
      time: new Date().toISOString(),
      random: Math.random().toString(36).substring(7),
    };
  },
  ['time-based-60s'],
  { revalidate: 60, tags: ['time-based'] },
);

export default async function TimeBasedPage() {
  const pageData = await getServerTime();
  const data30s = await getCachedData30s();
  const data60s = await getCachedData60s();

  const renderTime = new Date().toISOString();

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">⏱️ Time-Based Revalidation</h1>
        <p className="text-gray-400">Testing ISR with different revalidation intervals</p>
      </div>

      <div className="grid gap-6">
        {/* Page-level revalidation */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 bg-yellow-500/20 text-yellow-300 text-sm rounded-full">
              Page: revalidate = 10s
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-gray-400 text-sm">Generated At</p>
              <p className="text-white font-mono">{pageData.time}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Random ID</p>
              <p className="text-purple-300 font-mono">{pageData.random}</p>
            </div>
          </div>
          <p className="text-gray-500 text-xs mt-4">
            This entire page revalidates every 10 seconds. Refresh to see if the values change.
          </p>
        </div>

        {/* 30-second cache */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 bg-green-500/20 text-green-300 text-sm rounded-full">
              unstable_cache: 30s
            </span>
            <span className="px-3 py-1 bg-purple-500/20 text-purple-300 text-xs rounded-full">
              tag: time-based
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-gray-400 text-sm">Cached At</p>
              <p className="text-white font-mono">{data30s.time}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Random ID</p>
              <p className="text-green-300 font-mono">{data30s.random}</p>
            </div>
          </div>
        </div>

        {/* 60-second cache */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 bg-blue-500/20 text-blue-300 text-sm rounded-full">
              unstable_cache: 60s
            </span>
            <span className="px-3 py-1 bg-purple-500/20 text-purple-300 text-xs rounded-full">
              tag: time-based
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-gray-400 text-sm">Cached At</p>
              <p className="text-white font-mono">{data60s.time}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Random ID</p>
              <p className="text-blue-300 font-mono">{data60s.random}</p>
            </div>
          </div>
        </div>

        {/* Render timestamp */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
          <p className="text-gray-500 text-sm">
            Page rendered at: <span className="text-gray-300 font-mono">{renderTime}</span>
          </p>
        </div>
      </div>

      <div className="mt-8 p-6 bg-blue-500/10 border border-blue-500/30 rounded-xl">
        <h3 className="text-lg font-semibold text-blue-300 mb-2">🔍 What to Test</h3>
        <ul className="text-gray-300 text-sm space-y-2 list-disc list-inside">
          <li>Refresh immediately - all values should stay the same (cache hit)</li>
          <li>Wait 10+ seconds, refresh - page data should update</li>
          <li>Wait 30+ seconds - the 30s cached data should update</li>
          <li>Wait 60+ seconds - the 60s cached data should update</li>
          <li>Compare render timestamp vs cached timestamps</li>
        </ul>
      </div>
    </div>
  );
}
