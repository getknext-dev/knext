'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface AuditLog {
  id: number;
  action: string;
  details: string;
  created_at: string;
}

interface AuditData {
  logs: AuditLog[];
  total: number;
  page: number;
  hasMore: boolean;
}

function SkeletonRow() {
  return (
    <tr className="border-t border-white/10 animate-pulse">
      <td className="p-4">
        <div className="h-4 bg-white/10 rounded w-40" />
      </td>
      <td className="p-4">
        <div className="h-6 bg-white/10 rounded w-16" />
      </td>
      <td className="p-4">
        <div className="h-4 bg-white/10 rounded w-64" />
      </td>
    </tr>
  );
}

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(
    async (pageNum: number, append = true) => {
      if (loading) return;

      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/audit?page=${pageNum}`);
        if (!res.ok) throw new Error('Failed to fetch');

        const data: AuditData = await res.json();

        setLogs((prev) => (append ? [...prev, ...data.logs] : data.logs));
        setHasMore(data.hasMore);
        setTotal(data.total);
        setPage(pageNum);
      } catch (err) {
        setError('Failed to load audit logs. Please try again.');
        console.error('Fetch error:', err);
      } finally {
        setLoading(false);
        setInitialLoading(false);
      }
    },
    [loading],
  );

  // Initial load
  useEffect(() => {
    fetchLogs(0, false);
    // eslint-disable-next-line -- intentional: only run on mount
  }, [fetchLogs]);

  // Infinite scroll observer
  useEffect(() => {
    if (loading || !hasMore) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          fetchLogs(page + 1);
        }
      },
      { threshold: 0.1 },
    );

    if (loadMoreRef.current) {
      observerRef.current.observe(loadMoreRef.current);
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [hasMore, loading, page, fetchLogs]);

  return (
    <div className="p-8 text-white">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Audit Logs</h1>
          <p className="text-gray-400 mt-1">
            {initialLoading ? (
              <span className="inline-block w-32 h-4 bg-white/10 rounded animate-pulse" />
            ) : (
              `${logs.length.toLocaleString()} of ${total.toLocaleString()} events loaded`
            )}
          </p>
        </div>

        {/* Cache invalidation hint */}
        <div className="text-sm text-purple-300 bg-purple-500/10 px-4 py-2 rounded-lg border border-purple-500/30">
          <span className="font-mono">Tag: "audit"</span>
          <span className="text-gray-400 ml-2">← Use for invalidation</span>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/20 text-red-200 p-4 rounded-lg mb-4">
          {error}
          <button
            type="button"
            onClick={() => fetchLogs(0, false)}
            className="ml-4 underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      <div className="bg-white/5 rounded-xl overflow-hidden max-h-[600px] overflow-y-auto">
        <table className="w-full text-left">
          <thead className="bg-white/10 sticky top-0">
            <tr>
              <th className="p-4">Time</th>
              <th className="p-4">Action</th>
              <th className="p-4">Details</th>
            </tr>
          </thead>
          <tbody>
            {initialLoading ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
              Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={`skeleton-${i}`} />)
            ) : (
              <>
                {logs.map((log) => (
                  <tr
                    key={log.id}
                    className="border-t border-white/10 hover:bg-white/5 transition-colors"
                  >
                    <td className="p-4 font-mono text-sm text-gray-300">
                      {new Date(log.created_at).toLocaleString()}
                    </td>
                    <td className="p-4">
                      <span
                        className={`px-2 py-1 rounded text-xs font-bold ${
                          log.action === 'LOGIN'
                            ? 'bg-green-500/20 text-green-200'
                            : log.action === 'LOGOUT'
                              ? 'bg-red-500/20 text-red-200'
                              : 'bg-blue-500/20 text-blue-200'
                        }`}
                      >
                        {log.action}
                      </span>
                    </td>
                    <td className="p-4 text-gray-300">{log.details}</td>
                  </tr>
                ))}

                {/* Loading more skeleton rows */}
                {loading &&
                  hasMore &&
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                  Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={`loading-${i}`} />)}
              </>
            )}
          </tbody>
        </table>

        {/* Infinite scroll trigger */}
        {hasMore && !initialLoading && (
          <div ref={loadMoreRef} className="p-4 text-center text-gray-400">
            {loading ? (
              <div className="flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
                Loading more...
              </div>
            ) : (
              'Scroll for more'
            )}
          </div>
        )}

        {!hasMore && logs.length > 0 && (
          <div className="p-4 text-center text-gray-500 border-t border-white/10">
            ✓ All {total.toLocaleString()} logs loaded
          </div>
        )}
      </div>
    </div>
  );
}
