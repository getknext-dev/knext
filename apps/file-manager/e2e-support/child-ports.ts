/**
 * Port plumbing shared by the SIGTERM e2es (#678).
 *
 * WHY: `apps/file-manager/__fixtures__/ignore-sigterm-standalone-server.mjs` used
 * to hardcode its listen port, so `SIGTERM drain (shipped bundle gate)` failed on
 * PR #676 with `EADDRINUSE :::39188` and passed unchanged on re-run. Two jobs on
 * one runner (or a developer with that port bound) collide; #673 turned CI on for
 * stacked PRs, so concurrent jobs are more common, not less.
 *
 * THE TRAP THIS DELIBERATELY AVOIDS: making port discovery asynchronous is an easy
 * way to convert a REAL startup failure into a hang or a silent skip — the
 * green-by-skip class this repo has already closed three times (#408, #448, #659).
 * So {@link waitForListeningPort} rejects, promptly and with the child's stderr, on
 * BOTH failure shapes: the child exiting before it listened, and the child never
 * saying anything. It never resolves a fallback port and never skips.
 * `child-ports.test.ts` pins all three behaviours.
 */
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/** Fixtures announce readiness as `LISTENING:<the port the OS actually gave>`. */
const LISTENING_LINE = /LISTENING:(\d+)/;

export interface WaitForListeningOptions {
  /** How long to wait for the readiness line before failing. */
  readonly timeoutMs?: number;
  /** Named in the failure message so a multi-child spec says WHICH child. */
  readonly label?: string;
}

/**
 * Resolve with the port the child actually bound, parsed from its `LISTENING:<n>`
 * line on stdout — the child binds port 0 and the OS picks, so this is the only
 * source of truth for the port.
 *
 * Rejects (never hangs, never skips) if the child exits first or stays silent past
 * the timeout; both messages carry the captured stderr so a real boot failure is
 * diagnosable from the CI log alone.
 */
export function waitForListeningPort(
  proc: ChildProcess,
  options: WaitForListeningOptions = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const label = options.label ?? 'child';
  return new Promise<number>((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `${label} never reported LISTENING:<port> within ${timeoutMs}ms.\n` +
              `stdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        ),
      );
    }, timeoutMs);

    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      const m = stdout.match(LISTENING_LINE);
      if (m) {
        settle(() => resolvePromise(Number(m[1])));
      }
    });
    proc.once('exit', (code, signal) => {
      // A real startup failure (MODULE_NOT_FOUND, EADDRINUSE, a crash) MUST fail
      // the spec here and now — not time out, and certainly not skip.
      settle(() =>
        reject(
          new Error(
            `${label} exited early (code ${code}, signal ${signal}) before listening.\n` +
              `stdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        ),
      );
    });
  });
}

/** A batch of reserved ports, still held in LISTEN until `release()` is awaited. */
export interface HeldPorts {
  readonly ports: readonly number[];
  readonly release: () => Promise<void>;
}

/** Bind port 0 on loopback and resolve the socket plus the port the OS gave it. */
function listenEphemeral(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    const close = () => new Promise<void>((done) => srv.close(() => done()));
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (typeof address !== 'object' || address === null) {
        void close().then(() => reject(new Error('could not read an OS-assigned port')));
        return;
      }
      resolvePromise({ port: address.port, close });
    });
  });
}

/**
 * Reserve `count` OS-assigned ports and KEEP THEM ALL BOUND until `release()`.
 *
 * Why the hold is the point: two sequential `freePort()` calls can return the SAME
 * port — nothing forbids an ephemeral allocator from repeating once the first
 * socket is closed. A spawn that needs two ports (the drain e2e's `$PORT` and
 * `$METRICS_PORT`) would then hand the same number to both and one bind dies with
 * EADDRINUSE, which is precisely the flake class #678 removes. Holding every
 * socket in LISTEN while the rest are allocated makes that IMPOSSIBLE rather than
 * unlikely: `bind(0)` is never assigned a port already in LISTEN state.
 *
 * `child-ports.test.ts` asserts the simultaneity directly (every reserved port is
 * unbindable while held), because a "the ports differ" assertion would pass by
 * luck under the very close-then-reopen implementation it is meant to catch.
 */
export async function reserveHeldPorts(count: number): Promise<HeldPorts> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`reserveHeldPorts: count must be a positive integer, got ${count}`);
  }
  const held: Array<{ port: number; close: () => Promise<void> }> = [];
  try {
    for (let i = 0; i < count; i += 1) {
      held.push(await listenEphemeral());
    }
  } catch (err) {
    await Promise.all(held.map((h) => h.close()));
    throw err;
  }
  return {
    ports: held.map((h) => h.port),
    release: async () => {
      await Promise.all(held.map((h) => h.close()));
    },
  };
}

/**
 * `count` distinct OS-assigned free ports — distinct BY CONSTRUCTION (see
 * {@link reserveHeldPorts}), not by the improbability of a repeat.
 *
 * Used for ports a spec must know WITHOUT a readback channel: the supervisor's
 * `METRICS_PORT` (bound by the runtime entry and echoed only into a pino log whose
 * format differs between production JSON and dev pino-pretty, too brittle to
 * parse), and `$PORT` where the value must be a real port the supervisor's own
 * child-readiness probe can connect to.
 *
 * HONEST LIMIT: this closes the reservation's collision with ITSELF, not with the
 * rest of the machine. Between `release()` and the child's `bind()` there is still
 * a window in which an unrelated process could take the port; that window is
 * irreducible for a port someone else must bind. Where a readback channel exists
 * (`LISTENING:<port>`) prefer binding 0, which has no window at all.
 *
 * SCOPE OF THE FIX (#686): the sequential-`freePort()` collision was removed from
 * THIS lane in #683, and from the container e2e's host-port reservation in #686
 * (`examples/bun-exec/test/e2e-support/ports.ts` — a deliberate copy of this
 * module, because `examples/*` is not a pnpm workspace member and the example
 * must stay self-contained). It is not "gone repo-wide" by assertion of either
 * PR: what keeps it gone is the scan in `tests/e2e-ephemeral-ports.test.ts`,
 * which now covers `e2e-support/` and reds on any scanned file that reserves
 * ports one call at a time — within that scan's stated limits, which include
 * that it matches the literal `freePort()` SHAPE rather than the concept.
 *
 * The scan does NOT keep the two copies behaviourally identical: it reads syntax
 * and asserts exactly two properties. Equivalence is held by each copy carrying
 * the same cases — `child-ports.test.ts` here, `examples/bun-exec/test/ports.test.ts`
 * there, including the partial-failure (EMFILE) cleanup the scan cannot see.
 * Adding behaviour to one copy means adding its case to both.
 */
export async function freePorts(count: number): Promise<number[]> {
  const { ports, release } = await reserveHeldPorts(count);
  await release();
  return [...ports];
}

/** A single OS-assigned free port. See {@link freePorts} for the caveats. */
export async function freePort(): Promise<number> {
  const [port] = await freePorts(1);
  return port;
}
