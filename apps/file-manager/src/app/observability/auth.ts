import { timingSafeEqual } from 'node:crypto';

/**
 * Auth gate for the in-app /observability/* pages (obs-pages plan P1.1, ADR-0038).
 *
 * These pages surface operational metrics and MUST NOT be world-readable. Per
 * `.claude/rules/security.md` ("no unauthenticated ... endpoints", read-side
 * here) and the plan's fail-closed contract, the gate mirrors the timing-safe
 * Bearer pattern already used by the cache-invalidation route
 * (`api/cache/invalidate/auth.ts`):
 *
 * - **Fail-closed:** if no token is configured (`OBSERVABILITY_TOKEN` unset or
 *   empty) NOTHING is authorized — an unconfigured deployment denies every
 *   request rather than exposing metrics. Degrade closed, never open.
 * - **Constant-time** comparison (`timingSafeEqual`) so the token can't be
 *   recovered via response timing. Length is checked first (timingSafeEqual
 *   requires equal-length buffers); a length mismatch is an immediate reject and
 *   does not leak the secret.
 *
 * The token is provisioned via a K8s Secret → `OBSERVABILITY_TOKEN` env var;
 * never hardcoded, never sent to the browser (checked server-side only).
 */
export function isObservabilityAuthorized(
  authHeader: string | null | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) {
    return false; // fail closed: unconfigured = deny all
  }
  if (!authHeader) {
    return false;
  }
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) {
    return false;
  }
  const provided = Buffer.from(authHeader.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

/**
 * The configured observability token, or `undefined` when unset/empty. An empty
 * string collapses to `undefined` so callers get a single "unconfigured" signal
 * that `isObservabilityAuthorized` then treats as deny-all.
 */
export function observabilityToken(): string | undefined {
  const token = process.env.OBSERVABILITY_TOKEN;
  return token && token.length > 0 ? token : undefined;
}
