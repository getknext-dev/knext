// Force static generation
export const dynamic = 'force-static';

async function getData() {
  // This runs at build time (or ISR revalidation)
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    buildTime: new Date().toISOString(),
    randomValue: Math.random().toString(36).substring(7),
    environment: process.env.NODE_ENV || 'unknown',
  };
}

export default async function StaticPage() {
  const data = await getData();
  const renderTime = new Date().toISOString();

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">🗄️ Static Page</h1>
        <span className="px-3 py-1 bg-green-500/20 text-green-300 rounded-full">force-static</span>
      </div>

      <div className="bg-white/5 border border-green-500/30 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-4">Pre-rendered Data</h2>
        <div className="space-y-4">
          <div>
            <p className="text-gray-400 text-sm">Build/Revalidation Time</p>
            <p className="text-green-300 font-mono text-lg">{data.buildTime}</p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Random Value (frozen at build)</p>
            <p className="text-white font-mono text-lg">{data.randomValue}</p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Environment</p>
            <p className="text-purple-300">{data.environment}</p>
          </div>
        </div>
      </div>

      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 mb-6">
        <p className="text-gray-500 text-sm">
          Current render time: <span className="text-gray-300 font-mono">{renderTime}</span>
        </p>
        <p className="text-gray-600 text-xs mt-2">
          Note: In production with caching, this should match the build time above. If they differ,
          the page was just regenerated.
        </p>
      </div>

      <div className="p-6 bg-green-500/10 border border-green-500/30 rounded-xl">
        <h3 className="text-lg font-semibold text-green-300 mb-2">✅ Expected Behavior</h3>
        <ul className="text-gray-300 text-sm space-y-2 list-disc list-inside">
          <li>The random value stays the same on every refresh</li>
          <li>Build time and render time should be identical</li>
          <li>This page serves from cache instantly</li>
          <li>Only changes when explicitly revalidated</li>
        </ul>
      </div>
    </div>
  );
}
