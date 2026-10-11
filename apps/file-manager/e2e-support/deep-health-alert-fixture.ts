// Fixture app for the deep-health alert kind e2e (scripts/deep-health-alert-e2e.sh).
//
// It is NOT a mock of the thing under test. It runs the real pieces that the
// alert pipeline is made of, in one process, exactly as the compiled runtime
// does:
//
//   - the reference app's real instrumentation (`registerNode`), which registers
//     `knext_deep_health_state` and serves it on the loopback child port;
//   - the real runtime contract's `:9464` listener, which forwards that one
//     family onto the metrics port;
//   - the real `@getknext/lib` pool, pointed at a database that refuses
//     connections, so the real `checkDeepHealth` returns `down`.
//
// The only invented part is "traffic": a periodic query keeps the activity gate
// open the way a user hitting a database-backed page would. Without it the
// scrape probe correctly stays idle (it must never wake an idle database).
//
// Run from apps/file-manager so bare imports resolve against its node_modules.

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

import { getDbPool } from '@getknext/lib/clients';
import { registerNode } from '../src/instrumentation-node';

const APP_PORT = Number(process.env.PORT ?? 3000);
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9464);
const TRAFFIC_EVERY_MS = Number(process.env.FIXTURE_TRAFFIC_EVERY_MS ?? 10_000);

registerNode();

const contract = await import('../runtime-contract.mjs');
const state = contract.createMetricsState();

createServer(contract.metricsRequestListener(state)).listen(METRICS_PORT, '0.0.0.0');
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
}).listen(APP_PORT, '0.0.0.0');
contract.recordStartupComplete(state);

// The e2e makes the app go idle by creating this file; from then on there is no
// application traffic, and the only thing that can still reach the database is
// the deep-health probe the scrape triggers.
const STOP_FILE = process.env.FIXTURE_STOP_TRAFFIC_FILE ?? '/tmp/stop-traffic';

const touchDatabase = () => {
  if (existsSync(STOP_FILE)) return;
  // Rejects (ECONNREFUSED) by design; the call itself is what stamps activity.
  getDbPool()
    .query('SELECT 1')
    .catch(() => {});
};
touchDatabase();
setInterval(touchDatabase, TRAFFIC_EVERY_MS);

console.log(`LISTENING:${APP_PORT} METRICS:${METRICS_PORT} (deep-health alert fixture)`);
