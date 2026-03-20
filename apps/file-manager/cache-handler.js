/**
 * Re-export the framework's cache handler.
 *
 * The actual implementation lives in @kn-next/core/adapters/cache-handler.
 * App-level cache-handler.js only exists because Next.js requires a file path
 * via `cacheHandler` in next.config.ts. This thin re-export keeps the logic
 * in the framework where it belongs — bug fixes apply to all apps automatically.
 */
export { default } from "@kn-next/core/adapters/cache-handler";
