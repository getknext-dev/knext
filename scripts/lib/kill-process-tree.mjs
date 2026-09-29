/**
 * Killing a spawned test file's whole process TREE, and killing a whole SET
 * of them without one failure aborting the rest.
 *
 * Extracted out of `scripts/bun-test.mjs` (review round 3 on #1241) so the
 * isolation behaviour below is unit-testable with an INJECTED kill function
 * — the real defect only reproduced as a racy `EPERM` (1 in 6 attempts,
 * under `--coverage` with 3 concurrent files), and a test cannot depend on
 * waiting for a race to land.
 */

/**
 * SIGKILL the whole process GROUP a spawned file's child started, not just
 * that one process (#1241 recurrence). A file that itself `spawnSync`s a
 * real child (e.g. `tests/bytecode-liveness-wiring.test.ts`,
 * `tests/kn-next-action-preflight.test.ts` do) leaves that grandchild
 * orphaned — reparented to pid 1 — if only the bun-test child is killed,
 * because the grandchild was never a member of the killed process alone.
 * Every child is spawned with `detached: true`, which on POSIX makes it the
 * leader of its OWN new process group (pgid === its own pid), so `-pid`
 * reaches it and everything it forked. No such grouping exists on Windows;
 * fall back to a direct kill there.
 *
 * `killFn` is injectable (defaults to the real `process.kill`) so tests can
 * substitute a fake without touching the real `process.kill` — see
 * `tests/kill-process-tree-sweep-isolation.test.ts`.
 *
 * @param {number | undefined} pid
 * @param {(pid: number, signal: string) => void} [killFn] explicit JSDoc type,
 *   rather than letting it infer from `process.kill`'s own signature (which
 *   declares a `true` return) — that inferred type rejects a plain
 *   void-returning test double at the call site.
 */
export function killProcessTree(pid, killFn = process.kill) {
  if (pid === undefined) return;
  const isGone = (err) => err?.code === 'ESRCH';
  if (process.platform === 'win32') {
    try {
      killFn(pid, 'SIGKILL');
    } catch (err) {
      if (!isGone(err)) throw err; // already gone — not an error here
    }
    return;
  }
  try {
    killFn(-pid, 'SIGKILL');
  } catch (err) {
    if (isGone(err)) return; // already gone — not an error here
    if (err?.code !== 'EPERM') throw err;
    // The process-GROUP kill EPERM'd. Under a pid-recycling race, the pid
    // this runner remembers as a group leader can have been reused by an
    // unrelated process this runner has no permission to signal as a GROUP
    // — reproduced live (not merely hypothesised): an uncaught EPERM here,
    // 1 in 6 attempts, under `--coverage` with 3 concurrent in-flight files.
    // Fall back to killing the leader PID directly: if it is still the
    // process this runner spawned, this still reaps it; if it is already
    // gone, the ESRCH below is the expected, silent case.
    try {
      killFn(pid, 'SIGKILL');
    } catch (fallbackErr) {
      if (!isGone(fallbackErr)) throw fallbackErr;
    }
  }
}

/**
 * Kill every tracked pid's process tree, ISOLATED per pid.
 *
 * The SIGINT/SIGTERM handler in `scripts/bun-test.mjs` used to loop
 * `for (const pid of activeChildPids) killProcessTree(pid);` with no
 * per-iteration isolation. One pid's `killProcessTree` throwing (the racy
 * EPERM above, or anything else `killProcessTree` does not itself swallow)
 * aborted the WHOLE sweep, orphaning every OTHER in-flight file's process
 * tree too — worse than the single pid the failure actually concerned.
 *
 * Each pid's failure is caught, logged, and the sweep continues; the caller
 * still gets to exit afterward regardless of how many pids failed.
 *
 * @param {Iterable<number>} pids
 * @param {{ killFn?: (pid: number, signal: string) => void, log?: (msg: string) => void }} [opts]
 */
export function killAllProcessTrees(
  pids,
  { killFn = process.kill, log = (msg) => console.error(msg) } = {},
) {
  for (const pid of pids) {
    try {
      killProcessTree(pid, killFn);
    } catch (err) {
      log(
        `warning: failed to kill process tree for pid ${pid}, continuing sweep: ${err?.message ?? err}`,
      );
    }
  }
}
