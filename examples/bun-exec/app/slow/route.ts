// A deliberately slow (~2s) route so the SIGTERM-drain test can catch a request
// mid-flight: fire it, SIGTERM the runtime, and assert it STILL completes 200
// because `server.stop()` lets in-flight requests finish before exit.
export const dynamic = 'force-dynamic';

export async function GET() {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return new Response('drained-ok', {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}
