// @vitest-environment node
//
// #1331 — pure arg/env construction for the local e2e round, one test per defect.
// These exercise the DATA the orchestrator would pass to docker/compat-smoke, not
// a text match against e2e-round.mjs, and Docker is never invoked.

import { describe, expect, it } from 'bun:test';
import {
  buildCompatSmokeEnv,
  buildProdImageProbeEnv,
  buildProdImageRunArgs,
  buildRedisRunArgs,
  buildRedisStopArgs,
  defaultServerPath,
  PROD_IMAGE_PORT,
  runLegsWithCleanup,
  uniqueRedisContainerName,
} from './scripts/e2e-round-config.mjs';

describe('#1331 defect 1 — prod-image port', () => {
  it('the container port matches the Dockerfile listen port (3000, not 8080)', () => {
    expect(PROD_IMAGE_PORT).toBe(3000);
  });

  it('docker run publishes host:container as the SAME constant', () => {
    const args = buildProdImageRunArgs({
      tag: 'knext-file-manager-e2e:local',
      name: 'knext-e2e-prod',
    });
    const i = args.indexOf('-p');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(`${PROD_IMAGE_PORT}:${PROD_IMAGE_PORT}`);
  });

  it('the probe env BASE_URL targets the same port docker published', () => {
    const runArgs = buildProdImageRunArgs({ tag: 't', name: 'n' });
    const publishedPort = runArgs[runArgs.indexOf('-p') + 1].split(':')[1];
    const env = buildProdImageProbeEnv({});
    expect(env.BASE_URL).toBe(`http://127.0.0.1:${publishedPort}`);
  });

  it('a custom port still keeps host and container in sync', () => {
    // Computed, not a literal bind port (#678 scans for literal binds) — these
    // args are never passed to a listener, only asserted as data.
    const customPort = PROD_IMAGE_PORT + 11;
    const args = buildProdImageRunArgs({ tag: 't', name: 'n', port: customPort });
    expect(args[args.indexOf('-p') + 1]).toBe(`${customPort}:${customPort}`);
  });
});

describe('#1331 defect 2 — compat-smoke runtime classification', () => {
  it('sets RUNTIME=bun and SERVER_CMD===SERVER_PATH to the compiled binary, as ci.yml does', () => {
    const serverPath = '/repo/apps/file-manager/knext-smoke-exec';
    const env = buildCompatSmokeEnv({
      baseEnv: {},
      redisUrl: 'redis://127.0.0.1:6379',
      serverPath,
    });
    expect(env.RUNTIME).toBe('bun');
    expect(env.SERVER_CMD).toBe(serverPath);
    expect(env.SERVER_PATH).toBe(serverPath);
    expect(env.SERVER_CMD).toBe(env.SERVER_PATH);
  });

  it('threads REDIS_URL through and preserves the caller-provided base env', () => {
    const env = buildCompatSmokeEnv({
      baseEnv: { PATH: '/usr/bin', SOME_VAR: 'x' },
      redisUrl: 'redis://127.0.0.1:6379',
      serverPath: '/x/knext-smoke-exec',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SOME_VAR).toBe('x');
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:6379');
  });

  it('throws rather than silently defaulting when no serverPath is given', () => {
    // @ts-expect-error — deliberately omitting the required serverPath to prove the runtime throw.
    expect(() => buildCompatSmokeEnv({ baseEnv: {}, redisUrl: 'redis://x' })).toThrow();
  });

  it('defaultServerPath resolves under the given app dir to knext-smoke-exec', () => {
    expect(defaultServerPath('/repo/apps/file-manager')).toBe(
      '/repo/apps/file-manager/knext-smoke-exec',
    );
  });
});

describe('#1331 defect 3 — redis container name is unique, not a shared constant', () => {
  it('two calls without a seed produce different names', () => {
    const a = uniqueRedisContainerName();
    const b = uniqueRedisContainerName();
    expect(a).not.toBe(b);
  });

  it('is never the bare, collision-prone "knext-e2e-redis" name', () => {
    expect(uniqueRedisContainerName()).not.toBe('knext-e2e-redis');
    expect(uniqueRedisContainerName('abc')).toBe('knext-e2e-redis-abc');
  });

  it('buildRedisRunArgs names the container from the given unique name', () => {
    const name = uniqueRedisContainerName('seed-1');
    const args = buildRedisRunArgs(name);
    const i = args.indexOf('--name');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(name);
    expect(args[i + 1]).not.toBe('knext-e2e-redis');
  });

  it('buildRedisStopArgs targets the same unique name for cleanup', () => {
    const name = uniqueRedisContainerName('seed-2');
    expect(buildRedisStopArgs(name)).toEqual(['rm', '-f', name]);
  });

  it('cleanup runs exactly once when every leg passes', async () => {
    let cleanupCalls = 0;
    const legs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const ran: string[] = [];
    const { results, failed } = await runLegsWithCleanup({
      legs,
      runLeg: async (leg) => {
        ran.push(leg.id);
      },
      cleanup: () => {
        cleanupCalls += 1;
      },
    });
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(results.every((r) => r.status === 'PASS')).toBe(true);
    expect(failed).toBe(false);
    expect(cleanupCalls).toBe(1);
  });

  it('cleanup STILL runs when a leg throws — the leak this defect fixes', async () => {
    let cleanupCalls = 0;
    const legs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const ran: string[] = [];
    const { results, failed } = await runLegsWithCleanup({
      legs,
      runLeg: async (leg) => {
        ran.push(leg.id);
        if (leg.id === 'b') throw new Error('leg b failed');
      },
      cleanup: () => {
        cleanupCalls += 1;
      },
    });
    // 'c' never runs (fail-closed on first failure) but cleanup still fires.
    expect(ran).toEqual(['a', 'b']);
    expect(failed).toBe(true);
    const legB = results.find((r) => r.id === 'b');
    expect(legB?.status).toBe('FAIL');
    expect(cleanupCalls).toBe(1);
  });

  it('classifyError lets the caller mark a Refuse distinctly from a real failure', async () => {
    class Refuse extends Error {}
    const { results } = await runLegsWithCleanup({
      legs: [{ id: 'x' }],
      runLeg: async () => {
        throw new Refuse('no REDIS_URL');
      },
      cleanup: () => {},
      classifyError: (e) => (e instanceof Refuse ? 'REFUSED' : 'FAIL'),
    });
    expect(results[0].status).toBe('REFUSED');
  });
});
