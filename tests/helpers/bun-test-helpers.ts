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
      if (result) return result;
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
  await new Promise((resolve) => setImmediate(resolve));
}

/** Run every pending fake timer, then drain the microtask queue. See above. */
export async function runAllTimersAsync(): Promise<void> {
  jest.runAllTimers();
  await new Promise((resolve) => setImmediate(resolve));
}
