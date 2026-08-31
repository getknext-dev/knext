/**
 * The few things `bun:test` has no direct equivalent for.
 *
 * This is NOT a vitest shim. Everything vitest and bun both provide is used
 * natively — `mock`, `spyOn`, `jest.useFakeTimers`, and so on. What lands here
 * is the small remainder where bun genuinely offers nothing and the suite would
 * otherwise lose a real capability:
 *
 *   - env stubbing with automatic restore (`vi.stubEnv` / `vi.unstubAllEnvs`)
 *   - polling until a condition holds (`vi.waitFor`)
 *   - advancing fake timers and letting the microtask queue drain
 *     (`vi.advanceTimersByTimeAsync`)
 *
 * Keeping the list short is deliberate. A big compatibility layer would let the
 * suite keep speaking vitest forever, which is the opposite of migrating — and
 * it would hide the places where the two runners genuinely differ, which is
 * exactly where the silent failures live.
 */

import { jest } from 'bun:test';

/**
 * The REAL `setImmediate`, captured at module load.
 *
 * `jest.useFakeTimers()` replaces `setImmediate` along with everything else, so
 * `await new Promise((r) => setImmediate(r))` inside a faked test schedules a
 * callback onto the fake clock and waits for it forever. The file does not
 * fail — it HANGS, with no output at all, and the runner reports a timeout that
 * names no test (#871).
 *
 * Captured here because this module is imported before any test installs fake
 * timers, so the binding is still the real one.
 */
const realSetImmediate = globalThis.setImmediate;

// ── env stubbing ─────────────────────────────────────────────────────────────

const envStack: Array<[string, string | undefined]> = [];

/**
 * Set an env var for the duration of a test, remembering what it displaced.
 *
 * Records the PREVIOUS value rather than assuming the var was unset: restoring
 * to `undefined` when the process actually had a value is a leak that shows up
 * as an unrelated test failing later, in a different file, depending on order.
 */
export function stubEnv(key: string, value: string | undefined): void {
  envStack.push([key, process.env[key]]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Undo every `stubEnv` in reverse order. Safe to call when nothing is stubbed. */
export function unstubAllEnvs(): void {
  while (envStack.length > 0) {
    const [key, previous] = envStack.pop() as [string, string | undefined];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

// ── polling ──────────────────────────────────────────────────────────────────

export interface WaitForOptions {
  /** Give up after this long. Default 1000ms. */
  timeout?: number;
  /** Gap between attempts. Default 10ms. */
  interval?: number;
}

/**
 * Poll `predicate` until it returns a truthy value or the budget runs out.
 *
 * Rethrows the LAST error rather than a generic timeout, because "waitFor timed
 * out" tells you nothing about why — the assertion inside is the actual
 * diagnosis, and swallowing it turns a five-second fix into an investigation.
 */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { timeout = 1000, interval = 10 }: WaitForOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  for (;;) {
    try {
      const result = await predicate();
      // Success = "did not throw", NOT "returned something truthy".
      //
      // The truthy rule silently broke every assertion-style call. bun's
      // matchers return `undefined`, so `waitFor(() => expect(fn)
      // .toHaveBeenCalledTimes(1))` polled until timeout and reported
      // "condition still falsy" — while the assertion inside it had PASSED on
      // the first attempt. The failure named the helper's own bookkeeping and
      // said nothing about the code, which is the most expensive kind of red.
      //
      // `false` is still treated as not-yet, so boolean predicates keep working.
      // The trade: a predicate that forgets to return now succeeds immediately.
      // That is vitest's semantics for `vi.waitFor` too, and it is the lesser
      // hazard — a missing return is visible in the test, a matcher's return
      // type is not.
      if (result !== false) return result;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      if (lastError !== undefined) throw lastError;
      throw new Error(`waitFor: condition still falsy after ${timeout}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// ── fake timers ──────────────────────────────────────────────────────────────

/**
 * Advance fake timers, then let queued microtasks run.
 *
 * `jest.advanceTimersByTime` is synchronous: it fires the timer callbacks but
 * does not yield, so a promise chained off one has NOT settled when it returns.
 * Awaiting a macrotask afterwards is what makes assertions on that chain
 * reliable — without it the test reads the state from before the continuation
 * ran, intermittently.
 */
export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await new Promise((resolve) => realSetImmediate(resolve));
}

/**
 * vitest's `vi.runAllTimersAsync()`, which bun's `jest.runAllTimers()` is NOT.
 *
 * Two differences, and both matter:
 *
 *  1. `jest.runAllTimers()` is SYNCHRONOUS. A timer whose callback awaits, then
 *     schedules the next retry, never gets to schedule it — so the loop either
 *     ends early or, when the continuation runs inside the same tick, spins.
 *  2. It is UNBOUNDED. Against the DB wake-retry's self-rescheduling backoff it
 *     blocks the event loop outright: the file produced no output at all, and
 *     even `bun test --timeout` could not fire, because nothing yielded for the
 *     timeout to run on. A hang with no test name is far worse to diagnose than
 *     a failure.
 *
 * So this advances ONE timer at a time and yields a real macrotask between
 * them, which is what lets a promise chained off a timer settle before the next
 * one fires. The iteration cap converts an infinite reschedule into a named
 * error instead of a hang — vitest's own implementation caps for the same
 * reason.
 */
export async function runAllTimersAsync(maxIterations = 10_000): Promise<void> {
  // Yield BEFORE the first check. The caller typically starts an async
  // operation and then drains — and the first backoff timer is only scheduled
  // once that operation's first continuation runs. Checking immediately finds
  // zero timers, returns, and leaves the caller awaiting a promise nothing will
  // ever settle: a hang, not a failure.
  await new Promise((resolve) => realSetImmediate(resolve));

  for (let i = 0; i < maxIterations; i++) {
    if (jest.getTimerCount() === 0) {
      // Zero timers is not the same as "done". A backoff loop schedules its
      // NEXT sleep from the continuation of the previous one, so there is a
      // window where the clock has fired everything and nothing is pending yet.
      // Returning there leaves the caller awaiting a promise nothing will
      // settle — a hang, not a failure, and the runner can only report it as a
      // timeout naming no test.
      //
      // So confirm across a real macrotask boundary before concluding.
      await new Promise((resolve) => realSetImmediate(resolve));
      if (jest.getTimerCount() === 0) return;
    }
    jest.advanceTimersToNextTimer();
    await new Promise((resolve) => realSetImmediate(resolve));
  }
  throw new Error(
    `runAllTimersAsync: ${jest.getTimerCount()} timer(s) still pending after ` +
      `${maxIterations} iterations — a timer is almost certainly rescheduling ` +
      'itself forever. Advance by a bounded amount instead.',
  );
}
