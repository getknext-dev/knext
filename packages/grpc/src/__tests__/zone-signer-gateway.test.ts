/**
 * The zone signer under a Node gateway AND a Bun gateway.
 *
 * The fixture zone's committed glue is bundled with the real signer and run as
 * a gateway process under `node` and under `bun`, each on its default
 * transport (h2c on Node, HTTP/1.1 on Bun), against a real Connect function in
 * a third process. The function verifies every token with `node:crypto` and the
 * token contract (signature, header, iss, aud, method = the RPC called,
 * `exp - iat <= 60`, a non-empty sub for an AUTH_USER RPC), answers with what
 * it verified, and writes every token it received to a file.
 *
 * So the gateway's answers prove each runtime minted tokens a verifier accepts,
 * and the token file proves none of them leaked into the gateway's output, even
 * when the function refuses a call and the gateway prints the error.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PKG_DIR } from './helpers';

const GENERATED = join(PKG_DIR, 'fixtures/zone/src/generated/grpc/orders/v1');
const dir = mkdtempSync(join(tmpdir(), 'knext-grpc-signer-gateway-'));
const children: ChildProcess[] = [];
let functionUrl = '';

const ISSUER = 'knext:zone:shop/storefront';
const AUDIENCE = 'knext:fn:shop/orders';
const TOKENS = join(dir, 'tokens.log');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const SPKI = publicKey.export({ format: 'der', type: 'spki' });
const KID = createHash('sha256')
  .update(SPKI.subarray(SPKI.length - 32))
  .digest()
  .subarray(0, 16)
  .toString('base64url');
const KEY_DIR = join(dir, 'signing-key');

afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

const FUNCTION_SRC = `
import { appendFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { createServer as createH1 } from 'node:http';
import { createServer as createH2 } from 'node:http2';
import { connect, createServer as createNet } from 'node:net';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { CatalogService } from ${JSON.stringify(join(GENERATED, 'catalog_pb.ts'))};
import { OrdersService } from ${JSON.stringify(join(GENERATED, 'orders_pb.ts'))};

const key = createPublicKey({ key: Buffer.from(process.env.TEST_SPKI, 'base64'), format: 'der', type: 'spki' });
const PUBLIC = new Set(['/orders.v1.CatalogService/GetMenu']);

// A verifier built to the token contract. Returns "<sub>|<method>|<kid>".
function verified(ctx) {
  const path = '/' + ctx.service.typeName + '/' + ctx.method.name;
  const m = /^Bearer ([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)$/.exec(
    ctx.requestHeader.get('authorization') ?? '',
  );
  if (!m) throw new ConnectError('no bearer token', Code.Unauthenticated);
  appendFileSync(process.env.TEST_TOKENS, m[1] + '.' + m[2] + '.' + m[3] + '\\n');
  const header = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  if (JSON.stringify(header) !== JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: process.env.TEST_KID })) {
    throw new ConnectError('bad header', Code.Unauthenticated);
  }
  if (!verify(null, Buffer.from(m[1] + '.' + m[2]), key, Buffer.from(m[3], 'base64url'))) {
    throw new ConnectError('bad signature', Code.Unauthenticated);
  }
  const c = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  const ok =
    JSON.stringify(Object.keys(c)) === JSON.stringify(['iss', 'aud', 'method', 'sub', 'iat', 'exp']) &&
    c.iss === process.env.TEST_ISSUER &&
    c.aud === process.env.TEST_AUDIENCE &&
    c.method === path &&
    typeof c.sub === 'string' &&
    (PUBLIC.has(path) || c.sub !== '') &&
    Number.isInteger(c.iat) && Number.isInteger(c.exp) &&
    c.exp - c.iat > 0 && c.exp - c.iat <= 60 &&
    now < c.exp + 5 && c.iat <= now + 5;
  if (!ok) throw new ConnectError('claims refused', Code.Unauthenticated);
  return c.sub + '|' + c.method + '|' + header.kid;
}

const adapter = connectNodeAdapter({
  routes: (router) => {
    router.service(OrdersService, {
      getOrder: (req, ctx) => ({ id: req.id, status: verified(ctx) }),
      placeOrder: (_req, ctx) => ({ id: verified(ctx) }),
      cancelOrder: (_req, ctx) => {
        verified(ctx);
        throw new ConnectError('refused by the function', Code.PermissionDenied);
      },
      async *watchOrders(_req, ctx) {
        yield { id: 'w-1', status: verified(ctx) };
      },
    });
    router.service(CatalogService, { getMenu: (_req, ctx) => ({ items: [verified(ctx)] }) });
  },
});
const h1 = createH1(adapter);
const h2 = createH2(adapter);
await new Promise((r) => h1.listen(0, '127.0.0.1', r));
await new Promise((r) => h2.listen(0, '127.0.0.1', r));
const server = createNet((socket) => {
  socket.once('data', (first) => {
    socket.pause();
    const target = first.toString('latin1').startsWith('PRI * HTTP/2.0') ? h2 : h1;
    const upstream = connect(target.address().port, '127.0.0.1', () => {
      upstream.write(first);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
});
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

const GATEWAY_SRC = `
import { getOrder, watchOrders } from ${JSON.stringify(join(GENERATED, 'orders_knext_server.ts'))};
import { cancelOrder, placeOrder } from ${JSON.stringify(join(GENERATED, 'orders_knext_actions.ts'))};
import { getMenu } from ${JSON.stringify(join(GENERATED, 'catalog_knext_server.ts'))};
import { createZoneTokenSigner, registerTokenMinter } from '@getknext/grpc/runtime';

// The function listens on 127.0.0.1, not on its cluster-local address, so the
// audience is given; everything else is the signer's default (the issuer from
// KNEXT_ZONE_ISSUER, the key from the mounted directory).
registerTokenMinter(
  createZoneTokenSigner({ keyDir: process.env.TEST_KEY_DIR, audience: () => process.env.TEST_AUDIENCE }),
);
const read = await getOrder({ id: 'o-1' });
const write = await placeOrder(
  { sku: 's', quantity: 1, sub: 'mallory', userId: 'mallory' },
  { idempotencyKey: 'k-1' },
);
const stream = [];
for await (const m of watchOrders({})) stream.push(m.status);
const menu = await getMenu({ locale: 'en' });
let refused = '';
try {
  await cancelOrder({ id: 'o-1' }, { idempotencyKey: 'k-2' });
} catch (err) {
  console.error(err);
  console.error(JSON.stringify(err));
  refused = String(err.code) + ' ' + err.message + ' ' + err.stack;
}
console.log('RESULT ' + JSON.stringify({ read: read.status, write: write.id, stream, menu: menu.items, refused }));
`;

const STUBS: Record<string, string> = {
  'next/cache':
    'export const cacheLife = () => {}; export const cacheTag = () => {}; export const updateTag = () => {};',
  'server-only': 'export {};',
  authorize: 'export async function authorize() { return { sub: "alice" }; }',
};

async function bundle(entry: string, name: string): Promise<string> {
  const src = join(dir, `${name}.ts`);
  writeFileSync(src, entry);
  for (const [k, v] of Object.entries(STUBS))
    writeFileSync(join(dir, `${k.replace('/', '-')}.mjs`), v);
  const result = await Bun.build({
    entrypoints: [src],
    target: 'node',
    format: 'esm',
    outdir: dir,
    naming: `${name}.mjs`,
    plugins: [
      {
        name: 'gateway-stubs',
        setup(build) {
          build.onResolve({ filter: /^(next\/cache|server-only)$/ }, (a) => ({
            path: join(dir, `${a.path.replace('/', '-')}.mjs`),
          }));
          build.onResolve({ filter: /\/knext\/authorize$/ }, () => ({
            path: join(dir, 'authorize.mjs'),
          }));
          build.onResolve({ filter: /^@getknext\/grpc\/runtime$/ }, () => ({
            path: resolve(PKG_DIR, 'src/runtime.ts'),
          }));
          build.onResolve({ filter: /^@connectrpc\// }, (a) => ({
            path: Bun.resolveSync(a.path, PKG_DIR),
          }));
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join('\n'));
  return join(dir, `${name}.mjs`);
}

interface Run {
  readonly code: number | null;
  readonly output: string;
}

function run(cmd: string, script: string, env: Record<string, string>): Promise<Run> {
  return new Promise((res) => {
    const child = spawn(cmd, [script], { env: { ...process.env, ...env } });
    children.push(child);
    let output = '';
    child.stdout.on('data', (b) => {
      output += String(b);
    });
    child.stderr.on('data', (b) => {
      output += String(b);
    });
    child.on('close', (code) => res({ code, output }));
  });
}

interface Result {
  read: string;
  write: string;
  stream: string[];
  menu: string[];
  refused: string;
}

async function gateway(cmd: 'node' | 'bun'): Promise<{ result: Result; output: string }> {
  writeFileSync(TOKENS, '');
  const r = await run(cmd, join(dir, 'gateway.mjs'), {
    ORDERS_SERVICE_URL: functionUrl,
    ORDERS_SERVICE_PROTO_VERSION: '1.2.0',
    KNEXT_ZONE_ISSUER: ISSUER,
    TEST_KEY_DIR: KEY_DIR,
    TEST_AUDIENCE: AUDIENCE,
  });
  const line = r.output.split('\n').find((l) => l.startsWith('RESULT '));
  if (r.code !== 0 || !line) throw new Error(`${cmd} gateway exited ${r.code}:\n${r.output}`);
  return { result: JSON.parse(line.slice('RESULT '.length)) as Result, output: r.output };
}

beforeAll(async () => {
  mkdirSync(KEY_DIR);
  writeFileSync(join(KEY_DIR, 'current.key'), PEM);
  writeFileSync(join(KEY_DIR, 'current.kid'), KID);
  const fnScript = await bundle(FUNCTION_SRC, 'function');
  await bundle(GATEWAY_SRC, 'gateway');
  const fn = spawn('node', [fnScript], {
    env: {
      ...process.env,
      TEST_SPKI: SPKI.toString('base64'),
      TEST_KID: KID,
      TEST_ISSUER: ISSUER,
      TEST_AUDIENCE: AUDIENCE,
      TEST_TOKENS: TOKENS,
    },
  });
  children.push(fn);
  functionUrl = await new Promise<string>((res, rej) => {
    let out = '';
    fn.stdout.on('data', (b) => {
      out += String(b);
      const m = out.match(/PORT (\d+)/);
      if (m) res(`http://127.0.0.1:${m[1]}`);
    });
    fn.stderr.on('data', (b) => {
      out += String(b);
    });
    fn.on('close', (code) => rej(new Error(`function exited ${code}: ${out}`)));
  });
}, 60_000);

function expectVerified(r: Result): void {
  expect(r.read).toBe(`alice|/orders.v1.OrdersService/GetOrder|${KID}`);
  // A request field named sub or userId never becomes the token's sub.
  expect(r.write).toBe(`alice|/orders.v1.OrdersService/PlaceOrder|${KID}`);
  expect(r.stream).toEqual([`alice|/orders.v1.OrdersService/WatchOrders|${KID}`]);
  // The public read is signed by the zone, with an empty sub.
  expect(r.menu).toEqual([`|/orders.v1.CatalogService/GetMenu|${KID}`]);
  expect(r.refused).toContain('refused by the function');
}

function expectNoLeak(output: string): void {
  const tokens = readFileSync(TOKENS, 'utf8').split('\n').filter(Boolean);
  expect(tokens).toHaveLength(5);
  for (const token of tokens) {
    expect(output).not.toContain(token);
    for (const segment of token.split('.')) expect(output).not.toContain(segment);
  }
  for (const line of PEM.split('\n').filter((l) => l && !l.startsWith('-----'))) {
    expect(output).not.toContain(line);
  }
}

describe('the zone signer runs under a Node gateway and a Bun gateway', () => {
  it('Node gateway: every call carries a token the function verifies; none is printed', async () => {
    const { result, output } = await gateway('node');
    expectVerified(result);
    expectNoLeak(output);
  }, 60_000);

  it('Bun gateway: every call carries a token the function verifies; none is printed', async () => {
    const { result, output } = await gateway('bun');
    expectVerified(result);
    expectNoLeak(output);
  }, 60_000);
});
