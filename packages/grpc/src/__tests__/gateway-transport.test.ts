/**
 * The generated glue runs under a Node gateway AND a Bun gateway.
 *
 * The fixture zone's committed glue (queries, actions, a stream, a public read)
 * is bundled once and run as a separate gateway process under `node` and under
 * `bun`, against a real Connect function in a third process that accepts both
 * h2c and HTTP/1.1 on one port and reports which one each call arrived on.
 *
 * - Node gateway: h2c by default, and it says so in one log line.
 * - Bun gateway: falls back to HTTP/1.1 by default (Bun's HTTP/2 client is not
 *   verified for Connect), and the log line names HTTP/1.1 and the fallback.
 * - `<NAME>_SERVICE_HTTP_VERSION` overrides either default, and the log line
 *   names the variable.
 *
 * The transport is judged by what the FUNCTION saw, not by what the gateway
 * claims. `next/cache` and `server-only` are stubbed (no Next.js here): the
 * glue's call path, end-user check, token and served version are real.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PKG_DIR } from './helpers';

const GENERATED = join(PKG_DIR, 'fixtures/zone/src/generated/grpc/orders/v1');
const dir = mkdtempSync(join(tmpdir(), 'knext-grpc-gateway-'));
const children: ChildProcess[] = [];
let functionUrl = '';

afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

const FUNCTION_SRC = `
import { createServer as createH1 } from 'node:http';
import { createServer as createH2 } from 'node:http2';
import { connect, createServer as createNet } from 'node:net';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { CatalogService } from ${JSON.stringify(join(GENERATED, 'catalog_pb.ts'))};
import { OrdersService } from ${JSON.stringify(join(GENERATED, 'orders_pb.ts'))};

const seen = (ctx) =>
  [ctx.requestHeader.get('x-seen-http'), ctx.requestHeader.get('authorization') ?? 'none'].join('|');
const adapter = connectNodeAdapter({
  routes: (router) => {
    router.service(OrdersService, {
      getOrder: (req, ctx) => ({ id: req.id, status: seen(ctx) }),
      placeOrder: (_req, ctx) => ({ id: seen(ctx) + '|' + ctx.requestHeader.get('idempotency-key') }),
      cancelOrder: () => ({}),
      async *watchOrders(_req, ctx) {
        yield { id: 'w-1', status: seen(ctx) };
        yield { id: 'w-2', status: seen(ctx) };
      },
    });
    router.service(CatalogService, { getMenu: (_req, ctx) => ({ items: [seen(ctx)] }) });
  },
});
const handler = (req, res) => {
  req.headers['x-seen-http'] = 'http/' + req.httpVersion;
  adapter(req, res);
};
const h1 = createH1(handler);
const h2 = createH2(handler);
await new Promise((r) => h1.listen(0, '127.0.0.1', r));
await new Promise((r) => h2.listen(0, '127.0.0.1', r));
// One address for both protocols, as a cluster's function URL is: sniff the
// HTTP/2 connection preface and forward the bytes to the matching server.
const server = createNet((socket) => {
  socket.once('data', (first) => {
    socket.pause(); // until piped, or the next chunk is lost
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
import { placeOrder } from ${JSON.stringify(join(GENERATED, 'orders_knext_actions.ts'))};
import { getMenu } from ${JSON.stringify(join(GENERATED, 'catalog_knext_server.ts'))};
import { registerTokenMinter } from '@getknext/grpc/runtime';

const notices = [];
const info = console.info;
console.info = (line) => notices.push(String(line));
registerTokenMinter(({ sub, method }) => 'tok.' + (sub ?? 'anon') + '.' + method.split('/').pop());
const read = await getOrder({ id: 'o-1' });
const write = await placeOrder({ sku: 's', quantity: 1 }, { idempotencyKey: 'k-1' });
const stream = [];
for await (const m of watchOrders({})) stream.push(m.status);
const menu = await getMenu({ locale: 'en' });
console.info = info;
console.log('RESULT ' + JSON.stringify({ read: read.status, write: write.id, stream, menu: menu.items, notices }));
`;

/** Stand-ins for what only exists inside a Next.js app. */
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
          // The entry files live in a temp dir: resolve packages from this one.
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

function run(cmd: string, script: string, env: Record<string, string>): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, [script], { env: { ...process.env, ...env } });
    children.push(child);
    let out = '';
    child.stdout.on('data', (b) => {
      out += String(b);
    });
    child.stderr.on('data', (b) => {
      out += String(b);
    });
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (code === 0 && line) res(line.slice('RESULT '.length));
      else rej(new Error(`${cmd} gateway exited ${code}:\n${out}`));
    });
  });
}

interface Result {
  read: string;
  write: string;
  stream: string[];
  menu: string[];
  notices: string[];
}

async function gateway(cmd: 'node' | 'bun', extra: Record<string, string> = {}): Promise<Result> {
  const script = join(dir, 'gateway.mjs');
  return JSON.parse(
    await run(cmd, script, {
      ORDERS_SERVICE_URL: functionUrl,
      ORDERS_SERVICE_PROTO_VERSION: '1.2.0',
      ...extra,
    }),
  ) as Result;
}

beforeAll(async () => {
  const fnScript = await bundle(FUNCTION_SRC, 'function');
  await bundle(GATEWAY_SRC, 'gateway');
  const fn = spawn('node', [fnScript]);
  children.push(fn);
  functionUrl = await new Promise<string>((res, rej) => {
    let out = '';
    fn.stdout.on('data', (b) => {
      out += String(b);
      const m = out.match(/PORT (\d+)/);
      if (m) res(`http://127.0.0.1:${m[1]}`);
    });
    fn.on('close', (code) => rej(new Error(`function exited ${code}: ${out}`)));
  });
}, 60_000);

function expectAllOver(r: Result, http: string): void {
  // Each call carried the token minted inside the glue for the verified user.
  expect(r.read).toBe(`${http}|Bearer tok.alice.GetOrder`);
  expect(r.write).toBe(`${http}|Bearer tok.alice.PlaceOrder|k-1`);
  expect(r.stream).toEqual([
    `${http}|Bearer tok.alice.WatchOrders`,
    `${http}|Bearer tok.alice.WatchOrders`,
  ]);
  // The public read carries a token with no user.
  expect(r.menu).toEqual([`${http}|Bearer tok.anon.GetMenu`]);
}

describe('the generated glue runs under a Node gateway and a Bun gateway', () => {
  it('Node gateway: h2c by default, named in one log line', async () => {
    const r = await gateway('node');
    expectAllOver(r, 'http/2.0');
    expect(r.notices).toEqual([
      'knext: orders function: transport h2c (HTTP/2 cleartext) (Node gateway default)',
    ]);
  }, 60_000);

  it('Bun gateway: falls back to HTTP/1.1 by default, and the log line says so', async () => {
    const r = await gateway('bun');
    expectAllOver(r, 'http/1.1');
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain('transport HTTP/1.1');
    expect(r.notices[0]).toContain('falling back from h2c on a Bun gateway');
    expect(r.notices[0]).toContain('ORDERS_SERVICE_HTTP_VERSION=2');
  }, 60_000);

  it('Node gateway: ORDERS_SERVICE_HTTP_VERSION=1.1 switches the binding to HTTP/1.1', async () => {
    const r = await gateway('node', { ORDERS_SERVICE_HTTP_VERSION: '1.1' });
    expectAllOver(r, 'http/1.1');
    expect(r.notices).toEqual([
      'knext: orders function: transport HTTP/1.1, set by ORDERS_SERVICE_HTTP_VERSION=1.1 (Node gateway)',
    ]);
  }, 60_000);

  it('Bun gateway: ORDERS_SERVICE_HTTP_VERSION=2 opts back into h2c, and says so', async () => {
    const r = await gateway('bun', { ORDERS_SERVICE_HTTP_VERSION: '2' });
    expectAllOver(r, 'http/2.0');
    expect(r.notices).toEqual([
      'knext: orders function: transport h2c (HTTP/2 cleartext), set by ORDERS_SERVICE_HTTP_VERSION=2 (Bun gateway)',
    ]);
  }, 60_000);

  it('a gateway without the served contract version refuses before calling', async () => {
    await expect(gateway('node', { ORDERS_SERVICE_PROTO_VERSION: '' })).rejects.toThrow(
      /ORDERS_SERVICE_PROTO_VERSION is not set/,
    );
  }, 60_000);
});
