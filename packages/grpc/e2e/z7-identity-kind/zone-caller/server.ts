// The e2e zone: a tiny HTTP server standing in for a Next.js zone's server code.
// It does what a zone does to call its functions, through the REAL pieces:
//
//   /example/*    the generated glue for the Go function (a generated query and a
//                 generated Server Action: authorize() -> served-version check ->
//                 mintCallToken() -> the Connect client);
//   /inventory/*  the second function, called with a token from the same
//                 mintCallToken() (the Rust function serves the same contract,
//                 and one zone cannot generate the same function name twice);
//   /kid          the kid of the key the zone's signer signs with RIGHT NOW.
//
// The signer is the default one: the key is read from the Secret volume the
// operator mounted at /var/run/knext/signing-key, the issuer from
// KNEXT_ZONE_ISSUER and each audience from <NAME>_SERVICE_URL, all rendered by
// the operator. Nothing here sets those, and nothing here returns a token or a
// key: a response carries the outcome (and, from /kid, the public kid).
//
// build.ts bundles this file with the generated glue under stand-ins for
// `next/cache` and `server-only`: a query is not cached here, which is fine, the
// token is minted either way.
import { createServer, type ServerResponse } from 'node:http';
import { Code, ConnectError } from '@connectrpc/connect';
import { mintCallToken } from '@getknext/grpc/runtime';
import { putItem } from './generated/grpc/example/v1/example_knext_actions';
import { getItem } from './generated/grpc/example/v1/example_knext_server';
import { user } from './knext/context';

const PORT = Number(process.env.PORT ?? 3000);
const EXAMPLE = '/example.v1.ExampleService';

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** A failed call as a response: the Connect code and where it was raised. */
function failure(res: ServerResponse, err: unknown): void {
  const e = ConnectError.from(err);
  reply(res, e.code === Code.NotFound ? 404 : 502, { ok: false, code: Code[e.code] });
}

/** The kid in the header of the token the signer mints now. The token is dropped. */
async function signingKid(): Promise<string> {
  const token = await mintCallToken({
    function: 'example',
    method: `${EXAMPLE}/GetItem`,
    auth: 'user',
    sub: 'kid-probe',
  });
  const header = JSON.parse(
    Buffer.from(token.split('.')[0] as string, 'base64url').toString('utf8'),
  );
  return String(header.kid);
}

/** A call to the inventory function with a token from the zone's signer. */
async function inventory(rpc: 'PutItem' | 'GetItem', body: unknown, sub: string) {
  const base = process.env.INVENTORY_SERVICE_URL;
  if (!base) throw new ConnectError('INVENTORY_SERVICE_URL is not set', Code.FailedPrecondition);
  const token = await mintCallToken({
    function: 'inventory',
    method: `${EXAMPLE}/${rpc}`,
    auth: 'user',
    sub,
  });
  const r = await fetch(`${base}${EXAMPLE}/${rpc}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: r.status, body: parsed as { code?: string; value?: string } | null };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://zone');
  const q = url.searchParams;
  const sub = q.get('sub') ?? '';
  try {
    switch (url.pathname) {
      case '/api/health':
        return reply(res, 200, { ok: true });
      case '/kid':
        return reply(res, 200, { ok: true, kid: await signingKid() });
      case '/example/put': {
        await user.run({ sub }, () =>
          putItem(
            { id: q.get('id') ?? '', value: q.get('value') ?? '' },
            { idempotencyKey: crypto.randomUUID() },
          ),
        );
        return reply(res, 200, { ok: true });
      }
      case '/example/get': {
        const item = await user.run({ sub }, () => getItem({ id: q.get('id') ?? '' }));
        return reply(res, 200, { ok: true, value: item.value });
      }
      case '/inventory/put': {
        const r = await inventory(
          'PutItem',
          { id: q.get('id') ?? '', value: q.get('value') ?? '' },
          sub,
        );
        return reply(res, r.status === 200 ? 200 : 502, {
          ok: r.status === 200,
          code: r.body?.code ?? '',
        });
      }
      case '/inventory/get': {
        const r = await inventory('GetItem', { id: q.get('id') ?? '' }, sub);
        return reply(res, r.status === 200 ? 200 : r.status === 404 ? 404 : 502, {
          ok: r.status === 200,
          code: r.body?.code ?? '',
          value: r.body?.value,
        });
      }
      default:
        return reply(res, 404, { ok: false, code: 'no_route' });
    }
  } catch (err) {
    return failure(res, err);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`zone-caller listening on ${PORT}`));

// PID 1 ignores SIGTERM unless it handles it, which would hold a replaced revision's
// pod in Terminating for the whole grace period.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
});
