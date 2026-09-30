import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { attempt } from '../scripts/upgrade-e2e/traffic-monitor.mjs';

/**
 * Unit tests for the operator upgrade-under-load e2e's traffic driver
 * (#1668/#1671, round 4) — specifically that it sends the Host header
 * Kourier's routing needs when driving traffic through the
 * kourier-internal port-forward (see traffic-monitor.mjs's docblock and
 * run.sh's resolve_app_host).
 *
 * `fetch()` was tried first and silently DROPS a caller-set `Host` header
 * (a Fetch-spec forbidden header) — confirmed live: every request reached
 * Envoy with `Host: 127.0.0.1:<port>`, which matches no route, so every
 * attempt 404'd (100% failure, no connection-level error). The fix moved to
 * `node:http`'s `http.request`, which sends a caller-supplied `Host` header
 * verbatim. These tests fake `http.request` itself (not `fetch`) so they
 * exercise the same seam the real driver uses, with the same
 * request/response event-emitter shape node:http provides — no network.
 */

/** A minimal fake IncomingMessage: an EventEmitter with resume() and a status. */
function fakeResponse(statusCode: number) {
  const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
  res.statusCode = statusCode;
  res.resume = () => {
    // Real IncomingMessage emits 'end' once the body is fully drained;
    // there is no body here, so emit it on the next tick.
    process.nextTick(() => res.emit('end'));
  };
  return res;
}

/** A minimal fake ClientRequest: an EventEmitter with end()/destroy(), capturing the options it was called with. */
function fakeRequest(capture: { options?: unknown }, respond: () => EventEmitter) {
  return ((options: unknown, callback: (res: EventEmitter) => void) => {
    capture.options = options;
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (err?: Error) => void;
    };
    req.end = () => {
      process.nextTick(() => callback(respond()));
    };
    req.destroy = (err?: Error) => {
      if (err) req.emit('error', err);
    };
    return req;
  }) as unknown as typeof import('node:http').request;
}

describe('attempt', () => {
  it('sends the Host header when one is provided', async () => {
    const capture: { options?: { headers?: Record<string, string> } } = {};
    const requestImpl = fakeRequest(capture, () => fakeResponse(200));
    const result = await attempt('http://127.0.0.1:18080/', 'app.ns.example.com', requestImpl);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(capture.options?.headers).toEqual({ Host: 'app.ns.example.com' });
  });

  it('sends no Host override when none is provided', async () => {
    const capture: { options?: { headers?: Record<string, string> } } = {};
    const requestImpl = fakeRequest(capture, () => fakeResponse(200));
    await attempt('http://127.0.0.1:18080/', undefined, requestImpl);
    expect(capture.options?.headers).toEqual({});
  });

  it('treats a non-2xx/3xx status as not ok, but still a real response', async () => {
    const requestImpl = fakeRequest({}, () => fakeResponse(503));
    const result = await attempt('http://127.0.0.1:18080/', 'app.ns.example.com', requestImpl);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it('treats a connection error as not ok, with the error message as status', async () => {
    const requestImpl = ((_options: unknown, _callback: (res: EventEmitter) => void) => {
      const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: (err?: Error) => void;
      };
      req.end = () => {
        process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
      };
      req.destroy = () => {};
      return req;
    }) as unknown as typeof import('node:http').request;
    const result = await attempt('http://127.0.0.1:18080/', 'app.ns.example.com', requestImpl);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('ECONNREFUSED');
  });
});
