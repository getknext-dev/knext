export const revalidate = 30;

async function fetchWithForceCache() {
  const res = await fetch('https://httpbin.org/uuid', {
    cache: 'force-cache',
    next: { tags: ['fetch-uuid'] },
  });
  return res.json();
}

async function fetchWithNoStore() {
  const res = await fetch('https://httpbin.org/uuid', { cache: 'no-store' });
  return res.json();
}

async function fetchWithRevalidate() {
  const res = await fetch('https://httpbin.org/uuid', {
    next: { revalidate: 60, tags: ['fetch-revalidate'] },
  });
  return res.json();
}

export default async function FetchCachePage() {
  const forceCache = await fetchWithForceCache();
  const noStore = await fetchWithNoStore();
  const revalidateData = await fetchWithRevalidate();
  const renderTime = new Date().toISOString();

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">🔄 Fetch Cache Controls</h1>
        <p className="text-gray-400">Testing fetch() cache and next options</p>
      </div>

      <div className="grid gap-6">
        <div className="bg-white/5 border border-green-500/30 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">💾</span>
            <h3 className="text-lg font-semibold text-white">force-cache</h3>
            <span className="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded-full">
              tag: fetch-uuid
            </span>
          </div>
          <p className="text-green-300 font-mono">{forceCache.uuid}</p>
          <p className="text-gray-500 text-sm mt-2">Cached indefinitely until revalidated</p>
        </div>

        <div className="bg-white/5 border border-red-500/30 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">🔴</span>
            <h3 className="text-lg font-semibold text-white">no-store</h3>
          </div>
          <p className="text-red-300 font-mono">{noStore.uuid}</p>
          <p className="text-gray-500 text-sm mt-2">Never cached - always fresh</p>
        </div>

        <div className="bg-white/5 border border-yellow-500/30 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">⏰</span>
            <h3 className="text-lg font-semibold text-white">next.revalidate: 60</h3>
            <span className="px-2 py-1 bg-yellow-500/20 text-yellow-300 text-xs rounded-full">
              tag: fetch-revalidate
            </span>
          </div>
          <p className="text-yellow-300 font-mono">{revalidateData.uuid}</p>
          <p className="text-gray-500 text-sm mt-2">Cached for 60 seconds</p>
        </div>

        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
          <p className="text-gray-500 text-sm">
            Rendered at: <span className="text-gray-300 font-mono">{renderTime}</span>
          </p>
        </div>
      </div>

      <div className="mt-8 p-6 bg-blue-500/10 border border-blue-500/30 rounded-xl">
        <h3 className="text-blue-300 font-semibold mb-2">🔍 What to Test</h3>
        <ul className="text-gray-300 text-sm space-y-1 list-disc list-inside">
          <li>force-cache UUID stays the same on refresh</li>
          <li>no-store UUID changes every time</li>
          <li>revalidate UUID changes after 60 seconds</li>
        </ul>
      </div>
    </div>
  );
}
