/**
 * context/index.ts — request correlation layer for @knext/lib (#318).
 *
 * A knext request must be traceable end-to-end: app -> db-wake -> downstream.
 * This module gives the runtime request path a single, ambient correlation id
 * that flows through `AsyncLocalStorage` (no param threading) and lands on every
 * structured log line (see the pino `mixin` wired in `../logger`), on the
 * response (`x-request-id`), and on outbound/downstream calls.
 *
 * Contract:
 *   - Inbound: adopt an `x-request-id` header when it is WELL-FORMED; otherwise
 *     mint a fresh uuid. Arbitrary client input is never trusted verbatim
 *     (bounded length + safe token charset) — it is a log/propagation field, so
 *     an unbounded or structured value is a log-injection / cardinality hazard.
 *   - Trace tie-in: when an OTel span is active the correlation id is joined to
 *     the span's `trace_id`. To keep this module dependency-free (mirroring
 *     `packages/kn-next/src/adapters/otel-config.ts`, which is intentionally
 *     OTel-SDK-free so it unit-tests without the SDK), the active trace id is
 *     read through an INJECTABLE provider. The app wires it once, e.g.:
 *       import { trace } from '@opentelemetry/api';
 *       setTraceIdProvider(() => trace.getActiveSpan()?.spanContext().traceId);
 *
 * This module has no runtime dependencies beyond Node core.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Canonical correlation header. Lowercase — matches Node/undici header keys. */
export const CORRELATION_HEADER = 'x-request-id';

/**
 * Maximum accepted length of an inbound correlation id. Long enough for a uuid,
 * a ULID, a W3C trace id, or a short app prefix; short enough that a hostile
 * client can't bloat every downstream log line.
 */
const MAX_ID_LENGTH = 128;

/**
 * Safe token charset: alphanumerics plus `-`, `_`, `.` (uuid/ULID/trace-id and
 * common prefixed ids all satisfy this). No whitespace, control chars, quotes,
 * or markup — so the value is safe to embed in a JSON log line and in an HTTP
 * header without smuggling a second header or breaking a log parser.
 */
const ID_PATTERN = new RegExp(`^[A-Za-z0-9._-]{1,${MAX_ID_LENGTH}}$`);

/** Per-request state carried through the async context. */
export interface RequestContext {
  /** The correlation id — adopted from the inbound header or generated. */
  correlationId: string;
  /** The active OTel trace id, when a span is active (join key to traces). */
  traceId?: string;
}

const store = new AsyncLocalStorage<RequestContext>();

/** A minimal, framework-agnostic view of inbound request headers. */
export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null }
  | undefined
  | null;

/** True when `value` is a well-formed, trustworthy correlation id. */
export function isWellFormedCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/**
 * Resolve a correlation id from a raw header value: adopt it when well-formed,
 * otherwise generate a fresh uuid. A never-throwing, always-returns-an-id call.
 */
export function resolveCorrelationId(raw?: string | string[] | null): string {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (isWellFormedCorrelationId(candidate)) {
    return candidate;
  }
  return randomUUID();
}

/** Read a header by name from any supported header source (case-insensitive). */
export function readHeader(source: HeaderSource, name: string): string | undefined {
  if (!source) {
    return undefined;
  }
  // Web `Headers` / anything with a `.get()` (case-insensitive by spec).
  if (typeof (source as { get?: unknown }).get === 'function') {
    const value = (source as { get(n: string): string | null }).get(name);
    return value ?? undefined;
  }
  // Plain object / Node `IncomingHttpHeaders`: match keys case-insensitively.
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(
    source as Record<string, string | string[] | undefined>,
  )) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : (value ?? undefined);
    }
  }
  return undefined;
}

// ── Trace-id provider (dependency-inversion seam) ─────────────────────────────

const NO_TRACE: () => string | undefined = () => undefined;
let traceIdProvider: () => string | undefined = NO_TRACE;

/**
 * Install the active-trace-id provider. Called once at startup by an OTel-aware
 * app so the correlation layer can tie each id to the current trace_id without
 * this package taking an OTel dependency.
 */
export function setTraceIdProvider(fn: () => string | undefined): void {
  traceIdProvider = fn;
}

/** Reset the trace-id provider to the default (no trace). Mainly for tests. */
export function resetTraceIdProvider(): void {
  traceIdProvider = NO_TRACE;
}

function currentTraceId(): string | undefined {
  try {
    return traceIdProvider() || undefined;
  } catch {
    // A misbehaving provider must never break request handling or logging.
    return undefined;
  }
}

// ── Correlation-id provider (dependency-inversion seam, #346) ──────────────────

/**
 * On the real request path knext-core does NOT own the Next.js route-handler
 * chain (the node-server adapter is a supervisor that only runs the metrics
 * server; the app's handlers run in the standalone child). So nothing wraps the
 * handler in `runWithRequestContext`, and the AsyncLocalStorage store above is
 * empty during a real request.
 *
 * The OTel-aware `@knext/core` closes that gap by installing a correlation-id
 * PROVIDER (twin of the trace-id provider): it resolves the request's
 * correlation id from the ACTIVE OTel context/span at log time — the same
 * per-request context @vercel/otel already propagates via an
 * AsyncLocalStorageContextManager. When the ALS store is empty,
 * `correlationLogFields()` falls through to this provider so a log line emitted
 * during a request still carries `correlation_id` (+ `trace_id`) with no
 * hand-call to `runWithRequestContext`.
 *
 * This package stays OTel-free: the provider is injected, mirroring
 * `setTraceIdProvider`. Default is no-correlation (undefined), so with tracing
 * disabled there is zero correlation work and no field ever leaks.
 */
const NO_CORRELATION: () => string | undefined = () => undefined;
let correlationIdProvider: () => string | undefined = NO_CORRELATION;

/**
 * Install the active-correlation-id provider. Called once at startup by an
 * OTel-aware app so the correlation layer can resolve the request's id from the
 * active OTel context without this package taking an OTel dependency.
 */
export function setCorrelationIdProvider(fn: () => string | undefined): void {
  correlationIdProvider = fn;
}

/** Reset the correlation-id provider to the default (none). Mainly for tests. */
export function resetCorrelationIdProvider(): void {
  correlationIdProvider = NO_CORRELATION;
}

function providedCorrelationId(): string | undefined {
  try {
    return correlationIdProvider() || undefined;
  } catch {
    // A misbehaving provider must never break request handling or logging.
    return undefined;
  }
}

// ── Request context lifecycle ─────────────────────────────────────────────────

/**
 * Build a `RequestContext`. Provide either an explicit `correlationId` or the
 * inbound `headers` (from which the id is resolved). `traceId` defaults to the
 * active span's trace id via the installed provider.
 */
export function createRequestContext(opts: {
  correlationId?: string;
  headers?: HeaderSource;
  traceId?: string;
}): RequestContext {
  const correlationId =
    opts.correlationId ?? resolveCorrelationId(readHeader(opts.headers, CORRELATION_HEADER));
  const traceId = opts.traceId ?? currentTraceId();
  return traceId ? { correlationId, traceId } : { correlationId };
}

/**
 * Convenience for the request path: build a context from inbound headers,
 * adopting `x-request-id` when present + well-formed, else generating one.
 */
export function beginRequest(headers?: HeaderSource, opts?: { traceId?: string }): RequestContext {
  return createRequestContext({ headers, traceId: opts?.traceId });
}

/** Run `fn` with `ctx` as the ambient request context. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** The ambient request context, or `undefined` when outside a request. */
export function getRequestContext(): RequestContext | undefined {
  return store.getStore();
}

/** The ambient correlation id, or `undefined` when outside a request. */
export function getCorrelationId(): string | undefined {
  return store.getStore()?.correlationId;
}

/** The ambient trace id, or `undefined` when no span/context is active. */
export function getTraceId(): string | undefined {
  return store.getStore()?.traceId;
}

// ── Log + outbound propagation ────────────────────────────────────────────────

/**
 * Structured-log fields for the current request context. Empty outside a
 * request (nothing to add). Consumed by the `@knext/lib` logger `mixin`, so
 * every in-request line carries `correlation_id` (+ `trace_id` when active).
 */
export function correlationLogFields(): {
  correlation_id?: string;
  trace_id?: string;
} {
  const ctx = store.getStore();
  if (ctx) {
    // Explicit ALS context (someone called runWithRequestContext) always wins —
    // one path, no double-stamping.
    return ctx.traceId
      ? { correlation_id: ctx.correlationId, trace_id: ctx.traceId }
      : { correlation_id: ctx.correlationId };
  }
  // #346: no ALS store — the real request path. Fall through to the injected
  // providers, which read the id + trace id from the ACTIVE OTel context/span.
  // With tracing disabled both return undefined ⇒ {} (zero overhead, no leak).
  const correlationId = providedCorrelationId();
  if (!correlationId) {
    return {};
  }
  const traceId = currentTraceId();
  return traceId
    ? { correlation_id: correlationId, trace_id: traceId }
    : { correlation_id: correlationId };
}

/**
 * Header map to forward on outbound / downstream (incl. db-wake) calls so a
 * request stays correlated across hops. Empty outside a request context.
 */
export function correlationHeaders(
  ctx: RequestContext | undefined = store.getStore(),
): Record<string, string> {
  return ctx?.correlationId ? { [CORRELATION_HEADER]: ctx.correlationId } : {};
}

/** A response object we can stamp the correlation header onto. */
type HeaderSettable =
  | { set(name: string, value: string): void } // Web `Headers`
  | { setHeader(name: string, value: string): void }; // Node `ServerResponse`

/**
 * Echo `x-request-id` onto a response (Web `Headers` or Node `ServerResponse`).
 * No-op outside a request context. Idempotent.
 */
export function applyCorrelationHeader(
  target: HeaderSettable,
  ctx: RequestContext | undefined = store.getStore(),
): void {
  const id = ctx?.correlationId;
  if (!id) {
    return;
  }
  if (typeof (target as { set?: unknown }).set === 'function') {
    (target as { set(n: string, v: string): void }).set(CORRELATION_HEADER, id);
  } else if (typeof (target as { setHeader?: unknown }).setHeader === 'function') {
    (target as { setHeader(n: string, v: string): void }).setHeader(CORRELATION_HEADER, id);
  }
}
