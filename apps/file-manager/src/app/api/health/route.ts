import { checkShallowHealth } from '@knext/lib/health';
import { withRedMetrics } from '../_metrics/registry';

// Shallow readiness/liveness endpoint for Knative probes (#338, ADR-0026).
// Returns 200 whenever the process/server is up, WITHOUT dialing Postgres/Redis.
// Gating readiness on a scale-to-zero DB's reachability defeats scale-to-zero:
// an asleep/waking database is NORMAL, and a deep check would flap readiness on
// every cold wake. Deep dependency reachability lives at /api/health/deep.
export const dynamic = 'force-dynamic'; // Ensure health checks are never cached

// Wrapped in withRedMetrics so the constant Knative probe traffic on this route
// continuously populates the server-side RED series (kn_next_http_requests_total /
// kn_next_http_request_duration_seconds) that the availability + latency SLIs read.
export const GET = withRedMetrics('/api/health', async () => {
  const health = checkShallowHealth();

  return new Response(JSON.stringify(health), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
