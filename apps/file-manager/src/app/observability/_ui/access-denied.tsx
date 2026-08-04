import { unauthorized } from 'next/navigation';

/**
 * The ONE denial surface for every `/observability/*` page (#525, ADR-0038).
 *
 * **Why 401 and not 404.** The pages previously rendered the text
 * "401 — Unauthorized" inside a response whose status was 200: anything reading
 * the status — a monitor, a CI probe, a reverse proxy — saw success on a request
 * that was in fact denied. For a page set whose whole contract is "never show a
 * misleading state", the denial path is the last place that may lie. So the
 * response now carries a real 401, raised through Next's `unauthorized()`
 * access-fallback (`experimental.authInterrupts`, enabled in `next.config.ts`).
 *
 * 404 was the alternative — it would additionally hide the route's existence.
 * It is rejected here because these routes are not secret: they are documented,
 * open-source, fixed paths, so a 404 buys no real concealment while actively
 * misleading the operator whose only mistake was an unset `OBSERVABILITY_TOKEN`
 * (a "no such page" for a page that exists is the same class of lie this issue
 * removes). 401 is also the semantically correct answer to "you may retry with
 * credentials", which is exactly this gate's contract.
 *
 * The body stays deliberately contentless: no token value, no env-var name, no
 * Prometheus/Kubernetes detail, nothing that distinguishes "wrong token" from
 * "token not configured". Fail-closed is unchanged — the gate in `auth.ts` still
 * denies everything when `OBSERVABILITY_TOKEN` is unset.
 */
export function AccessDenied() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>401 — Unauthorized</h1>
      <p>The observability pages require a valid bearer token.</p>
    </main>
  );
}

/**
 * Deny the current request: raises Next's 401 access-fallback, so the response
 * status matches the text `AccessDenied` renders (via `unauthorized.tsx`).
 *
 * Never returns — call it, do not return it. Because it throws, no page code
 * after the auth check can run, which is the fail-closed property the previous
 * `return <AccessDenied />` relied on the caller to preserve.
 */
export function denyObservabilityAccess(): never {
  unauthorized();
}
