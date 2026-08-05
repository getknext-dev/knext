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

/**
 * An OS-assigned free port. Used ONLY for a port with no readback channel — the
 * supervisor's `METRICS_PORT`, which is bound by the runtime entry itself and is
 * not echoed anywhere the spec can parse. Everything with a readback channel binds
 * 0 and reports what it got, which has no reservation window at all.
 *
 * Same shape as `examples/bun-exec/test/alpine-image.docker-e2e.test.ts`'s
 * `freePort()`, which reserves host ports for `docker --publish` for this reason.
 */
export function freePort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (typeof address !== 'object' || address === null) {
        srv.close(() => reject(new Error('could not read an OS-assigned port')));
        return;
      }
      const { port } = address;
      srv.close(() => resolvePromise(port));
    });
  });
}
