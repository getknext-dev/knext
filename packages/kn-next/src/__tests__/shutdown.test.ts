import { describe, expect, it, vi } from 'vitest';
import { gracefulShutdown } from '../adapters/shutdown';

// Minimal child-process double: records signal forwarding + lets the test fire "exit".
function makeChild() {
  const handlers: Record<string, () => void> = {};
  return {
    kill: vi.fn(),
    once: vi.fn((ev: string, cb: () => void) => {
      handlers[ev] = cb;
    }),
    emitExit: () => handlers.exit?.(),
  };
}

describe('gracefulShutdown (A5 — drain on SIGTERM, no dropped requests)', () => {
  it('closes servers and FORWARDS SIGTERM to the child (so Next drains in-flight + runs after())', () => {
    const child = makeChild();
    const closable = { close: vi.fn() };
    const exit = vi.fn();
    gracefulShutdown('SIGTERM', {
      child,
      closables: [closable],
      graceMs: 1000,
      exit,
    });
    expect(closable.close).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // Must NOT exit immediately — it waits for the child to finish draining.
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits 0 as soon as the child exits (drain complete) — before the grace cap', () => {
    const child = makeChild();
    const exit = vi.fn();
    gracefulShutdown('SIGTERM', { child, closables: [], graceMs: 10_000, exit });
    child.emitExit();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('force-exits at the grace cap if the child never drains', () => {
    vi.useFakeTimers();
    const child = makeChild();
    const exit = vi.fn();
    gracefulShutdown('SIGTERM', { child, closables: [], graceMs: 5_000, exit });
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(exit).toHaveBeenCalledWith(0);
    vi.useRealTimers();
  });

  it('exits exactly once (child-exit and the cap timer never double-exit)', () => {
    vi.useFakeTimers();
    const child = makeChild();
    const exit = vi.fn();
    gracefulShutdown('SIGTERM', { child, closables: [], graceMs: 5_000, exit });
    child.emitExit();
    vi.advanceTimersByTime(5_000);
    expect(exit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
