// @vitest-environment node
//
// This e2e makes real cross-origin HTTP calls to localhost child processes; the
// repo's default `apps` project runs happy-dom, whose fetch enforces a
// Same-Origin Policy that blocks those calls. Force the node environment so the
// drain proof exercises real sockets, not a DOM fetch shim.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Shared port plumbing (#678). waitForListeningPort REJECTS — promptly, with the
// child's stderr — when the runtime entry exits early (the MODULE_NOT_FOUND
// regression this file exists for) or never announces a port, so swapping a fixed
// port for discovery cannot turn a real boot failure into a hang or a skip. Its
// own guard: apps/file-manager/child-ports.test.ts.
import { freePort, waitForListeningPort } from './e2e-support/child-ports';

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
const APP_DIR = __dirname;
const SLOW_SERVER = resolve(__dirname, '__fixtures__/slow-standalone-server.mjs');

// PORTS ARE OS-ASSIGNED, NEVER LITERAL (#678). "Unlikely to collide" is not the
// same as "cannot collide": this gate failed on PR #676 with `EADDRINUSE :::39188`
// (the hard-cap e2e's twin of the port that used to live here) and passed on a
// re-run, and #673 turned CI on for stacked PRs so concurrent jobs are now more
// common, not less.
//
// Two mechanisms, because the two ports differ in one respect only — whether the
// process that binds echoes the port back:
//   - The app port has a readback channel: PORT=0, the fixture binds what the OS
//     gives it and prints `LISTENING:<port>`, and the spec reads that. No window
//     in which anything could take the port between choosing and binding.
//   - The supervisor's METRICS_PORT does not: it is bound by the runtime entry
//     itself and echoed only into a pino log whose FORMAT differs between
//     production (JSON) and dev (pino-pretty), which is too brittle to parse. So
//     it gets an OS-assigned reservation via freePort() — the same approach the
//     alpine docker e2e already uses for its `--publish` host ports.
const EPHEMERAL = '0';

// The CMD specifier the container boots — the EXACT string from the Dockerfile.
const RUNTIME_IMPORT = "import('@getknext/core/internal/node-server')";

/**
 * Locate the standalone "tracing-root mirror" that contains the app's server.js.
 * Next preserves paths relative to the auto-detected tracing root (the repo
 * root, by lockfile), so the app entry lands at
 * `.next/standalone/<rel>/apps/file-manager/server.js`. We search for it rather
 * than hardcoding `<rel>` (which differs between a plain checkout and a git
 * worktree).
 */
function findStandaloneMirrorRoot(): string | null {
  const standaloneDir = resolve(APP_DIR, '.next/standalone');
  if (!existsSync(standaloneDir)) return null;
  // Candidate 1: single-app / repo-root layout → apps/file-manager/server.js
  const direct = join(standaloneDir, 'apps/file-manager/server.js');
  if (existsSync(direct)) return standaloneDir;
  // Candidate 2: worktree/nested-root layout → <rel>/apps/file-manager/server.js
  const found = spawnSync('find', [standaloneDir, '-path', '*/apps/file-manager/server.js'], {
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
  // Reserved fresh per spawn: the metrics port has no readback channel (#678).
  metricsPort = await freePort();
  return spawn('node', ['-e', RUNTIME_IMPORT], {
    cwd: runnerRoot,
    env: childEnv({
      PORT: EPHEMERAL, // OS-assigned; the fixture reports what it got (#678)
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
      expect(port).toBeGreaterThan(0);
      expect(child.exitCode).toBeNull(); // still running → resolved & booted
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

      // metricsPort was RESERVED for this spawn (freePort), so it is known without
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
