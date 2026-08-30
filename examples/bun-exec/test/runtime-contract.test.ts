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

import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkBearer,
  createGracefulShutdown,
  createMetricsState,
  METRICS_CONTENT_TYPE,
  renderMetrics,
  resolveAssetAnchor,
  resolveBindHost,
} from '../runtime-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(__dirname, 'drain-harness.mjs');
// Real-srvx harness (#467): same contract wiring but the app listener is the
// actual `srvx/bun` serve + `appSrvx.close(force)` adaptation, so drain/hardcap
// run against live srvx close() semantics rather than a raw Bun.serve stub.
const SRVX_HARNESS = resolve(__dirname, 'srvx-close-harness.mjs');

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

// ── #460 bug 3 — where the runtime reads `.output/public` from ───────────────
//
// The regression these lock in is SILENT by construction: when the asset root
// is wrong, `/` still returns correct SSR HTML and only the JS chunks 500, so
// the page renders and never hydrates. Only the minutes-long container e2e
// catches it end-to-end, so the decision itself is factored out of the entry
// (which cannot be imported here — it pulls in nitro/vinext) into this pure
// resolver, and BOTH directions are asserted.
describe('resolveAssetAnchor — the asset root travels with the binary (#460 bug 3)', () => {
  const bakedUrl = (dir: string) => pathToFileURL(resolve(dir, '.output/server/index.mjs')).href;
  /** exists() over an explicit allowlist — no filesystem, so both directions are expressible. */
  const existsIn = (present: string[]) => (p: string) => present.includes(resolve(p));

  it('re-anchors on the EXECUTABLE dir when the baked path is gone (the shipped container)', () => {
    // The compiled binary's baked `__nitro_main__` is the BUILD MACHINE's path,
    // which does not exist in the image. `/app/server` + `/app/.output/public`
    // is the shape the Dockerfile ships.
    const anchor = resolveAssetAnchor({
      bakedMain: bakedUrl('/Users/whoever/knext/examples/bun-exec'),
      execPath: '/app/server',
      exists: existsIn(['/app/.output/public']),
    });
    expect(anchor.mainUrl).toBe(bakedUrl('/app'));
    expect(anchor.warning).toBeNull();
  });

  it('is NOT cwd-dependent — the same executable resolves from any working directory', () => {
    // The whole point of anchoring on execPath: `docker run -w /somewhere-else`,
    // or a systemd unit with an unrelated WorkingDirectory, must still serve.
    const anchor = resolveAssetAnchor({
      bakedMain: bakedUrl('/Users/whoever/knext/examples/bun-exec'),
      execPath: '/opt/knext/server',
      exists: existsIn(['/opt/knext/.output/public']),
      cwd: '/var/empty',
    });
    expect(anchor.mainUrl).toBe(bakedUrl('/opt/knext'));
  });

  it('KEEPS a valid baked value — a non-compiled run from an unrelated cwd is untouched', () => {
    // `bun run /abs/path/.output/server/index.mjs` from somewhere else: the
    // baked `import.meta.url` is CORRECT there, and an unrelated `.output/public`
    // under cwd (or beside the `bun` executable) must not hijack it.
    const anchor = resolveAssetAnchor({
      bakedMain: bakedUrl('/srv/realapp'),
      execPath: '/opt/homebrew/bin/bun',
      exists: existsIn([
        '/srv/realapp/.output/public',
        '/elsewhere/.output/public',
        '/opt/homebrew/bin/.output/public',
      ]),
      cwd: '/elsewhere',
    });
    expect(anchor.mainUrl, 'a correct baked asset root was overwritten').toBeNull();
    expect(anchor.warning).toBeNull();
  });

  // ── The COMPILED-ON-THE-BUILDER case (#658 false-green class) ─────────────
  // Every case above is either "compiled, baked root gone" or "not compiled".
  // The one left over is the one humans actually stand in: a compiled binary
  // run ON THE MACHINE THAT BUILT IT, where the baked build-tree root DOES
  // still exist. If the baked root wins there unconditionally, the binary
  // serves the BUILD TREE's assets instead of the ones shipped beside it —
  // and `warning: null` means nothing says so. Consequences, all silent:
  // "I copied the binary + .output/public to /tmp/ship and it served" proves
  // nothing (delete the shipped public/ and it still serves); after a rebuild
  // a moved binary serves the NEW tree's content-hashed chunks against old
  // HTML; and because `exists` is directory-level, a stale or emptied baked
  // public/ SHADOWS a complete co-located one — a partial anchor, which is
  // worse than no anchor. The two cases are distinguishable: a non-compiled
  // run's execPath is the bun/node RUNTIME, a compiled one's is the binary.
  it('prefers the CO-LOCATED root over the build tree when compiled and BOTH exist', () => {
    const anchor = resolveAssetAnchor({
      bakedMain: bakedUrl('/Users/dev/knext/examples/bun-exec'),
      execPath: '/tmp/ship/server',
      exists: existsIn([
        '/Users/dev/knext/examples/bun-exec/.output/public',
        '/tmp/ship/.output/public',
      ]),
    });
    expect(
      anchor.mainUrl,
      'a compiled binary silently served the BUILD TREE assets, not its own',
    ).toBe(bakedUrl('/tmp/ship'));
    expect(anchor.source).toBe('execdir');
    expect(anchor.warning, 'the build-tree/co-located ambiguity resolved silently').toBeTruthy();
    // Both roots must be named or the operator cannot tell which one it got.
    expect(anchor.warning).toContain('/tmp/ship/.output/public');
    expect(anchor.warning).toContain('/Users/dev/knext/examples/bun-exec/.output/public');
  });

  it('WARNS when a compiled binary can only anchor on the build tree', () => {
    // Same builder machine, but nothing was shipped beside the binary. Serving
    // is not broken (the baked root is right there), so we keep it — but this
    // is exactly the "it worked on my machine" false green, so it must be loud.
    const anchor = resolveAssetAnchor({
      bakedMain: bakedUrl('/Users/dev/knext/examples/bun-exec'),
      execPath: '/tmp/ship/server',
      exists: existsIn(['/Users/dev/knext/examples/bun-exec/.output/public']),
    });
    expect(anchor.source).toBe('baked');
    expect(
      anchor.mainUrl,
      'the baked value must be kept whole, never partially rewritten',
    ).toBeNull();
    expect(
      anchor.warning,
      'a compiled binary anchored on its build tree without saying so',
    ).toBeTruthy();
  });

  // ── The DOCUMENTED FIRST RUN: one root, reached two ways ──────────────────
  // `build.sh` drops the binary INTO `examples/bun-exec/`, beside the very
  // `.output/public` it was built from, and the README tells you to run it
  // there. So `dirname(execPath)/.output/public` and the baked
  // `dirname(__nitro_main__)/../public` are THE SAME DIRECTORY. Nothing is
  // ambiguous and nothing is missing — there is one root and it is correct.
  // Treating that as "no co-located root, fell back to the build tree" prints
  // the same path twice and tells the user to do what they already did. This
  // PR exists because the failure mode was SILENCE; a warning that cries wolf
  // on the documented first run is how the real one gets ignored.
  it('does NOT warn when the two roots are the SAME directory (binary built in place)', () => {
    const dir = '/Users/dev/knext/examples/bun-exec';
    const anchor = resolveAssetAnchor({
      bakedMain: bakedUrl(dir),
      execPath: `${dir}/knext-bun-exec-darwin-arm64`,
      exists: existsIn([`${dir}/.output/public`]),
    });
    expect(anchor.source, 'the single real root was reported as a build-tree fallback').toBe(
      'execdir',
    );
    expect(anchor.mainUrl).toBe(bakedUrl(dir));
    expect(
      anchor.warning,
      'warned about a build-tree fallback while the co-located root IS that directory',
    ).toBeNull();
  });

  it('is still LOUD when the two roots are the same directory and it does not exist', () => {
    // Same coincident-roots layout, nothing built. One path, named once, and
    // the "ship it next to .output/public" advice is genuinely actionable here.
    const dir = '/Users/dev/knext/examples/bun-exec';
    const anchor = resolveAssetAnchor({
      bakedMain: bakedUrl(dir),
      execPath: `${dir}/knext-bun-exec-darwin-arm64`,
      exists: existsIn([]),
    });
    expect(anchor.source).toBe('unresolved');
    expect(anchor.mainUrl).toBeNull();
    expect(anchor.warning, 'a missing asset layout resolved silently').toBeTruthy();
    expect(anchor.warning).toContain(`${dir}/.output/public`);
  });

  it('honours an explicitly injected isCompiled over the execPath heuristic', () => {
    // The discriminator is injectable so a binary named `bun`, or a future bun
    // signal, does not have to be guessed at by basename.
    const anchor = resolveAssetAnchor({
      bakedMain: bakedUrl('/srv/realapp'),
      execPath: '/opt/homebrew/bin/bun',
      isCompiled: true,
      exists: existsIn(['/srv/realapp/.output/public', '/opt/homebrew/bin/.output/public']),
    });
    expect(anchor.source).toBe('execdir');
    expect(anchor.warning).toBeTruthy();
  });

  it('is LOUD when no candidate has the layout — never silently keeps a dead root', () => {
    // The failure this whole PR exists to have discovered. Nothing can be
    // served, so the one thing that must not happen is silence.
    const anchor = resolveAssetAnchor({
      bakedMain: bakedUrl('/Users/whoever/knext/examples/bun-exec'),
      execPath: '/app/server',
      exists: existsIn([]),
    });
    expect(anchor.mainUrl).toBeNull();
    expect(anchor.warning, 'a missing asset layout resolved silently').toBeTruthy();
    // The message has to name both candidates, or it cannot be acted on.
    expect(anchor.warning).toContain('/app/.output/public');
    expect(anchor.warning).toContain('/Users/whoever/knext/examples/bun-exec/.output/public');
  });

  it('is loud, not throwing, when there is no baked value at all', () => {
    // Dev / a preset change that stops prepending `__nitro_main__`.
    const anchor = resolveAssetAnchor({
      bakedMain: undefined,
      execPath: '/app/server',
      exists: existsIn([]),
    });
    expect(anchor.warning).toBeTruthy();
    expect(anchor.mainUrl).toBeNull();
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
// PORTS ARE OS-ASSIGNED, NEVER LITERAL (#678). Literals here deconflicted only our
// own files; the collision that actually bit was two CI jobs on one runner
// (`EADDRINUSE :::39188` on PR #676). The harnesses print
// `LISTENING:<port> METRICS:<port>` from the sockets they actually bound, so every
// case reads both ports back rather than assuming them.
const EPHEMERAL = '0';
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

function spawnHarness(extraEnv: Record<string, string> = {}, harness: string = HARNESS) {
  const proc = spawn('bun', [harness], {
    env: {
      ...process.env,
      PORT: EPHEMERAL,
      METRICS_PORT: EPHEMERAL,
      CACHE_INVALIDATE_TOKEN: TOKEN,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return proc;
}

/**
 * Both ports the harness ACTUALLY bound, parsed from its
 * `LISTENING:<port> METRICS:<port>` line (#678 — with PORT/METRICS_PORT=0 the OS
 * assigns them, so this line is the only source of truth).
 *
 * It must still fail LOUDLY on a real startup failure: a harness that exits early
 * or never announces rejects here, with stderr — never hangs to the vitest
 * timeout, never skips (the green-by-skip class closed in #408/#448/#659).
 */
function waitForListeningPorts(
  proc: ReturnType<typeof spawn>,
): Promise<{ port: number; metricsPort: number }> {
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
      const m = buf.match(/LISTENING:(\d+) METRICS:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolvePromise({ port: Number(m[1]), metricsPort: Number(m[2]) });
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
      const { port } = await waitForListeningPorts(child);

      const started = Date.now();
      const inFlight = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text());
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

    it('serves a valid Prometheus exposition on its metrics port while up', async () => {
      child = spawnHarness();
      const { metricsPort } = await waitForListeningPorts(child);

      const res = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/version=0\.0\.4/);
      const text = await res.text();
      expect(text).toContain('# TYPE knext_bunexec_process_uptime_seconds gauge');
      expect(text).toMatch(/knext_bunexec_process_resident_memory_bytes \d+/);

      child.kill('SIGTERM');
    }, 30000);

    it('401s /api/cache/invalidate without a token, 200s with it', async () => {
      child = spawnHarness();
      const { port } = await waitForListeningPorts(child);

      const unauth = await fetch(`http://127.0.0.1:${port}/api/cache/invalidate`, {
        method: 'POST',
      });
      expect(unauth.status).toBe(401);

      const wrong = await fetch(`http://127.0.0.1:${port}/api/cache/invalidate`, {
        method: 'POST',
        headers: { authorization: 'Bearer nope' },
      });
      expect(wrong.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${port}/api/cache/invalidate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ invalidated: true });

      child.kill('SIGTERM');
    }, 30000);
  },
);

// ── Layer C: real srvx close() semantics (#467) ──────────────────────────────
// The mock drain-harness above proves createGracefulShutdown's ORDERING with a
// raw Bun.serve. This block runs the SAME drain + hardcap through the entry's
// ACTUAL `srvx/bun` serve + `appSrvx.close(force)` adaptation, so a srvx pin bump
// that changed close() semantics is caught here rather than only on OKE.
describe.skipIf(!bunAvailable)('bun-exec entry e2e (REAL srvx close): drain + hardcap', () => {
  it('srvx close() drains an in-flight /slow request on SIGTERM and exits 0', async () => {
    child = spawnHarness({ SHUTDOWN_GRACE_MS: '10000' }, SRVX_HARNESS);
    const { port } = await waitForListeningPorts(child);

    const started = Date.now();
    const inFlight = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 400)); // land SIGTERM mid-flight
    child.kill('SIGTERM');

    // The in-flight request must still complete 200 — proving srvx close()
    // (no force) waited for it rather than severing the socket.
    expect(await inFlight).toBe('drained-ok');
    expect(Date.now() - started).toBeGreaterThan(1500);

    const exitCode = await new Promise<number | null>((r) => {
      if (child?.exitCode != null) return r(child.exitCode);
      child?.once('exit', (code) => r(code));
    });
    expect(exitCode).toBe(0);
  }, 30000);

  it('srvx close(true) force-exits 1 when an in-flight request exceeds the hardcap', async () => {
    child = spawnHarness({ SHUTDOWN_GRACE_MS: '800' }, SRVX_HARNESS);
    const { port } = await waitForListeningPorts(child);

    // /hang never resolves, so graceful srvx close() cannot drain it; the
    // hardcap must fire close(true) (force) and exit 1.
    const hung = fetch(`http://127.0.0.1:${port}/hang`).catch(() => 'errored');
    await new Promise((r) => setTimeout(r, 300));
    child.kill('SIGTERM');

    const exitCode = await new Promise<number | null>((r) => {
      if (child?.exitCode != null) return r(child.exitCode);
      child?.once('exit', (code) => r(code));
    });
    expect(exitCode).toBe(1); // hardcap path (force close)
    await hung; // the force-closed request errors/settles — don't leak it
  }, 30000);

  it('PORT=0 resolves the ephemeral port via srvx and serves on it', async () => {
    // Since #678 EVERY case in this file runs with PORT=0, so the srvx-resolved
    // `.bun.server.port` fallback is on the common path rather than exercised only
    // here. This case is still the one that PINS it explicitly: it sets PORT=0
    // itself (not via the shared default) and asserts the reported port actually
    // serves, so an srvx internal-shape change is caught by a named test rather
    // than by every other case going mysteriously red.
    child = spawnHarness({ PORT: '0', METRICS_PORT: '0' }, SRVX_HARNESS);
    const { port } = await waitForListeningPorts(child);
    expect(port).toBeGreaterThan(0);

    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', target: 'bun-exec' });

    child.kill('SIGTERM');
  }, 30000);
});
