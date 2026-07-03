#!/usr/bin/env node
/**
 * A/B trial driver for the bun-sandbox-fetch investigation
 * (docs/compat/upstream-bun-sandbox-fetch-bug.md, path 1: "move the A/B where
 * the discrimination already exists" — a GHA-hosted, no-WAN, no-docker A/B).
 *
 * Per trial: boot the fixture's standalone server under --runtime (node|bun),
 * fire the four probe shapes from the doc's repro (GET/POST x normal-fetch/
 * new-request) with a 15s client timeout, record per-shape outcome + timing,
 * kill the server. The probe CLIENT and the local HTTPS echo server always run
 * under NODE — the serving runtime is the ONLY variable across lanes.
 *
 * Usage:
 *   node run-trials.mjs --runtime bun --trials 10 \
 *     --fixture test/bun-sandbox-fetch-ab/fixture --out ab-results-bun.json
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROBE_TIMEOUT_MS = 15000;
// Uncommon ports on purpose: a foreign listener on a default port (3000) would
// silently make the probe measure the WRONG server. Pre-flighted below.
// ECHO_PORT must match the hardcoded HTTP_ECHO_URL in fixture/middleware.js.
const APP_PORT = 3873;
const ECHO_PORT = 8743;

// The four probe shapes from the doc's repro app (order matches its 4-probe
// transcripts: exercise new-request first, mixed methods).
const SHAPES = [
  { id: 'GET normal-fetch', method: 'GET', path: '/?kind=normal-fetch' },
  { id: 'POST normal-fetch', method: 'POST', path: '/?kind=normal-fetch' },
  { id: 'GET new-request', method: 'GET', path: '/?kind=new-request' },
  { id: 'POST new-request', method: 'POST', path: '/?kind=new-request' },
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const runtime = arg('runtime');
const trials = Number(arg('trials', '10'));
const fixtureDir = resolve(arg('fixture', 'test/bun-sandbox-fetch-ab/fixture'));
const outPath = resolve(arg('out', `ab-results-${runtime}.json`));
if (runtime !== 'node' && runtime !== 'bun') {
  console.error(`--runtime must be node|bun, got "${runtime}"`);
  process.exit(2);
}
// #197 gate follow-up: a NaN/0 trials value would silently skip the trial loop
// and write an EMPTY artifact that aggregates to a vacuous verdict. Fail loud.
if (!Number.isInteger(trials) || trials < 1) {
  console.error(`--trials must be an integer >= 1, got "${arg('trials', '10')}"`);
  process.exit(2);
}
const scriptDir = resolve(import.meta.dirname);
const standaloneServer = join(fixtureDir, '.next/standalone/server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Self-signed cert with an IP SAN for 127.0.0.1 (TLS stays in the path). */
function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'knext-ab-'));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=knext-ab-echo',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'pipe' },
  );
  return { certPath, keyPath };
}

/** Poll until a TCP connect to 127.0.0.1:port succeeds (or times out). */
async function waitPortOpen(port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      const s = net.connect({ host: '127.0.0.1', port, timeout: 500 });
      s.once('connect', () => {
        s.destroy();
        res(true);
      });
      s.once('error', () => res(false));
      s.once('timeout', () => {
        s.destroy();
        res(false);
      });
    });
    if (ok) return;
    await sleep(250);
  }
  throw new Error(`${label}: port ${port} not open after ${timeoutMs}ms`);
}

/** Poll until a TCP connect FAILS (server fully gone between trials). */
async function waitPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((res) => {
      const s = net.connect({ host: '127.0.0.1', port, timeout: 500 });
      s.once('connect', () => {
        s.destroy();
        res(true);
      });
      s.once('error', () => res(false));
      s.once('timeout', () => {
        s.destroy();
        res(false);
      });
    });
    if (!open) return;
    await sleep(250);
  }
  throw new Error(`port ${port} still open after ${timeoutMs}ms`);
}

/** One probe request against the middleware. Timeout = hang. */
function probe(shape) {
  const started = Date.now();
  return new Promise((resolveProbe) => {
    const req = http.request(
      { host: '127.0.0.1', port: APP_PORT, path: shape.path, method: shape.method },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolveProbe({
            shape: shape.id,
            outcome: 'resolved',
            status: res.statusCode,
            resolvedHeader: (res.headers['x-resolved'] ?? '').slice(0, 40),
            ms: Date.now() - started,
          }),
        );
      },
    );
    req.on('error', (e) =>
      resolveProbe({
        shape: shape.id,
        outcome: 'client-error',
        code: e.code,
        ms: Date.now() - started,
      }),
    );
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy();
      resolveProbe({ shape: shape.id, outcome: 'timeout', ms: Date.now() - started });
    });
    req.end();
  });
}

/** True iff something already listens on 127.0.0.1:port. */
function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 500 });
    s.once('connect', () => {
      s.destroy();
      res(true);
    });
    s.once('error', () => res(false));
    s.once('timeout', () => {
      s.destroy();
      res(false);
    });
  });
}

async function main() {
  // Pre-flight: BOTH ports must be free, or the probe would measure a foreign
  // server (observed locally: a stray dev server on :3000). Fail loud.
  for (const [label, port] of [
    ['app', APP_PORT],
    ['echo', ECHO_PORT],
  ]) {
    if (await portOpen(port)) {
      throw new Error(`pre-flight: ${label} port ${port} is already in use — refusing to run`);
    }
  }

  const { certPath, keyPath } = makeCert();

  // Echo server: constant across lanes, always node.
  const echo = spawn(
    'node',
    [
      join(scriptDir, 'echo-server.mjs'),
      '--port',
      String(ECHO_PORT),
      '--cert',
      certPath,
      '--key',
      keyPath,
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  await waitPortOpen(ECHO_PORT, 15000, 'echo-server');

  const runtimeVersion = execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim();
  const perTrial = [];
  let server = null;

  try {
    for (let trial = 1; trial <= trials; trial++) {
      server = spawn(runtime, [standaloneServer], {
        cwd: join(fixtureDir, '.next/standalone'),
        env: {
          ...process.env,
          PORT: String(APP_PORT),
          HOSTNAME: '127.0.0.1',
          NODE_ENV: 'production',
          // Trust the local CA in BOTH runtimes (bun honors this too); TLS
          // failures surface as middleware 500s / client errors, NOT timeouts,
          // so they can never be miscounted as hangs.
          NODE_EXTRA_CA_CERTS: certPath,
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      let exited = false;
      server.once('exit', (code, signal) => {
        exited = true;
        // A crash BEFORE the port opens must fail the run loudly, not let the
        // readiness poll spin for 60s (or worse, probe a foreign listener).
        if (server.crashedEarly === undefined) {
          server.crashedEarly = { code, signal };
        }
      });

      // Readiness: the middleware is prebuilt in standalone output, TCP-open
      // suffices — but bail immediately if the server process already died.
      const readyDeadline = Date.now() + 60000;
      while (!(await portOpen(APP_PORT))) {
        if (exited) {
          throw new Error(
            `standalone server (${runtime}) exited before listening: ${JSON.stringify(server.crashedEarly)}`,
          );
        }
        if (Date.now() > readyDeadline) {
          throw new Error(`standalone server (${runtime}): port ${APP_PORT} not open after 60s`);
        }
        await sleep(250);
      }

      const results = [];
      for (const shape of SHAPES) {
        // Sequential — one in-flight middleware fetch at a time, like the doc's probe.
        results.push(await probe(shape));
      }
      console.log(
        `[trial ${trial}/${trials}] ${results.map((r) => `${r.shape}=${r.outcome}${r.status ? `(${r.status})` : ''}`).join('  ')}`,
      );
      perTrial.push({ trial, results });

      server.kill('SIGKILL');
      if (!exited) await new Promise((r) => server.once('exit', r));
      server = null;
      await waitPortClosed(APP_PORT, 15000);
    }
  } finally {
    // Never orphan children — even when a trial throws.
    if (server) server.kill('SIGKILL');
    echo.kill('SIGKILL');
  }

  const out = {
    runtime,
    runtimeVersion,
    trials,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    echo: `local https 127.0.0.1:${ECHO_PORT}, self-signed CA via NODE_EXTRA_CA_CERTS (no WAN)`,
    shapes: SHAPES.map((s) => s.id),
    perTrial,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
