import { cookies, headers } from 'next/headers';

// This page automatically becomes dynamic because it uses headers()/cookies()

export default async function HeadersPage() {
  const headersList = await headers();
  const cookieStore = await cookies();

  const userAgent = headersList.get('user-agent') || 'Unknown';
  const host = headersList.get('host') || 'Unknown';
  const acceptLanguage = headersList.get('accept-language') || 'Unknown';
  const xForwardedFor = headersList.get('x-forwarded-for') || 'Direct';

  const allCookies = cookieStore.getAll();

  const renderTime = new Date().toISOString();

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">📨 Headers & Cookies</h1>
        <span className="px-3 py-1 bg-purple-500/20 text-purple-300 rounded-full">
          auto-dynamic (uses headers/cookies)
        </span>
      </div>

      <div className="grid gap-6">
        {/* Headers */}
        <div className="bg-white/5 border border-purple-500/30 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Request Headers</h2>
          <div className="space-y-3">
            <div>
              <p className="text-gray-400 text-sm">Host</p>
              <p className="text-purple-300 font-mono text-sm break-all">{host}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">User-Agent</p>
              <p className="text-white font-mono text-xs break-all">{userAgent}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Accept-Language</p>
              <p className="text-blue-300 font-mono text-sm">{acceptLanguage}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">X-Forwarded-For</p>
              <p className="text-green-300 font-mono text-sm">{xForwardedFor}</p>
            </div>
          </div>
        </div>

        {/* Cookies */}
        <div className="bg-white/5 border border-blue-500/30 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Cookies</h2>
          {allCookies.length > 0 ? (
            <div className="space-y-2">
              {allCookies.map((cookie) => (
                <div key={cookie.name} className="flex items-center gap-2">
                  <span className="text-blue-300 font-mono text-sm">{cookie.name}:</span>
                  <span className="text-white font-mono text-sm">{cookie.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500 text-sm">No cookies found</p>
          )}
        </div>

        {/* Render time */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
          <p className="text-gray-500 text-sm">
            Rendered at: <span className="text-gray-300 font-mono">{renderTime}</span>
          </p>
        </div>
      </div>

      <div className="mt-8 p-6 bg-purple-500/10 border border-purple-500/30 rounded-xl">
        <h3 className="text-lg font-semibold text-purple-300 mb-2">📨 Expected Behavior</h3>
        <ul className="text-gray-300 text-sm space-y-2 list-disc list-inside">
          <li>Using headers() or cookies() makes the page dynamic</li>
          <li>No export dynamic = 'force-dynamic' needed</li>
          <li>Headers are unique per request - cannot be cached</li>
          <li>Render time changes on every refresh</li>
          <li>Check Cache Monitor - this should never be a cache HIT</li>
        </ul>
      </div>
    </div>
  );
}
