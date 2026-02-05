import Link from 'next/link';

export const metadata = {
  title: 'Dynamic vs Static | Cache Tests',
};

export default function DynamicStaticPage() {
  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">⚡ Dynamic vs Static Rendering</h1>
        <p className="text-gray-400">Compare force-dynamic and force-static behaviors</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Link
          href="/cache-tests/dynamic-static/static"
          className="group bg-white/5 hover:bg-white/10 border border-green-500/30 hover:border-green-500/50 rounded-xl p-6 transition-all"
        >
          <div className="flex items-center gap-3 mb-4">
            <span className="text-3xl">🗄️</span>
            <div>
              <h2 className="text-xl font-semibold text-white group-hover:text-green-300 transition-colors">
                Static Page
              </h2>
              <span className="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded-full">
                force-static
              </span>
            </div>
          </div>
          <p className="text-gray-400 text-sm">
            Pre-rendered at build time. Same content for all users until revalidated.
          </p>
        </Link>

        <Link
          href="/cache-tests/dynamic-static/dynamic"
          className="group bg-white/5 hover:bg-white/10 border border-yellow-500/30 hover:border-yellow-500/50 rounded-xl p-6 transition-all"
        >
          <div className="flex items-center gap-3 mb-4">
            <span className="text-3xl">⚡</span>
            <div>
              <h2 className="text-xl font-semibold text-white group-hover:text-yellow-300 transition-colors">
                Dynamic Page
              </h2>
              <span className="px-2 py-1 bg-yellow-500/20 text-yellow-300 text-xs rounded-full">
                force-dynamic
              </span>
            </div>
          </div>
          <p className="text-gray-400 text-sm">
            Rendered on every request. Fresh data but higher latency.
          </p>
        </Link>

        <Link
          href="/cache-tests/dynamic-static/headers"
          className="group bg-white/5 hover:bg-white/10 border border-purple-500/30 hover:border-purple-500/50 rounded-xl p-6 transition-all"
        >
          <div className="flex items-center gap-3 mb-4">
            <span className="text-3xl">📨</span>
            <div>
              <h2 className="text-xl font-semibold text-white group-hover:text-purple-300 transition-colors">
                Headers/Cookies
              </h2>
              <span className="px-2 py-1 bg-purple-500/20 text-purple-300 text-xs rounded-full">
                auto-dynamic
              </span>
            </div>
          </div>
          <p className="text-gray-400 text-sm">
            Uses headers() or cookies() - automatically becomes dynamic.
          </p>
        </Link>

        <Link
          href="/cache-tests/dynamic-static/search"
          className="group bg-white/5 hover:bg-white/10 border border-blue-500/30 hover:border-blue-500/50 rounded-xl p-6 transition-all"
        >
          <div className="flex items-center gap-3 mb-4">
            <span className="text-3xl">🔍</span>
            <div>
              <h2 className="text-xl font-semibold text-white group-hover:text-blue-300 transition-colors">
                Search Params
              </h2>
              <span className="px-2 py-1 bg-blue-500/20 text-blue-300 text-xs rounded-full">
                searchParams
              </span>
            </div>
          </div>
          <p className="text-gray-400 text-sm">Uses searchParams - dynamic at request time.</p>
        </Link>
      </div>

      <div className="mt-8 p-6 bg-blue-500/10 border border-blue-500/30 rounded-xl">
        <h3 className="text-lg font-semibold text-blue-300 mb-2">🔍 What to Test</h3>
        <ul className="text-gray-300 text-sm space-y-2 list-disc list-inside">
          <li>Static page: timestamp stays the same on refresh</li>
          <li>Dynamic page: timestamp changes on every refresh</li>
          <li>Headers page: reads request headers, always dynamic</li>
          <li>Search page: try adding ?q=test to the URL</li>
        </ul>
      </div>
    </div>
  );
}
