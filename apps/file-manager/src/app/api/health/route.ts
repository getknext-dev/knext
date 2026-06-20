import { checkDeepHealth } from '@knext/lib/health';

// Health check endpoint for Knative probes
// Executes deep readiness checks against configured backend services (Postgres/Redis)
export const dynamic = 'force-dynamic'; // Ensure health checks are never cached

export async function GET() {
  const healthStr = await checkDeepHealth();

  return new Response(JSON.stringify(healthStr), {
    status: healthStr.status === 'ok' || healthStr.status === 'degraded' ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
  });
}
