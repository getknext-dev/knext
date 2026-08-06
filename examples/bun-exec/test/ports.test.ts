// @vitest-environment node
//
// #686 — the container e2e's host-port reservation cannot collide with itself.
//
// `alpine-image.docker-e2e.test.ts` needs TWO host ports before `docker run`,
// and it used to take them with two sequential `freePort()` calls: the first
// socket closed before the second was allocated, so the OS was free to hand back
// the same number twice and one `--publish` would fail. This suite pins the
// property that makes a repeat IMPOSSIBLE — every reserved port is still in
// LISTEN while the rest are allocated.
//
// The assertion is deliberately NOT "the ports differ": that passes by luck under
// the very close-then-reopen implementation it is meant to catch. It asserts the
// HOLD directly, by trying to bind each reserved port while the batch is held.

import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { freePorts, reserveHeldPorts } from './e2e-support/ports';

/** Resolve true if `port` can be bound right now, false on EADDRINUSE. */
function isBindable(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const srv = createServer();
    srv.once('error', () => resolvePromise(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolvePromise(true));
    });
  });
}

describe('#686 held host-port reservation for the container e2e', () => {
  it('holds EVERY reserved port in LISTEN until release()', async () => {
    const { ports, release } = await reserveHeldPorts(4);
    expect(ports).toHaveLength(4);
    try {
      for (const port of ports) {
        // Held ⇒ unbindable. This is the property the hold buys; a
        // close-then-reopen implementation makes every one of these bindable.
        expect(await isBindable(port), `port ${port} was not held`).toBe(false);
      }
    } finally {
      await release();
    }
    // ...and released ⇒ bindable again, so the helper leaks no descriptors.
    for (const port of ports) {
      expect(await isBindable(port)).toBe(true);
    }
  });

  it('returns distinct ports', async () => {
    const ports = await freePorts(8);
    expect(new Set(ports).size).toBe(8);
  });

  it('rejects a bad count instead of silently returning fewer ports', async () => {
    // `const [a, b] = await freePorts(1)` would leave `b` undefined and bind
    // "undefined" as a port; fail loudly at the call instead.
    await expect(freePorts(0)).rejects.toThrow(/count/);
  });
});
