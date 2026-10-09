import 'server-only';

import { type Client, createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';

import { PingService } from '../gen/zonefn/v1/ping_pb';

export type HttpVersion = '1.1' | '2';

// Function services are cluster-local Knative Services in the same namespace.
// "-h2" in the name means the ksvc port is named h2c; the zone then speaks
// HTTP/2 prior-knowledge (h2c) to it. Anything else is HTTP/1.1.
export function fnUrl(fn: string): string {
  const ns = process.env.FN_NAMESPACE || 'z2';
  return `http://${fn}.${ns}.svc.cluster.local`;
}

export function defaultHttpVersion(fn: string): HttpVersion {
  return fn.endsWith('-h2') ? '2' : '1.1';
}

// One client per (fn, version), anchored on globalThis so the bundler's module
// duplication cannot give each layer its own connection pool (ADR-0027).
const KEY = Symbol.for('knext.spike.z2.clients');
type Clients = Map<string, Client<typeof PingService>>;
function clients(): Clients {
  const g = globalThis as unknown as Record<symbol, Clients | undefined>;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY] as Clients;
}

export function pingClient(fn: string, httpVersion: HttpVersion): Client<typeof PingService> {
  const key = `${fn}|${httpVersion}`;
  const cache = clients();
  let c = cache.get(key);
  if (!c) {
    const transport = createConnectTransport({ baseUrl: fnUrl(fn), httpVersion });
    c = createClient(PingService, transport);
    cache.set(key, c);
  }
  return c;
}

export async function callFn(fn: string, httpVersion: HttpVersion) {
  const t0 = performance.now();
  const res = await pingClient(fn, httpVersion).ping({ msg: 'z2' }, { timeoutMs: 60_000 });
  const callMs = performance.now() - t0;
  return {
    callMs,
    fnLang: res.lang,
    fnUptimeMs: Number(res.uptimeMs),
    fnProto: res.proto,
  };
}
