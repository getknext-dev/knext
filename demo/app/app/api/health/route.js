// Liveness/readiness endpoint. The knext operator defaults
// spec.healthCheckPath to /api/health and wires Knative probes to it.
// This MUST NOT touch Postgres — a health check that wakes the database would
// defeat scale-to-zero (every probe would keep the DB alive). It only proves
// the Next.js server process is up.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
