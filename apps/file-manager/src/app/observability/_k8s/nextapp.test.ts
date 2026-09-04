import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { advanceTimersByTimeAsync } from '../../../../../../tests/helpers/bun-test-helpers';

/**
 * P1.4 (obs-pages plan) / ADR-0038 — the OPT-IN `NextApp` status reader.
 *
 * The whole point of this module is that it is **off unless explicitly turned
 * on**, and that every way it can fail has its own honest, non-throwing outcome:
 *  - not opted in ⇒ `disabled`, with NO file read and NO network call,
 *  - opted in but not in a cluster ⇒ `not-in-cluster`,
 *  - CRD / object absent (404) ⇒ `crd-absent` — never "no deployments",
 *  - RBAC denied (401/403) ⇒ `forbidden` — never silently empty,
 *  - anything else ⇒ `unreachable` (short summary, never a raw error).
 */

const readFileSyncMock = mock<(path: string, enc?: unknown) => string>();
const httpsRequestMock =
  mock<(url: string, opts: HttpsOptions, cb: (res: FakeResponse) => void) => FakeRequest>();

const __knextReal1 = { ...(await import('node:fs')) };
mock.module('node:fs', () => {
  const actual = __knextReal1;
  const readFileSync = (p: string, enc?: unknown) => readFileSyncMock(p, enc);
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const __knextReal2 = { ...(await import('node:https')) };
mock.module('node:https', () => {
  const actual = __knextReal2;
  const request = (url: string, opts: HttpsOptions, cb: (res: FakeResponse) => void) =>
    httpsRequestMock(url, opts, cb);
  return { ...actual, request, default: { ...actual, request } };
});

interface HttpsOptions {
  method?: string;
  ca?: string[];
  headers?: Record<string, string>;
  timeout?: number;
}
type Handler = (arg?: unknown) => void;
interface FakeResponse {
  statusCode: number;
  on: (event: string, handler: Handler) => void;
}
interface FakeRequest {
  on: (event: string, handler: Handler) => FakeRequest;
  end: () => void;
  destroy: (err?: Error) => void;
}

/**
 * Make the fake API server answer with `status` + `body`.
 *
 * `configure` gets the fake request before it is returned, so a test can spy on
 * `destroy` — the socket-cleanup half of the total-duration bound.
 */
function respondWith(status: number, body: unknown, configure?: (req: EmittingRequest) => void) {
  httpsRequestMock.mockImplementation((_url, _opts, cb) => {
    queueMicrotask(() => {
      const handlers: Record<string, Handler[]> = {};
      const res: FakeResponse = {
        statusCode: status,
        on: (event, handler) => {
          const list = handlers[event] ?? [];
          handlers[event] = list;
          list.push(handler);
        },
      };
      cb(res);
      for (const h of handlers.data ?? []) h(Buffer.from(JSON.stringify(body)));
      for (const h of handlers.end ?? []) h();
    });
    const req = fakeRequest();
    configure?.(req);
    return req;
  });
}

/** Make the fake API server fail at the socket level. */
function failWith(error: Error) {
  httpsRequestMock.mockImplementation(() => {
    const req = fakeRequest();
    queueMicrotask(() => req.emit('error', error));
    return req;
  });
}

interface EmittingRequest extends FakeRequest {
  emit: (event: string, arg?: unknown) => void;
}

function fakeRequest(): EmittingRequest {
  const handlers: Record<string, Handler[]> = {};
  const req: EmittingRequest = {
    on: (event, handler) => {
      const list = handlers[event] ?? [];
      handlers[event] = list;
      list.push(handler);
      return req;
    },
    end: () => {},
    destroy: () => {},
    emit: (event, arg) => {
      for (const h of handlers[event] ?? []) h(arg);
    },
  };
  return req;
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN = 'sa-projected-token-value';
const NAMESPACE = 'demo-ns';
const CA_CERT = '-----BEGIN CERTIFICATE-----\nclusterca\n-----END CERTIFICATE-----';

const ORIGINAL_SOURCE = process.env.OBSERVABILITY_NEXTAPP_SOURCE;
const ORIGINAL_HOST = process.env.KUBERNETES_SERVICE_HOST;
const ORIGINAL_PORT = process.env.KUBERNETES_SERVICE_PORT;

function seedServiceAccount() {
  readFileSyncMock.mockImplementation((path: string) => {
    if (path === `${SA_DIR}/token`) return TOKEN;
    if (path === `${SA_DIR}/namespace`) return NAMESPACE;
    if (path === `${SA_DIR}/ca.crt`) return CA_CERT;
    throw new Error(`ENOENT: ${path}`);
  });
}

const NEXTAPP_BODY = {
  apiVersion: 'apps.kn-next.dev/v1alpha1',
  kind: 'NextApp',
  metadata: { name: 'demo', namespace: NAMESPACE },
  spec: {
    image: 'registry.example.com/demo@sha256:abc',
    traffic: { revisionName: 'demo-00002', canaryPercent: 10 },
  },
  status: {
    observedRevision: 'demo-00003',
    lastSuccessfulDeployTime: '2026-07-25T10:00:00Z',
    scaledToZero: true,
    currentTraffic: [
      { revisionName: 'demo-00002', percent: 90, latestRevision: false },
      { revisionName: 'demo-00003', percent: 10, latestRevision: true },
    ],
    conditions: [
      {
        type: 'Ready',
        status: 'True',
        reason: 'ServiceReady',
        message: 'Knative Service is ready',
        lastTransitionTime: '2026-07-25T10:00:05Z',
      },
    ],
  },
};

beforeEach(() => {
  // No `resetModules()`: `nextapp.ts` holds no module-level mutable state —
  // everything this file varies goes through the mocks reset below and the env
  // vars set after. bun has no equivalent anyway, and re-evaluating a stateless
  // module was never doing anything here.
  readFileSyncMock.mockReset();
  httpsRequestMock.mockReset();
  process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';
  process.env.KUBERNETES_SERVICE_PORT = '443';
  delete process.env.OBSERVABILITY_NEXTAPP_SOURCE;
});

afterEach(() => {
  // Tests that pin the deadline timer opt into fake timers; nobody else sees them.
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (ORIGINAL_SOURCE === undefined) delete process.env.OBSERVABILITY_NEXTAPP_SOURCE;
  else process.env.OBSERVABILITY_NEXTAPP_SOURCE = ORIGINAL_SOURCE;
  if (ORIGINAL_HOST === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
  else process.env.KUBERNETES_SERVICE_HOST = ORIGINAL_HOST;
  if (ORIGINAL_PORT === undefined) delete process.env.KUBERNETES_SERVICE_PORT;
  else process.env.KUBERNETES_SERVICE_PORT = ORIGINAL_PORT;
});

async function load() {
  return import('./nextapp');
}

describe('NextApp reader — opt-in by default (smallest trust surface)', () => {
  it('is disabled when the source env var is unset: no fs read, no network call', async () => {
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(result.status).toBe('disabled');
    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('stays disabled for any value other than the explicit opt-in', async () => {
    process.env.OBSERVABILITY_NEXTAPP_SOURCE = 'yes-please';
    const { readNextAppStatus } = await load();

    expect((await readNextAppStatus('demo')).status).toBe('disabled');
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});

describe('NextApp reader — enabled path', () => {
  beforeEach(() => {
    process.env.OBSERVABILITY_NEXTAPP_SOURCE = 'kubernetes';
  });

  it('reads the CR from the namespaced NextApp endpoint with the ServiceAccount token', async () => {
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(result.status).toBe('ok');
    const [url, opts] = httpsRequestMock.mock.calls[0];
    expect(url).toContain('/apis/apps.kn-next.dev/v1alpha1/');
    expect(url).toContain(`/namespaces/${NAMESPACE}/nextapps/demo`);
    expect(url.startsWith('https://')).toBe(true);
    expect(opts.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    // GET only: these pages never mutate cluster state (ADR-0001).
    expect(opts.method).toBe('GET');
    // Bounded: a hung API server degrades the page instead of hanging it.
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('scopes the cluster CA to THIS request and never disables verification', async () => {
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    await readNextAppStatus('demo');

    const [, opts] = httpsRequestMock.mock.calls[0];
    // Per-request CA (node:https `ca`) — NOT a process-global trust widening.
    expect(opts.ca).toEqual([CA_CERT]);
    expect(readFileSyncMock).toHaveBeenCalledWith(`${SA_DIR}/ca.crt`, 'utf8');
    // TLS verification is never turned off.
    expect('rejectUnauthorized' in opts).toBe(false);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe('0');
  });

  it('projects the deploy-relevant status/spec fields', async () => {
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);

    expect(result.data.observedRevision).toBe('demo-00003');
    expect(result.data.lastSuccessfulDeployTime).toBe('2026-07-25T10:00:00Z');
    expect(result.data.scaledToZero).toBe(true);
    expect(result.data.pinnedRevision).toBe('demo-00002');
    expect(result.data.canaryPercent).toBe(10);
    expect(result.data.image).toBe('registry.example.com/demo@sha256:abc');
    expect(result.data.currentTraffic).toEqual([
      { revisionName: 'demo-00002', percent: 90, latestRevision: false },
      { revisionName: 'demo-00003', percent: 10, latestRevision: true },
    ]);
    expect(result.data.conditions[0]).toMatchObject({ type: 'Ready', status: 'True' });
  });

  it('reports not-in-cluster when the ServiceAccount token is absent (no network call)', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(result).toMatchObject({ status: 'source-unavailable', reason: 'not-in-cluster' });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('reports not-in-cluster when KUBERNETES_SERVICE_HOST is unset', async () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    seedServiceAccount();
    const { readNextAppStatus } = await load();

    expect(await readNextAppStatus('demo')).toMatchObject({
      status: 'source-unavailable',
      reason: 'not-in-cluster',
    });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('maps 404 to crd-absent (the CRD is not installed / the object is gone)', async () => {
    seedServiceAccount();
    respondWith(404, { kind: 'Status', code: 404 });
    const { readNextAppStatus } = await load();

    expect(await readNextAppStatus('demo')).toMatchObject({
      status: 'source-unavailable',
      reason: 'crd-absent',
    });
  });

  it('maps 403 and 401 to forbidden (RBAC not granted)', async () => {
    seedServiceAccount();
    const { readNextAppStatus } = await load();

    for (const code of [401, 403]) {
      respondWith(code, { kind: 'Status', code });
      expect(await readNextAppStatus('demo')).toMatchObject({
        status: 'source-unavailable',
        reason: 'forbidden',
      });
    }
  });

  it('maps a network failure to unreachable and never throws or leaks the error', async () => {
    seedServiceAccount();
    failWith(new Error('connect ECONNREFUSED 10.96.0.1:443'));
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(result).toMatchObject({ status: 'source-unavailable', reason: 'unreachable' });
    if (result.status !== 'source-unavailable') throw new Error('unreachable');
    expect(result.detail).not.toContain('10.96.0.1');
  });

  it('maps a 500 to unreachable (distinct from crd-absent and forbidden)', async () => {
    seedServiceAccount();
    respondWith(500, { kind: 'Status', code: 500 });
    const { readNextAppStatus } = await load();

    expect(await readNextAppStatus('demo')).toMatchObject({
      status: 'source-unavailable',
      reason: 'unreachable',
    });
  });

  it('never puts the ServiceAccount token in the returned value', async () => {
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(CA_CERT);
  });

  it('reports an unreadable API response distinctly instead of throwing', async () => {
    seedServiceAccount();
    httpsRequestMock.mockImplementation((_url, _opts, cb) => {
      queueMicrotask(() => {
        const handlers: Record<string, Handler[]> = {};
        cb({
          statusCode: 200,
          on: (event, handler) => {
            const list = handlers[event] ?? [];
            handlers[event] = list;
            list.push(handler);
          },
        });
        for (const h of handlers.data ?? []) h(Buffer.from('{not json'));
        for (const h of handlers.end ?? []) h();
      });
      return fakeRequest();
    });
    const { readNextAppStatus } = await load();

    expect(await readNextAppStatus('demo')).toMatchObject({
      status: 'source-unavailable',
      reason: 'unreachable',
    });
  });
});

/**
 * PR-520 review finding 5. Both halves are defence-in-depth, not a live hole:
 * the caller already validates the name and a malformed URL fails closed. But
 * "fails closed with the wrong reason" is still a wrong answer on a page whose
 * contract is never to show a misleading state, and an IPv6 cluster is a real
 * deployment shape.
 */
describe('NextApp reader — API-server URL portability + defensive name check', () => {
  beforeEach(() => {
    process.env.OBSERVABILITY_NEXTAPP_SOURCE = 'kubernetes';
  });

  it('brackets an IPv6 API-server host so the URL is parseable', async () => {
    process.env.KUBERNETES_SERVICE_HOST = 'fd00::1';
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(result.status).toBe('ok');
    const url = httpsRequestMock.mock.calls[0]?.[0] ?? '';
    expect(url).toContain('https://[fd00::1]:443/');
    // The bracketed form must be a URL Node can actually parse.
    expect(() => new URL(url)).not.toThrow();
    // WHATWG keeps the brackets on an IPv6 hostname; the point is that it parses
    // at all and the path survives intact.
    expect(new URL(url).hostname).toBe('[fd00::1]');
    expect(new URL(url).pathname).toContain('/nextapps/demo');
  });

  it('does not double-bracket an already-bracketed host', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '[fd00::1]';
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    expect((await readNextAppStatus('demo')).status).toBe('ok');
    expect(httpsRequestMock.mock.calls[0]?.[0]).toContain('https://[fd00::1]:443/');
  });

  it('leaves an IPv4 host / DNS name unbracketed', async () => {
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    await readNextAppStatus('demo');
    expect(httpsRequestMock.mock.calls[0]?.[0]).toContain('https://10.96.0.1:443/');
  });

  it('rejects a non-numeric port as unreachable WITHOUT issuing a request', async () => {
    process.env.KUBERNETES_SERVICE_PORT = 'tcp://10.96.0.1:443';
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    expect(await readNextAppStatus('demo')).toMatchObject({
      status: 'source-unavailable',
      reason: 'unreachable',
    });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('rejects a name that is not a DNS-1123 subdomain, without any request', async () => {
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    for (const bad of [
      '../../secrets/admin',
      'demo/nextapps/other',
      'Demo',
      'demo name',
      '-demo',
      '',
      'a'.repeat(254),
    ]) {
      const result = await readNextAppStatus(bad);
      expect(result).toMatchObject({ status: 'source-unavailable', reason: 'invalid-name' });
    }
    // Not one request escaped with an unvalidated name in the path.
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('still accepts the names a NextApp can actually have', async () => {
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    for (const good of ['demo', 'demo-api', 'a', 'demo.example', 'demo-0']) {
      expect((await readNextAppStatus(good)).status).toBe('ok');
    }
  });

  it('leaks neither the name nor the API-server host in the invalid-name detail', async () => {
    seedServiceAccount();
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('../../etc/passwd');

    expect(JSON.stringify(result)).not.toContain('etc/passwd');
    expect(JSON.stringify(result)).not.toContain('10.96.0.1');
  });
});

/**
 * The page's shared budget must be a TOTAL-duration bound on this read too, not
 * merely a socket-inactivity one (PR-520 review finding 2), and an already-spent
 * budget must refuse to start rather than fail open (finding 3).
 */
describe('NextApp reader — the page budget is a real bound, and a spent one starts nothing', () => {
  beforeEach(() => {
    process.env.OBSERVABILITY_NEXTAPP_SOURCE = 'kubernetes';
  });

  /**
   * Three properties in one test, because they are one behaviour (PR-520 review
   * round 3):
   *  1. the total-duration bound fires at all (a trickling server is cut off);
   *  2. it fires at the CALLER's budget — asserted by advancing a fake clock to
   *     1 ms short of it and finding nothing settled. The previous form
   *     (`elapsed < 2000` against a 60 ms budget) would have passed with a
   *     hard-coded 1000 ms timer, so it pinned the bound to nothing;
   *  3. the socket is destroyed BEFORE the promise settles. A rejected promise
   *     with a live socket is precisely the leak this bound exists to prevent, so
   *     the ordering is part of the assertion, not an implementation detail.
   */
  it('cuts off a TRICKLING API server at exactly the caller budget, destroying the socket before it settles', async () => {
    jest.useFakeTimers();
    seedServiceAccount();
    // A server that keeps sending data and never ends. `node:https`' `timeout`
    // option is reset by every received chunk, so the inactivity timer alone would
    // hold this connection open forever — only a total-duration bound ends it.
    let trickle: ReturnType<typeof setInterval> | undefined;
    const order: string[] = [];
    const destroy = mock((_err?: Error) => {
      order.push('destroy');
      // A real socket stops producing data once destroyed.
      clearInterval(trickle);
    });
    httpsRequestMock.mockImplementation((_url, _opts, cb) => {
      const req = fakeRequest();
      req.destroy = destroy;
      queueMicrotask(() => {
        const handlers: Record<string, Handler[]> = {};
        cb({
          statusCode: 200,
          on: (event, handler) => {
            const list = handlers[event] ?? [];
            handlers[event] = list;
            list.push(handler);
          },
        });
        trickle = setInterval(() => {
          for (const h of handlers.data ?? []) h(Buffer.from('{'));
        }, 5);
      });
      return req;
    });
    const { readNextAppStatus } = await load();

    const pending = readNextAppStatus('demo', { timeoutMs: 60 }).then((value) => {
      order.push('settled');
      return value;
    });

    // 1 ms short of the caller's budget: the request is in flight and trickling,
    // and NOTHING has happened yet. Any bound not derived from `timeoutMs` fails
    // here (too early) or at the next step (never fires).
    await advanceTimersByTimeAsync(59);
    expect(order).toEqual([]);

    await advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({
      status: 'source-unavailable',
      reason: 'unreachable',
      detail: 'the Kubernetes API server could not be reached',
    });
    // Destroyed, and destroyed FIRST — no live socket outlives the rejection.
    expect(destroy).toHaveBeenCalled();
    expect(destroy.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(order).toEqual(['destroy', 'settled']);
    clearInterval(trickle);
  });

  it('leaves no armed deadline timer behind after a SUCCESSFUL read', async () => {
    jest.useFakeTimers();
    seedServiceAccount();
    const destroy = mock();
    respondWith(200, NEXTAPP_BODY, (req) => {
      req.destroy = destroy;
    });
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo', { timeoutMs: 1500 });

    expect(result.status).toBe('ok');
    // The total-duration timer is armed unconditionally, so a success path that
    // does not clear it leaks a ref'd timer per read…
    expect(jest.getTimerCount()).toBe(0);
    // …which would later destroy an already-completed request.
    await advanceTimersByTimeAsync(5000);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('refuses an oversized response body instead of buffering it without bound', async () => {
    seedServiceAccount();
    const { readNextAppStatus, MAX_RESPONSE_BYTES } = await load();
    const destroy = mock();
    // Two chunks that together exceed the cap: the read must fail closed while the
    // body is still streaming, without ever waiting for `end`.
    const half = Buffer.alloc(Math.ceil(MAX_RESPONSE_BYTES / 2) + 1, 0x20);
    httpsRequestMock.mockImplementation((_url, _opts, cb) => {
      const req = fakeRequest();
      req.destroy = destroy;
      queueMicrotask(() => {
        const handlers: Record<string, Handler[]> = {};
        cb({
          statusCode: 200,
          on: (event, handler) => {
            const list = handlers[event] ?? [];
            handlers[event] = list;
            list.push(handler);
          },
        });
        for (const h of handlers.data ?? []) h(half);
        for (const h of handlers.data ?? []) h(half);
        // Deliberately NO `end`: a real oversized/hostile body need never finish.
      });
      return req;
    });

    const result = await readNextAppStatus('demo', { timeoutMs: 60 });

    // Reuses the existing unreadable-response outcome — the page renders no new
    // state for this, and the detail names neither a size nor the host.
    expect(result).toEqual({
      status: 'source-unavailable',
      reason: 'unreachable',
      detail: 'the Kubernetes API returned an unreadable response',
    });
    expect(destroy).toHaveBeenCalled();
    expect(destroy.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('refuses to start a read once the shared budget is spent (never timeout: 0)', async () => {
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo', { timeoutMs: 0 });

    // `timeout: 0` on https.request means NO timeout — the exact inverse of a
    // spent budget. So no request may be issued at all…
    expect(httpsRequestMock).not.toHaveBeenCalled();
    // …and the outcome says the page ran out of time, never that the API server is
    // unreachable (a cause this read never established).
    expect(result).toEqual({
      status: 'source-unavailable',
      reason: 'deadline-exceeded',
      detail: 'the page ran out of its shared time budget before this read could start',
    });
  });

  it('still uses the caller budget as the request timeout when budget is left', async () => {
    seedServiceAccount();
    respondWith(200, NEXTAPP_BODY);
    const { readNextAppStatus } = await load();

    await readNextAppStatus('demo', { timeoutMs: 1234 });

    expect(httpsRequestMock.mock.calls[0]?.[1].timeout).toBe(1234);
  });
});
