import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

/**
 * End to end, on the two runtimes knext ships: a pod whose bring-your-own
 * `DATABASE_URL` points at a refused port reports `down` with DEFAULT settings.
 *
 * `health-refused-defaults.test.ts` drives both DRIVERS in one process; this one
 * drives both RUNTIMES, as separate processes, because the lib picks its driver
 * from the runtime it finds itself in (`pg` on Node, `Bun.SQL` on Bun) and the
 * defect was reported on each. The probe is bundled from source with its bare
 * imports left external, so node resolves the real `pg` from node_modules and
 * the run needs no prior package build.
 */

const LIB = resolve(import.meta.dir, '../..');
const OUT = join(LIB, `.e2e-health-probe-${process.pid}`);
const BUNDLE = join(OUT, 'deep-health-probe.js');

/** Every knob that moves either of the two timings this test is about. */
const TIMING_ENV = [
  'DB_WAKE_RETRY_BUDGET_MS',
  'DB_WAKE_RETRY_BASE_MS',
  'DB_WAKE_RETRY_MAX_MS',
  'DB_POOL_CONNECT_TIMEOUT_MS',
  'HEALTH_DEEP_TIMEOUT_MS',
  'KNEXT_DB_DRIVER',
  'REDIS_URL',
];

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

function run(runtime: 'node' | 'bun', databaseUrl: string): Promise<{ out: string; code: number }> {
  const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: databaseUrl };
  for (const k of TIMING_ENV) delete env[k];
  return new Promise((done, fail) => {
    const child = spawn(runtime, [BUNDLE], { env: env as NodeJS.ProcessEnv, cwd: LIB });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(killer);
      done({ out, code: code ?? -1 });
    });
  });
}

describe('deep health on a dead bring-your-own database — real runtimes, default settings', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'fixtures/deep-health-probe.ts')],
      outdir: OUT,
      target: 'node',
      packages: 'external',
    });
    expect(built.success).toBe(true);
  });

  afterAll(() => {
    rmSync(OUT, { recursive: true, force: true });
  });

  for (const [runtime, driver] of [
    ['node', 'pg'],
    ['bun', 'bun'],
  ] as const) {
    it(`${runtime}: a refused database reads down, promptly (driver ${driver})`, async () => {
      const port = await closedPort();
      const { out, code } = await run(runtime, `postgres://u:p@127.0.0.1:${port}/app`);
      const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
      expect(line, out).toBeDefined();
      const result = JSON.parse((line as string).slice('RESULT:'.length));

      expect(code).toBe(0);
      expect(result.driver).toBe(driver);
      expect(result.res.checks.postgres).toBe('down');
      expect(result.res.status).toBe('down');
      expect(result.elapsedMs).toBeLessThan(3000);
    }, 40_000);
  }
});
