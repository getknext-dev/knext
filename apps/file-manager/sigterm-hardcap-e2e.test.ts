// @vitest-environment node
//
// This e2e spawns real localhost child processes and measures wall-clock exit
// timing; the repo's default `apps` project runs happy-dom, whose fetch/timers
// are DOM shims. Force the node environment so the hard-cap proof exercises the
// real spawned runtime entry, real signals, and real process exit.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared port plumbing (#678). waitForListeningPort REJECTS — promptly, with the
// child's stderr — when the runtime entry exits early or never announces a port,
// so swapping a fixed port for discovery cannot turn a real boot failure into a
// hang or a skip. Its own guard: apps/file-manager/child-ports.test.ts.
import { waitForListeningPort } from './e2e-support/child-ports';
import { installShippedPackages } from './e2e-support/shipped-runner';

/**
 * SHIPPED-PATH SIGTERM HARD-CAP (force-kill / safety-net) e2e for the knext
 * runtime entry.
 *
 * Companion to sigterm-drain-e2e.test.ts, which proves the HAPPY path: the
 * standalone child drains in-flight requests on SIGTERM and the runtime entry
 * exits cleanly. THIS test proves the SAFETY NET that drain test cannot: when the
 * standalone child IGNORES SIGTERM and never drains, the runtime entry must STILL
 * exit at the `graceMs` hard cap (SHUTDOWN_GRACE_MS) so the pod never blows past
 * its terminationGracePeriodSeconds (CLAUDE.md §7 / security.md: graceful shutdown
 * "must not hang past the pod grace period").
 *
 * Until now that hard-cap path was only covered by a UNIT test
 * (packages/kn-next/src/__tests__/shutdown.test.ts) with an INJECTED fake timer —
 * never e2e against the real spawned runtime entry. Reviewers flagged that gap.
 *
 * Approach (identical container-shaped layout to the drain e2e, so it exercises
 * the SHIPPED `@getknext/core/internal/node-server` entry, not the source tree):
 *   1. Build an ISOLATED runner dir OUTSIDE the workspace so `@getknext/core`
 *      resolution cannot escape upward into the repo's node_modules.
 *   2. npm-pack + npm-install the published @getknext/* shape (was: pnpm deploy,
 *      retired with pnpm itself) — a self-contained @getknext/core
 *      (dist + prom-client + pino) into <runner>/node_modules/@getknext/core —
 *      replicating the Dockerfile runtime COPY.
 *   3. Run the EXACT Dockerfile CMD (`node -e import('@getknext/core/internal/node-server')`)
 *      from the runner root, pointed via STANDALONE_SERVER_PATH at the
 *      IGNORE-SIGTERM fixture (traps SIGTERM, never drains, sleeps ~5min), with a
 *      SHORT SHUTDOWN_GRACE_MS so the test is fast.
 *   4. Send SIGTERM to the runtime entry and measure when it exits.
 *
 * Assertions (the hard-cap contract):
 *   - The runtime entry does NOT exit "instantly" — the child never drains, so
 *     the only way out is the cap timer; an early exit would mean the cap wasn't
 *     what released it (regression guard against the cap firing at 0 / a crash).
 *   - It DOES exit within graceMs + a margin — proving the pod grace period is
 *     honored and the process does not hang indefinitely on an unresponsive child.
 *   - The fixture printed SIGTERM-IGNORED (signal was forwarded but the child
 *     refused to drain) — so we know we exercised the unresponsive-child path,
 *     not an accidental clean drain.
 *
 * RED-first evidence: if the hard cap in shutdown.ts were removed, the runtime
 * entry would block forever on the child's "exit" event that never fires, and the
 * `exits at the hard cap` case below would TIME OUT (never resolve) — i.e. fail.
 * The injected SHORT graceMs makes that failure fast and deterministic.
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
const IGNORE_SERVER = resolve(__dirname, '__fixtures__/ignore-sigterm-standalone-server.mjs');

// PORTS ARE OS-ASSIGNED, NEVER LITERAL (#678). This file used to pin 39188/9092
// "to avoid collisions" with the drain e2e — which fixed collisions between OUR
// two files and did nothing about the real one: two CI jobs on the same runner.
// That is exactly how this gate failed on PR #676 (`EADDRINUSE :::39188`) and then
// passed unchanged on re-run. Both ports are now 0:
//   - PORT=0 → the fixture binds an OS-assigned port and reports it on stdout; the
//     spec reads it back (waitForListeningPort) instead of assuming it.
//   - METRICS_PORT=0 → the supervisor's Prometheus sidecar takes an OS-assigned
//     port too. Nothing here scrapes it, so it needs no readback; it only must not
//     collide (the drain e2e, which DOES scrape, reserves one via freePorts()).
// Note the supervisor's child-readiness TCP probe (waitForChildServing) reads $PORT
// and so cannot connect to "0" — its deferred init lands via its own deadline
// instead. That is acceptable HERE and only here: nothing in this file asserts on
// that path (no scrape, no metrics assertion), and this file's subject is the hard
// cap. The drain e2e is where the metrics sidecar AND the probe path are proven —
// it therefore reserves a REAL $PORT (freePorts(2)) rather than using 0, and asserts
// deferred init is reached with reason `child-serving`. Do not copy the `PORT=0`
// below into a spec that cares about supervisor readiness.
const EPHEMERAL = '0';
const GRACE_MS = 3000; // SHORT hard cap so the e2e is fast (default is 25s)

// The CMD specifier the container boots — the EXACT string from the Dockerfile.
const RUNTIME_IMPORT = "import('@getknext/core/internal/node-server')";

/**
 * Locate the standalone "tracing-root mirror" — only used to GATE the test on a
 * real build existing (the runner replaces server.js via STANDALONE_SERVER_PATH).
 */
function findStandaloneMirrorRoot(): string | null {
  const standaloneDir = resolve(APP_DIR, '.next/standalone');
  if (!existsSync(standaloneDir)) return null;
  const direct = join(standaloneDir, `apps/${APP_NAME}/server.js`);
  if (existsSync(direct)) return standaloneDir;
  const found = spawnSync('find', [standaloneDir, '-path', `*/apps/${APP_NAME}/server.js`], {
    encoding: 'utf8',
  });
  const line = found.stdout.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  return resolve(dirname(line), '..', '..');
}

const requireStandalone = process.env.KNEXT_REQUIRE_STANDALONE === '1';
const mirrorRoot = findStandaloneMirrorRoot();
const skipReason =
  mirrorRoot !== null ? null : 'standalone build not found — run `next build --webpack` first';

if (requireStandalone && skipReason !== null) {
  throw new Error(`KNEXT_REQUIRE_STANDALONE=1 but no standalone build present — ${skipReason}`);
}

let runnerRoot: string | undefined;
let child: ReturnType<typeof spawn> | undefined;

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // The runtime entry is plain Node; clear any harness NODE_OPTIONS preload so
  // the spawned `node` starts cleanly in any environment.
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

beforeAll(() => {
  if (skipReason !== null || mirrorRoot === null) return;

  // 1. Isolated runner dir OUTSIDE the workspace — see file header.
  runnerRoot = mkdtempSync(join(tmpdir(), 'knext-hardcap-runner-'));

  // 2. Install the real published shape (install-smoke.mjs pattern; the pnpm
  //    deploy this replicated died with the legacy Dockerfile — pnpm left the
  //    workspace, fe28ad9c): pack the three @getknext/* packages and
  //    npm-install the tarballs into the runner. Flat npm layout puts core AND
  //    its prod deps under <runner>/node_modules, as a real consumer resolves.
  //    The pack + install + PROVENANCE check lives in `e2e-support/shipped-runner`
  //    (T6a) — it reads npm's own `.package-lock.json` and requires every
  //    @getknext/* to have been resolved from a `file:` tarball, at the workspace
  //    version, with no nested second copy. So a rewritten `workspace:^` range
  //    that npm satisfies from the public registry reds here — INCLUDING when the
  //    published package carries the very same version number.
  const repoRoot = resolve(APP_DIR, '../..');
  installShippedPackages({ repoRoot, runnerRoot, env: childEnv() });
}, 180_000);

afterAll(() => {
  if (runnerRoot) rmSync(runnerRoot, { recursive: true, force: true });
});

// The runtime entry SPAWNS the fixture as a grandchild. We launch it `detached`
// in its own process group so teardown can SIGKILL the WHOLE group — otherwise
// the ignore-SIGTERM fixture keeps its listening sockets bound and the next
// case dies with EADDRINUSE.
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
  // The fixture is orphaned when the runtime entry hard-cap-exits before this
  // teardown runs; reap the (possibly orphaned) group too, then let ports free.
  if (proc.pid != null) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}

afterEach(async () => {
  await killTree();
});

function spawnShippedRuntime(extraEnv: Record<string, string>): ReturnType<typeof spawn> {
  return spawn('node', ['-e', RUNTIME_IMPORT], {
    cwd: runnerRoot,
    env: childEnv({
      PORT: EPHEMERAL, // OS-assigned; the fixture reports what it got (#678)
      METRICS_PORT: EPHEMERAL, // OS-assigned; nothing here scrapes it
      STANDALONE_SERVER_PATH: IGNORE_SERVER,
      STORAGE_BUCKET: '', // disable image-cache sync side effects
      ...extraEnv,
    }),
    detached: true, // own group so teardown can reap the grandchild fixture
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('SIGTERM hard-cap e2e (SHIPPED bundle): runtime entry force-exits at graceMs on an unresponsive child', () => {
  it.skipIf(skipReason !== null)(
    'force-exits at ~graceMs (not before, not never) when the child IGNORES SIGTERM',
    async () => {
      let stdout = '';
      child = spawnShippedRuntime({ SHUTDOWN_GRACE_MS: String(GRACE_MS) });
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });

      // Discovery, not assumption: the port comes from the fixture's own socket.
      // A runtime entry that fails to boot rejects here rather than hanging.
      const port = await waitForListeningPort(child, { label: 'runtime entry' });
      expect(port).toBeGreaterThan(0);
      expect(child.exitCode).toBeNull(); // booted & running

      // SIGTERM the runtime entry and start the clock. The forwarded SIGTERM hits
      // the ignore-fixture, which refuses to drain — so the ONLY way the runtime
      // entry can exit is its hard-cap timer.
      const t0 = Date.now();
      child.kill('SIGTERM');

      // Wait for the runtime entry to exit, bounded WELL above graceMs so a true
      // hang (cap removed) fails by timing out rather than passing.
      const exitMs = await new Promise<number>((resolvePromise, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `runtime entry DID NOT EXIT within ${GRACE_MS + 9000}ms after SIGTERM — ` +
                  `the hard cap failed to force-exit an unresponsive child (pod grace ` +
                  `period would be violated). stdout:\n${stdout}`,
              ),
            ),
          GRACE_MS + 9000,
        );
        child?.once('exit', () => {
          clearTimeout(timeout);
          resolvePromise(Date.now() - t0);
        });
      });

      // Proves the signal was forwarded but the child genuinely ignored it — so
      // we exercised the unresponsive-child path, not an accidental clean drain.
      expect(stdout).toContain('SIGTERM-IGNORED');
      expect(stdout).not.toContain('UNEXPECTED-SELF-EXIT');

      // Not "instant": the child never drained, so the cap timer (not an early
      // drain/crash) is what released the exit. Allow generous scheduling slack
      // below graceMs but reject a ~0ms exit.
      expect(exitMs).toBeGreaterThanOrEqual(GRACE_MS - 1000);

      // Not "never": exited within the hard cap + margin — pod grace period honored.
      expect(exitMs).toBeLessThanOrEqual(GRACE_MS + 6000);
    },
    60_000,
  );
});
