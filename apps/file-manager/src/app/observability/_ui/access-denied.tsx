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
 *
 * **Two limits, measured on a live build rather than assumed — stated because a
 * change whose thesis is "the denial path is the last place that may lie" cannot
 * be quiet about where it is still imprecise:**
 *
 *  1. **The 401 carries no `WWW-Authenticate` challenge**, which RFC 9110 §11.6.1
 *     requires of a 401. `unauthorized()` raises a render-time fallback and has
 *     no way to set a response header; only middleware could, and middleware runs
 *     BEFORE the handler, so it cannot know the eventual status and would have to
 *     stamp the challenge on successful 200s too (or duplicate the whole auth gate
 *     at the edge, where `timingSafeEqual` is unavailable). Neither is worth it
 *     for a demo-app page set, so the gap is documented, not papered over.
 *  2. **The status is exact for DOCUMENT requests.** The same route fetched as an
 *     RSC navigation (`RSC: 1`) returns 200 with a flight payload — Next's
 *     behaviour, not this module's. That payload is the denial, so no metric data
 *     leaks either way; it is only the status code that is uninformative there.
 *     So "a monitor or probe sees the denial" is true of a document request, and
 *     is the claim this component actually makes.
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
