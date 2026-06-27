// @vitest-environment node
//
// This e2e spawns real localhost child processes and measures wall-clock exit
// timing; the repo's default `apps` project runs happy-dom, whose fetch/timers
// are DOM shims. Force the node environment so the hard-cap proof exercises the
// real spawned runtime entry, real signals, and real process exit.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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
 * the SHIPPED `@knext/core/internal/node-server` entry, not the source tree):
 *   1. Build an ISOLATED runner dir OUTSIDE the workspace so `@knext/core`
 *      resolution cannot escape upward into the repo's node_modules.
 *   2. `pnpm --filter @knext/core --prod deploy` a self-contained @knext/core
 *      (dist + prom-client + pino) into <runner>/node_modules/@knext/core —
 *      replicating the Dockerfile runtime COPY.
 *   3. Run the EXACT Dockerfile CMD (`node -e import('@knext/core/internal/node-server')`)
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
const APP_DIR = __dirname;
const IGNORE_SERVER = resolve(__dirname, '__fixtures__/ignore-sigterm-standalone-server.mjs');

const PORT = 39188; // distinct from the drain e2e's port to avoid collisions
// Distinct metrics port too: the drain e2e binds the default 9091. Without this
// override, running both files in one vitest invocation makes the second runtime
// entry die with EADDRINUSE on 9091 (the runtime exits early → nondeterministic).
// METRICS_PORT is a real production knob in node-server.ts (default 9091).
const METRICS_PORT = 9092;
const GRACE_MS = 3000; // SHORT hard cap so the e2e is fast (default is 25s)

// The CMD specifier the container boots — the EXACT string from the Dockerfile.
const RUNTIME_IMPORT = "import('@knext/core/internal/node-server')";

/**
 * Locate the standalone "tracing-root mirror" — only used to GATE the test on a
 * real build existing (the runner replaces server.js via STANDALONE_SERVER_PATH).
 */
function findStandaloneMirrorRoot(): string | null {
  const standaloneDir = resolve(APP_DIR, '.next/standalone');
  if (!existsSync(standaloneDir)) return null;
  const direct = join(standaloneDir, 'apps/file-manager/server.js');
  if (existsSync(direct)) return standaloneDir;
  const found = spawnSync('find', [standaloneDir, '-path', '*/apps/file-manager/server.js'], {
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

  // 2. Replicate the Dockerfile runtime COPY: self-contained @knext/core + prod
  //    deps at node_modules/@knext/core via the SAME `pnpm deploy` the image uses.
  const deployDir = mkdtempSync(join(tmpdir(), 'knext-core-deploy-'));
  const repoRoot = resolve(APP_DIR, '../..');
  const dep = spawnSync(
    'pnpm',
    ['--filter', '@knext/core', '--prod', 'deploy', '--legacy', deployDir],
    { cwd: repoRoot, encoding: 'utf8', env: childEnv() },
  );
  if (
    !existsSync(join(deployDir, 'dist/adapters/node-server.js')) ||
    !existsSync(join(deployDir, 'node_modules/prom-client')) ||
    !existsSync(join(deployDir, 'node_modules/pino'))
  ) {
    throw new Error(
      `pnpm deploy did not produce a self-contained @knext/core ` +
        `(node-server.js + prom-client + pino). stderr:\n${dep.stderr}`,
    );
  }
  // verbatimSymlinks: keep pnpm's RELATIVE `.pnpm/…` symlinks intact (the
  // Dockerfile COPY preserves them verbatim; the default rewrites to absolute
  // paths into deployDir, which we then delete → dangling → MODULE_NOT_FOUND).
  cpSync(deployDir, join(runnerRoot, 'node_modules/@knext/core'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  rmSync(deployDir, { recursive: true, force: true });
}, 180_000);

afterAll(() => {
  if (runnerRoot) rmSync(runnerRoot, { recursive: true, force: true });
});

// The runtime entry SPAWNS the fixture as a grandchild. We launch it `detached`
// in its own process group so teardown can SIGKILL the WHOLE group — otherwise
// the ignore-SIGTERM fixture keeps the metrics port (9091) bound and the next
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
      PORT: String(PORT),
      METRICS_PORT: String(METRICS_PORT), // distinct from the drain e2e's 9091
      STANDALONE_SERVER_PATH: IGNORE_SERVER,
      STORAGE_BUCKET: '', // disable image-cache sync side effects
      ...extraEnv,
    }),
    detached: true, // own group so teardown can reap the grandchild fixture
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForListening(proc: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`runtime never reported LISTENING. stderr:\n${stderr}`)),
      25_000,
    );
    let buf = '';
    let stderr = '';
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
      reject(
        new Error(`runtime entry exited early (code ${code}) before listening. stderr:\n${stderr}`),
      );
    });
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

      await waitForListening(child);
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
