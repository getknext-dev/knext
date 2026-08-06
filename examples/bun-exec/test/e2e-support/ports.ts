/**
 * Host-port reservation for this example's container e2e (#686).
 *
 * WHY IT EXISTS AT ALL: `alpine-image.docker-e2e.test.ts` publishes two host
 * ports (`--publish <app>:3000`, `--publish <metrics>:9091`), and docker binds
 * them — so unlike a child that can bind 0 and report back, the spec must KNOW
 * both numbers up front. That is the one case where a reservation is
 * unavoidable.
 *
 * WHY THE HOLD IS THE POINT: the previous version made two sequential
 * `freePort()` calls, each closing its socket before the next was allocated.
 * Nothing forbids the OS returning the same ephemeral port twice, and then both
 * `--publish` flags carry the same host port and `docker run` fails. Reserving
 * every port in ONE call, with all sockets still in LISTEN, makes that
 * IMPOSSIBLE rather than unlikely: `bind(0)` is never handed a port already in
 * LISTEN state.
 *
 * WHY THIS IS A COPY OF `apps/file-manager/e2e-support/child-ports.ts` RATHER
 * THAN AN IMPORT: `examples/*` is deliberately NOT a pnpm workspace member
 * (`pnpm-workspace.yaml` lists only `apps/*` and `packages/*`), so the example
 * has no dependency edge to `file-manager`; reaching across with a relative
 * `../../../apps/...` path would resolve under vitest while making the example —
 * whose whole job is to be a self-contained recipe someone copies out — silently
 * dependent on an app it does not ship with. The duplication is ~25 lines and is
 * deliberate. Both copies are kept honest by the same repo-level scan
 * (`tests/e2e-ephemeral-ports.test.ts`), which now covers `e2e-support/` and
 * fails on a file that reserves ports one call at a time.
 *
 * HONEST LIMIT (same as the file-manager copy): this closes the reservation's
 * collision with ITSELF, not with the rest of the machine. Between `release()`
 * and docker's own bind there is still a window in which an unrelated process
 * could take the port. That window is irreducible for a port someone else must
 * bind.
 */
import { createServer } from 'node:net';

/** A batch of reserved ports, still held in LISTEN until `release()` is awaited. */
export interface HeldPorts {
  readonly ports: readonly number[];
  readonly release: () => Promise<void>;
}

/** Bind port 0 on loopback and resolve the socket plus the port the OS gave it. */
function listenEphemeral(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    const close = () => new Promise<void>((done) => srv.close(() => done()));
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (typeof address !== 'object' || address === null) {
        void close().then(() => reject(new Error('could not read an OS-assigned port')));
        return;
      }
      resolvePromise({ port: address.port, close });
    });
  });
}

/** Reserve `count` OS-assigned ports and KEEP THEM ALL BOUND until `release()`. */
export async function reserveHeldPorts(count: number): Promise<HeldPorts> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`reserveHeldPorts: count must be a positive integer, got ${count}`);
  }
  const held: Array<{ port: number; close: () => Promise<void> }> = [];
  try {
    for (let i = 0; i < count; i += 1) {
      held.push(await listenEphemeral());
    }
  } catch (err) {
    // Partial failure (EMFILE) must not leak the sockets already taken.
    await Promise.all(held.map((h) => h.close()));
    throw err;
  }
  return {
    ports: held.map((h) => h.port),
    release: async () => {
      await Promise.all(held.map((h) => h.close()));
    },
  };
}

/**
 * `count` distinct OS-assigned free ports — distinct BY CONSTRUCTION (see
 * {@link reserveHeldPorts}), not by the improbability of a repeat.
 */
export async function freePorts(count: number): Promise<number[]> {
  const { ports, release } = await reserveHeldPorts(count);
  await release();
  return [...ports];
}
