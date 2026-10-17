/**
 * Resource tripwire for the mutation-prover lane (#2499).
 *
 * WHY. One leg of the first full run lost its hosted runner about 75 minutes in:
 * "The hosted runner lost communication with the server", the job log was never
 * kept, and the report artifact was never uploaded, so nothing said which
 * resource ran out. A line printed after each prover cannot help once the runner
 * is dead. The only thing that can is to notice the shortage BETWEEN provers,
 * while the runner is still alive, and stop the leg with a NAMED finding so the
 * report still uploads and the aggregate says what happened.
 *
 * THRESHOLDS (picked with jev, 0.38 over two close alternatives), for a standard
 * GitHub-hosted ubuntu runner (4 vCPU, 16 GB RAM, about 14 GB SSD for work):
 *   - HARD stop below 1024 MiB free disk or 256 MiB available memory;
 *   - SOFT (clean regenerable build output first) below 3072 MiB free disk.
 * Memory is read from /proc/meminfo `MemAvailable` (what a new process can
 * actually get), never `os.freemem()`, which on Linux counts only MemFree and
 * would trip on a healthy page cache; where /proc/meminfo does not exist (a
 * developer's Mac) the memory check is skipped rather than guessed.
 *
 * The check runs when no prover process is alive, so a low MemAvailable means an
 * orphan or a leak, not a prover mid-build.
 *
 * Pure: every function takes its inputs. Overridable by env so tests can force a
 * trip without filling a disk.
 */

import { readFileSync, statfsSync } from 'node:fs';

export const DEFAULT_THRESHOLDS = Object.freeze({
  hardFreeDiskMiB: 1024,
  hardAvailMemMiB: 256,
  softFreeDiskMiB: 3072,
  // MID-prover: kill the running prover's process group when available memory
  // falls below this. Picked with jev (2048 over 1024 and 512) for a 16 GB runner:
  // a real runaway grew about 270 MB/s, the watch polls every 2 s, and healthy
  // legs sit at about 14 GB available.
  killAvailMemMiB: 2048,
});

const MIB = 1024 * 1024;

/** @param {NodeJS.ProcessEnv} env */
export function thresholdsFromEnv(env = process.env) {
  const read = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${name} must be a non-negative number of MiB, got ${JSON.stringify(raw)}`);
    }
    return n;
  };
  return {
    hardFreeDiskMiB: read('KNEXT_LANE_MIN_FREE_DISK_MIB', DEFAULT_THRESHOLDS.hardFreeDiskMiB),
    hardAvailMemMiB: read('KNEXT_LANE_MIN_AVAIL_MEM_MIB', DEFAULT_THRESHOLDS.hardAvailMemMiB),
    softFreeDiskMiB: read('KNEXT_LANE_SOFT_FREE_DISK_MIB', DEFAULT_THRESHOLDS.softFreeDiskMiB),
    killAvailMemMiB: read('KNEXT_LANE_KILL_AVAIL_MEM_MIB', DEFAULT_THRESHOLDS.killAvailMemMiB),
  };
}

/** `MemAvailable` and `MemTotal` in MiB from /proc/meminfo text, or nulls. */
export function parseMeminfo(text) {
  const kib = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
    return m ? Number(m[1]) / 1024 : null;
  };
  return { availMemMiB: kib('MemAvailable'), totalMemMiB: kib('MemTotal') };
}

/**
 * @param {string} root a path on the filesystem the work happens on
 * @param {string} meminfoPath
 */
export function readResources(root, meminfoPath = '/proc/meminfo') {
  let freeDiskMiB = null;
  try {
    const st = statfsSync(root);
    freeDiskMiB = (st.bavail * st.bsize) / MIB;
  } catch {
    // unreadable: reported as null, never a fabricated number
  }
  let mem = { availMemMiB: null, totalMemMiB: null };
  try {
    mem = parseMeminfo(readFileSync(meminfoPath, 'utf8'));
  } catch {
    // no /proc/meminfo (macOS): the memory check is skipped
  }
  return { freeDiskMiB, ...mem };
}

/**
 * @param {{ freeDiskMiB: number|null, availMemMiB: number|null }} res
 * @param {typeof DEFAULT_THRESHOLDS} t
 * @returns {{ level: 'ok'|'soft'|'hard', reasons: string[] }}
 */
export function evaluateResources(res, t) {
  const hard = [];
  if (res.freeDiskMiB !== null && res.freeDiskMiB < t.hardFreeDiskMiB) {
    hard.push(`free disk ${Math.round(res.freeDiskMiB)} MiB < ${t.hardFreeDiskMiB} MiB`);
  }
  if (res.availMemMiB !== null && res.availMemMiB < t.hardAvailMemMiB) {
    hard.push(`available memory ${Math.round(res.availMemMiB)} MiB < ${t.hardAvailMemMiB} MiB`);
  }
  if (hard.length > 0) return { level: 'hard', reasons: hard };
  if (res.freeDiskMiB !== null && res.freeDiskMiB < t.softFreeDiskMiB) {
    return {
      level: 'soft',
      reasons: [`free disk ${Math.round(res.freeDiskMiB)} MiB < ${t.softFreeDiskMiB} MiB`],
    };
  }
  return { level: 'ok', reasons: [] };
}

/**
 * Is a RUNNING prover consuming the machine? Pure; the runner polls it.
 *
 * @param {{ availMemMiB: number|null }} res
 * @param {{ killAvailMemMiB: number }} t
 * @returns {string | null} the reason to kill, or null
 */
export function runawayReason(res, t) {
  if (res.availMemMiB !== null && res.availMemMiB < t.killAvailMemMiB) {
    return `available memory ${Math.round(res.availMemMiB)} MiB < ${t.killAvailMemMiB} MiB while the prover was running`;
  }
  return null;
}

/**
 * May we signal the process GROUP `-pid`? Only a real child's own group: an
 * integer above 1 that is not this process. `kill(-0)` signals the caller's whole
 * group and `kill(-1)` signals every process the user can reach, either of which
 * would take the runner agent down with it; a failed spawn leaves `pid`
 * undefined, and `-undefined` is NaN. Anything else falls back to signalling the
 * child alone.
 *
 * @param {unknown} pid
 * @param {number} selfPid
 */
export function isSafeGroupTarget(pid, selfPid = process.pid) {
  return Number.isInteger(pid) && pid > 1 && pid !== selfPid;
}

/** The count of numeric entries in a /proc listing (processes), or null. */
export function countProcesses(procEntries) {
  return procEntries === null ? null : procEntries.filter((n) => /^\d+$/.test(n)).length;
}

/**
 * One sample line, streamed to the log every few seconds while a prover runs, so
 * what the machine looked like up to the moment of a lost runner survives in the
 * log. `extra` carries the parts that need a subprocess (top processes, kernel
 * log), gathered by the runner because this library does not spawn.
 *
 * @param {{ prover: string, res: object, procs: number|null, load: number[], extra?: string[] }} s
 */
export function sampleLine({ prover, res, procs, load, extra = [] }) {
  const f = (n) => (n === null ? 'unknown' : `${Math.round(n)}`);
  const head =
    `   sample [${prover.replace('scripts/mutation-prove-', '')}]: ` +
    `mem avail ${f(res.availMemMiB)} MiB, procs ${procs ?? 'unknown'}, ` +
    `load ${load.map((n) => n.toFixed(2)).join('/')}, disk free ${f(res.freeDiskMiB)} MiB`;
  return [head, ...extra.map((l) => `      ${l}`)].join('\n');
}

/** One human line, printed after every prover. */
export function describeResources(res) {
  const f = (n) => (n === null ? 'unknown' : `${Math.round(n)}`);
  return `free memory ${f(res.availMemMiB)} of ${f(res.totalMemMiB)} MiB available, free disk ${f(res.freeDiskMiB)} MiB`;
}

/**
 * Regenerable build output that is safe to delete UNDER PRESSURE, by repo-relative
 * path. Each is gitignored, rebuilt by whoever needs it, and not an input any
 * other prover reads without building it first. Deliberately absent:
 * `packages/*\/dist` (several provers REQUIRE the built CLI bundle and do not
 * rebuild it), `node_modules`, and the operator's `bin/` toolchain (envtest and
 * kustomize are installed once by the workflow).
 */
export const REGENERABLE_BUILD_DIRS = Object.freeze(['crates/target', 'templates/rust/target']);
