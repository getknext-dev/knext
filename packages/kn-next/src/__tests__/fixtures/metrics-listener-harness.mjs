/**
 * Harness for malformed-url-guard.test.ts: serves the runtime contract's
 * `metricsRequestListener` on a plain node:http server, the way the vinext
 * node entry serves its :9464 metrics port.
 *
 * env:
 *   CONTRACT                     absolute path to a runtime-contract.mjs copy
 *   KNEXT_HARNESS_OLD_METRICS=1  serve the previous inline handler instead (the
 *                                control run that shows the failure this closes)
 *
 * Prints `LISTENING:<port>` once it accepts connections.
 */
import { createServer } from 'node:http';

const contract = await import(process.env.CONTRACT);
const state = contract.createMetricsState();

const previousHandler = (req, res) => {
  if (req.method === 'GET' && new URL(req.url ?? '/', 'http://x').pathname === '/metrics') {
    res.writeHead(200, { 'content-type': contract.METRICS_CONTENT_TYPE });
    res.end(contract.renderMetrics(state));
    return;
  }
  res.writeHead(404).end('Not Found');
};

const server = createServer(
  process.env.KNEXT_HARNESS_OLD_METRICS === '1'
    ? previousHandler
    : contract.metricsRequestListener(state),
);
server.listen(0, '127.0.0.1', () => {
  console.log(`LISTENING:${server.address().port}`);
});
