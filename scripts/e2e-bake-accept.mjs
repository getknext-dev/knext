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
 * THE DECISION (`evaluateBakeOutcome`) is re-derived from the child's own
 * signal, exit code, stdout and stderr — never trusted on exit code alone
 * (review round on #1377 found that "exit 1" is NOT unique to the known
 * non-2xx failure: a signal-killed child, or one that threw AFTER logging
 * one good `WARMED:` line, both looked identical to the real failure shape
 * under the earlier, looser check — both would have recorded
 * `compile_cache_bake=ok` for a cache that was never actually flushed).
 * Tolerance under `KNEXT_WARM_ACCEPT_ANY_STATUS=1` requires EVERY one of
 * the following to hold — not most, not "close enough":
 *   - the child was not killed by a signal (`signal === null`);
 *   - the child's exit code is EXACTLY 1 — the driver's own documented
 *     failure code for "a warm path did not answer 2xx"
 *     (`knext-compile-cache-bake.mjs.hbs`), never any other non-zero code;
 *   - stdout contains the driver's `COMPILE_CACHE:` line — proof the warm
 *     loop actually finished and the flush ran, not that the process merely
 *     happened to exit non-zero at some earlier point;
 *   - stderr contains the driver's own, exact
 *     `"a warm path did not answer 2xx"` marker — proof this is that
 *     specific, known failure and not some other crash that coincidentally
 *     also exited 1;
 *   - every `WARMED:<path> status=<s> ms=<n>` line's `status` is a real
 *     3-digit HTTP status code (`/^\d{3}$/` — this also rules out the
 *     driver's own `status=error` spelling for a connection failure, and
 *     any malformed/empty status, in one check); and
 *   - at least one of those numeric statuses is outside the 2xx range —
 *     if every logged status was 2xx yet the driver still exited non-zero,
 *     that contradicts the known failure shape and is never tolerated.
 * Every other combination — a signal, a wrong exit code, a missing marker,
 * a non-numeric status, or an all-2xx set — is a REAL failure, exactly as
 * strict as `KNEXT_WARM_ACCEPT_ANY_STATUS` being unset.
 *
 * Usage:
 *   KNEXT_WARM_ACCEPT_ANY_STATUS=1 node scripts/e2e-bake-accept.mjs <cmd> [args...]
 *   (any command works — this only ever interprets ITS OWN env, spawns the
 *   given command with KNEXT_WARM_ACCEPT_ANY_STATUS stripped from the
 *   child's environment, and re-derives the verdict from the child's own
 *   signal, exit code, stdout and stderr.)
 */

import { spawnSync } from 'node:child_process';

const WARMED_LINE_RE = /^WARMED:(\S+) status=(\S+) ms=(\d+)/;
const HTTP_STATUS_RE = /^\d{3}$/;
const COMPILE_CACHE_MARKER = 'COMPILE_CACHE:';
const DRIVER_FAILURE_MARKER = 'a warm path did not answer 2xx';

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
 * @param {{ exitCode: number | null, signal: string | null, stdout: string, stderr: string, acceptAnyStatus: boolean }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateBakeOutcome({ exitCode, signal, stdout, stderr, acceptAnyStatus }) {
  if (exitCode === 0 && signal === null) {
    return { ok: true, reason: 'the driver exited 0 (strict 2xx bake succeeded)' };
  }
  if (!acceptAnyStatus) {
    return {
      ok: false,
      reason: `the driver exited ${exitCode === null ? `via signal ${signal}` : exitCode} and KNEXT_WARM_ACCEPT_ANY_STATUS is not set — real failure, not tolerated`,
    };
  }

  // From here on, tolerance requires EVERY condition below — see the file
  // header for why each one exists. Any single miss is a real failure.
  if (signal !== null) {
    return {
      ok: false,
      reason: `the driver was killed by signal ${signal} — never tolerated, even under KNEXT_WARM_ACCEPT_ANY_STATUS (a kill proves nothing about whether the cache was flushed)`,
    };
  }
  if (exitCode !== 1) {
    return {
      ok: false,
      reason: `the driver exited ${exitCode}, not the driver's own documented non-2xx failure code (1) — never tolerated`,
    };
  }
  if (!stdout.includes(COMPILE_CACHE_MARKER)) {
    return {
      ok: false,
      reason: `stdout has no "${COMPILE_CACHE_MARKER}" line — the driver never reached its flush, so exit 1 here is not proven to be the known non-2xx failure`,
    };
  }
  if (!stderr.includes(DRIVER_FAILURE_MARKER)) {
    return {
      ok: false,
      reason: `stderr does not contain the driver's own "${DRIVER_FAILURE_MARKER}" marker — exit 1 here is not proven to be that specific, known failure`,
    };
  }
  const warmed = parseWarmedLines(stdout);
  if (warmed.length === 0) {
    return {
      ok: false,
      reason:
        'the driver logged no WARMED line at all — it never reached a real response, despite the other markers',
    };
  }
  const invalid = warmed.filter((w) => !HTTP_STATUS_RE.test(w.status));
  if (invalid.length > 0) {
    return {
      ok: false,
      reason: `${invalid.length} warm path(s) logged a non-numeric status (connection error or malformed, never a real HTTP status): ${invalid.map((w) => `${w.path}=${w.status}`).join(', ')}`,
    };
  }
  const nonTwoXx = warmed.filter((w) => {
    const n = Number(w.status);
    return !(n >= 200 && n < 300);
  });
  if (nonTwoXx.length === 0) {
    return {
      ok: false,
      reason:
        'every WARMED status was 2xx, yet the driver exited non-zero — this does not match the known non-2xx failure shape and is never tolerated',
    };
  }
  return {
    ok: true,
    reason: `the driver exited 1 on a genuine non-2xx status alone (every warm path answered with a real HTTP status, the flush ran, and the driver's own failure marker matched) — tolerated under KNEXT_WARM_ACCEPT_ANY_STATUS`,
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
    exitCode: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
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
