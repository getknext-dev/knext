import { NextResponse } from 'next/server';

// Faithful reduction of the upstream fixture
// (test/e2e/middleware-fetches-with-any-http-method at v16.2.0) — see
// docs/compat/upstream-bun-sandbox-fetch-bug.md. The ONE deliberate change vs
// the doc's repro app: the echo endpoint is a CONTROLLED LOCAL HTTPS server
// (run-trials.mjs boots it on 127.0.0.1:8743 with a self-signed CA passed via
// NODE_EXTRA_CA_CERTS), because the 2026-07-03 local campaign proved the WAN
// endpoint is a confound. TLS stays in the path (it was implicated in the CI
// signature); the IP literal avoids a dual-stack localhost-resolution confound.
const HTTP_ECHO_URL = 'https://127.0.0.1:8743/api/echo-headers';

export default async function middleware(req) {
  const kind = req.nextUrl.searchParams.get('kind');
  const handler = handlers[kind] ?? handlers['normal-fetch'];
  const response = await handler({ url: HTTP_ECHO_URL, method: req.method });
  const json = await response.text();
  const res = NextResponse.next();
  res.headers.set('x-resolved', json ?? '{}');
  return res;
}

const handlers = {
  'new-request': ({ url, method }) =>
    fetch(new Request(url, { method, headers: { 'x-kind': 'new-request' } })),
  'normal-fetch': ({ url, method }) =>
    fetch(url, { method, headers: { 'x-kind': 'normal-fetch' } }),
};

export const config = { matcher: '/' };
