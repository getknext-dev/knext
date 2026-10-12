/**
 * The generated-client policy: how each RPC of a zone function is called.
 *
 * - **Deadline.** Every call carries an explicit Connect deadline, and that
 *   deadline must be shorter than the zone's gateway timeout, so a slow
 *   function surfaces as `DEADLINE_EXCEEDED` inside the zone's request rather
 *   than the whole request being cut off by the gateway.
 * - **Retry only reads.** A unary RPC marked
 *   `option idempotency_level = NO_SIDE_EFFECTS` is a read and may be retried.
 *   Every other unary RPC is a write and is never retried: a retry across a
 *   cold-start timeout can apply a write twice. `IDEMPOTENT` is still a write.
 * - **Writes carry an idempotency key**, so a write the caller re-submits
 *   (a re-posted Server Action, say) can be de-duplicated by the function.
 * - **Streams are never retried.**
 *
 * The method kind is derived from the descriptor here AND re-derived by the
 * runtime from the service descriptor when the client is defined, so a
 * hand-edited generated file cannot turn retries on for a write.
 */

import type { DescMethod } from '@bufbuild/protobuf';
import { MethodOptions_IdempotencyLevel } from '@bufbuild/protobuf/wkt';

export type MethodKind = 'read' | 'mutation' | 'stream';

/** Attempts (first try included) for a read that fails as UNAVAILABLE. */
export const READ_MAX_ATTEMPTS = 3;

/**
 * Default per-call deadline. Budget, written down: a cold function measured
 * ~1.4 s to start on kind and more on a loaded cluster; 10 s leaves room for
 * that plus the call itself and still sits far inside the default gateway
 * timeout below.
 */
export const DEFAULT_DEADLINE_MS = 10_000;

/** The zone's default request timeout (a `NextApp` with no `timeoutSeconds`). */
export const DEFAULT_GATEWAY_TIMEOUT_SECONDS = 300;

/** Classify an RPC from its descriptor. */
export function methodKind(method: Pick<DescMethod, 'methodKind' | 'idempotency'>): MethodKind {
  if (method.methodKind !== 'unary') return 'stream';
  return method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS
    ? 'read'
    : 'mutation';
}

/**
 * Why a deadline/gateway-timeout pair is not acceptable, or `undefined` if it
 * is. The deadline must be a positive whole number of milliseconds and
 * strictly shorter than the gateway timeout.
 */
export function checkBudget(deadlineMs: number, gatewayTimeoutMs: number): string | undefined {
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
    return `the call deadline must be a positive whole number of milliseconds (got ${deadlineMs})`;
  }
  if (!Number.isInteger(gatewayTimeoutMs) || gatewayTimeoutMs <= 0) {
    return `the gateway timeout must be a positive whole number of milliseconds (got ${gatewayTimeoutMs})`;
  }
  if (deadlineMs >= gatewayTimeoutMs) {
    return (
      `the call deadline (${deadlineMs} ms) must be shorter than the gateway timeout ` +
      `(${gatewayTimeoutMs} ms), so a slow function fails the call, not the whole request`
    );
  }
  return undefined;
}
