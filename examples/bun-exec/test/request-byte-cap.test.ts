// @vitest-environment node
//
// ADR-0044 Option C — the in-process request byte cap, BEHAVIOURAL half.
//
// `tests/request-byte-cap.test.ts` proves every copy of the entry is WIRED. This
// file proves the wiring does what the ADR asked for, over real sockets, because
// the one constraint that matters cannot be read off the source: Decision 4
// requires COUNTED bytes, never a trusted `Content-Length` — chunked encoding
// carries no length, so a cap that only reads the header is not a cap.
//
// The subject is `srvx-close-harness.mjs`, which wires `srvx/bun` serve + the
// `:9464` `Bun.serve` exactly as `knext-bun-entry.mjs` does (that mirroring is
// itself pinned by the wiring scan). Booting the compiled binary instead would
// be better and is what the alpine docker e2e is for; this runs on every PR.
//
// MEASURED, and the reason this file asserts a Bun floor elsewhere: on Bun 1.3.5
// `maxRequestBodySize` refuses an honest oversize Content-Length (413) but hands
// a CHUNKED body of the same size straight to the handler. On 1.4.0 — the floor
// `vinext-build.ts` already enforces for every shipped binary — both are 413.
//
// NO GREEN-BY-SKIP: without `bun` on PATH the e2e cannot run, so it skips with a
// loud reason, and under `KNEXT_REQUIRE_BUN=1` a missing bun is a hard failure.

import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRVX_HARNESS = resolve(__dirname, 'srvx-close-harness.mjs');
const EPHEMERAL = '0';

const bunProbe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
const bunAvailable = bunProbe.status === 0;
if (!bunAvailable && process.env.KNEXT_REQUIRE_BUN === '1') {
  throw new Error(
    'KNEXT_REQUIRE_BUN=1 but `bun` is not on PATH — the byte-cap e2e cannot run, ' +
      'and a skipped security gate must never read as green.',
  );
}

/** The cap the e2e runs at: small enough to send oversize bodies cheaply. */
const CAP = 1024;

let child: ReturnType<typeof spawn> | undefined;

afterEach(async () => {
  const proc = child;
  child = undefined;
  if (proc && proc.exitCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
});

type Booted = { port: number; metricsPort: number; out: () => string };

/**
 * Boot the harness and wait for the ports it ACTUALLY bound.
 *
 * Fails loudly on an early exit — never hangs to the runner timeout, never
 * skips.
 */
function boot(extraEnv: Record<string, string> = {}): Promise<Booted> {
  const proc = spawn('bun', [SRVX_HARNESS], {
    env: { ...process.env, PORT: EPHEMERAL, METRICS_PORT: EPHEMERAL, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  let buf = '';
  proc.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
  });
  proc.stderr?.on('data', (d: Buffer) => {
    buf += d.toString();
  });
  return new Promise((res, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`harness never listened. output:\n${buf}`)),
      15_000,
    );
    proc.stdout?.on('data', () => {
      const m = buf.match(/LISTENING:(\d+) METRICS:(\d+)/);
      if (m) {
        clearTimeout(timer);
        res({ port: Number(m[1]), metricsPort: Number(m[2]), out: () => buf });
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited early (${code}) before listening. output:\n${buf}`));
    });
  });
}

/** A body sent with NO `Content-Length` — chunked transfer encoding. */
function chunked(totalBytes: number, chunks = 8): ReadableStream<Uint8Array> {
  const per = Math.ceil(totalBytes / chunks);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(per, totalBytes - sent);
      sent += n;
      controller.enqueue(new TextEncoder().encode('y'.repeat(n)));
    },
  });
}

describe.skipIf(!bunAvailable)('the request byte cap, over real sockets', () => {
  it('lets an under-limit body through untouched', async () => {
    const { port } = await boot({ KNEXT_MAX_REQUEST_BYTES: String(CAP) });
    const res = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      body: 'x'.repeat(CAP - 1),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`bytes:${CAP - 1}`);
  });

  it('refuses an oversize body with an honest Content-Length (413)', async () => {
    const { port } = await boot({ KNEXT_MAX_REQUEST_BYTES: String(CAP) });
    const res = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      body: 'x'.repeat(CAP * 5),
    });
    expect(res.status).toBe(413);
  });

  it('refuses an oversize CHUNKED body with no Content-Length (413) — counted bytes', async () => {
    // THE ADR-0044 Decision 4 constraint. A cap that trusted `Content-Length`
    // would answer 200 here, and the whole control would be bypassable by
    // omitting one header.
    const { port } = await boot({ KNEXT_MAX_REQUEST_BYTES: String(CAP) });
    const res = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      body: chunked(CAP * 5),
      // @ts-expect-error — `duplex` is required for a stream body and is not in
      // the DOM lib types bun:test resolves.
      duplex: 'half',
    }).catch((err: Error) => err);
    expect(res, `the request errored instead of being answered: ${res}`).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(413);
  });

  it('does not engage for a bodyless Upgrade request', async () => {
    // The cap is request-BODY-side, so an upgrade handshake (no body) must reach
    // the app unchanged. This asserts pass-through of the request, not a full
    // 101 negotiation — the harness mirrors the entry, and the entry runs no
    // websocket server, so adding one here would prove a different program.
    const { port } = await boot({ KNEXT_MAX_REQUEST_BYTES: String(CAP) });
    const res = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: { upgrade: 'websocket', connection: 'Upgrade' },
      body: 'x'.repeat(16),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('bytes:16');
  });

  it('leaves a streaming RESPONSE streaming', async () => {
    // The cap wraps nothing on the response side; "by construction" is exactly
    // what this repo keeps discovering to be false, so measure it: the first SSE
    // chunk must arrive well before the last.
    const { port } = await boot({ KNEXT_MAX_REQUEST_BYTES: String(CAP) });
    const res = await fetch(`http://127.0.0.1:${port}/sse`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const t0 = Date.now();
    const first = await reader.read();
    const firstMs = Date.now() - t0;
    let seen = new TextDecoder().decode(first.value);
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      seen += new TextDecoder().decode(next.value);
    }
    const lastMs = Date.now() - t0;
    expect(seen).toContain('data: 1');
    expect(seen).toContain('data: 3');
    // 3 events, ~120 ms apart. Buffered delivery would put firstMs ≈ lastMs.
    expect(lastMs).toBeGreaterThan(200);
    expect(firstMs).toBeLessThan(lastMs / 2);
  });

  it('caps the :9464 metrics listener small while a scrape still works', async () => {
    const { metricsPort } = await boot();
    const scrape = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
    expect(scrape.status).toBe(200);
    expect(await scrape.text()).toContain('knext_bunexec_');
    // 128 KiB: over the 64 KiB metrics cap, far UNDER the 8 MiB app default — so
    // a pass here would mean the metrics listener is running on the app's cap or
    // on Bun's 128 MB default, which is the co-resident path ADR-0044 names.
    const push = await fetch(`http://127.0.0.1:${metricsPort}/metrics`, {
      method: 'POST',
      body: 'z'.repeat(128 * 1024),
    });
    expect(push.status).toBe(413);
  });

  it('logs the effective cap at boot', async () => {
    const { out } = await boot({ KNEXT_MAX_REQUEST_BYTES: String(CAP) });
    await new Promise((r) => setTimeout(r, 150));
    expect(out()).toContain(`REQUEST_BYTE_CAP:${CAP}`);
  });

  it('KNEXT_MAX_REQUEST_BYTES=0 uncaps, and says so loudly at boot', async () => {
    const { port, out } = await boot({ KNEXT_MAX_REQUEST_BYTES: '0' });
    await new Promise((r) => setTimeout(r, 150));
    expect(out()).toMatch(/UNCAPPED/);
    expect(out()).toContain('KNEXT_MAX_REQUEST_BYTES');
    // A body far over the 8 MiB default gets through, which is the whole meaning
    // of the escape hatch — and is why the boot log has to be unmissable.
    const big = 9 * 1024 * 1024;
    const res = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      body: 'x'.repeat(big),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`bytes:${big}`);
  });

  it('still caps the metrics listener when the app is uncapped', async () => {
    // `KNEXT_MAX_REQUEST_BYTES=0` is an APP-side escape hatch. If it reached the
    // metrics listener it would silently reopen the co-resident-pod path.
    const { metricsPort } = await boot({ KNEXT_MAX_REQUEST_BYTES: '0' });
    const push = await fetch(`http://127.0.0.1:${metricsPort}/metrics`, {
      method: 'POST',
      body: 'z'.repeat(128 * 1024),
    });
    expect(push.status).toBe(413);
  });
});
