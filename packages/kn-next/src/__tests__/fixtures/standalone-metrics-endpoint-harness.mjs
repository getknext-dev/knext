/**
 * Harness for malformed-url-standalone-metrics.test.ts: boots the REAL
 * standalone supervisor's `:9464` metrics endpoint (`createLazyMetricsEndpoint`,
 * `packages/kn-next/src/adapters/deferred-supervisor-init.ts` — the module
 * `node-server.ts` uses for both the standalone-on-node and standalone-on-bun
 * cells) from a freshly bundled copy of the CURRENT source, so the behaviour
 * proved here is the behaviour the shipped supervisor has today.
 *
 * env:
 *   BUNDLE  absolute path to a `deferred-supervisor-init.ts` bundle (built by
 *           the test with `Bun.build`, target "node", so plain `node` can run
 *           it too — the same technique malformed-url-guard.test.ts uses for
 *           the vinext runtime contract's minified build)
 *
 * Prints `LISTENING:<port>` once it accepts connections.
 */
const { createLazyMetricsEndpoint } = await import(process.env.BUNDLE);

const endpoint = createLazyMetricsEndpoint({
    port: 0,
    // No real child to scrape in this harness; a no-op keeps the request path
    // exercised (the handler still awaits it) without a network dependency.
    fetchChild: async () => "",
});

await endpoint.ensureListening("harness-start");
console.log(`LISTENING:${endpoint.address()}`);
