// #2627 — knext-owned traceparent-through-middleware test.
//
// Replaces the coverage lost when upstream `otel-middleware-trace` (Next 16.4.1+)
// was quarantined as Vercel-topology coupled (ADR-0007 §h): that file snapshots
// span TREES shaped by Vercel's separate middleware/render functions. What it is
// ABOUT — trace context surviving middleware to the handler — is asserted here
// against a topology knext shares and Vercel does not: ONE process serving
// middleware + handler.
//
// WHAT THIS BOOTS, exactly: a tiny fixture built with `output: 'standalone'`,
// then the emitted standalone `server.js` run by plain `node` — the same artifact
// shape knext ships — with `@vercel/otel` registered exactly as `apps/file-manager`
// registers it. WHAT IT IS NOT: no knext Next adapter (`adapterPath`), no operator,
// no Knative/queue-proxy, no cluster, no container image. It is a hermetic
// standalone-server e2e on loopback, not a kind/OKE test.
//
// Both halves are asserted: a good trace id survives to the handler, AND a
// missing / malformed one is detected (fresh valid id, never the garbage).
//
// #2657 adds the span TREE + OTLP EXPORT half: the fixture registers @vercel/otel
// the way the app does (span processors direct-passed, ADR-0027; exporter from
// OTEL_EXPORTER_OTLP_* env) and exports over OTLP/HTTP-JSON to a loopback receiver
// this test holds open on an ephemeral port for the whole run (never closed and
// rebound). NOT covered: a real collector/Tempo, protobuf encoding (JSON is used
// so the receiver can parse it), the app's own knext processors (the fixture's
// inline processor stands in), and Vercel's split middleware/render topology.
// Flush: no explicit forceFlush across the process boundary; the batch processor
// is set to a short schedule delay and the test awaits receipt (event-driven).

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reserveHeldPorts } from './e2e-support/child-ports';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'traceparent-app');
const NEXT_BIN = join(HERE, 'node_modules', 'next', 'dist', 'bin', 'next');
const BUILD_TIMEOUT_MS = 150_000;
const READY_TIMEOUT_MS = 60_000;
// Export waits are event-driven but bounded (waitForSpans: 30 s); let that bound,
// not bun's 5 s default, be what fails a missing export (with a useful message).
setDefaultTimeout(40_000);

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const INCOMING = `00-${TRACE_ID}-b7ad6b7169203331-01`;
const MW_TRACEPARENT = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
const VALID_ID = /^(?!0{32}$)[0-9a-f]{32}$/;

interface Echo {
  traceparentHeader: string | null;
  mwOverride: string | null;
  activeTraceId: string | null;
}

let server: ChildProcess | undefined;
let base = '';
let output = '';

interface ExportedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attrs: Record<string, unknown>;
  serviceName: string | undefined;
}

/** Loopback OTLP/HTTP-JSON receiver, bound once to an OS-chosen port and held. */
let receiver: Server | undefined;
let receiverPort = 0;
const exported: ExportedSpan[] = [];
const waiters: Array<() => void> = [];

type OtlpAttr = { key: string; value: Record<string, unknown> };
const attrMap = (list: OtlpAttr[] = []): Record<string, unknown> =>
  Object.fromEntries(list.map((a) => [a.key, Object.values(a.value)[0]]));

function startReceiver(): Promise<void> {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        for (const rs of body.resourceSpans ?? []) {
          const serviceName = attrMap(rs.resource?.attributes)['service.name'] as
            | string
            | undefined;
          for (const ss of rs.scopeSpans ?? []) {
            for (const s of ss.spans ?? []) {
              exported.push({
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId || undefined,
                name: s.name,
                attrs: attrMap(s.attributes),
                serviceName,
              });
            }
          }
        }
      } catch {
        // non-JSON export: ignore; the assertions will fail on missing spans
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
      for (const w of waiters.splice(0)) w();
    });
  });
  return new Promise((resolve, reject) => {
    receiver?.once('error', reject);
    receiver?.listen(0, '127.0.0.1', () => {
      receiverPort = (receiver?.address() as { port: number }).port;
      resolve();
    });
  });
}

/** Resolve once `pred` holds over the exported spans; event-driven, bounded. */
async function waitForSpans(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error(
        `never received expected spans (${label}); got: ${JSON.stringify(exported.map((s) => s.name))}\n${output}`,
      );
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 1000).unref?.();
    });
  }
}

async function echo(path: string, traceparent?: string): Promise<Echo> {
  const res = await fetch(`${base}${path}`, {
    headers: traceparent ? { traceparent } : {},
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Echo;
}

/**
 * Locate the standalone `server.js`. Next nests it under the monorepo-relative
 * path of the fixture (tracing root = workspace root), so search for it rather
 * than hardcoding that layout. Exactly one must exist.
 */
function findStandaloneServer(): string {
  const root = join(FIXTURE, '.next', 'standalone');
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'server.js') found.push(p);
    }
  };
  walk(root);
  if (found.length !== 1) {
    throw new Error(`expected exactly one standalone server.js under ${root}, found: ${found}`);
  }
  return found[0];
}

/** Poll until the server answers; fail fast (with its output) if it exits first. */
async function waitReady(proc: ChildProcess): Promise<void> {
  let exited: string | undefined;
  proc.once('exit', (code, sig) => {
    exited = `code ${code} signal ${sig}`;
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`fixture standalone server exited early: ${exited}\n${output}`);
    }
    try {
      const r = await fetch(`${base}/api/echo`);
      if (r.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `fixture standalone server never became ready within ${READY_TIMEOUT_MS}ms\n${output}`,
  );
}

beforeAll(async () => {
  const build = spawnSync('node', [NEXT_BIN, 'build', '--webpack'], {
    cwd: FIXTURE,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  if (build.error) {
    throw new Error(
      `fixture next build did not complete (${build.error.message}; timeout ${BUILD_TIMEOUT_MS}ms):\n${build.stdout}\n${build.stderr}`,
    );
  }
  if (build.status !== 0) {
    throw new Error(`fixture next build failed:\n${build.stdout}\n${build.stderr}`);
  }
  const serverJs = findStandaloneServer();

  // Hold the port until the instant before spawn (no self-collision); the
  // remaining release->bind window is the irreducible one child-ports.ts documents.
  await startReceiver();
  const held = await reserveHeldPorts(1);
  const port = held.ports[0];
  base = `http://127.0.0.1:${port}`;
  await held.release();
  // Own process group so teardown can kill the whole tree.
  server = spawn('node', [serverJs], {
    cwd: dirname(serverJs),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${receiverPort}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_BSP_SCHEDULE_DELAY: '50',
    },
  });
  server.stdout?.on('data', (d: Buffer) => {
    output += `[stdout] ${d}`;
  });
  server.stderr?.on('data', (d: Buffer) => {
    output += `[stderr] ${d}`;
  });
  await waitReady(server);
}, 240_000);

afterAll(async () => {
  const proc = server;
  server = undefined;
  if (!proc || proc.pid == null) return;
  const closed = new Promise<void>((done) => {
    if (proc.exitCode !== null || proc.signalCode !== null) done();
    else proc.once('close', () => done());
  });
  try {
    process.kill(-proc.pid, 'SIGKILL'); // negative pid -> whole process group
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await closed;
  const r = receiver;
  receiver = undefined;
  if (r) await new Promise<void>((done) => r.close(() => done()));
});

describe('traceparent through middleware, standalone server (#2627)', () => {
  it('an incoming traceparent is the root of the trace the handler runs in, and middleware overrides still apply', async () => {
    const seen = await echo('/api/echo', INCOMING);
    expect(seen.activeTraceId).toBe(TRACE_ID);
    expect(seen.traceparentHeader?.split('-')[1]).toBe(TRACE_ID);
    expect(seen.mwOverride).toBe('applied');
  });

  it('a missing traceparent is detected: the handler gets a fresh valid trace id, distinct per request', async () => {
    const a = await echo('/api/echo');
    const b = await echo('/api/echo');
    expect(a.activeTraceId).toMatch(VALID_ID);
    expect(b.activeTraceId).toMatch(VALID_ID);
    expect(a.activeTraceId).not.toBe(b.activeTraceId);
    expect(a.activeTraceId).not.toBe(TRACE_ID);
    expect(a.mwOverride).toBe('applied');
  });

  // Guards REGISTRATION (the SDK is actually installed in this process) and the
  // UPSTREAM W3C propagator's rejection of malformed input. That rejection is not
  // knext-owned behaviour: a failure here means registration broke or an
  // OTel/@vercel/otel bump changed parsing.
  it('a malformed traceparent is detected: never adopted, a fresh valid trace id is used', async () => {
    const seen = await echo('/api/echo', 'not-a-traceparent');
    expect(seen.activeTraceId).toMatch(VALID_ID);
    expect(seen.activeTraceId).not.toBe(TRACE_ID);
    expect(seen.mwOverride).toBe('applied');
  });

  it('a middleware-set traceparent reaches the handler as a request-header override', async () => {
    const seen = await echo('/api/echo/mw-sets', INCOMING);
    expect(seen.traceparentHeader).toBe(MW_TRACEPARENT);
    expect(seen.mwOverride).toBe('applied');
    // ...and it starts its OWN trace: the handler runs under the middleware's
    // trace id, not the incoming one (measured on Next 16.4.3).
    expect(seen.activeTraceId).toBe(MW_TRACEPARENT.split('-')[1]);
    expect(seen.activeTraceId).not.toBe(TRACE_ID);
  });
});

const HANDLER_SPAN = 'AppRouteRouteHandlers.runHandler';
const REQUEST_SPAN = 'BaseServer.handleRequest';
const byType = (spans: ExportedSpan[], type: string): ExportedSpan[] =>
  spans.filter((s) => s.attrs['next.span_type'] === type);

/**
 * Wait until the whole request tree (handler + both request spans) for `traceId`
 * has been received AFTER `mark` (a snapshot of `exported.length` taken before the
 * request was sent), so spans exported by earlier requests can never satisfy it.
 */
async function exportedTree(traceId: string, mark: number): Promise<ExportedSpan[]> {
  const fresh = (): ExportedSpan[] => exported.slice(mark).filter((s) => s.traceId === traceId);
  await waitForSpans(
    () => byType(fresh(), HANDLER_SPAN).length >= 1 && byType(fresh(), REQUEST_SPAN).length >= 2,
    `tree for ${traceId}`,
  );
  return fresh();
}

describe('span tree + OTLP export, standalone server (#2657)', () => {
  it('exports the inbound request span tree under the incoming traceparent, correctly parented', async () => {
    const traceId = 'cccccccccccccccccccccccccccccc01';
    const incomingSpanId = 'c0c0c0c0c0c0c001';
    const mark = exported.length;
    await echo('/api/echo', `00-${traceId}-${incomingSpanId}-01`);
    const spans = await exportedTree(traceId, mark);

    // (b) the outermost in-process span is parented on the INCOMING span id.
    const outer = spans.find((s) => s.parentSpanId === incomingSpanId);
    expect(outer).toBeDefined();
    expect(outer?.attrs['next.span_type']).toBe(REQUEST_SPAN);

    // (a) parent/child shape: outer request span -> route request span -> handler span.
    const route = spans.find((s) => s.parentSpanId === outer?.spanId && s.name === 'GET /api/echo');
    expect(route).toBeDefined();
    const handler = byType(spans, HANDLER_SPAN)[0];
    expect(handler.parentSpanId).toBe(route?.spanId);
    expect(handler.name).toContain('/api/echo');

    // Every parent other than the incoming remote one is itself exported.
    const ids = new Set(spans.map((s) => s.spanId));
    expect(ids.size).toBe(spans.length);
    for (const s of spans) {
      if (s.parentSpanId !== incomingSpanId) expect(ids.has(s.parentSpanId ?? '')).toBe(true);
    }
  });

  it('actually exports over OTLP with the registered service name and the direct-passed processor attribute', async () => {
    const traceId = 'cccccccccccccccccccccccccccccc02';
    const mark = exported.length;
    await echo('/api/echo', `00-${traceId}-c0c0c0c0c0c0c002-01`);
    const spans = await exportedTree(traceId, mark);
    // (c) service identity from registerOTel, on every exported span...
    for (const s of spans) expect(s.serviceName).toBe('traceparent-fixture');
    // ...and the spanProcessors entry passed directly into registerOTel ran on all of them.
    for (const s of spans) expect(s.attrs['knext.fixture.processor']).toBe('ran');
    const handler = byType(spans, HANDLER_SPAN)[0];
    expect(String(handler.attrs['next.span_name'])).toContain('/api/echo');
  });

  it('a request with no traceparent exports a fresh, internally consistent tree (single root)', async () => {
    const mark = exported.length;
    const seen = await echo('/api/echo');
    const traceId = seen.activeTraceId as string;
    expect(traceId).toMatch(VALID_ID);
    const spans = await exportedTree(traceId, mark);
    const roots = spans.filter((s) => !s.parentSpanId);
    expect(roots.length).toBe(1);
    expect(roots[0].attrs['next.span_type']).toBe(REQUEST_SPAN);
  });

  it('a middleware-set traceparent re-roots the exported handler span under the middleware trace', async () => {
    // The middleware sets a FIXED traceparent, so the trace id cannot identify
    // this request: only spans received after `mark` are considered.
    const [, mwTrace, mwSpanId] = MW_TRACEPARENT.split('-');
    const incomingTrace = 'cccccccccccccccccccccccccccccc04';
    const mark = exported.length;
    await echo('/api/echo/mw-sets', `00-${incomingTrace}-c0c0c0c0c0c0c004-01`);
    const fresh = (traceId: string): ExportedSpan[] =>
      exported.slice(mark).filter((s) => s.traceId === traceId);
    // Wait for this request's own spans on BOTH traces before asserting absence:
    // the handler span under the middleware trace, and the outer request span
    // under the incoming trace (so the negative below cannot pass vacuously).
    await waitForSpans(
      () =>
        byType(fresh(mwTrace), HANDLER_SPAN).length >= 1 &&
        byType(fresh(incomingTrace), REQUEST_SPAN).length >= 1,
      'mw-sets spans on both traces',
    );
    const handler = byType(fresh(mwTrace), HANDLER_SPAN)[0];
    expect(handler.name).toContain('/api/echo/mw-sets');
    // parented on the middleware-supplied span id, never the incoming trace
    expect(fresh(mwTrace).some((s) => s.parentSpanId === mwSpanId)).toBe(true);
    expect(byType(fresh(incomingTrace), HANDLER_SPAN)).toEqual([]);
  });
});
