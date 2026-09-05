#!/usr/bin/env node
/**
 * A stand-in for the compiled single executable, used by
 * `postcompile-smoke.test.ts`.
 *
 * The post-compile smoke (#894) asserts the three RuntimeContract obligations a
 * `bun build --compile` binary can silently lose — the health route the operator
 * probes, the `:9091` metrics exposition, and the SIGTERM drain. Proving the
 * smoke can SEE each one go missing needs a server that can lose exactly one at
 * a time, which a real compiled binary cannot do without editing the app.
 *
 * So this file speaks the same startup contract as `knext-bun-entry.mjs` —
 * binds PORT and METRICS_PORT (0 ⇒ OS-assigned), prints
 * `LISTENING:<port> METRICS:<port>` once both listeners are bound, and exits 0
 * on SIGTERM — and `KNEXT_SMOKE_FIXTURE_MODE` removes one obligation per run.
 * It is a NODE script on purpose: the smoke must not care what produced the
 * executable it boots, only that the executable honours the contract.
 */

import { createServer } from 'node:http';

const MODE = process.env.KNEXT_SMOKE_FIXTURE_MODE ?? 'good';
const HEALTH_PATH = process.env.KNEXT_SMOKE_FIXTURE_HEALTH_PATH ?? '/api/health';

if (MODE === 'crash') {
  // Compiles, does not boot — the `bun-linux-*-musl`-on-glibc failure shape.
  process.stderr.write('fixture: refusing to start\n');
  process.exit(1);
}

const app = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === HEALTH_PATH && MODE !== 'no-health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }
  res.writeHead(404).end('Not Found');
});

const metrics = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/metrics' && MODE !== 'no-metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end('knext_startup_duration_seconds 0.061\n', maybeExitAfterServing);
    return;
  }
  res.writeHead(404).end('Not Found');
});

// SIGTERM handling is installed BEFORE the boot line, so a smoke that sees the
// line has a process that can already be drained.
//
// `unhandled-sigterm` installs NO handler at all, which is the DEFAULT
// disposition and the likeliest real regression: an entry that simply never
// registers the drain. The kernel then terminates the process by signal, so it
// exits fast and looks fine to anything that only checks "did it stop?" — the
// two failure modes are opposite in timing and a smoke needs both.
if (MODE !== 'unhandled-sigterm') {
  process.on('SIGTERM', () => {
    if (MODE === 'ignore-sigterm') return; // handler present, exit never happens
    app.close();
    metrics.close();
    process.exit(0);
  });
}

// `exits-after-serving` is gone BEFORE any SIGTERM arrives. Keyed on having
// SERVED the metrics scrape rather than on a timer: a timer would race the
// probes and make the case flaky in whichever direction the machine was slow.
// Nothing here is a drain failure, so a smoke must not report one.
function maybeExitAfterServing() {
  if (MODE !== 'exits-after-serving') return;
  app.close();
  metrics.close();
  setImmediate(() => process.exit(0));
}

let bound = 0;
const announce = () => {
  if (++bound < 2) return;
  if (MODE === 'no-boot-line') return; // listeners up, startup signal missing
  const appPort = app.address().port;
  const metricsPort = metrics.address().port;
  process.stdout.write(`LISTENING:${appPort} METRICS:${metricsPort}\n`);
};

app.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', announce);
metrics.listen(Number(process.env.METRICS_PORT ?? 9091), '127.0.0.1', announce);
