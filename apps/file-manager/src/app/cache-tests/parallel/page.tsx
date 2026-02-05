import { unstable_cache } from 'next/cache';
import { Suspense } from 'react';

// Revalidate page every 30 seconds
export const revalidate = 30;

// Different cache configurations for parallel fetches - minimal delays for reliability
const fetchFast = unstable_cache(
  async () => {
    return {
      name: 'Fast API',
      time: new Date().toISOString(),
      latency: '~10ms',
      random: Math.random().toString(36).substring(7),
    };
  },
  ['parallel-fast'],
  { revalidate: 30, tags: ['parallel', 'fast'] },
);

const fetchMedium = unstable_cache(
  async () => {
    return {
      name: 'Medium API',
      time: new Date().toISOString(),
      latency: '~10ms',
      random: Math.random().toString(36).substring(7),
    };
  },
  ['parallel-medium'],
  { revalidate: 60, tags: ['parallel', 'medium'] },
);

const fetchSlow = unstable_cache(
  async () => {
    return {
      name: 'Slow API',
      time: new Date().toISOString(),
      latency: '~10ms',
      random: Math.random().toString(36).substring(7),
    };
  },
  ['parallel-slow'],
  { revalidate: 120, tags: ['parallel', 'slow'] },
);

// Non-cached fetch (always fresh)
async function fetchRealtime() {
  return {
    name: 'Realtime API',
    time: new Date().toISOString(),
    latency: '~0ms',
    random: Math.random().toString(36).substring(7),
  };
}

function DataCard({
  data,
  color,
  revalidateTime,
}: {
  data: { name: string; time: string; latency: string; random: string };
  color: string;
  revalidateTime: string;
}) {
  const borderColor =
    color === 'green'
      ? 'border-green-500/30'
      : color === 'yellow'
        ? 'border-yellow-500/30'
        : color === 'red'
          ? 'border-red-500/30'
          : 'border-purple-500/30';
  const textColor =
    color === 'green'
      ? 'text-green-300'
      : color === 'yellow'
        ? 'text-yellow-300'
        : color === 'red'
          ? 'text-red-300'
          : 'text-purple-300';
  const bgColor =
    color === 'green'
      ? 'bg-green-500/20'
      : color === 'yellow'
        ? 'bg-yellow-500/20'
        : color === 'red'
          ? 'bg-red-500/20'
          : 'bg-purple-500/20';

  return (
    <div className={`bg-white/5 border ${borderColor} rounded-xl p-6`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">{data.name}</h3>
        <span className={`px-2 py-1 ${bgColor} ${textColor} text-xs rounded-full`}>
          {revalidateTime}
        </span>
      </div>
      <div className="space-y-2 text-sm">
        <p className="text-gray-400">
          Cached at: <span className={`${textColor} font-mono`}>{data.time}</span>
        </p>
        <p className="text-gray-500 font-mono text-xs">ID: {data.random}</p>
      </div>
    </div>
  );
}

async function SlowDataCard() {
  const data = await fetchSlow();
  return <DataCard data={data} color="red" revalidateTime="120s" />;
}

async function MediumDataCard() {
  const data = await fetchMedium();
  return <DataCard data={data} color="yellow" revalidateTime="60s" />;
}

async function FastDataCard() {
  const data = await fetchFast();
  return <DataCard data={data} color="green" revalidateTime="30s" />;
}

async function RealtimeDataCard() {
  const data = await fetchRealtime();
  return <DataCard data={data} color="purple" revalidateTime="no-cache" />;
}

function Loading({ name }: { name: string }) {
  return (
    <div className="bg-white/5 border border-gray-500/30 rounded-xl p-6 animate-pulse">
      <div className="flex items-center justify-between mb-4">
        <div className="h-6 w-24 bg-gray-700 rounded" />
        <div className="h-6 w-16 bg-gray-700 rounded-full" />
      </div>
      <div className="space-y-2">
        <div className="h-4 w-full bg-gray-700 rounded" />
        <div className="h-4 w-2/3 bg-gray-700 rounded" />
      </div>
      <p className="text-gray-600 text-xs mt-4">Loading {name}...</p>
    </div>
  );
}

export default async function ParallelPage() {
  const startTime = Date.now();

  // Parallel fetch with Promise.all
  const [fast, medium, slow] = await Promise.all([fetchFast(), fetchMedium(), fetchSlow()]);

  const parallelDuration = Date.now() - startTime;
  const renderTime = new Date().toISOString();

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">🔀 Parallel Fetches</h1>
        <p className="text-gray-400">Multiple data fetches with different cache configurations</p>
      </div>

      {/* Timing info */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-6">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-gray-400 text-sm">Total fetch time (parallel)</p>
            <p className="text-white font-mono text-xl">{parallelDuration}ms</p>
          </div>
          <div className="text-gray-500">(cached data returns instantly)</div>
        </div>
      </div>

      {/* Promise.all results */}
      <h2 className="text-xl font-semibold text-white mb-4">Promise.all (Parallel)</h2>
      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <DataCard data={fast} color="green" revalidateTime="30s" />
        <DataCard data={medium} color="yellow" revalidateTime="60s" />
        <DataCard data={slow} color="red" revalidateTime="120s" />
      </div>

      {/* Streaming with Suspense */}
      <h2 className="text-xl font-semibold text-white mb-4">Streaming with Suspense</h2>
      <div className="grid gap-4 md:grid-cols-4 mb-6">
        <Suspense fallback={<Loading name="Fast API" />}>
          <FastDataCard />
        </Suspense>
        <Suspense fallback={<Loading name="Medium API" />}>
          <MediumDataCard />
        </Suspense>
        <Suspense fallback={<Loading name="Slow API" />}>
          <SlowDataCard />
        </Suspense>
        <Suspense fallback={<Loading name="Realtime API" />}>
          <RealtimeDataCard />
        </Suspense>
      </div>

      {/* Render time */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 mb-6">
        <p className="text-gray-500 text-sm">
          Page rendered at: <span className="text-gray-300 font-mono">{renderTime}</span>
        </p>
      </div>

      <div className="p-6 bg-blue-500/10 border border-blue-500/30 rounded-xl">
        <h3 className="text-lg font-semibold text-blue-300 mb-2">🔍 What to Test</h3>
        <ul className="text-gray-300 text-sm space-y-2 list-disc list-inside">
          <li>Fast (30s), Medium (60s), Slow (120s) have different revalidation times</li>
          <li>All fetches return from cache instantly (0-10ms)</li>
          <li>Suspense boundaries stream independently</li>
          <li>Realtime API is not cached - always fresh on each request</li>
          <li>Compare timestamps between cards after waiting for revalidation</li>
        </ul>
      </div>
    </div>
  );
}
