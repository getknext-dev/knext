import { registerOTel } from '@vercel/otel';

// NOTE: setCacheHandler is not exported from next/cache in Next.js 16.0.3.
// The Redis CacheHandler is registered via the `cacheHandler` field in
// next.config.ts (the correct mechanism for ISR caching).
// If Next.js adds a runtime setCacheHandler API in future versions, wire it here.

export function register() {
  registerOTel({
    serviceName: 'file-manager',
  });
}
