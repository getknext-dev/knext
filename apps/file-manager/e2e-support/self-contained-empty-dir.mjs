#!/usr/bin/env bun
/**
 * self-contained-empty-dir.mjs — boot a compiled standalone executable from a
 * directory that holds ONLY what the self-contained image ships beside it
 * (the binary, `public/`, `.next/static/`, and `native/` when present), then
 * request every route the build's own manifests list (#1456).
 *
 * Two arms, so a self-contained binary is judged against the disk-mode one on
 * the same build:
 *
 *   A (disk)           the standalone tree + `public` + `.next/static`, with the
 *                      disk-mode executable beside `server.js`;
 *   B (self-contained) the self-contained executable alone in an empty dir.
 *
 * Library (the e2e imports it) and CLI (the A/B measurement):
 *
 *   bun e2e-support/self-contained-empty-dir.mjs \
 *     --next-dir <app>/.next --sc-binary <path> [--disk-binary <path>] [--runs 5] [--label webpack]
 *
 * Prints one JSON document: per arm, the status of every route, and boot time
 * (spawn → first 200 on `/api/health`) per run with the median.
 */
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Every route the build serves, from its own manifests (no hand-kept list). */
export function routesFromManifests(nextDir) {
  const routes = new Set();
  const appRoutes = join(nextDir, 'app-path-routes-manifest.json');
  if (existsSync(appRoutes)) {
    for (const route of Object.values(JSON.parse(readFileSync(appRoutes, 'utf8')))) {
      routes.add(route);
    }
  }
  const pages = join(nextDir, 'server', 'pages-manifest.json');
  if (existsSync(pages)) {
    for (const route of Object.keys(JSON.parse(readFileSync(pages, 'utf8')))) routes.add(route);
  }
  // Framework-internal entries and the error pages are not routes a client requests by that name.
  return [...routes]
    .filter((r) => !/^\/(?:_app|_document|_error|_global-error|_not-found|404|500)$/.test(r))
    .sort();
}

/** A route with a dynamic segment cannot be requested without a value; they are reported, not guessed. */
export const isDynamicRoute = (route) => route.includes('[');

/** The one static asset the build references first — proves `.next/static` is served from disk. */
export function firstStaticAsset(nextDir) {
  const manifest = JSON.parse(readFileSync(join(nextDir, 'build-manifest.json'), 'utf8'));
  const file = [...(manifest.rootMainFiles ?? []), ...(manifest.polyfillFiles ?? [])].find((f) =>
    f.startsWith('static/'),
  );
  return file ? `/_next/${file}` : undefined;
}

/**
 * Arm B: a fresh dir with the self-contained binary, `public/`, `.next/static/`
 * and (when the app has one) `native/` — nothing else.
 */
export function stageSelfContained({ nextDir, binary, publicDir, nativeDir }) {
  const dir = mkdtempSync(join(tmpdir(), 'knext-sc-empty-'));
  cpSync(binary, join(dir, 'app'));
  if (publicDir && existsSync(publicDir))
    cpSync(publicDir, join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, '.next'));
  cpSync(join(nextDir, 'static'), join(dir, '.next', 'static'), { recursive: true });
  if (nativeDir && existsSync(nativeDir))
    cpSync(nativeDir, join(dir, 'native'), { recursive: true });
  return { dir, exec: join(dir, 'app') };
}

/** Arm A: the standalone tree, plus `public` and `.next/static`, with the disk-mode binary beside server.js. */
export function stageDisk({ nextDir, binary, publicDir }) {
  const dir = mkdtempSync(join(tmpdir(), 'knext-sc-disk-'));
  cpSync(join(nextDir, 'standalone'), dir, { recursive: true, verbatimSymlinks: true });
  const server = findServerJs(dir);
  const appDir = dirname(server);
  if (publicDir && existsSync(publicDir))
    cpSync(publicDir, join(appDir, 'public'), { recursive: true });
  cpSync(join(nextDir, 'static'), join(appDir, '.next', 'static'), { recursive: true });
  cpSync(binary, join(appDir, 'app'));
  return { dir, exec: join(appDir, 'app') };
}

function findServerJs(root) {
  const direct = join(root, 'server.js');
  if (existsSync(direct)) return direct;
  const apps = join(root, 'apps');
  if (existsSync(apps)) {
    for (const name of readdirSync(apps)) {
      const s = join(apps, name, 'server.js');
      if (existsSync(s)) return s;
    }
  }
  throw new Error(`no server.js under ${root}`);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function get(url, timeoutMs = 30_000) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.arrayBuffer();
  return {
    status: res.status,
    bytes: body.byteLength,
    type: res.headers.get('content-type') ?? '',
  };
}

/**
 * Spawn `exec` (cwd = its directory, a clean env) and wait for the first 200 on
 * `readyPath`. Rejects — never hangs — if the process exits first or stays
 * unready past the timeout, with its output.
 *
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number, bootMs: number, output: () => string }>}
 */
export async function boot(exec, { readyPath = '/api/health', timeoutMs = 60_000, env = {} } = {}) {
  const port = await freePort();
  const started = performance.now();
  const child = spawn(exec, [], {
    cwd: dirname(exec),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: tmpdir(),
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => {
    out += c;
  });
  child.stderr.on('data', (c) => {
    out += c;
  });
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = `exit ${code ?? signal}`;
  });
  const deadline = started + timeoutMs;
  while (performance.now() < deadline) {
    if (exited)
      throw new Error(`${exec} ${exited} before it served ${readyPath}:\n${out.slice(-2000)}`);
    try {
      const r = await get(`http://127.0.0.1:${port}${readyPath}`, 2_000);
      if (r.status === 200) {
        return { child, port, bootMs: performance.now() - started, output: () => out };
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  child.kill('SIGKILL');
  throw new Error(
    `${exec} did not serve ${readyPath} within ${timeoutMs} ms:\n${out.slice(-2000)}`,
  );
}

export async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await done;
  clearTimeout(t);
}

/** Request every route (and one static asset) against a booted arm. */
export async function serveAll(port, routes, staticAsset) {
  const results = {};
  for (const route of routes) {
    if (isDynamicRoute(route)) {
      results[route] = { skipped: 'dynamic segment' };
      continue;
    }
    try {
      results[route] = await get(`http://127.0.0.1:${port}${route}`);
    } catch (e) {
      results[route] = { error: String(e?.message ?? e) };
    }
  }
  if (staticAsset) {
    try {
      results[staticAsset] = await get(`http://127.0.0.1:${port}${staticAsset}`);
    } catch (e) {
      results[staticAsset] = { error: String(e?.message ?? e) };
    }
  }
  return results;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** One arm: boot `runs` times (first run also serves every route). */
export async function measureArm(stage, { routes, staticAsset, runs, env = {} }) {
  const bootMs = [];
  let served;
  let output = '';
  for (let i = 0; i < runs; i++) {
    const b = await boot(stage.exec, { env });
    bootMs.push(Math.round(b.bootMs));
    if (i === 0) {
      served = await serveAll(b.port, routes, staticAsset);
      output = b.output();
    }
    await stop(b.child);
  }
  return {
    binaryBytes: statSync(stage.exec).size,
    bootMs,
    bootMedianMs: median(bootMs),
    served,
    output,
  };
}

/** A route "served" = a non-5xx answer that is not the fallback 404. */
export const isServed = (r) => typeof r?.status === 'number' && r.status < 500 && r.status !== 404;

async function main() {
  const argv = process.argv.slice(2);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };
  const nextDir = val('--next-dir');
  const scBinary = val('--sc-binary');
  const diskBinary = val('--disk-binary');
  const runs = Number(val('--runs') ?? 5);
  // `--env KEY=VALUE` (repeatable): passed to both arms, e.g. a DATABASE_URL.
  const env = Object.fromEntries(
    argv.flatMap((a, i) => (a === '--env' ? [argv[i + 1].split(/=(.*)/s).slice(0, 2)] : [])),
  );
  const publicDir = val('--public') ?? join(dirname(nextDir ?? '.'), 'public');
  if (!nextDir || !scBinary) {
    process.stderr.write(
      'usage: --next-dir <app>/.next --sc-binary <path> [--disk-binary <path>] [--runs 5]\n',
    );
    process.exit(2);
  }
  const routes = routesFromManifests(nextDir);
  const staticAsset = firstStaticAsset(nextDir);
  const result = { label: val('--label') ?? '', routes, staticAsset, arms: {} };
  const stages = [];
  try {
    if (diskBinary) {
      const a = stageDisk({ nextDir, binary: diskBinary, publicDir });
      stages.push(a);
      result.arms.A = await measureArm(a, { routes, staticAsset, runs, env });
    }
    const b = stageSelfContained({ nextDir, binary: scBinary, publicDir });
    stages.push(b);
    result.arms.B = await measureArm(b, { routes, staticAsset, runs, env });
  } finally {
    for (const s of stages) rmSync(s.dir, { recursive: true, force: true });
  }
  for (const arm of Object.values(result.arms)) {
    arm.servedCount = Object.values(arm.served).filter(isServed).length;
    arm.output = arm.output.slice(-1500);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) await main();
