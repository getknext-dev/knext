// @vitest-environment node
//
// RuntimeContract tests for the opt-in bun-exec target (ADR-0036).
//
// Two layers:
//   A. Pure unit tests of runtime-contract.mjs (metrics format, fail-closed
//      Bearer auth, graceful-shutdown drain + hardcap ordering) — run under
//      node, no bun/vinext needed.
//   B. A real-sockets e2e that spawns `test/drain-harness.mjs` under BUN (the
//      same two Bun.serve listeners + shared contract as knext-bun-entry.mjs,
//      minus the vinext handler): fire a ~2s /slow request, SIGTERM mid-flight,
//      assert it STILL completes 200 and the process exits 0; scrape :9091
//      /metrics for a valid Prometheus exposition; assert /api/cache/invalidate
//      is 401 without the token and 200 with it. Skips (does not fail) if `bun`
//      is not on PATH — noted as a coverage gap; OKE runs the compiled binary.
//
// This exercises the NET-NEW knext code (metrics/drain/auth). The vinext handler
// composition is proven by the P1a/P2 spikes and re-proven on OKE — see README.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkBearer,
  createGracefulShutdown,
  createMetricsState,
  METRICS_CONTENT_TYPE,
  renderMetrics,
  resolveBindHost,
} from '../runtime-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(__dirname, 'drain-harness.mjs');

// ── Layer A: pure unit tests ─────────────────────────────────────────────────
describe('renderMetrics — Prometheus exposition', () => {
  it('emits valid HELP/TYPE lines and real process metrics', () => {
    const state = createMetricsState();
    state.requestsTotal = 3;
    state.inflight = 1;
    const text = renderMetrics(state);
    expect(text).toContain('# TYPE knext_bunexec_process_resident_memory_bytes gauge');
    expect(text).toMatch(/knext_bunexec_process_resident_memory_bytes \d+/);
    expect(text).toContain('# TYPE knext_bunexec_http_requests_total counter');
    expect(text).toContain('knext_bunexec_http_requests_total 3');
    expect(text).toContain('knext_bunexec_http_inflight_requests 1');
    expect(METRICS_CONTENT_TYPE).toMatch(/version=0\.0\.4/);
  });
});

describe('resolveBindHost — never bind to a k8s pod name (#447)', () => {
  it('falls through to 0.0.0.0 for a k8s pod-name HOSTNAME', () => {
    // Kubernetes injects HOSTNAME=<pod-name> into every pod; a pod name is not
    // a bind address, so binding to it would make the server unreachable.
    expect(resolveBindHost({ HOSTNAME: 'recipe-validate-fn252' })).toBe('0.0.0.0');
    expect(resolveBindHost({ HOSTNAME: 'my-app-7d9f8-abcde' })).toBe('0.0.0.0');
  });

  it('defaults to 0.0.0.0 when HOSTNAME is unset or empty', () => {
    expect(resolveBindHost({})).toBe('0.0.0.0');
    expect(resolveBindHost({ HOSTNAME: '' })).toBe('0.0.0.0');
  });

  it('honours an explicit bind/loopback HOSTNAME', () => {
    expect(resolveBindHost({ HOSTNAME: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveBindHost({ HOSTNAME: '127.0.0.1' })).toBe('127.0.0.1');
    expect(resolveBindHost({ HOSTNAME: '127.0.53.53' })).toBe('127.0.53.53');
    expect(resolveBindHost({ HOSTNAME: '::1' })).toBe('::1');
    expect(resolveBindHost({ HOSTNAME: '::' })).toBe('::');
    expect(resolveBindHost({ HOSTNAME: 'localhost' })).toBe('localhost');
    expect(resolveBindHost({ HOSTNAME: 'LOCALHOST' })).toBe('LOCALHOST');
  });
});

describe('checkBearer — fail-closed mutating-route guard', () => {
  const token = 's3cret-token';
  const withAuth = (h?: string) =>
    new Request('http://x/api/cache/invalidate', {
      method: 'POST',
      headers: h ? { authorization: h } : {},
    });

  it('denies (401) when the server token env is unset — fail closed', () => {
    const res = checkBearer(withAuth(`Bearer ${token}`), undefined);
    expect(res?.status).toBe(401);
  });

  it('denies (401) when no Authorization header is present', () => {
    const res = checkBearer(withAuth(), token);
    expect(res?.status).toBe(401);
  });

  it('denies (401) on a wrong token', () => {
    const res = checkBearer(withAuth('Bearer wrong'), token);
    expect(res?.status).toBe(401);
  });

  it('authorises (null) on the correct Bearer token', () => {
    const res = checkBearer(withAuth(`Bearer ${token}`), token);
    expect(res).toBeNull();
  });
});

describe('createGracefulShutdown — drain ordering + hardcap', () => {
  function fakeServer() {
    return {
      stopped: [] as boolean[],
      stop(force?: boolean) {
        this.stopped.push(Boolean(force));
        return Promise.resolve();
      },
    };
  }

  it('drains servers, awaits tasks, closes metrics, exits 0', async () => {
    const app = fakeServer();
    const metricsServer = fakeServer();
    const order: string[] = [];
    let exitCode: number | undefined;
    const shutdown = createGracefulShutdown({
      appServers: [app],
      metricsServer,
      drainTasks: async () => {
        order.push('tasks');
      },
      graceMs: 5000,
      log: () => {},
      exit: (c) => {
        exitCode = c;
      },
    });
    // record app.stop / metrics.stop ordering via wrappers
    const appStop = app.stop.bind(app);
    app.stop = (f?: boolean) => {
      order.push('app');
      return appStop(f);
    };
    const mStop = metricsServer.stop.bind(metricsServer);
    metricsServer.stop = (f?: boolean) => {
      order.push('metrics');
      return mStop(f);
    };

    await shutdown('SIGTERM');
    expect(order).toEqual(['app', 'tasks', 'metrics']);
    expect(exitCode).toBe(0);
    expect(app.stopped).toEqual([false]); // graceful stop(), not force
  });

  it('is idempotent — a second signal is ignored', async () => {
    const app = fakeServer();
    let exits = 0;
    const shutdown = createGracefulShutdown({
      appServers: [app],
      metricsServer: fakeServer(),
      drainTasks: async () => {},
      graceMs: 5000,
      log: () => {},
      exit: () => {
        exits++;
      },
    });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGTERM')]);
    expect(exits).toBe(1);
  });

  it('force-stops + exits 1 when drain exceeds the hardcap', async () => {
    const app = fakeServer();
    let exitCode: number | undefined;
    const shutdown = createGracefulShutdown({
      appServers: [app],
      metricsServer: fakeServer(),
      // never resolves → forces the hardcap path
      drainTasks: () => new Promise(() => {}),
      graceMs: 60,
      log: () => {},
      exit: (c) => {
        exitCode ??= c;
      },
    });
    await Promise.race([shutdown('SIGTERM'), new Promise((r) => setTimeout(r, 400))]);
    expect(exitCode).toBe(1);
    expect(app.stopped).toContain(true); // stop(true) force path fired
  });
});

// ── Layer B: real-sockets e2e under bun ──────────────────────────────────────
const bunAvailable =
  spawnSync('bun', ['--version'], {
    encoding: 'utf8',
  }).status === 0;
const PORT = 39287;
const METRICS_PORT = 39291;
const TOKEN = 'test-invalidate-token';

let child: ReturnType<typeof spawn> | undefined;

afterEach(async () => {
  const proc = child;
  child = undefined;
  if (proc && proc.exitCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* gone */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
});

function spawnHarness(extraEnv: Record<string, string> = {}) {
  const proc = spawn('bun', [HARNESS], {
    env: {
      ...process.env,
      PORT: String(PORT),
      METRICS_PORT: String(METRICS_PORT),
      CACHE_INVALIDATE_TOKEN: TOKEN,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return proc;
}

function waitForListening(proc: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`harness never listened. stderr:\n${stderr}`)),
      15000,
    );
    let stderr = '';
    let buf = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(`LISTENING:${PORT}`)) {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`harness exited early (${code}). stderr:\n${stderr}`));
    });
  });
}

describe.skipIf(!bunAvailable)(
  'bun-exec entry e2e (harness under bun): drain + metrics + auth',
  () => {
    it('completes an in-flight /slow request after SIGTERM and exits 0', async () => {
      child = spawnHarness({ SHUTDOWN_GRACE_MS: '10000' });
      await waitForListening(child);

      const started = Date.now();
      const inFlight = fetch(`http://127.0.0.1:${PORT}/slow`).then((r) => r.text());
      // let the request be accepted, then SIGTERM mid-flight
      await new Promise((r) => setTimeout(r, 400));
      child.kill('SIGTERM');

      const body = await inFlight;
      expect(body).toBe('drained-ok');
      expect(Date.now() - started).toBeGreaterThan(1500); // truly waited out the sleep

      const exitCode = await new Promise<number | null>((r) => {
        if (child?.exitCode != null) return r(child.exitCode);
        child?.once('exit', (code) => r(code));
      });
      expect(exitCode).toBe(0);
    }, 30000);

    it('serves a valid Prometheus exposition on :9091 while up', async () => {
      child = spawnHarness();
      await waitForListening(child);

      const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/version=0\.0\.4/);
      const text = await res.text();
      expect(text).toContain('# TYPE knext_bunexec_process_uptime_seconds gauge');
      expect(text).toMatch(/knext_bunexec_process_resident_memory_bytes \d+/);

      child.kill('SIGTERM');
    }, 30000);

    it('401s /api/cache/invalidate without a token, 200s with it', async () => {
      child = spawnHarness();
      await waitForListening(child);

      const unauth = await fetch(`http://127.0.0.1:${PORT}/api/cache/invalidate`, {
        method: 'POST',
      });
      expect(unauth.status).toBe(401);

      const wrong = await fetch(`http://127.0.0.1:${PORT}/api/cache/invalidate`, {
        method: 'POST',
        headers: { authorization: 'Bearer nope' },
      });
      expect(wrong.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${PORT}/api/cache/invalidate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ invalidated: true });

      child.kill('SIGTERM');
    }, 30000);
  },
);
