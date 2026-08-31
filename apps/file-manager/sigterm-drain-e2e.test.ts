// @vitest-environment node
//
// This e2e makes real cross-origin HTTP calls to localhost child processes; the
// repo's default `apps` project runs happy-dom, whose fetch enforces a
// Same-Origin Policy that blocks those calls. Force the node environment so the
// drain proof exercises real sockets, not a DOM fetch shim.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared port plumbing (#678). waitForListeningPort REJECTS — promptly, with the
// child's stderr — when the runtime entry exits early (the MODULE_NOT_FOUND
// regression this file exists for) or never announces a port, so swapping a fixed
// port for discovery cannot turn a real boot failure into a hang or a skip. Its
// own guard: apps/file-manager/child-ports.test.ts.
import { freePorts, waitForListeningPort } from './e2e-support/child-ports';

/**
 * SHIPPED-PATH SIGTERM-drain e2e for the knext runtime entry.
 *
 * Why this is NOT the source-tree e2e it replaces:
 * The previous version spawned `packages/kn-next/dist/adapters/node-server.js`
 * straight from the SOURCE TREE. On a dev machine that always resolves
 * `prom-client`/`pino` via the workspace's hoisted node_modules, so it could
 * NOT catch the real container bug: Next's standalone output is import-graph
 * driven, NOTHING in app code imports node-server.js, so neither the runtime
 * entry NOR its hard deps (prom-client, pino) are traced into `.next/standalone`.
 * The shipped image's CMD — `node -e "import('@getknext/core/internal/node-server')"`
 * — therefore resolved to MODULE_NOT_FOUND and crash-looped at boot, while CI
 * stayed green because no job ran that CMD against the real bundle.
 *
 * This test reproduces the REAL container resolution layout:
 *   1. Build an ISOLATED runner dir OUTSIDE the workspace whose ONLY way to find
 *      `@getknext/core` is the package we place in it — so Node's module resolution
 *      cannot escape upward into the repo's node_modules (the dev-machine false
 *      positive the reviewers flagged). Without step 2 below, the CMD here fails
 *      with `ERR_MODULE_NOT_FOUND: Cannot find package '@getknext/core'` — exactly
 *      the container crash-loop.
 *   2. Replicate the Dockerfile's runtime COPY: `pnpm --filter @getknext/core
 *      --prod deploy` a self-contained @getknext/core into
 *      `<runner>/node_modules/@getknext/core` (dist + a real node_modules with
 *      prom-client/pino). This is the fix under test.
 *   3. Run the EXACT Dockerfile CMD (`node -e import('@getknext/core/internal/node-server')`)
 *      from the runner root, pointed at a slow fixture server via
 *      STANDALONE_SERVER_PATH, send SIGTERM mid-inflight-request, and assert the
 *      request drains (200 "drained") + the process exits cleanly.
 *
 * The runner intentionally does NOT copy the (huge) `.next/standalone` tree: the
 * app server.js is replaced by the slow fixture via STANDALONE_SERVER_PATH, and
 * the property under test is purely whether the runtime ENTRY (`@getknext/core` +
 * prom-client + pino) resolves from a container-shaped layout. We still GATE on
 * the standalone build existing (below) so this only runs when an image could
 * actually be built — i.e. it tracks the real shipped artifact.
 *
 * RED proof (verified manually before the fix): without the deploy COPY, the
 * isolated runner's CMD fails with `ERR_MODULE_NOT_FOUND: Cannot find package
 * '@getknext/core'`. The `resolves the runtime entry from the shipped bundle` case
 * below FAILS (not skips) if that resolution gap ever returns.
 *
 * Skips (does not fail) only when the standalone build is entirely absent — a
 * source-only checkout. Under KNEXT_REQUIRE_STANDALONE=1 (CI) a missing build is
 * a HARD failure, so a green check can never mean "skipped".
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * The app whose standalone build supplies the runner environment.
 *
 * Defaults to this directory for a local run, but is overridable because
 * file-manager STOPPED producing a standalone tree when ADR-0048 made vinext
 * its build. The subject of this gate is the node-server SUPERVISOR, not any
 * particular app — the app's own `server.js` is replaced by the slow fixture
 * via STANDALONE_SERVER_PATH — so it needs *a* standalone tree, and
 * `apps/db-demo` is the one that still emits one.
 *
 * Without this the gate is worse than absent: with KNEXT_REQUIRE_STANDALONE=1
 * it hard-fails on a build that no longer exists, and without it, it silently
 * skips and reports green while testing nothing.
 */
const APP_DIR = process.env.KNEXT_SIGTERM_APP_DIR
  ? resolve(process.env.KNEXT_SIGTERM_APP_DIR)
  : __dirname;

/** The app's directory name, used to find its entry inside the mirror. */
const APP_NAME = basename(APP_DIR);
const SLOW_SERVER = resolve(__dirname, '__fixtures__/slow-standalone-server.mjs');

// PORTS ARE OS-ASSIGNED, NEVER LITERAL (#678). "Unlikely to collide" is not the
// same as "cannot collide": this gate failed on PR #676 with `EADDRINUSE :::39188`
// (the hard-cap e2e's twin of the port that used to live here) and passed on a
// re-run, and #673 turned CI on for stacked PRs so concurrent jobs are now more
// common, not less.
//
// BOTH ports are reserved in ONE call to freePorts(2). An earlier revision of this
// file used `PORT=0` for the app port, on the reasoning that a readback channel
// (`LISTENING:<port>`) closes the reserve→bind window that freePort() leaves open.
// That is true, and it was still the wrong trade, for a reason that has nothing to
// do with flakiness:
//
//   `PORT=0` IS NOT A CONFIGURATION PRODUCTION EVER RUNS. The runtime entry's own
//   default is 3000 (`packages/kn-next/src/adapters/env.ts`), and Knative injects
//   the container port. More concretely, the supervisor probes its child at
//   `Number(process.env.PORT ?? 3000)` (`node-server.ts`, deferred supervisor
//   init). With PORT=0 that probe connects to port 0, which can NEVER succeed — so
//   deferred init reached `ensureStarted` via the 60s DEADLINE instead of via
//   `child-serving`, and this spec silently stopped covering the probe path. That
//   path — real $PORT → real child → `child-serving` — is covered NOWHERE else:
//   `waitForChildServing` is unit-tested with an INJECTED probe and `probeTcp`
//   against a bare socket, but never wired to a real child, and `node-server.ts`
//   is the repo's 0%-coverage residual (`vitest.config.ts`).
//
// So: reserve a real port, pass it as $PORT, and let the readback prove the
// reservation was honoured (`expect(port).toBe(appPort)`) rather than merely
// prove the port is positive.
//
// METRICS_PORT keeps its reservation for the original reason: it has no readback
// channel at all. It is bound by the runtime entry itself and echoed only into a
// pino log whose FORMAT differs between production (JSON) and dev (pino-pretty),
// which is too brittle to parse.
//
// The two are reserved by ONE `freePorts(2)` call, not two `freePort()` calls,
// and that is load-bearing rather than tidy: sequential reservations can return
// the SAME port (the OS may reuse it once the first socket closes), which would
// set PORT === METRICS_PORT and kill one bind with EADDRINUSE — reintroducing, by
// a different route, the exact flake this file exists to remove. freePorts holds
// every socket in LISTEN until all are allocated, so a repeat is impossible, not
// merely improbable (`child-ports.test.ts` asserts the hold directly).
//
// What that does NOT fix, stated rather than glossed: a reserved port still has a
// release→bind window against the REST of the machine, where `PORT=0` had none.
// The window is irreducible for a port a different process must bind, and this
// spawn already had it for METRICS_PORT.

// The CMD specifier the container boots — the EXACT string from the Dockerfile.
const RUNTIME_IMPORT = "import('@getknext/core/internal/node-server')";

/**
 * Locate the standalone "tracing-root mirror" that contains the app's server.js.
 * Next preserves paths relative to the auto-detected tracing root (the repo
 * root, by lockfile), so the app entry lands at
 * `.next/standalone/<rel>/apps/<app>/server.js`. We search for it rather
 * than hardcoding `<rel>` (which differs between a plain checkout and a git
 * worktree).
 */
function findStandaloneMirrorRoot(): string | null {
  const standaloneDir = resolve(APP_DIR, '.next/standalone');
  if (!existsSync(standaloneDir)) return null;
  // Candidate 1: single-app / repo-root layout → apps/file-manager/server.js
  const direct = join(standaloneDir, `apps/${APP_NAME}/server.js`);
  if (existsSync(direct)) return standaloneDir;
  // Candidate 2: worktree/nested-root layout → <rel>/apps/file-manager/server.js
  const found = spawnSync('find', [standaloneDir, '-path', `*/apps/${APP_NAME}/server.js`], {
    encoding: 'utf8',
  });
  const line = found.stdout.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  // mirror root = the dir two levels above apps/file-manager/server.js
  return resolve(dirname(line), '..', '..');
}

const requireStandalone = process.env.KNEXT_REQUIRE_STANDALONE === '1';
const mirrorRoot = findStandaloneMirrorRoot();
const skipReason =
  mirrorRoot !== null ? null : 'standalone build not found — run `next build --webpack` first';

if (requireStandalone && skipReason !== null) {
  throw new Error(`KNEXT_REQUIRE_STANDALONE=1 but no standalone build present — ${skipReason}`);
}

// Assembled once: an isolated runner mirroring the Dockerfile runner stage.
let runnerRoot: string | undefined;
let child: ReturnType<typeof spawn> | undefined;
// Reserved per-case (see afterEach/spawn) so a re-spawn never reuses a port the
// previous, still-dying supervisor holds.
let metricsPort = 0;
// The app port handed to the runtime entry as $PORT. Reserved (not 0) so the
// supervisor's child-readiness probe — which reads $PORT — can actually connect.
let appPort = 0;
// Everything the supervisor wrote to stdout, INCLUDING the child's (the entry
// spawns it with stdio:'inherit'). Kept for the whole life of the child so the
// spec can assert on logs that arrive AFTER the LISTENING line.
let childStdout = '';

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // The runtime entry is plain Node; clear any harness NODE_OPTIONS preload so
  // the spawned `node` starts cleanly in any environment.
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

beforeAll(() => {
  if (skipReason !== null || mirrorRoot === null) return;

  // 1. An isolated runner dir OUTSIDE the workspace. The CMD runs from here, so
  //    `@getknext/core` resolution cannot escape up into the repo node_modules —
  //    the only @getknext/core it can find is the one we deploy into it (step 2).
  runnerRoot = mkdtempSync(join(tmpdir(), 'knext-shipped-runner-'));

  // 2. Replicate the Dockerfile runtime COPY: a self-contained @getknext/core with
  //    its prod deps (prom-client, pino) at node_modules/@getknext/core. We run the
  //    SAME `pnpm deploy` the Dockerfile uses so the test exercises the actual
  //    fix, not a hand-assembled stand-in.
  const deployDir = mkdtempSync(join(tmpdir(), 'knext-core-deploy-'));
  const repoRoot = resolve(APP_DIR, '../..');
  const dep = spawnSync(
    'pnpm',
    ['--filter', '@getknext/core', '--prod', 'deploy', '--legacy', deployDir],
    { cwd: repoRoot, encoding: 'utf8', env: childEnv() },
  );
  if (
    !existsSync(join(deployDir, 'dist/adapters/node-server.js')) ||
    !existsSync(join(deployDir, 'node_modules/prom-client')) ||
    !existsSync(join(deployDir, 'node_modules/pino'))
  ) {
    throw new Error(
      `pnpm deploy did not produce a self-contained @getknext/core ` +
        `(node-server.js + prom-client + pino). stderr:\n${dep.stderr}`,
    );
  }
  // verbatimSymlinks: KEEP pnpm's RELATIVE `.pnpm/…` symlinks intact. The default
  // (false) rewrites them to ABSOLUTE paths pointing back at deployDir, which we
  // then delete → dangling links → MODULE_NOT_FOUND for prom-client/pino. The
  // Dockerfile `COPY` preserves them verbatim, so we must too.
  cpSync(deployDir, join(runnerRoot, 'node_modules/@getknext/core'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  rmSync(deployDir, { recursive: true, force: true });
}, 180_000);

afterAll(() => {
  if (runnerRoot) rmSync(runnerRoot, { recursive: true, force: true });
});

// The runtime entry SPAWNS the fixture server as a grandchild. We launch it in
// its own process group (`detached`) so teardown can SIGKILL the WHOLE group —
// otherwise an orphaned fixture keeps its OS-assigned ports bound and the
// next case dies with EADDRINUSE. Wait for the ports to actually free before the
// next case runs.
async function killTree(): Promise<void> {
  const proc = child;
  child = undefined;
  if (!proc || proc.pid == null) return;
  if (proc.exitCode === null) {
    try {
      process.kill(-proc.pid, 'SIGKILL'); // negative pid → whole process group
    } catch {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  // Give the OS a moment to release the bound (OS-assigned) ports.
  await new Promise((r) => setTimeout(r, 500));
}

afterEach(async () => {
  await killTree();
});

/**
 * Spawn the EXACT Dockerfile CMD from the isolated runner root: boot the runtime
 * entry by its published package specifier (NOT the dist file path), so the test
 * proves resolution from the shipped bundle, not the source tree.
 */
async function spawnShippedRuntime(
  extraEnv: Record<string, string>,
): Promise<ReturnType<typeof spawn>> {
  // Reserved fresh per spawn (#678) so a re-spawn never reuses a port the
  // previous, still-dying supervisor holds — and in ONE call, so the two can
  // never come back as the same number (see the header note).
  [appPort, metricsPort] = await freePorts(2);
  childStdout = '';
  const proc = spawn('node', ['-e', RUNTIME_IMPORT], {
    cwd: runnerRoot,
    env: childEnv({
      // A REAL port, not 0: the supervisor probes its child at $PORT, and port 0
      // can never be connected to. See the header note.
      PORT: String(appPort),
      METRICS_PORT: String(metricsPort),
      STANDALONE_SERVER_PATH: SLOW_SERVER,
      STORAGE_BUCKET: '', // disable image-cache sync side effects
      ...extraEnv,
    }),
    // Own process group so teardown can SIGKILL the runtime entry AND its spawned
    // fixture grandchild together (see killTree). `child.kill('SIGTERM')` still
    // targets only the group leader (the runtime entry), which is exactly the
    // signal path under test — the entry must FORWARD it to drain the child.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Attached in the same tick as spawn(), before any data can arrive.
  proc.stdout?.on('data', (d: Buffer) => {
    childStdout += d.toString();
  });
  return proc;
}

/**
 * Wait for `re` to appear in the supervisor's stdout, or FAIL with what was
 * actually captured. Polls rather than parsing a stream so it works whether pino
 * emitted JSON (production) or pino-pretty (dev) — the assertion is on the
 * substring, never on the log's shape.
 *
 * SCOPE LIMIT (recorded, not fixed): unlike `waitForListeningPort` this has NO
 * early-exit detection. If the supervisor dies between `LISTENING` and the log
 * being awaited, this burns the full timeout and reports without the child's
 * stderr. It still REDS — never a hang, never a skip — so this is a
 * diagnosability nit, not a correctness hole; the fix is to watch `exit` here too.
 */
async function waitForStdout(re: RegExp, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (re.test(childStdout)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `${what}: never saw ${re} in the runtime entry's stdout within ${timeoutMs}ms.\n` +
      `stdout:\n${childStdout}`,
  );
}

describe('SIGTERM drain e2e (SHIPPED bundle): knext runtime entry drains in-flight requests', () => {
  it.skipIf(skipReason !== null)(
    'resolves the runtime entry from the shipped standalone bundle (no MODULE_NOT_FOUND)',
    async () => {
      // This is the regression the reviewers found: if @getknext/core (or its hard
      // deps) is missing from the shipped layout, the CMD crash-loops at boot.
      // Booting it and reaching LISTENING proves the specifier + prom-client +
      // pino all resolve from the bundle. A MODULE_NOT_FOUND would surface as an
      // early exit here and FAIL (not skip) this test.
      child = await spawnShippedRuntime({});
      const port = await waitForListeningPort(child, { label: 'runtime entry' });
      // The port the child ACTUALLY bound is the port we reserved and passed as
      // $PORT. `toBeGreaterThan(0)` would pass on any port at all — including one
      // the supervisor could never have told the child about.
      expect(port).toBe(appPort);
      expect(child.exitCode).toBeNull(); // still running → resolved & booted
      child.kill('SIGTERM');
    },
    60_000,
  );

  it.skipIf(skipReason !== null)(
    'supervisor reaches deferred init via the child-readiness PROBE, not the deadline',
    async () => {
      // The wiring this spec is the only coverage of: the runtime entry reads the
      // REAL $PORT, TCP-probes its own child there, and starts deferred supervisor
      // init with reason `child-serving` (node-server.ts). `waitForChildServing`
      // is unit-tested only with an injected probe, so nothing else joins the
      // three real parts up.
      //
      // Asserting the REASON is what makes this a probe test rather than a "did
      // init happen" test: `ensureStarted` is idempotent and logs only the FIRST
      // caller's reason, and there are FOUR other callers — the 60s deadline
      // (`child-deadline`, node-server.ts:342 with outcome `deadline`), a probe
      // crash (`probe-error`, :346), deferral being switched off outright
      // (`deferral-disabled`, :350) and a metrics scrape (`scrape`, via
      // `ensureDefaultMetrics`). Every one of them would leave init "complete"
      // while the probe path was dead. Under the pre-#678-fix `PORT=0` this case
      // fails with `child-deadline`: port 0 is unconnectable, so the probe could
      // never win.
      //
      // WHAT DISCRIMINATES, precisely: the POSITIVE assertion plus its MARGIN.
      // `child-serving` exists in the bundle only as `ensureStarted(\`child-${outcome}\`)`
      // with outcome === 'serving', which `waitForChildServing` returns only after
      // `probeTcp` actually CONNECTED to $PORT — so the string cannot be logged by
      // any other path. And 20s is a hard bound well inside the 60s deadline, so a
      // deadline-driven init cannot masquerade as a probe-driven one; a slow
      // machine can only red this case, never green it falsely.
      //
      // NOT asserted, deliberately: `expect(childStdout).not.toMatch(/child-deadline|…/)`.
      // That negative is VACUOUS — `ensureStarted` sets `started = true` before
      // `runAll`, and `runAll` logs the reason exactly once, so once `child-serving`
      // has appeared no other reason string can exist in the stream. It could never
      // fail while the positive passed. Do not re-add it as if it carried weight.
      child = await spawnShippedRuntime({});
      await waitForListeningPort(child, { label: 'runtime entry' });

      // Nothing here scrapes :METRICS_PORT, so `scrape` cannot pre-empt the probe.
      // Well under the 60s deadline: the probe polls every 250ms.
      await waitForStdout(/child-serving/, 20_000, 'child-readiness probe');

      child.kill('SIGTERM');
    },
    60_000,
  );

  it.skipIf(skipReason !== null)(
    'completes an in-flight request after SIGTERM and exits cleanly',
    async () => {
      let stdout = '';
      child = await spawnShippedRuntime({ SHUTDOWN_GRACE_MS: '10000' });
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });

      const port = await waitForListeningPort(child, { label: 'runtime entry' });

      // Fire a slow in-flight request; do NOT await it yet. The port is the one
      // the fixture's socket actually got — never an assumed constant.
      const inFlight = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text());

      // Let the request be accepted, then SIGTERM the runtime entry.
      await new Promise((r) => setTimeout(r, 300));
      child.kill('SIGTERM');

      // The in-flight request MUST still complete (drained), not be dropped.
      const body = await inFlight;
      expect(body).toBe('drained');

      // The runtime entry must exit cleanly after the child drains.
      const exitCode = await new Promise<number | null>((r) => {
        if (child?.exitCode != null) {
          r(child.exitCode);
          return;
        }
        child?.once('exit', (code) => r(code));
      });
      expect(exitCode).toBe(0);

      // The fixture proves the signal was actually forwarded + the drain ran.
      expect(stdout).toContain('SIGTERM-RECEIVED');
      expect(stdout).toContain('DRAINED-EXIT');
    },
    60_000,
  );

  it.skipIf(skipReason !== null)(
    'serves the Prometheus metrics sidecar while the runtime entry is up',
    async () => {
      child = await spawnShippedRuntime({});
      await waitForListeningPort(child, { label: 'runtime entry' });

      // metricsPort was RESERVED for this spawn (freePorts(2)), so it is known without
      // parsing a log — but it is still OS-assigned, never a literal.
      const res = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toMatch(/process_cpu|nodejs_/); // default metrics present

      child.kill('SIGTERM');
    },
    60_000,
  );
});
