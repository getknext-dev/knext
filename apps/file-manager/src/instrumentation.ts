import { setCacheHandler } from 'next/cache';
import CacheHandler from '../cache-handler.js';

/**
 * Next.js instrumentation hook — registers the cache handler.
 *
 * OpenTelemetry is initialized automatically by the kn-next node-server adapter
 * (packages/kn-next/src/adapters/node-server.ts) BEFORE the Nitro server starts.
 * No need for @vercel/otel or manual SDK setup — the framework handles it.
 *
 * To enable: set `observability: { enabled: true }` in kn-next.config.ts
 */
export function register() {
  setCacheHandler(new CacheHandler());
}
