/**
 * Slow-dependency logging — the cold-start ledger's discrimination instrument.
 *
 * Row 3 of `docs/benchmarks/cold-start-ledger.md` measured a ~1-in-8 first-request
 * stall (~2.4 s) that the pod's logs cannot attribute: the strongest evidence is
 * an ABSENCE (no `failing open` line), which leaves three compatible readings —
 * PG pool first-connect delay, cache lazy-connect TCP delay, or a slow-but-
 * inside-budget cache ready-check. The next lever (eager cache connect at boot)
 * is worth taking under one of them and worthless under another, so the loop
 * cannot proceed on an undiscriminated stall.
 *
 * This module is the discriminator: when a dependency operation on a request
 * path exceeds `SLOW_DEP_LOG_MS` (default 500 ms) it emits ONE structured,
 * greppable line naming the dependency class, the operation and the duration.
 * It changes no timeout, no budget and no failure behaviour — it only names what
 * already happened.
 *
 * Security: the line carries the dep CLASS, never the target. Any context value
 * that looks like a URL/DSN (`://` or userinfo `@`) is dropped rather than
 * redacted — a knext log line must never carry credentials
 * (`.claude/rules/security.md`).
 *
 * A second copy of this emitter lives at
 * `@getknext/core/adapters/slow-dep-log.js`, because the two Redis readings are
 * timed inside the cache handler and `@getknext/lib` may not depend on
 * `@getknext/core`. `slow-dep-format-parity.test.ts` holds the two to one
 * format — one `grep '[slow-dep]'` must return all three readings comparably.
 */

/** The three readings row 3 left undiscriminated. */
export type SlowDepName = 'pg' | 'redis-connect' | 'redis-ready';

/** The grep anchor. Do not change it without changing the ledger's next row. */
export const SLOW_DEP_PREFIX = '[slow-dep]';

const DEFAULT_SLOW_DEP_LOG_MS = 500;

/**
 * The effective threshold (ms), read at CALL time so a running pod can be
 * re-pointed by a rollout without a code change. Junk / non-positive values fall
 * back to the default rather than disabling the instrument.
 */
export function slowDepThresholdMs(): number {
  const parsed = Number.parseInt(process.env.SLOW_DEP_LOG_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SLOW_DEP_LOG_MS;
}

/** Anything URL-shaped or carrying userinfo is a credential risk — drop it. */
const looksLikeTarget = (value: string): boolean => value.includes('://') || value.includes('@');

const MAX_VALUE_LEN = 120;

function safeExtra(extra?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!extra) return out;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      if (looksLikeTarget(value)) continue;
      out[key] = value.length > MAX_VALUE_LEN ? value.slice(0, MAX_VALUE_LEN) : value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
    // Everything else (objects, errors) is dropped: an unbounded value in a log
    // line is how a DSN gets in sideways.
  }
  return out;
}

/**
 * Emit one line iff `durationMs` EXCEEDS the threshold. Returns whether it did,
 * so a caller (and a test) can assert both halves.
 *
 * Fail-open: a broken log pipeline must never propagate into the dependency
 * path this is observing.
 */
export function logSlowDep(
  dep: SlowDepName,
  op: string,
  durationMs: number,
  extra?: Record<string, unknown>,
): boolean {
  try {
    const thresholdMs = slowDepThresholdMs();
    if (!(durationMs > thresholdMs)) return false;
    const fields = {
      dep,
      op,
      durationMs: Math.round(durationMs),
      thresholdMs,
      ...safeExtra(extra),
    };
    // JSON.stringify escapes newlines, so the record is always ONE line.
    console.warn(`${SLOW_DEP_PREFIX} ${JSON.stringify(fields)}`);
    return true;
  } catch {
    return false;
  }
}
