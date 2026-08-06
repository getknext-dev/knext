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
import { describe, expect, it, vi } from 'vitest';
import { freePorts, reserveHeldPorts } from './e2e-support/ports';

/**
 * Fault injection for the PARTIAL-FAILURE case below. A reservation that dies
 * part-way (EMFILE) must close the sockets it already took; that path cannot be
 * reached by asking the OS nicely, so the Nth `listen()` is made to fail.
 *
 * Inert unless `failAfter >= 0`, so every other case in this file runs against
 * the real `node:net`.
 */
const netFault = vi.hoisted(() => ({ failAfter: -1, created: 0, opened: [] as number[] }));

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    default: actual,
    createServer: ((...args: Parameters<typeof actual.createServer>) => {
      const srv = actual.createServer(...args);
      srv.on('listening', () => {
        const addr = srv.address();
        if (addr !== null && typeof addr === 'object') netFault.opened.push(addr.port);
      });
      if (netFault.failAfter >= 0 && netFault.created++ >= netFault.failAfter) {
        srv.listen = ((..._ignored: unknown[]) => {
          setImmediate(() =>
            srv.emit(
              'error',
              Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }),
            ),
          );
          return srv;
        }) as typeof srv.listen;
      }
      return srv;
    }) as typeof actual.createServer,
  };
});

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

  it('closes the sockets it already took when a later reservation fails', async () => {
    // The partial-failure path. `reserveHeldPorts` holds every socket open by
    // design, so a mid-batch throw is the ONE way it can leak descriptors — and
    // the leaked sockets stay in LISTEN for the life of the vitest worker,
    // silently burning ports for every later spec in the same process.
    //
    // This is the property this file's `apps/` twin
    // (`apps/file-manager/child-ports.test.ts`) also asserts: the two copies are
    // kept behaviourally equivalent by having the same cases, NOT by the
    // repo-level scan, which only sees syntax.
    netFault.opened = [];
    netFault.created = 0;
    netFault.failAfter = 3; // the 4th listen() fails
    let takenBeforeFailure: number[];
    try {
      await expect(reserveHeldPorts(6)).rejects.toThrow(/EMFILE/);
      takenBeforeFailure = [...netFault.opened];
    } finally {
      netFault.failAfter = -1; // real node:net again, for the checks below
    }

    // The batch really was PARTIAL. Without this the loop below can be vacuous.
    expect(takenBeforeFailure).toHaveLength(3);

    // ...and every socket taken before the failure was closed on the way out.
    for (const port of takenBeforeFailure) {
      expect(await isBindable(port), `port ${port} leaked after a partial failure`).toBe(true);
    }
  });

  it('rejects a bad count instead of silently returning fewer ports', async () => {
    // `const [a, b] = await freePorts(1)` would leave `b` undefined and bind
    // "undefined" as a port; fail loudly at the call instead.
    await expect(freePorts(0)).rejects.toThrow(/count/);
  });
});
