// @vitest-environment node
//
// SIGTERM HARD-CAP e2e for the `bun-exec` recipe (#448) — the bun-side analogue
// of the node path's `apps/file-manager/sigterm-hardcap-e2e.test.ts`.
//
// WHY THIS FILE EXISTS (both halves of #448 live here, because they are ONE
// property observed two ways):
//
//   1. The drain in `runtime-contract.mjs` stops the app listener, awaits
//      `after()`/waitUntil tasks, and stops the `:9091` metrics listener LAST.
//      That ordering is LOAD-BEARING, not incidental: the hardcap timer is
//      `unref()`ed, so it can only fire while SOMETHING ELSE holds the event
//      loop open. During a drain that "something else" is the metrics listener.
//      Stop metrics before `drainTasks()`/the app drain and the loop can empty,
//      the process exits before the cap fires, and a hung request is silently
//      NOT force-terminated within grace — the shutdown guarantee regresses with
//      every existing test still green. The source-order guard below pins the
//      ordering AND the comment that explains it, so a refactor has to delete a
//      red test rather than quietly reorder two awaits.
//
//   2. Until now the hardcap force path (`stop(true)` → exit 1) was only proven
//      against FAKE servers, or — in `runtime-contract.test.ts` Layer C — over
//      real sockets but WITHOUT a timing assertion, so "exits 1" could have come
//      from a crash, an immediate abort, or the cap. This file measures the wall
//      clock: a route that hangs forever, SIGTERM, and the process must exit 1
//      at ~SHUTDOWN_GRACE_MS — NOT before (that would mean something other than
//      the cap released it) and NOT never (the pod grace period would blow).
//
// NO GREEN-BY-SKIP: without `bun` on PATH the e2e cannot run at all, so it skips
// with a loud reason — and under `KNEXT_REQUIRE_BUN=1` (what CI must set when
// this recipe is wired into a real target, ADR-0036 P2) a missing bun is a HARD
// failure, so a green check can never mean "skipped".

import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = resolve(__dirname, '../runtime-contract.mjs');
// The REAL srvx-coupled harness: the app listener is `srvx/bun` serve +
// `appSrvx.close(force)` exactly as `knext-bun-entry.mjs` wires it, and `/hang`
// never resolves — so a graceful close CANNOT drain it and only the cap can exit.
const SRVX_HARNESS = resolve(__dirname, 'srvx-close-harness.mjs');

// PORTS ARE OS-ASSIGNED, NEVER LITERAL (#678). These used to be literals "distinct
// from runtime-contract.test.ts's" — which only deconflicted OUR OWN files and did
// nothing about the real collision: two CI jobs on one runner (how the node-side
// sibling gate flaked with `EADDRINUSE :::39188` on PR #676). The harness binds
// what the OS gives it and prints `LISTENING:<port> METRICS:<port>`, so the spec
// reads the ports back instead of assuming them.
const EPHEMERAL = '0';
// Short cap so the e2e is fast, but long enough that "exited at the cap" is
// distinguishable from "exited immediately" given process-spawn jitter.
const GRACE_MS = 2500;

// ── Part 1: the metrics-stopped-last ordering is load-bearing ────────────────
describe('drain ordering: the metrics listener MUST be stopped last (#448)', () => {
  const src = readFileSync(CONTRACT_SRC, 'utf8');
  const shutdownBody = src.slice(src.indexOf('export function createGracefulShutdown'));

  it('stops metrics AFTER the app drain and AFTER drainTasks(), exactly once', () => {
    // Scan, do not enumerate: there must be exactly ONE metrics stop call, so a
    // second one added earlier in the drain fails here rather than sneaking past
    // an index comparison against the first occurrence.
    const metricsStops = [...shutdownBody.matchAll(/metricsServer\s*\.\s*stop\s*\(/g)];
    expect(metricsStops).toHaveLength(1);

    const appStopIdx = shutdownBody.indexOf('appServers.map');
    const drainTasksIdx = shutdownBody.indexOf('await drainTasks()');
    const metricsIdx = metricsStops[0].index as number;

    expect(appStopIdx).toBeGreaterThan(-1);
    expect(drainTasksIdx).toBeGreaterThan(-1);
    // The whole point: metrics last. If this fails, the unref'd hardcap can stop
    // firing (event loop empties first) — see this file's header.
    expect(metricsIdx).toBeGreaterThan(appStopIdx);
    expect(metricsIdx).toBeGreaterThan(drainTasksIdx);
  });

  it('carries an at-the-drain-site comment explaining WHY metrics is stopped last', () => {
    // A comment far away in the file does not survive a refactor of these lines,
    // so require it ADJACENT to the metrics stop (the lines a reorder would move).
    const lines = shutdownBody.split('\n');
    const metricsLine = lines.findIndex((l) => /metricsServer\s*\.\s*stop\s*\(/.test(l));
    expect(metricsLine).toBeGreaterThan(-1);
    // Strip the `//` markers and collapse whitespace so a phrase the formatter
    // wrapped across two comment lines still reads as one phrase.
    const preceding = lines
      .slice(Math.max(0, metricsLine - 14), metricsLine)
      .filter((l) => l.trim().startsWith('//'))
      .map((l) => l.trim().replace(/^\/\/\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');

    // The comment must name the mechanism, not just assert an order — the
    // mechanism is what tells a future refactor why it cannot move this line.
    expect(preceding).toMatch(/unref/i);
    expect(preceding).toMatch(/event loop/i);
    expect(preceding).toMatch(/hardcap/i);
  });
});

// ── Part 2: real-sockets hardcap e2e ─────────────────────────────────────────
const bunProbe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
const bunAvailable = bunProbe.status === 0;
if (!bunAvailable && process.env.KNEXT_REQUIRE_BUN === '1') {
  throw new Error(
    'KNEXT_REQUIRE_BUN=1 but `bun` is not on PATH — the bun-exec hardcap e2e ' +
      'cannot run, and a skipped hardcap gate must never read as green.',
  );
}

let child: ReturnType<typeof spawn> | undefined;

afterEach(async () => {
  const proc = child;
  child = undefined;
  if (proc && proc.exitCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
});

function spawnHarness(extraEnv: Record<string, string> = {}) {
  return spawn('bun', [SRVX_HARNESS], {
    env: {
      ...process.env,
      PORT: EPHEMERAL,
      METRICS_PORT: EPHEMERAL,
      CACHE_INVALIDATE_TOKEN: 'test-invalidate-token',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Returns the app port the harness ACTUALLY bound (PORT=0 → the OS picks it).
// It must still fail LOUDLY on a real startup failure: a harness that exits early
// or never announces rejects here — never hangs to the vitest timeout, never skips
// (the green-by-skip class closed in #408/#448/#659).
function waitForListeningPort(proc: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`harness never listened. stderr:\n${stderr}`)),
      15_000,
    );
    let stderr = '';
    let buf = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/LISTENING:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolvePromise(Number(m[1]));
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`harness exited early (${code}) before listening. stderr:\n${stderr}`));
    });
  });
}

describe.skipIf(!bunAvailable)(
  'SIGTERM hardcap e2e (real sockets, real srvx): a hung request is force-terminated within grace',
  () => {
    it('exits 1 at ~SHUTDOWN_GRACE_MS — not before, not never', async () => {
      let stdout = '';
      child = spawnHarness({ SHUTDOWN_GRACE_MS: String(GRACE_MS) });
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      const port = await waitForListeningPort(child);
      expect(port).toBeGreaterThan(0);
      expect(child.exitCode).toBeNull();

      // A genuinely hung request over a real socket: `/hang` awaits a promise
      // that never settles, so srvx's graceful `close()` can never resolve.
      const hung = fetch(`http://127.0.0.1:${port}/hang`).catch(() => 'errored');
      await new Promise((r) => setTimeout(r, 300)); // let it be accepted

      const t0 = Date.now();
      child.kill('SIGTERM');

      const { exitMs, exitCode } = await new Promise<{
        exitMs: number;
        exitCode: number | null;
      }>((resolvePromise, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `harness DID NOT EXIT within ${GRACE_MS + 9000}ms of SIGTERM — the ` +
                  `hardcap failed to force-terminate a hung request, so the pod grace ` +
                  `period would be violated. stdout:\n${stdout}`,
              ),
            ),
          GRACE_MS + 9000,
        );
        child?.once('exit', (code) => {
          clearTimeout(timeout);
          resolvePromise({ exitMs: Date.now() - t0, exitCode: code });
        });
      });

      // Force path, not a clean drain: exit 1, HARDCAP logged, and NOT the
      // clean-drain log (both halves — a green must mean the cap fired, not
      // that the drain happened to finish).
      expect(exitCode).toBe(1);
      expect(stdout).toContain('HARDCAP');
      expect(stdout).not.toContain('DRAINED cleanly');

      // Not "before": the hung request cannot drain, so anything materially
      // earlier than the cap means something OTHER than the cap released the
      // exit (a crash, an immediate abort, or a cap armed at ~0).
      expect(exitMs).toBeGreaterThanOrEqual(GRACE_MS - 500);
      // Not "never": exited within the cap + margin ⇒ grace period honoured.
      expect(exitMs).toBeLessThanOrEqual(GRACE_MS + 4000);

      await hung; // the force-closed request settles — don't leak it
    }, 60_000);
  },
);
