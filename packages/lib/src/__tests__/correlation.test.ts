import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Correlation-ID layer (#318). The runtime request path adopts an inbound
// `x-request-id` when it is well-formed, otherwise mints one; the id then flows
// through an AsyncLocalStorage-backed request context so every log line emitted
// during the request carries it (joinable to the OTel trace_id when a span is
// active), and it is echoed on the response + forwarded to downstream calls so a
// request can be traced app -> db-wake.

import {
  applyCorrelationHeader,
  beginRequest,
  CORRELATION_HEADER,
  correlationHeaders,
  correlationLogFields,
  createRequestContext,
  getCorrelationId,
  getRequestContext,
  getTraceId,
  isWellFormedCorrelationId,
  resetTraceIdProvider,
  resolveCorrelationId,
  runWithRequestContext,
  setTraceIdProvider,
} from '../context';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('@knext/lib correlation — id resolution', () => {
  afterEach(() => {
    resetTraceIdProvider();
  });

  it('uses the canonical header name x-request-id', () => {
    expect(CORRELATION_HEADER).toBe('x-request-id');
  });

  it('(a) adopts a well-formed inbound x-request-id', () => {
    expect(resolveCorrelationId('req-abc.123_XYZ')).toBe('req-abc.123_XYZ');
  });

  it('(b) generates a uuid when the header is absent', () => {
    const a = resolveCorrelationId(undefined);
    const b = resolveCorrelationId(null);
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b); // fresh id each time
  });

  it('(c) generates a new uuid when the header is malformed (untrusted input)', () => {
    // Injection-ish / oversized / empty / structurally invalid inputs are never
    // trusted; each yields a fresh, generated id.
    const bad = [
      '',
      '   ',
      'has spaces',
      'has\nnewline',
      'a'.repeat(4096),
      '<script>alert(1)</script>',
      'id;DROP TABLE',
    ];
    for (const raw of bad) {
      expect(isWellFormedCorrelationId(raw)).toBe(false);
      expect(resolveCorrelationId(raw)).toMatch(UUID_RE);
    }
  });

  it('takes the first value when a header arrives as an array', () => {
    expect(resolveCorrelationId(['first-id', 'second-id'])).toBe('first-id');
  });
});

describe('@knext/lib correlation — request context (AsyncLocalStorage)', () => {
  afterEach(() => {
    resetTraceIdProvider();
  });

  it('flows the id through the async context without threading params', async () => {
    const ctx = createRequestContext({ correlationId: 'req-flow' });
    const seen = await runWithRequestContext(ctx, async () => {
      await Promise.resolve();
      return getCorrelationId();
    });
    expect(seen).toBe('req-flow');
    // Outside any request there is no ambient context.
    expect(getCorrelationId()).toBeUndefined();
    expect(getRequestContext()).toBeUndefined();
  });

  it('beginRequest adopts the inbound header from a Headers-like object', () => {
    const headers = new Headers({ 'x-request-id': 'inbound-42' });
    const ctx = beginRequest(headers);
    expect(ctx.correlationId).toBe('inbound-42');
  });

  it('beginRequest generates an id when no inbound header is present', () => {
    const ctx = beginRequest(new Headers());
    expect(ctx.correlationId).toMatch(UUID_RE);
  });

  it('reads the inbound header case-insensitively from a plain object', () => {
    const ctx = beginRequest({ 'X-Request-ID': 'plain-obj-7' });
    expect(ctx.correlationId).toBe('plain-obj-7');
  });

  it('(f) ties the correlation id to the active trace id when a span is active', () => {
    const traceId = 'a'.repeat(32);
    setTraceIdProvider(() => traceId); // simulate an active OTel span
    const ctx = createRequestContext({ correlationId: 'req-trace' });
    expect(ctx.traceId).toBe(traceId);
    runWithRequestContext(ctx, () => {
      expect(getTraceId()).toBe(traceId);
      expect(correlationLogFields()).toEqual({
        correlation_id: 'req-trace',
        trace_id: traceId,
      });
    });
  });

  it('omits trace_id when no span/provider is active', () => {
    const ctx = createRequestContext({ correlationId: 'req-notrace' });
    expect(ctx.traceId).toBeUndefined();
    runWithRequestContext(ctx, () => {
      expect(correlationLogFields()).toEqual({ correlation_id: 'req-notrace' });
    });
  });

  it('returns no fields outside a request context', () => {
    expect(correlationLogFields()).toEqual({});
  });
});

describe('@knext/lib correlation — outbound propagation', () => {
  afterEach(() => {
    resetTraceIdProvider();
  });

  it('(e) echoes x-request-id onto a Web Headers response', () => {
    const ctx = createRequestContext({ correlationId: 'resp-web' });
    const responseHeaders = new Headers();
    runWithRequestContext(ctx, () => {
      applyCorrelationHeader(responseHeaders);
    });
    expect(responseHeaders.get('x-request-id')).toBe('resp-web');
  });

  it('(e) echoes x-request-id onto a Node ServerResponse-like object', () => {
    const ctx = createRequestContext({ correlationId: 'resp-node' });
    const setHeader = vi.fn();
    runWithRequestContext(ctx, () => {
      applyCorrelationHeader({ setHeader });
    });
    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'resp-node');
  });

  it('forwards the id on the downstream / db-wake call path via correlationHeaders()', () => {
    const ctx = createRequestContext({ correlationId: 'downstream-9' });
    const headers = runWithRequestContext(ctx, () => correlationHeaders());
    expect(headers).toEqual({ 'x-request-id': 'downstream-9' });
  });

  it('emits no header outside a request context (nothing to forward)', () => {
    expect(correlationHeaders()).toEqual({});
    const setHeader = vi.fn();
    applyCorrelationHeader({ setHeader });
    expect(setHeader).not.toHaveBeenCalled();
  });
});

describe('@knext/lib logger — correlation mixin (#318)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOG_LEVEL', undefined);
    vi.stubEnv('KN_APP_NAME', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('pino');
    vi.restoreAllMocks();
  });

  it('(d) every log line within a request carries correlation_id (+ trace_id when active)', async () => {
    const realPino = (await import('pino')).default;
    const lines: string[] = [];
    vi.doMock('pino', () => ({
      default: (options: Record<string, unknown>) =>
        realPino(options, { write: (s: string) => lines.push(s) }),
    }));

    const ctxMod = await import('../context');
    const { logger } = await import('../logger');

    ctxMod.setTraceIdProvider(() => 'b'.repeat(32));
    const ctx = ctxMod.createRequestContext({ correlationId: 'log-req-1' });
    ctxMod.runWithRequestContext(ctx, () => {
      logger.info('inside a request');
      logger.warn({ extra: true }, 'still inside');
    });

    const inside = lines.map((l) => JSON.parse(l));
    expect(inside).toHaveLength(2);
    for (const rec of inside) {
      expect(rec.correlation_id).toBe('log-req-1');
      expect(rec.trace_id).toBe('b'.repeat(32));
    }

    // Outside a request there is no correlation field to leak.
    ctxMod.resetTraceIdProvider();
    logger.info('outside a request');
    const outside = JSON.parse(lines.at(-1) as string);
    expect(outside.correlation_id).toBeUndefined();
    expect(outside.trace_id).toBeUndefined();
  });
});
