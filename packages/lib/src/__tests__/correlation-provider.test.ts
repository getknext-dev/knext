import { afterEach, describe, expect, it } from 'vitest';

/**
 * #346 — the correlation id must land on in-request log lines WITHOUT any
 * hand-call to `runWithRequestContext` on the real request path.
 *
 * On the real path knext-core does NOT own the Next.js route-handler chain, so
 * nothing wraps the handler in `runWithRequestContext`; the ambient
 * AsyncLocalStorage store is therefore empty. The OTel-aware `@knext/core`
 * instead installs a CORRELATION-ID provider (dependency-inversion seam, twin of
 * `setTraceIdProvider`) that resolves the id from the ACTIVE OTel context/span at
 * log time. `correlationLogFields()` must fall through to that provider (and the
 * trace-id provider) when there is no ALS store, so the logger mixin still stamps
 * `correlation_id` (+ `trace_id`) on every line emitted during a request.
 */

import {
  correlationLogFields,
  resetCorrelationIdProvider,
  resetTraceIdProvider,
  setCorrelationIdProvider,
  setTraceIdProvider,
} from '../context';

describe('@knext/lib correlation — correlation-id provider seam (#346)', () => {
  afterEach(() => {
    resetCorrelationIdProvider();
    resetTraceIdProvider();
  });

  it('falls through to the injected provider when there is NO ALS store (real path)', () => {
    // No runWithRequestContext — mirrors the real request path where knext-core
    // never wraps the handler. The provider reads from the active OTel context.
    setCorrelationIdProvider(() => 'otel-corr-1');
    setTraceIdProvider(() => 'c'.repeat(32));

    expect(correlationLogFields()).toEqual({
      correlation_id: 'otel-corr-1',
      trace_id: 'c'.repeat(32),
    });
  });

  it('emits correlation_id from the provider even when no trace id is active', () => {
    setCorrelationIdProvider(() => 'otel-corr-2');
    // trace provider left at default (no trace)
    expect(correlationLogFields()).toEqual({ correlation_id: 'otel-corr-2' });
  });

  it('emits nothing when tracing is disabled (both providers return undefined)', () => {
    // Default-OFF: no correlation work, zero fields, so non-request / disabled
    // logs are unchanged and no field ever leaks.
    expect(correlationLogFields()).toEqual({});
  });

  it('a misbehaving provider never breaks logging (fails open to no fields)', () => {
    setCorrelationIdProvider(() => {
      throw new Error('boom');
    });
    expect(() => correlationLogFields()).not.toThrow();
    expect(correlationLogFields()).toEqual({});
  });

  it('the explicit ALS store still wins over the provider (no double path)', async () => {
    const { createRequestContext, runWithRequestContext } = await import('../context');
    setCorrelationIdProvider(() => 'provider-should-not-win');
    const ctx = createRequestContext({ correlationId: 'als-wins' });
    runWithRequestContext(ctx, () => {
      expect(correlationLogFields()).toEqual({ correlation_id: 'als-wins' });
    });
  });
});
