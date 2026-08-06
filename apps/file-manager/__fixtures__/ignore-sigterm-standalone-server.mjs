/**
 * Test fixture that stands in for an UNRESPONSIVE Next.js standalone server.js.
 *
 * Used by sigterm-hardcap-e2e.test.ts to prove the knext runtime entry's
 * graceful-shutdown HARD CAP (the safety net): if the spawned standalone child
 * IGNORES SIGTERM and refuses to drain, the runtime entry must still exit at the
 * `graceMs` hard cap (SHUTDOWN_GRACE_MS) so the pod never exceeds its
 * terminationGracePeriodSeconds. This is the path that, until now, was only
 * covered by a unit test with an injected timer — never e2e against the real
 * spawned runtime entry.
 *
 * Behaviour, mirroring a Next standalone server that hangs on shutdown:
 *  - Listens on $PORT (default 0 → the OS assigns a free one, #678) and announces
 *    readiness on stdout as `LISTENING:<the port actually bound>`. It reports the
 *    socket's own address, never the requested value, so the spec can never probe
 *    a port this process is not on.
 *  - TRAPS SIGTERM and deliberately does NOT exit — it logs that it received the
 *    signal and then keeps the event loop alive far past any sane grace cap.
 *    (A bare empty SIGTERM handler also suppresses Node's default
 *    terminate-on-SIGTERM behaviour, so this child genuinely ignores the signal.)
 *
 * If the runtime entry's hard cap were removed, the parent would block forever
 * waiting for this child's "exit" event that never comes — the test asserts the
 * opposite: the parent force-exits at ~graceMs.
 */

import http from 'node:http';

// 0 → the OS assigns a free port (#678). A hardcoded port made this fixture
// collide with any concurrent CI job on the same runner (EADDRINUSE :::39188 on
// PR #676), which is how a required gate becomes a flake people re-run reflexively.
const PORT = Number(process.env.PORT ?? 0);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});

server.listen(PORT, () => {
  // Report the port the SOCKET got, not the one requested — with PORT=0 they
  // differ, and the requested value would send the spec at nothing.
  process.stdout.write(`LISTENING:${server.address().port}\n`);
});

// IGNORE SIGTERM: receive it but refuse to drain/exit. We additionally hold the
// event loop open with a long timer so the process cannot exit on its own — the
// ONLY way this child dies is the parent's hard-cap force-exit taking the whole
// process group down. Far longer than any test grace cap (sleeps ~5 minutes).
process.on('SIGTERM', () => {
  process.stdout.write('SIGTERM-IGNORED\n');
});

setTimeout(() => {
  // Should never fire within the test window; the parent's hard cap kills us first.
  process.stdout.write('UNEXPECTED-SELF-EXIT\n');
  process.exit(0);
}, 300_000);
