/**
 * Test fixture that stands in for Next.js's `output:'standalone'` server.js.
 *
 * Used by sigterm-drain-e2e.test.ts to prove the knext runtime entry
 * (@getknext/core node-server) actually drains in-flight requests on SIGTERM
 * end-to-end — exercising the REAL signal-forwarding code path, not a unit
 * double.
 *
 * Behaviour, mirroring a real Next standalone server under graceful shutdown:
 *  - Listens on $PORT.
 *  - GET /slow holds the request open for ~1.5s, then responds 200 "drained".
 *  - On SIGTERM it STOPS accepting new connections but WAITS for in-flight
 *    requests to finish (server.close callback) before exiting 0 — i.e. it
 *    drains. A request that was already in flight when SIGTERM arrived must
 *    still complete.
 *
 * If the runtime entry failed to forward SIGTERM (the bug this guards against),
 * this process would never receive the signal and the in-flight request would
 * be killed when the parent died — the test asserts the opposite.
 */

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3000);
let inFlight = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/slow') {
    inFlight++;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('drained');
      inFlight--;
    }, 1500);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});

server.listen(PORT, () => {
  // Signal readiness on stdout so the test can synchronize before sending traffic.
  process.stdout.write(`LISTENING:${PORT}\n`);
});

process.on('SIGTERM', () => {
  process.stdout.write(`SIGTERM-RECEIVED inFlight=${inFlight}\n`);
  // Drain: stop accepting, wait for in-flight to finish, THEN exit.
  server.close(() => {
    process.stdout.write('DRAINED-EXIT\n');
    process.exit(0);
  });
});
