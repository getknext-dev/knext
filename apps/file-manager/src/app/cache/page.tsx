'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

interface CacheEvent {
  id: string;
  timestamp: string;
  type: 'HIT' | 'MISS' | 'SET' | 'DELETE' | 'INVALIDATE' | 'REVALIDATE';
  source: 'gcs' | 'redis' | 'fetch';
  key: string;
  tag?: string;
  durationMs?: number;
  details?: string;
}

interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  invalidations: number;
  revalidations: number;
  hitRate: string;
  totalEvents: number;
}

export default function CacheMonitorPage() {
  const [events, setEvents] = useState<CacheEvent[]>([]);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalidateTag, setInvalidateTag] = useState('files');
  const [invalidating, setInvalidating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/cache/events');
      const data = await res.json();
      setEvents(data.events || []);
      setStats(data.stats || null);
    } catch (error) {
      console.error('Failed to fetch cache events:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
    // Auto-refresh every 5 seconds
    const interval = setInterval(fetchEvents, 5000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  const handleInvalidate = async () => {
    setInvalidating(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/cache/invalidate?tag=${encodeURIComponent(invalidateTag)}`);
      const data = await res.json();
      if (data.success) {
        setMessage(`✅ Invalidated tag: ${invalidateTag}`);
        fetchEvents();
      } else {
        setMessage(`❌ Error: ${data.error}`);
      }
    } catch (error) {
      setMessage(`❌ Error: ${(error as Error).message}`);
    } finally {
      setInvalidating(false);
    }
  };

  const handleClearEvents = async () => {
    try {
      await fetch('/api/cache/events', { method: 'DELETE' });
      setEvents([]);
      setStats(null);
      setMessage('✅ Events cleared');
    } catch (error) {
      setMessage(`❌ Error: ${(error as Error).message}`);
    }
  };

  const getEventEmoji = (type: CacheEvent['type']) => {
    switch (type) {
      case 'HIT':
        return '✅';
      case 'MISS':
        return '❌';
      case 'SET':
        return '💾';
      case 'DELETE':
        return '🗑️';
      case 'INVALIDATE':
        return '🔄';
      case 'REVALIDATE':
        return '♻️';
      default:
        return '📝';
    }
  };

  const getEventColor = (type: CacheEvent['type']) => {
    switch (type) {
      case 'HIT':
        return 'bg-green-500/20 text-green-400';
      case 'MISS':
        return 'bg-red-500/20 text-red-400';
      case 'SET':
        return 'bg-blue-500/20 text-blue-400';
      case 'DELETE':
        return 'bg-orange-500/20 text-orange-400';
      case 'INVALIDATE':
        return 'bg-purple-500/20 text-purple-400';
      case 'REVALIDATE':
        return 'bg-yellow-500/20 text-yellow-400';
      default:
        return 'bg-gray-500/20 text-gray-400';
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Cache Monitor</h1>
        <Link href="/" className="text-purple-400 hover:text-purple-300">
          ← Back to Files
        </Link>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-6">
          <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
            <div className="text-2xl font-bold text-green-400">{stats.hits}</div>
            <div className="text-sm text-gray-400">Cache Hits</div>
          </div>
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
            <div className="text-2xl font-bold text-red-400">{stats.misses}</div>
            <div className="text-sm text-gray-400">Cache Misses</div>
          </div>
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
            <div className="text-2xl font-bold text-blue-400">{stats.sets}</div>
            <div className="text-sm text-gray-400">Cache Sets</div>
          </div>
          <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4">
            <div className="text-2xl font-bold text-orange-400">{stats.deletes}</div>
            <div className="text-sm text-gray-400">Deletes</div>
          </div>
          <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4">
            <div className="text-2xl font-bold text-purple-400">{stats.invalidations}</div>
            <div className="text-sm text-gray-400">Invalidations</div>
          </div>
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4">
            <div className="text-2xl font-bold text-yellow-400">{stats.revalidations}</div>
            <div className="text-sm text-gray-400">Revalidations</div>
          </div>
          <div className="bg-white/10 border border-white/30 rounded-lg p-4">
            <div className="text-2xl font-bold">{stats.hitRate}</div>
            <div className="text-sm text-gray-400">Hit Rate</div>
          </div>
        </div>
      )}

      {/* Invalidation Controls */}
      <div className="bg-white/5 border border-white/10 rounded-lg p-4 mb-6">
        <h2 className="text-lg font-semibold mb-3">Cache Invalidation</h2>
        <div className="flex gap-4 items-center flex-wrap">
          <input
            type="text"
            value={invalidateTag}
            onChange={(e) => setInvalidateTag(e.target.value)}
            placeholder="Tag name (e.g., files)"
            className="bg-black/50 border border-white/20 rounded px-3 py-2 w-48"
          />
          <button
            type="button"
            onClick={handleInvalidate}
            disabled={invalidating}
            className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 px-4 py-2 rounded font-medium"
          >
            {invalidating ? 'Invalidating...' : 'Invalidate Tag'}
          </button>
          <button
            type="button"
            onClick={handleClearEvents}
            className="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded font-medium"
          >
            Clear Events
          </button>
          <button
            type="button"
            onClick={fetchEvents}
            className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded font-medium"
          >
            Refresh
          </button>
        </div>
        {message && <div className="mt-3 text-sm">{message}</div>}
      </div>

      {/* Events Table */}
      <div className="bg-white/5 border border-white/10 rounded-lg overflow-hidden max-h-[500px] flex flex-col">
        <div className="px-4 py-3 border-b border-white/10 flex justify-between items-center">
          <h2 className="text-lg font-semibold">Cache Events</h2>
          <span className="text-sm text-gray-400">
            {events.length} events (auto-refreshes every 5s)
          </span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No cache events yet. Navigate to pages to generate cache activity.
          </div>
        ) : (
          <div className="overflow-x-auto overflow-y-auto flex-1">
            <table className="w-full text-sm">
              <thead className="bg-black/30">
                <tr>
                  <th className="px-4 py-2 text-left">Time</th>
                  <th className="px-4 py-2 text-left">Type</th>
                  <th className="px-4 py-2 text-left">Source</th>
                  <th className="px-4 py-2 text-left">Key</th>
                  <th className="px-4 py-2 text-left">Tag</th>
                  <th className="px-4 py-2 text-right">Duration</th>
                  <th className="px-4 py-2 text-left">Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t border-white/5 hover:bg-white/5">
                    <td className="px-4 py-2 text-gray-400 whitespace-nowrap">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${getEventColor(event.type)}`}
                      >
                        {getEventEmoji(event.type)} {event.type}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="text-xs bg-white/10 px-2 py-0.5 rounded">
                        {event.source}
                      </span>
                    </td>
                    <td
                      className="px-4 py-2 font-mono text-xs max-w-[200px] truncate"
                      title={event.key}
                    >
                      {event.key}
                    </td>
                    <td className="px-4 py-2">
                      {event.tag && (
                        <span className="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded">
                          {event.tag}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-400">
                      {event.durationMs ? `${event.durationMs}ms` : '-'}
                    </td>
                    <td
                      className="px-4 py-2 text-xs text-gray-400 max-w-[200px] truncate"
                      title={event.details}
                    >
                      {event.details || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
