interface SearchParams {
  q?: string;
  page?: string;
  sort?: string;
}

// This page uses searchParams, making it dynamic at request time
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const query = params.q || '';
  const page = params.page || '1';
  const sort = params.sort || 'relevance';

  const renderTime = new Date().toISOString();
  const requestId = Math.random().toString(36).substring(2, 10);

  // Simulate search results based on query
  const mockResults = query
    ? [
        { id: 1, title: `Result for "${query}" #1`, score: 0.95 },
        { id: 2, title: `Result for "${query}" #2`, score: 0.87 },
        { id: 3, title: `Result for "${query}" #3`, score: 0.76 },
      ]
    : [];

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">🔍 Search Params</h1>
        <span className="px-3 py-1 bg-blue-500/20 text-blue-300 rounded-full">
          uses searchParams (dynamic)
        </span>
      </div>

      {/* Current Parameters */}
      <div className="bg-white/5 border border-blue-500/30 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-4">Current Search Parameters</h2>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-gray-400 text-sm">Query (q)</p>
            <p className="text-blue-300 font-mono">{query || '(empty)'}</p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Page</p>
            <p className="text-white font-mono">{page}</p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Sort</p>
            <p className="text-purple-300 font-mono">{sort}</p>
          </div>
        </div>
      </div>

      {/* Try different URLs */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-4">Try These URLs</h2>
        <div className="space-y-2 font-mono text-sm">
          <a
            href="/cache-tests/dynamic-static/search?q=hello"
            className="block text-blue-400 hover:text-blue-300 transition-colors"
          >
            ?q=hello
          </a>
          <a
            href="/cache-tests/dynamic-static/search?q=world&page=2"
            className="block text-blue-400 hover:text-blue-300 transition-colors"
          >
            ?q=world&page=2
          </a>
          <a
            href="/cache-tests/dynamic-static/search?q=test&sort=date"
            className="block text-blue-400 hover:text-blue-300 transition-colors"
          >
            ?q=test&sort=date
          </a>
          <a
            href="/cache-tests/dynamic-static/search"
            className="block text-gray-400 hover:text-gray-300 transition-colors"
          >
            (no params)
          </a>
        </div>
      </div>

      {/* Results */}
      {mockResults.length > 0 && (
        <div className="bg-white/5 border border-green-500/30 rounded-xl p-6 mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">Search Results</h2>
          <div className="space-y-3">
            {mockResults.map((result) => (
              <div
                key={result.id}
                className="flex items-center justify-between p-3 bg-black/20 rounded-lg"
              >
                <span className="text-white">{result.title}</span>
                <span className="text-green-300 text-sm">Score: {result.score}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Request info */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 mb-6">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">
            Rendered at: <span className="text-gray-300 font-mono">{renderTime}</span>
          </span>
          <span className="text-gray-500">
            Request ID: <span className="text-purple-300 font-mono">{requestId}</span>
          </span>
        </div>
      </div>

      <div className="p-6 bg-blue-500/10 border border-blue-500/30 rounded-xl">
        <h3 className="text-lg font-semibold text-blue-300 mb-2">🔍 Expected Behavior</h3>
        <ul className="text-gray-300 text-sm space-y-2 list-disc list-inside">
          <li>Using searchParams makes the page dynamic</li>
          <li>Different query strings = different responses</li>
          <li>Request ID changes on every request</li>
          <li>Each unique URL combination may be cached separately (PPR)</li>
        </ul>
      </div>
    </div>
  );
}
