// @vitest-environment node
//
// RUNTIME proof that the production Next.js standalone server knext deploys
// never loads a dev-only Next module.
//
// The founder's question: "are our builds production builds?" Source review says
// `next/dist/server/next.js` only `require('./dev/next-dev-server')` under
// `options.dev`, the standalone `server.js` passes `dev: false`, and the runtime
// images set `NODE_ENV=production`. All true by reading; none of it observed.
// This test observes it: it boots the REAL `.next/standalone/server.js` that a
// real `next build` emitted, the way the runtime image launches it, records
// EVERY module the process loads (including request-time lazy loads), and
// asserts that none is a dev-only module.
//
// ── How the load list is recorded ────────────────────────────────────────────
// A tiny CJS preload (`TRACER`, below) wraps `Module._load` and appends the
// resolved filename of every distinct module to a file, synchronously. Appending
// per module (rather than dumping at exit) means a SIGKILLed server still leaves
// a complete list, and it records modules at the moment they are first required,
// so request-time lazy loads land in the file too. The tracer is loaded with
// `--require`, exactly like the runtime's own preloads, and is the FIRST preload
// so nothing the others pull in escapes it.
//
// ── What "launched the way the runtime image does" means here ────────────────
// The node/bun runtime stages (templates/runtime-standalone/Dockerfile.standalone.hbs)
// run `knext-standalone-entry.mjs` → the node-server supervisor, which spawns
// `<runtime> --require <preloads…> server.js` with NODE_ENV=production and PORT /
// HOSTNAME in the environment. This test spawns that same child command line
// directly (supervisor omitted — it is not part of Next's module graph), with
// the same preloads in the same order (cache-control-normalize, request-body-cap,
// public-origin, plus bun-keepalive-guard under Bun).
//
// ── Dev-only patterns, each with its reason ──────────────────────────────────
// Only patterns that Next's SOURCE shows are dev-only are asserted; `next/dist/build/`
// as a whole is deliberately NOT, because some build-dir helpers (logging, utils)
// legitimately load at serve time. See `DEV_ONLY`.
//
// ── Mutations (proved by exit code, see the PR) ──────────────────────────────
//   M1 tracer requires `next/dist/server/dev/next-dev-server`
//   M2 the server is launched under NODE_ENV=development
//   M3 the tracer output gains a `*.runtime.dev.js` / React `*.development.js` path
// M1 and M3 must turn this file red. M2 deliberately does NOT: the built page
// chunk pins the production runtime and server.js hardcodes `dev: false`, so
// NODE_ENV alone does not change which modules load (NODE_ENV in the images is
// pinned by tests/runtime-image-node-env.test.ts).

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type ChildProcess, type ChildProcessByStdio, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { freePort } from '../apps/file-manager/e2e-support/child-ports';
import { BUN_BIN, NODE_BIN } from './helpers/runtime-binaries';

setDefaultTimeout(60_000);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ADAPTERS = join(REPO, 'packages/kn-next/src/adapters');

/**
 * The app whose real `next build` supplies the standalone tree. db-demo is the
 * app CI already builds for the SIGTERM gates (file-manager is vinext and emits
 * no standalone tree since ADR-0048). Overridable for the same reason.
 */
const APP_DIR = process.env.KNEXT_STANDALONE_APP_DIR
  ? resolve(process.env.KNEXT_STANDALONE_APP_DIR)
  : join(REPO, 'apps/db-demo');

/** Find `<standalone>/…/server.js` — nested under the tracing root in a monorepo. */
function findServerJs(): string | null {
  const root = join(APP_DIR, '.next/standalone');
  if (!existsSync(root)) return null;
  const direct = join(root, 'server.js');
  if (existsSync(direct)) return direct;
  const found = spawnSync(
    'find',
    [root, '-name', 'server.js', '-not', '-path', '*/node_modules/*'],
    {
      encoding: 'utf8',
    },
  );
  const line = found.stdout.split('\n').find((l) => l.trim().length > 0);
  return line ?? null;
}

const serverJs = findServerJs();
const skipReason =
  serverJs !== null
    ? null
    : 'standalone build not found — run `next build --webpack` in apps/db-demo';
if (process.env.KNEXT_REQUIRE_STANDALONE === '1' && skipReason !== null) {
  throw new Error(`KNEXT_REQUIRE_STANDALONE=1 but no standalone build present — ${skipReason}`);
}

/**
 * Module path fragments that are dev-only in Next (verified against
 * next/dist/server/next.js and the dist tree). Matched against forward-slash
 * paths of every loaded module.
 */
const DEV_ONLY: ReadonlyArray<{ pattern: string | RegExp; reason: string }> = [
  {
    pattern: /next\/dist\/compiled\/.*\.runtime\.dev\.js$/,
    reason:
      "Next's module.compiled.js picks `*.runtime.dev.js` (which bundles React's dev build) " +
      "when NODE_ENV === 'development'; production must load `*.runtime.prod.js`",
  },
  {
    pattern:
      /\/(react|react-dom|react-is|scheduler|react-server-dom-[\w-]+)\/cjs\/[^/]*\.development\.js$/,
    reason:
      "React's development builds (react, react-dom, scheduler, react-server-dom-*; plain or " +
      'under next/dist/compiled) add warnings/validation and are a production-mode regression',
  },
  {
    pattern: 'next/dist/server/dev/',
    reason: 'the dev server: next-dev-server, hot reloaders, HMR middleware, dev overlay state',
  },
  {
    pattern: 'next/dist/server/lib/router-utils/setup-dev-bundler',
    reason: 'wires the dev bundler (webpack/turbopack watch) into the router; only `dev: true`',
  },
  {
    pattern: 'next/dist/next-devtools/server/',
    reason: 'server half of the dev overlay / devtools (only reachable from the dev server)',
  },
  {
    pattern: 'next/dist/compiled/react-refresh/',
    reason: 'Fast Refresh runtime, HMR only',
  },
  {
    pattern: 'next/dist/compiled/webpack/',
    reason: 'the webpack compiler itself: build and dev-watch only, never needed to serve',
  },
  {
    pattern: 'next/dist/client/dev/',
    reason: 'dev-only client modules (error overlay, HMR client)',
  },
];

/** Modules that PROVE the list is the production server, not a vacuous/empty one. */
const PROD_MARKERS = [
  'next/dist/server/next-server.js',
  'next/dist/server/next.js',
  'next/dist/server/base-server.js',
];

const tmpDirs: string[] = [];
afterAll(() => {
  // D9: drained via a for-of registry.
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** The tracer preload. Anchor `const seen = new Set();` occurs exactly once. */
const TRACER = `
const Module = require('node:module');
const fs = require('node:fs');
const out = process.env.KNEXT_TRACE_OUT;
const seen = new Set();
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  let file;
  try { file = Module._resolveFilename(request, parent, isMain); } catch { file = String(request); }
  if (!seen.has(file)) { seen.add(file); fs.appendFileSync(out, file + '\\n'); }
  return orig.apply(this, arguments);
};
// Second source, for runtimes whose Module._load is not on the require path
// (Bun): on SIGUSR2 dump every key of the require cache, atomically.
process.on('SIGUSR2', () => {
  const tmp = out + '.cache.tmp';
  fs.writeFileSync(tmp, Object.keys(Module._cache).join('\\n') + '\\n');
  fs.renameSync(tmp, out + '.cache');
});
`;

interface Booted {
  loaded: string[];
  statuses: Record<string, number>;
}

function waitForPort(port: number, proc: ChildProcess, getErr: () => string): Promise<void> {
  const deadline = Date.now() + 40_000;
  return new Promise((ok, fail) => {
    const tick = async () => {
      if (proc.exitCode !== null) return fail(new Error(`server exited early\n${getErr()}`));
      if (Date.now() > deadline) return fail(new Error(`server never listened\n${getErr()}`));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/_next/static/none`);
        await r.arrayBuffer();
        return ok();
      } catch {
        setTimeout(tick, 150);
      }
    };
    void tick();
  });
}

async function bootAndTrace(runtime: 'node' | 'bun', nodeEnv: string): Promise<Booted> {
  const dir = makeTmp('knext-no-dev-modules-');
  const tracerPath = join(dir, 'module-load-tracer.cjs');
  const traceOut = join(dir, 'loaded.txt');
  writeFileSync(tracerPath, TRACER);
  writeFileSync(traceOut, '');

  const port = await freePort();
  const preloads = [
    tracerPath,
    join(ADAPTERS, 'cache-control-normalize.cjs'),
    join(ADAPTERS, 'request-body-cap.cjs'),
    join(ADAPTERS, 'public-origin.cjs'),
    ...(runtime === 'bun' ? [join(ADAPTERS, 'bun-keepalive-guard.cjs')] : []),
  ];
  const args = [...preloads.flatMap((p) => ['--require', p]), realpathSync(serverJs as string)];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: nodeEnv,
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    KNEXT_TRACE_OUT: traceOut,
  };
  delete env.NODE_OPTIONS;

  const bin = runtime === 'bun' ? BUN_BIN : NODE_BIN;
  if (bin === undefined) throw new Error(`no ${runtime} executable available to run the server`);
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(bin, args, {
    cwd: dirname(serverJs as string),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  proc.stdout?.on('data', () => {});
  try {
    await waitForPort(port, proc, () => stderr);
    const statuses: Record<string, number> = {};
    // Request-time lazy loads: an unknown path renders Next's not-found page
    // through the full app-render pipeline (a 404 by design), and `/` renders the
    // app's own route (db-demo's needs a database, so it may answer 500 here —
    // either way it ran the render path, which is the point).
    for (const path of ['/__knext_probe_not_found', '/']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      await res.arrayBuffer();
      statuses[path] = res.status;
    }
    // Snapshot the require cache too (see TRACER) and wait for it to land.
    proc.kill('SIGUSR2');
    const cacheFile = `${traceOut}.cache`;
    const until = Date.now() + 10_000;
    while (!existsSync(cacheFile) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(cacheFile)).toBe(true);
    const lines = [
      ...readFileSync(traceOut, 'utf8').split('\n'),
      ...readFileSync(cacheFile, 'utf8').split('\n'),
    ];
    const loaded = [
      ...new Set(lines.filter((l) => l.length > 0).map((l) => l.replaceAll('\\', '/'))),
    ];
    return { loaded, statuses };
  } finally {
    proc.kill('SIGKILL');
  }
}

/**
 * Two files under `next/dist/server/dev/` ARE loaded by a production server,
 * measured: `router-server.js` requires `hot-reloader-types` (a pure enum module
 * of HMR message names) and `node-environment-extensions/console-file.js`
 * requires `browser-logs/file-logger` (a lazily-initialised file-logger class;
 * the console patch that uses it is gated on `NODE_ENV === 'development'`).
 * They live in `dev/` because the dev server shares them, but they are leaves:
 * neither pulls in a dev-server module. The allowlist is therefore exact, and
 * the leaf property is itself asserted from source (see the leaf test) so the
 * exemption cannot silently widen to something that is not a leaf.
 */
const SHARED_LEAVES = [
  'next/dist/server/dev/hot-reloader-types.js',
  'next/dist/server/dev/browser-logs/file-logger.js',
];

function matches(file: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? file.includes(pattern) : pattern.test(file);
}

function assertNoDevModules(loaded: string[]): void {
  const offenders = DEV_ONLY.flatMap(({ pattern, reason }) =>
    loaded
      .filter((f) => matches(f, pattern) && !SHARED_LEAVES.some((leaf) => f.endsWith(leaf)))
      .map((f) => `${f}  [${String(pattern)}: ${reason}]`),
  );
  expect(offenders).toEqual([]);
}

function assertProductionServerLoaded(loaded: string[]): void {
  // Non-vacuity: an empty or wrong list must not pass.
  expect(loaded.length).toBeGreaterThan(100);
  expect(loaded.filter((f) => f.includes('/next/dist/')).length).toBeGreaterThan(50);
  for (const marker of PROD_MARKERS) {
    expect(loaded.some((f) => f.includes(marker))).toBe(true);
  }
  // The preloads we launched with are in the list: proves the tracer sat first
  // and saw the runtime's own wiring.
  expect(loaded.some((f) => f.endsWith('/request-body-cap.cjs'))).toBe(true);
}

describe.skipIf(skipReason !== null)('standalone server loads no dev-only Next modules', () => {
  it('the allowlisted dev/ files are leaves: they require only node builtins', async () => {
    const { loaded } = await bootAndTrace('node', 'production');
    const allowed = loaded.filter((f) => SHARED_LEAVES.some((leaf) => f.endsWith(leaf)));
    // Both halves: the allowlist entries really are loaded (else it is dead
    // config), and each one is a leaf (else the exemption hides a dev module).
    expect(allowed.length).toBe(SHARED_LEAVES.length);
    for (const file of allowed) {
      const requires = [
        ...readFileSync(file, 'utf8').matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
      ].map((m) => m[1]);
      // Relative requires would reach siblings; `next/dist/...` requires reach any
      // Next module by package path. Only node builtins are allowed.
      expect(requires.filter((r) => r.startsWith('.') || r.startsWith('next/'))).toEqual([]);
    }
  });

  it('node: production server.js under NODE_ENV=production', async () => {
    const { loaded, statuses } = await bootAndTrace('node', 'production');
    expect(statuses['/__knext_probe_not_found']).toBe(404);
    expect([200, 500]).toContain(statuses['/']);
    assertProductionServerLoaded(loaded);
    assertNoDevModules(loaded);
  });

  it('bun: the same server.js under `bun`', async () => {
    const { loaded, statuses } = await bootAndTrace('bun', 'production');
    expect(statuses['/__knext_probe_not_found']).toBe(404);
    expect([200, 500]).toContain(statuses['/']);
    assertProductionServerLoaded(loaded);
    assertNoDevModules(loaded);
  });
});
