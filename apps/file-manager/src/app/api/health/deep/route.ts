import { checkDeepHealth } from '@knext/lib/health';
import { withRedMetrics } from '../../_metrics/registry';

// Deep dependency endpoint — observability/alerting ONLY (#338, ADR-0026).
// This dials Postgres/Redis and classifies a scale-to-zero DB that is asleep or
// mid-wake as `waking` (a normal, transient state), a reachable-but-erroring DB
// as `down`, and a cache blip as `degraded`. It is NOT wired to the Knative
// readiness/liveness gate — /api/health (shallow) backs those.
export const dynamic = 'force-dynamic'; // Never cache health checks

export const GET = withRedMetrics('/api/health/deep', async () => {
  const health = await checkDeepHealth();

  // 200 for ok / degraded / waking (all serviceable or transient); 503 only for
  // a genuine fault (`down`). Monitoring reads the body's `status` for detail.
  const httpStatus = health.status === 'down' ? 503 : 200;

  return new Response(JSON.stringify(health), {
    status: httpStatus,
    headers: { 'Content-Type': 'application/json' },
  });
});
