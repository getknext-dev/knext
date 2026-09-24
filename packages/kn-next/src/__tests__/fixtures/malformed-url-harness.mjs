/**
 * Harness for malformed-url-guard.test.ts. Serves a REAL h3 app through REAL
 * srvx (node or bun adapter, picked by the SRVX env) with the same request-path
 * wiring the vinext entries use: the runtime contract's `rejectMalformedPath`
 * middleware, a middleware after it that fails on purpose, and the contract's
 * `requestErrorResponse` as srvx's `error` handler.
 *
 * env:
 *   CONTRACT  absolute path to a runtime-contract.mjs copy
 *   SRVX      absolute path to srvx's node or bun adapter module
 *   H3        absolute path to h3's module
 *   KNEXT_HARNESS_NO_GUARD=1 / KNEXT_HARNESS_NO_ERROR=1  drop one half (for the
 *             control runs that prove the unguarded server really fails)
 *
 * Prints `LISTENING:<port>` once it accepts connections.
 */
const { rejectMalformedPath, requestErrorResponse } = await import(process.env.CONTRACT);
const { serve } = await import(process.env.SRVX);
const { H3 } = await import(process.env.H3);

const app = new H3().get('/**', () => 'ok');

const middleware = [];
if (process.env.KNEXT_HARNESS_NO_GUARD !== '1') middleware.push(rejectMalformedPath);
// A request-path failure AFTER the guard: a synchronous throw and an async
// rejection, the two shapes an upstream handler can fail in.
middleware.push((req, next) => {
  const path = new URL(req.url).pathname;
  if (path === '/boom-sync') throw new Error('handler failed synchronously');
  if (path === '/boom-async') return Promise.reject(new Error('handler rejected'));
  return next();
});

const server = serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: app.fetch,
  gracefulShutdown: false,
  silent: true,
  middleware,
  ...(process.env.KNEXT_HARNESS_NO_ERROR === '1' ? {} : { error: requestErrorResponse }),
});
await server.ready();
const port = server.node?.server?.address()?.port ?? server.bun?.server?.port;
console.log(`LISTENING:${port}`);
