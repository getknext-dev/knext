#!/usr/bin/env node
/**
 * e2e-bake-accept — #1299.
 *
 * WHY. `packages/kn-next/templates/runtime-standalone/knext-compile-cache-bake.mjs.hbs`
 * is SHIPPED, byte-for-byte, into every user's standalone-node image
 * (`kn-next deploy`/`preview` stage it into the `docker build` context — see
 * that file's own header). Its bake MUST be strict — every warm path
 * answering 2xx — because a real user's warm paths are real pages, and a
 * silently-rendered 404/500 there is exactly the build failure the user
 * needs surfaced, not swallowed.
 *
 * The official compat harness's own fixtures are a different story: they
 * are DELIBERATELY built to exercise odd routing (a 404 root, a page that
 * throws) — the compile cache still needs to cover the server RUNTIME that
 * rendered that 404/500, so a harness night must tolerate a non-2xx warm
 * without failing the deploy. That tolerance USED TO live inside the
 * shipped driver itself (`KNEXT_WARM_ACCEPT_ANY_STATUS`), which meant
 * harness-only policy was compiled into every user's image (#1299,
 * architect gate on #1280, jev 0.75).
 *
 * This script moves it here instead: it spawns the REAL, now
 * unconditionally-strict shipped driver as a CHILD process, and is the
 * ONLY place that ever interprets `KNEXT_WARM_ACCEPT_ANY_STATUS` — the
 * driver template no longer reads that variable at all, and this
 * wrapper deliberately STRIPS it from the child's own environment before
 * spawning, so a driver that someday reintroduces the knob is not
 * silently reactivated by inheriting the value from its parent.
 *
 * NOTHING ABOUT THE ACTUAL BAKE CHANGES. On every exit path (2xx success,
 * non-2xx failure, or a thrown exception) the driver flushes the V8
 * compile cache before exiting — this wrapper only ever affects the
 * PASS/FAIL VERDICT the harness records, never what gets baked to disk.
 * That is what keeps the "warm" signal intact across the move: the cache
 * a harness night ships is byte-identical whether this wrapper tolerates
 * the exit code or not.
 *
 * THE DECISION (`evaluateBakeOutcome`), re-derived from the child's own
 * stdout + exit code rather than trusting an env var the child interprets,
 * reproduces exactly the old in-driver semantics:
 *   - child exit 0            -> always ok (strict bake succeeded for real).
 *   - child exit != 0, no
 *     KNEXT_WARM_ACCEPT_ANY_STATUS -> real failure, never tolerated.
 *   - child exit != 0, WITH
 *     the env var set to "1"  -> ok ONLY IF every `WARMED:<path> status=<n>
 *                                 ms=<n>` line the child printed logged a
 *                                 real HTTP status (never `status=error`,
 *                                 the driver's own spelling for a
 *                                 connection failure) AND at least one such
 *                                 line was printed at all — a driver that
 *                                 crashed before ever warming anything is
 *                                 never tolerated, matching the old
 *                                 driver's own try/catch behaviour.
 *
 * Usage:
 *   KNEXT_WARM_ACCEPT_ANY_STATUS=1 node scripts/e2e-bake-accept.mjs <cmd> [args...]
 *   (any command works — this only ever interprets ITS OWN env, spawns the
 *   given command with KNEXT_WARM_ACCEPT_ANY_STATUS stripped from the
 *   child's environment, and re-derives the verdict from the child's own
 *   stdout + exit code.)
 */

import { spawnSync } from 'node:child_process';

const WARMED_LINE_RE = /^WARMED:(\S+) status=(\S+) ms=(\d+)/;

/**
 * @param {string} stdout
 * @returns {{ path: string, status: string, ms: number }[]}
 */
export function parseWarmedLines(stdout) {
  /** @type {{ path: string, status: string, ms: number }[]} */
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(WARMED_LINE_RE);
    if (m) out.push({ path: m[1], status: m[2], ms: Number(m[3]) });
  }
  return out;
}

/**
 * @param {{ exitCode: number, stdout: string, acceptAnyStatus: boolean }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateBakeOutcome({ exitCode, stdout, acceptAnyStatus }) {
  if (exitCode === 0) {
    return { ok: true, reason: 'the driver exited 0 (strict 2xx bake succeeded)' };
  }
  if (!acceptAnyStatus) {
    return {
      ok: false,
      reason: `the driver exited ${exitCode} and KNEXT_WARM_ACCEPT_ANY_STATUS is not set — real failure, not tolerated`,
    };
  }
  const warmed = parseWarmedLines(stdout);
  if (warmed.length === 0) {
    return {
      ok: false,
      reason:
        'the driver exited non-zero and logged no WARMED line at all — it never reached a real response',
    };
  }
  const errored = warmed.filter((w) => w.status === 'error');
  if (errored.length > 0) {
    return {
      ok: false,
      reason: `the driver exited non-zero and ${errored.length} warm path(s) never answered (connection error, not just a non-2xx status): ${errored.map((w) => w.path).join(', ')}`,
    };
  }
  return {
    ok: true,
    reason: `the driver exited ${exitCode} on a non-2xx status alone (every warm path answered with a real HTTP status) — tolerated under KNEXT_WARM_ACCEPT_ANY_STATUS`,
  };
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('e2e-bake-accept: no command given — usage: e2e-bake-accept.mjs <cmd> [args...]');
    process.exit(2);
  }

  const acceptAnyStatus = process.env.KNEXT_WARM_ACCEPT_ANY_STATUS === '1';

  // Deliberately stripped from the CHILD's env — see the file header. Kept
  // as its own object rather than `delete childEnv.X` on a spread copy, so
  // a future refactor cannot accidentally reintroduce it by iterating
  // `process.env` after the strip.
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'KNEXT_WARM_ACCEPT_ANY_STATUS') continue;
    childEnv[k] = v;
  }

  const r = spawnSync(command, args, { encoding: 'utf8', env: childEnv });

  if (r.error) {
    console.error(`e2e-bake-accept: failed to spawn "${command}": ${r.error.message}`);
    process.exit(1);
  }

  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);

  const outcome = evaluateBakeOutcome({
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    acceptAnyStatus,
  });

  if (!outcome.ok) {
    console.error(`[knext] e2e-bake-accept: ${outcome.reason}`);
  } else if (r.status !== 0) {
    console.error(`[knext] e2e-bake-accept: tolerating a non-strict exit — ${outcome.reason}`);
  }

  process.exit(outcome.ok ? 0 : 1);
}
/* c8 ignore stop */
