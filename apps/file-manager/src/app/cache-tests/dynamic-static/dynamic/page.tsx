// Force dynamic rendering on every request
export const dynamic = 'force-dynamic';

async function getData() {
  // This runs on every request
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    serverTime: new Date().toISOString(),
    randomValue: Math.random().toString(36).substring(7),
    requestId: Math.random().toString(36).substring(2, 10),
  };
}

export default async function DynamicPage() {
  const data = await getData();
  const renderTime = new Date().toISOString();

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">⚡ Dynamic Page</h1>
        <span className="px-3 py-1 bg-yellow-500/20 text-yellow-300 rounded-full">
          force-dynamic
        </span>
      </div>

      <div className="bg-white/5 border border-yellow-500/30 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-4">Fresh Data (Every Request)</h2>
        <div className="space-y-4">
          <div>
            <p className="text-gray-400 text-sm">Server Time</p>
            <p className="text-yellow-300 font-mono text-lg">{data.serverTime}</p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Random Value (changes every request)</p>
            <p className="text-white font-mono text-lg">{data.randomValue}</p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Request ID</p>
            <p className="text-purple-300 font-mono">{data.requestId}</p>
          </div>
        </div>
      </div>

      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 mb-6">
        <p className="text-gray-500 text-sm">
          Render time: <span className="text-gray-300 font-mono">{renderTime}</span>
        </p>
        <p className="text-gray-600 text-xs mt-2">
          This should always be very close to the server time above.
        </p>
      </div>

      <div className="p-6 bg-yellow-500/10 border border-yellow-500/30 rounded-xl">
        <h3 className="text-lg font-semibold text-yellow-300 mb-2">⚡ Expected Behavior</h3>
        <ul className="text-gray-300 text-sm space-y-2 list-disc list-inside">
          <li>The random value changes on every refresh</li>
          <li>Server time updates to current time on each request</li>
          <li>A new Request ID is generated each time</li>
          <li>This page is never cached - always fresh</li>
          <li>May have higher latency than static pages</li>
        </ul>
      </div>
    </div>
  );
}
