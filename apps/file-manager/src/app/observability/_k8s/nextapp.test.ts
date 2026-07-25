import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const readFileSyncMock = vi.fn<(path: string, enc?: unknown) => string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = (p: string, enc?: unknown) => readFileSyncMock(p, enc);
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN = 'sa-projected-token-value';
const NAMESPACE = 'demo-ns';

const ORIGINAL_SOURCE = process.env.OBSERVABILITY_NEXTAPP_SOURCE;
const ORIGINAL_HOST = process.env.KUBERNETES_SERVICE_HOST;
const ORIGINAL_PORT = process.env.KUBERNETES_SERVICE_PORT;

function seedServiceAccount() {
  readFileSyncMock.mockImplementation((path: string) => {
    if (path === `${SA_DIR}/token`) return TOKEN;
    if (path === `${SA_DIR}/namespace`) return NAMESPACE;
    throw new Error(`ENOENT: ${path}`);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
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
  vi.resetModules();
  readFileSyncMock.mockReset();
  process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';
  process.env.KUBERNETES_SERVICE_PORT = '443';
  delete process.env.OBSERVABILITY_NEXTAPP_SOURCE;
});

afterEach(() => {
  vi.restoreAllMocks();
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(result.status).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('stays disabled for any value other than the explicit opt-in', async () => {
    process.env.OBSERVABILITY_NEXTAPP_SOURCE = 'yes-please';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { readNextAppStatus } = await load();

    expect((await readNextAppStatus('demo')).status).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('NextApp reader — enabled path', () => {
  beforeEach(() => {
    process.env.OBSERVABILITY_NEXTAPP_SOURCE = 'kubernetes';
  });

  it('reads the CR from the namespaced NextApp endpoint with the ServiceAccount token', async () => {
    seedServiceAccount();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(NEXTAPP_BODY) as never);
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(result.status).toBe('ok');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/apis/apps.kn-next.dev/v1alpha1/');
    expect(url).toContain(`/namespaces/${NAMESPACE}/nextapps/demo`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    // Never cached — status must reflect the live cluster.
    expect(init.cache).toBe('no-store');
    // GET only: these pages never mutate cluster state (ADR-0001).
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('projects the deploy-relevant status/spec fields', async () => {
    seedServiceAccount();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(NEXTAPP_BODY) as never);
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(result).toMatchObject({ status: 'source-unavailable', reason: 'not-in-cluster' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports not-in-cluster when KUBERNETES_SERVICE_HOST is unset', async () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    seedServiceAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { readNextAppStatus } = await load();

    expect(await readNextAppStatus('demo')).toMatchObject({
      status: 'source-unavailable',
      reason: 'not-in-cluster',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps 404 to crd-absent (the CRD is not installed / the object is gone)', async () => {
    seedServiceAccount();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ kind: 'Status', code: 404 }, 404) as never,
    );
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
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ kind: 'Status', code }, code) as never,
      );
      expect(await readNextAppStatus('demo')).toMatchObject({
        status: 'source-unavailable',
        reason: 'forbidden',
      });
    }
  });

  it('maps a network failure to unreachable and never throws or leaks the error', async () => {
    seedServiceAccount();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connect ECONNREFUSED 10.96.0.1:443'),
    );
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(result).toMatchObject({ status: 'source-unavailable', reason: 'unreachable' });
    if (result.status !== 'source-unavailable') throw new Error('unreachable');
    expect(result.detail).not.toContain('10.96.0.1');
  });

  it('maps a 500 to unreachable (distinct from crd-absent and forbidden)', async () => {
    seedServiceAccount();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ kind: 'Status', code: 500 }, 500) as never,
    );
    const { readNextAppStatus } = await load();

    expect(await readNextAppStatus('demo')).toMatchObject({
      status: 'source-unavailable',
      reason: 'unreachable',
    });
  });

  it('never puts the ServiceAccount token in the returned value', async () => {
    seedServiceAccount();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(NEXTAPP_BODY) as never);
    const { readNextAppStatus } = await load();

    const result = await readNextAppStatus('demo');

    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
