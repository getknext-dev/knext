// A deliberately SLOW handler — the in-flight fixture for the SIGTERM drain
// e2e (test/alpine-image.docker-e2e.test.ts). The drain guarantee is only
// testable with a request that is genuinely mid-flight when TERM arrives, and
// every other route here answers in microseconds.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const ms = Math.min(Number(new URL(req.url).searchParams.get('ms')) || 3000, 10_000);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return Response.json({ ok: true, sleptMs: ms });
}
