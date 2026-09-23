#!/usr/bin/env node
/**
 * e2e-round.mjs — the named file-manager end-to-end round (issue #1197 / T1).
 *
 * ONE command that chains the app-level e2e legs that already gate every PR, plus
 * one newly-wired leg (authenticated ISR invalidation over HTTP). This is a NAME
 * and an ENTRY POINT, not new coverage — the underlying checks pre-exist. See
 * e2e-round-legs.mjs for the single-source-of-truth leg registry.
 *
 * Contract (design §2):
 *   - fail-closed: exits non-zero on the FIRST leg failure, with a clear message;
 *   - NEVER a silent skip: a missing precondition is an ERROR that names the fix;
 *   - prints a leg table at the end;
 *   - flags: --only <leg>  --no-build  --no-docker  --allow-docker
 *
 * Deliberate non-defaults (design §6):
 *   - REDIS_URL is NEVER defaulted to "" — that silently neuters compat-smoke
 *     check (k). It must be set, or pass --allow-docker to have the round start a
 *     redis:7-alpine itself.
 *   - the SIGTERM-drain leg is NOT claimed here for file-manager (G3): its drain
 *     and image proofs are the CI-only `standalone-drain-bun-image` and
 *     `bun-exec-alpine-image` jobs.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_LEGS } from './e2e-round-legs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : undefined;
};
const OPTS = {
  only: valOf('--only'),
  noBuild: has('--no-build'),
  noDocker: has('--no-docker'),
  allowDocker: has('--allow-docker'),
};

/** A precondition failure — refuse the leg, never skip it. */
class Refuse extends Error {}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, ...opts });
  if (r.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(' ')}\` exited ${r.status ?? `signal ${r.signal}`}`);
  }
}

function onPath(bin) {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return r.status === 0 || r.error === undefined;
}

function waitForHealth(host, port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host, port, path: '/api/health', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('server did not become healthy in time'));
      setTimeout(tick, 500);
    };
    tick();
  });
}

// ── leg implementations ──────────────────────────────────────────────────────

async function legBuild() {
  if (OPTS.noBuild) {
    console.log('  --no-build: reusing existing build artifacts');
    return;
  }
  sh('bun', ['run', '--filter', '@getknext/lib', 'build']);
  sh('bun', ['run', '--filter', '@getknext/db', 'build']);
  sh('bun', ['run', '--filter', '@getknext/core', 'build']);
  sh('bun', ['run', '--filter', 'file-manager', 'build']);
}

async function legCompile() {
  if (OPTS.noBuild) {
    console.log('  --no-build: reusing existing single-executable');
    return;
  }
  if (!onPath('bun')) {
    throw new Refuse('bun is required on PATH to compile the single executable (kn-next build).');
  }
  sh('bun', ['run', '--filter', 'file-manager', 'build:exec']);
}

function requireRedis() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  if (!OPTS.allowDocker) {
    throw new Refuse(
      'REDIS_URL is not set. compat-smoke check (k) proves ISR against a REAL Redis and is ' +
        'meaningless without one. Set REDIS_URL, or pass --allow-docker to start redis:7-alpine.',
    );
  }
  // --allow-docker: the round would start its own redis. Kept explicit so the
  // default path never silently falls back to an in-memory cache.
  if (!onPath('docker')) throw new Refuse('--allow-docker given but docker is not on PATH.');
  console.log('  --allow-docker: starting redis:7-alpine on :6379');
  sh('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    '6379:6379',
    '--name',
    'knext-e2e-redis',
    'redis:7-alpine',
  ]);
  return 'redis://127.0.0.1:6379';
}

async function legCompatSmoke() {
  const redis = requireRedis();
  sh('node', ['scripts/compat-smoke.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, REDIS_URL: redis },
  });
}

async function legInvalidationProbe() {
  const redis = requireRedis();
  const token = process.env.CACHE_INVALIDATE_TOKEN;
  if (!token) {
    throw new Refuse(
      'CACHE_INVALIDATE_TOKEN is not set. Leg 4 proves BOTH the authenticated 200 and the ' +
        'unauthenticated 401 — it cannot run without the token the server is started with.',
    );
  }
  const bin = process.env.SERVER_PATH || path.resolve(APP_DIR, 'knext-smoke-exec');
  if (!existsSync(bin)) {
    throw new Refuse(`single-executable not found at ${bin}. Run the compile leg first.`);
  }
  const port = Number(process.env.INVALIDATION_PORT || 3998);
  const host = '127.0.0.1';
  const server = spawn(bin, [], {
    cwd: path.dirname(bin),
    env: {
      ...process.env,
      REDIS_URL: redis,
      HOSTNAME: '0.0.0.0',
      PORT: String(port),
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    await waitForHealth(host, port);
    sh('node', ['scripts/invalidation-probe.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, PORT: String(port), HOST: host, CACHE_INVALIDATE_TOKEN: token },
    });
  } finally {
    server.kill('SIGTERM');
  }
}

async function legProdImage() {
  if (OPTS.noDocker) {
    // Explicit opt-out — printed as NOT RUN, NEVER as a pass.
    throw new Refuse('--no-docker: prod image leg NOT RUN (opt-out). This is not a pass.');
  }
  if (!onPath('docker')) {
    throw new Refuse('docker daemon required for the prod image leg. Pass --no-docker to opt out.');
  }
  // The self-test first proves the probe itself is fail-closed.
  sh('node', ['scripts/prod-image-probe.selftest.mjs'], { cwd: APP_DIR });
  const tag = 'knext-file-manager-e2e:local';
  sh('docker', ['build', '-f', 'apps/file-manager/Dockerfile', '-t', tag, '.']);
  const run = spawnSync(
    'docker',
    ['run', '-d', '--rm', '-p', '8080:8080', '--name', 'knext-e2e-prod', tag],
    { encoding: 'utf8', cwd: REPO_ROOT },
  );
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  try {
    sh('node', ['scripts/prod-image-probe.mjs'], { cwd: APP_DIR });
  } finally {
    spawnSync('docker', ['rm', '-f', 'knext-e2e-prod'], { stdio: 'ignore' });
  }
}

const IMPL = {
  build: legBuild,
  compile: legCompile,
  'compat-smoke': legCompatSmoke,
  'invalidation-probe': legInvalidationProbe,
  'prod-image': legProdImage,
};

async function main() {
  let legs = LOCAL_LEGS;
  if (OPTS.only) {
    legs = legs.filter((l) => l.id === OPTS.only);
    if (legs.length === 0) {
      console.error(
        `--only ${OPTS.only}: no such local leg. Choose from: ${LOCAL_LEGS.map((l) => l.id).join(', ')}`,
      );
      process.exit(2);
    }
  }

  const results = [];
  for (const leg of legs) {
    console.log(`\n=== leg: ${leg.id} — ${leg.title} ===`);
    try {
      await IMPL[leg.id]();
      results.push({ id: leg.id, status: 'PASS' });
    } catch (e) {
      const status = e instanceof Refuse ? 'REFUSED' : 'FAIL';
      results.push({ id: leg.id, status, why: e.message });
      console.error(`\n[${status}] ${leg.id}: ${e.message}`);
      printTable(results, legs);
      process.exit(1);
    }
  }
  printTable(results, legs);
  console.log('\nfile-manager e2e round: all legs passed.');
}

function printTable(results, legs) {
  console.log('\n── e2e round result ──');
  for (const leg of legs) {
    const r = results.find((x) => x.id === leg.id);
    console.log(`  ${r ? r.status.padEnd(7) : 'SKIPPED'} ${leg.id}`);
  }
}

main().catch((e) => {
  console.error(`e2e-round crashed: ${e?.stack || e}`);
  process.exit(1);
});
