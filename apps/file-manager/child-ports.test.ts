// @vitest-environment node
//
// #678 — the port-discovery plumbing the SIGTERM e2es depend on.
//
// The point of these cases is NOT that discovery works when everything is fine;
// it is that discovery still FAILS LOUDLY when the server does not come up.
// Replacing a fixed port with "wait for the child to tell us its port" is exactly
// how a real boot failure turns into a hang (the spec sits until the vitest
// timeout with no message) or into a skip — the green-by-skip class already closed
// three times here (#408, #448, #659). So a crashing child and a silent child both
// have their own case, and both assert the REASON is in the message.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { freePort, waitForListeningPort } from './e2e-support/child-ports';

let child: ReturnType<typeof spawn> | undefined;

afterEach(() => {
  if (child && child.exitCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  child = undefined;
});

/** Spawn a throwaway node child running `src`. */
function spawnNode(src: string): ReturnType<typeof spawn> {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // no harness preload in a plain-node child
  return spawn(process.execPath, ['-e', src], { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('waitForListeningPort (#678)', () => {
  it('resolves with the port the OS actually assigned, not the one requested', async () => {
    // Binds 0 — so the resolved port can only have come from the LISTENING line.
    child = spawnNode(
      `const http=require('node:http');const s=http.createServer((_q,r)=>r.end('ok'));` +
        `s.listen(0,()=>{process.stdout.write('LISTENING:'+s.address().port+'\\n')});` +
        `setTimeout(()=>process.exit(0),10000);`,
    );
    const port = await waitForListeningPort(child, { timeoutMs: 10_000 });
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);

    // Prove it is the REAL port, not a parsed-but-wrong number: it answers.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
  }, 20_000);

  it('REJECTS promptly, with stderr, when the server fails to start', async () => {
    // The mutation case: a server that cannot come up (here: a throw at boot, the
    // same shape as MODULE_NOT_FOUND or EADDRINUSE) must red the spec — not hang
    // to the vitest timeout, and not be swallowed into a skip.
    child = spawnNode(`throw new Error('BOOT-FAILED-ON-PURPOSE')`);
    const started = Date.now();
    await expect(
      waitForListeningPort(child, { timeoutMs: 20_000, label: 'broken server' }),
    ).rejects.toThrow(/broken server exited early[\s\S]*BOOT-FAILED-ON-PURPOSE/);
    // "Promptly" means it failed on the exit event, NOT by burning the timeout.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('REJECTS on timeout when the child comes up but never announces a port', async () => {
    // The other silent-failure shape: alive, but no readiness line. Without an
    // explicit timeout this is the hang the discovery change could have created.
    child = spawnNode(`setTimeout(()=>process.exit(0),30000)`);
    await expect(
      waitForListeningPort(child, { timeoutMs: 750, label: 'mute server' }),
    ).rejects.toThrow(/mute server never reported LISTENING/);
  }, 20_000);

  it('never resolves a fallback port from stdout that is not a LISTENING line', async () => {
    // A discovery helper that quietly returned a default (3000, say) would make the
    // e2e probe SOMEONE ELSE'S server and pass for the wrong reason.
    //
    // The child must stay alive PAST the timeout: if it exits first this rejects
    // via the early-exit branch (already covered above) and proves nothing about
    // stdout parsing. So it keeps the loop alive well beyond timeoutMs, and the
    // matcher pins the TIMEOUT branch specifically — `.rejects.toThrow()` with no
    // matcher cannot tell the two rejection reasons apart.
    child = spawnNode(
      `process.stdout.write('no port here\\n');` +
        `process.stdout.write('listening on 3000, LISTENING soon\\n');` +
        `setTimeout(()=>process.exit(0),30000)`,
    );
    await expect(
      waitForListeningPort(child, { timeoutMs: 750, label: 'chatty server' }),
    ).rejects.toThrow(/chatty server never reported LISTENING/);
    expect(child.exitCode).toBeNull(); // still alive → it was the timeout, not an exit
  }, 20_000);
});

describe('freePort (#678)', () => {
  /** Bind `port` on loopback and resolve a closer — the caller controls the hold. */
  function hold(port: number): Promise<() => Promise<void>> {
    return new Promise((res, rej) => {
      const srv = createServer();
      srv.on('error', rej);
      srv.listen(port, '127.0.0.1', () =>
        res(() => new Promise<void>((done) => srv.close(() => done()))),
      );
    });
  }

  it('returns a port that is genuinely free right now', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);

    // The property that matters to callers: it can actually be bound. `hold`
    // rejects on EADDRINUSE/EACCES, so this fails rather than hangs.
    const release = await hold(port);
    await release();
  }, 20_000);

  it('never hands out a port that is already bound', async () => {
    // The "is it a constant, or a real allocation?" question — asked in the one
    // form the OS actually guarantees.
    //
    // NOT asserted: that two sequential calls differ. Nothing specifies that an
    // ephemeral allocator cannot repeat once the first socket is closed (it is
    // merely unlikely), and a de-flaking change must not smuggle in a new
    // nondeterministic assertion. Holding the first port makes the difference a
    // guarantee: bind(0) is never assigned a port in LISTEN state.
    const held = await freePort();
    const release = await hold(held);
    try {
      const next = await freePort();
      expect(next).toBeGreaterThan(0);
      expect(next).not.toBe(held); // deterministic: `held` is occupied
    } finally {
      await release();
    }
  }, 20_000);
});
