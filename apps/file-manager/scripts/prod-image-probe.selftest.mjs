#!/usr/bin/env node
/**
 * Self-test for prod-image-probe.mjs — proves the probe is FAIL-CLOSED.
 *
 * This does NOT need Docker. It stands up tiny fake HTTP servers that emulate the
 * container's relevant endpoints and asserts the probe:
 *   - FAILS (exit 1) when the optimizer 500s (broken sharp/musl runtime)
 *   - FAILS when the optimizer returns a non-image content-type
 *   - FAILS when the "optimized" body is NOT smaller than the source
 *   - PASSES (exit 0) only when ALL three invariants hold (200 + image/webp|avif + smaller)
 *
 * Run: node scripts/prod-image-probe.selftest.mjs
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(__dirname, 'prod-image-probe.mjs');

const SOURCE_BYTES = 4096; // pretend source PNG is 4 KB

function startFake(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function sourceAndOptimized(handler) {
  // common: health + source asset; handler decides /_next/image behavior
  return (req, res) => {
    if (req.url.startsWith('/api/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"status":"ok"}');
    }
    if (req.url === '/knext-optimize-fixture.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.alloc(SOURCE_BYTES, 1));
    }
    if (req.url.startsWith('/_next/image')) {
      return handler(req, res);
    }
    res.writeHead(404);
    res.end();
  };
}

// Async spawn — a synchronous spawnSync would block THIS process's event loop,
// starving the in-process fake HTTP server so the probe's requests would all time out.
function runProbe(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE], {
      env: {
        ...process.env,
        BASE_URL: `http://127.0.0.1:${port}`,
        READY_TIMEOUT_MS: '5000',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const cases = [
  {
    name: 'broken optimizer (HTTP 500) → probe FAILS',
    handler: (_req, res) => {
      res.writeHead(500);
      res.end('optimizer crashed: sharp missing');
    },
    expectExit: 1,
  },
  {
    name: 'non-image content-type (HTTP 200 text/html) → probe FAILS',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not an image</html>');
    },
    expectExit: 1,
  },
  {
    name: 'optimized NOT smaller than source → probe FAILS',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/webp' });
      res.end(Buffer.alloc(SOURCE_BYTES + 10, 2)); // larger than source
    },
    expectExit: 1,
  },
  {
    name: 'all invariants hold (200 + image/webp + smaller) → probe PASSES',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/webp' });
      res.end(Buffer.alloc(Math.floor(SOURCE_BYTES / 2), 3)); // smaller
    },
    expectExit: 0,
  },
];

let failures = 0;
for (const c of cases) {
  const server = await startFake(sourceAndOptimized(c.handler));
  const port = server.address().port;
  const exit = await runProbe(port);
  server.close();
  try {
    assert.strictEqual(exit, c.expectExit, `expected exit ${c.expectExit}, got ${exit}`);
    console.log(`✓ ${c.name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${c.name} — ${err.message}`);
  }
}

if (failures > 0) {
  console.error(`\nprod-image-probe.selftest: ${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nprod-image-probe.selftest: all cases passed (probe is fail-closed)');
