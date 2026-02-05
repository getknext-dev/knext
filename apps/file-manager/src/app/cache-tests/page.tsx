import Link from 'next/link';

export const metadata = {
  title: 'Cache Tests | Knative File Manager',
  description: 'Comprehensive cache testing scenarios',
};

const scenarios = [
  {
    name: 'Time-Based Revalidation',
    href: '/cache-tests/time-based',
    description: 'Test revalidate: N seconds behavior',
    icon: '⏱️',
    tags: ['ISR', 'revalidate'],
  },
  {
    name: 'On-Demand Revalidation',
    href: '/cache-tests/on-demand',
    description: 'Test revalidateTag() and revalidatePath()',
    icon: '🎯',
    tags: ['tags', 'path'],
  },
  {
    name: 'Dynamic vs Static',
    href: '/cache-tests/dynamic-static',
    description: 'Compare force-dynamic vs force-static',
    icon: '⚡',
    tags: ['dynamic', 'static'],
  },
  {
    name: 'Parallel Fetches',
    href: '/cache-tests/parallel',
    description: 'Multiple fetches with different cache configs',
    icon: '🔀',
    tags: ['parallel', 'waterfall'],
  },
  {
    name: 'Nested Layouts',
    href: '/cache-tests/nested',
    description: 'Nested layouts with mixed caching',
    icon: '📦',
    tags: ['layouts', 'segments'],
  },
  {
    name: 'Fetch Cache Controls',
    href: '/cache-tests/fetch-cache',
    description: 'Test fetch() cache and next options',
    icon: '🔄',
    tags: ['no-store', 'force-cache'],
  },
];

export default function CacheTestsPage() {
  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">🧪 Cache Test Scenarios</h1>
        <p className="text-gray-400">
          Comprehensive tests to validate caching behavior in the distributed deployment
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {scenarios.map((scenario) => (
          <Link
            key={scenario.href}
            href={scenario.href}
            className="group bg-white/5 hover:bg-white/10 border border-white/10 hover:border-purple-500/50 rounded-xl p-6 transition-all duration-300"
          >
            <div className="text-4xl mb-4">{scenario.icon}</div>
            <h2 className="text-xl font-semibold text-white mb-2 group-hover:text-purple-300 transition-colors">
              {scenario.name}
            </h2>
            <p className="text-gray-400 text-sm mb-4">{scenario.description}</p>
            <div className="flex flex-wrap gap-2">
              {scenario.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-1 bg-purple-500/20 text-purple-300 text-xs rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-8 p-6 bg-blue-500/10 border border-blue-500/30 rounded-xl">
        <h3 className="text-lg font-semibold text-blue-300 mb-2">📖 How to Use</h3>
        <ol className="text-gray-300 text-sm space-y-2 list-decimal list-inside">
          <li>Open each test scenario in a new tab</li>
          <li>Note the timestamps and cache indicators</li>
          <li>Refresh the page to observe caching behavior</li>
          <li>Use the Cache Monitor to verify cache hits/misses</li>
          <li>Test invalidation using the provided controls</li>
        </ol>
      </div>
    </div>
  );
}
