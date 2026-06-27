import { checkDeepHealth } from '@knext/lib/health';
import { withRedMetrics } from '../_metrics/registry';

// Health check endpoint for Knative probes
// Executes deep readiness checks against configured backend services (Postgres/Redis)
export const dynamic = 'force-dynamic'; // Ensure health checks are never cached

// Wrapped in withRedMetrics so the constant Knative probe traffic on this route
// continuously populates the server-side RED series (kn_next_http_requests_total /
// kn_next_http_request_duration_seconds) that the availability + latency SLIs read.
// Behavior is unchanged: the wrapper returns this handler's own Response.
export const GET = withRedMetrics('/api/health', async () => {
  const healthStr = await checkDeepHealth();

  return new Response(JSON.stringify(healthStr), {
    status: healthStr.status === 'ok' || healthStr.status === 'degraded' ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
  });
});
