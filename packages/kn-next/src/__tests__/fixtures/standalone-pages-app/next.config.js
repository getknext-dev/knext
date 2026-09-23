/**
 * Pages Router fixture for standalone-pages.docker-e2e.test.ts.
 *
 * - `knext-ext-probe` is server-EXTERNAL, so the page chunk loads it from disk
 *   at request time and its `next/router` import goes through Next's
 *   require-hook redirect.
 * - `cacheHandler` is a custom ISR handler that imports a Next internal (see
 *   cache-handler.js). Memory caching is off so every ISR read reaches it.
 */
module.exports = {
  output: 'standalone',
  typescript: { ignoreBuildErrors: true },
  serverExternalPackages: ['knext-ext-probe'],
  cacheHandler: require.resolve('./cache-handler.js'),
  cacheMaxMemorySize: 0,
};
