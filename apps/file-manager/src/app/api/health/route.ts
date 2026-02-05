// Health check endpoint for Knative probes
// Does not depend on external services
export async function GET() {
  return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
