/**
 * Review round 3 on the #1241 chain: the SIGINT/SIGTERM handler in
 * `scripts/bun-test.mjs` swept `activeChildPids` with
 * `for (const pid of activeChildPids) killProcessTree(pid);` and no
 * per-iteration isolation. `killProcessTree` tolerated only `ESRCH`, so an
 * uncaught `EPERM` from `process.kill(-pid, 'SIGKILL')` — reproduced live at
 * 1-in-6 under `--coverage` with 3 concurrent files, a pid-recycling race —
 * aborted the WHOLE sweep, leaving every OTHER in-flight file's process
 * group (and its grandchildren) orphaned.
 *
 * These are unit-level, with an INJECTED kill function rather than a real
 * racy EPERM: the race reproduced at only 1-in-6 under real load, which is
 * not something a deterministic test can wait for. The end-to-end
 * consequence (a real SIGINT to the runner with 3 concurrent in-flight
 * grandchild-spawning files, none surviving) is covered separately by the
 * extended canary in `tests/bun-test-hard-timeout.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { killAllProcessTrees, killProcessTree } from '../scripts/lib/kill-process-tree.mjs';

function systemError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('killProcessTree', () => {
  test('does nothing for an undefined pid (no child was ever spawned)', () => {
    const calls: unknown[] = [];
    killProcessTree(undefined, (...args: unknown[]) => {
      calls.push(args);
    });
    expect(calls).toEqual([]);
  });

  test('signals the whole process GROUP (negative pid), and tolerates ESRCH — already gone', () => {
    if (process.platform === 'win32') return; // POSIX-only path under test
    const calls: Array<[number, string]> = [];
    expect(() => {
      killProcessTree(4242, (pid: number, sig: string) => {
        calls.push([pid, sig]);
        throw systemError('ESRCH', 'kill ESRCH');
      });
    }).not.toThrow();
    expect(calls).toEqual([[-4242, 'SIGKILL']]);
  });

  test('an EPERM on the group kill falls back to killing the leader pid directly, and tolerates its own ESRCH', () => {
    if (process.platform === 'win32') return;
    const calls: Array<[number, string]> = [];
    expect(() => {
      killProcessTree(4242, (pid: number, sig: string) => {
        calls.push([pid, sig]);
        if (pid === -4242) throw systemError('EPERM', 'kill EPERM');
        throw systemError('ESRCH', 'kill ESRCH'); // fallback: leader already gone too
      });
    }).not.toThrow();
    expect(calls).toEqual([
      [-4242, 'SIGKILL'], // the group attempt, which EPERM'd
      [4242, 'SIGKILL'], // the fallback: the leader pid directly
    ]);
  });

  test('an EPERM on the group kill AND on the direct-pid fallback is surfaced, not silently swallowed', () => {
    if (process.platform === 'win32') return;
    expect(() => {
      killProcessTree(4242, () => {
        throw systemError('EPERM', 'kill EPERM');
      });
    }).toThrow(/EPERM/);
  });

  test('a genuinely unexpected error (not ESRCH/EPERM) is never swallowed', () => {
    expect(() => {
      killProcessTree(4242, () => {
        throw new Error('boom');
      });
    }).toThrow('boom');
  });
});

describe('killAllProcessTrees — the SIGINT/SIGTERM sweep must isolate per pid', () => {
  test('one pid throwing does NOT stop the sweep from reaching the rest (both halves: attempted, AND continued)', () => {
    const attempted: number[] = [];
    const logged: string[] = [];
    killAllProcessTrees([111, 222, 333], {
      // The group kill (-111) EPERMs; the leader-pid fallback (111) then
      // succeeds, so nothing is logged for 111 — the interesting assertion
      // is that 222 and 333 are STILL reached after all of that, not that
      // 111 itself ultimately fails.
      killFn: (pid: number) => {
        attempted.push(pid);
        if (pid === -111) throw systemError('EPERM', 'kill EPERM for 111');
      },
      log: (msg: string) => logged.push(msg),
    });

    // Half 1: the failing pid really was attempted (group AND fallback) —
    // not skipped up front.
    expect(attempted).toContain(-111);
    expect(attempted).toContain(111);
    // Half 2: the OTHER pids were still reached AFTER the throw+fallback.
    // This is the defect under test: a loop with no per-iteration isolation
    // stops here.
    expect(attempted).toEqual([-111, 111, -222, -333]);
    // No failure escaped `killProcessTree` here (the fallback succeeded), so
    // nothing needed logging for this scenario.
    expect(logged).toEqual([]);
  });

  test('every pid throwing still reaches every pid (no early-exit on the very first failure)', () => {
    const attempted: number[] = [];
    const logged: string[] = [];
    killAllProcessTrees([1, 2, 3], {
      // An EPERM on the group kill (-pid) makes `killProcessTree` itself
      // retry the leader pid directly — so each pid here is attempted
      // TWICE (group, then the direct-pid fallback) before the sweep moves
      // on to the next pid. Both attempts EPERM, so the fallback's error is
      // what the sweep ultimately logs and continues past.
      killFn: (pid: number) => {
        attempted.push(pid);
        throw systemError('EPERM', `kill EPERM for ${pid}`);
      },
      log: (msg: string) => logged.push(msg),
    });
    expect(attempted).toEqual([-1, 1, -2, 2, -3, 3]);
    expect(logged).toHaveLength(3);
  });

  test('no failures: every pid is killed and nothing is logged', () => {
    const attempted: number[] = [];
    const logged: string[] = [];
    killAllProcessTrees([1, 2], {
      killFn: (pid: number) => attempted.push(pid),
      log: (msg: string) => logged.push(msg),
    });
    expect(attempted).toEqual([-1, -2]);
    expect(logged).toEqual([]);
  });
});
