/**
 * The generated glue with the REAL zone signer, against a real Connect function
 * that verifies every token the way a function's verifier does.
 *
 * The glue is generated NOW from the fixture contract (so a generator change is
 * what this test sees), `next/cache` and `server-only` are stand-ins, and the
 * signer reads its key from a directory laid out as kubelet lays out the
 * zone's signing-key Secret. The function checks the signature with
 * `node:crypto` against the public keys it was given (current and previous, as
 * the zone's JWKS holds them), and then the contract: iss is the zone, aud is
 * this function, `method` is the RPC actually being called, `exp - iat <= 60`,
 * and `sub` is non-empty for an AUTH_USER RPC. A token that fails any check is
 * UNAUTHENTICATED, so a call that succeeds proves its token was valid.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { createHash, generateKeyPairSync, type KeyObject, verify } from 'node:crypto';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import ts from 'typescript';
import { CatalogService } from '../../fixtures/zone/src/generated/grpc/orders/v1/catalog_pb';
import { OrdersService } from '../../fixtures/zone/src/generated/grpc/orders/v1/orders_pb';
import { generateFiles } from '../generate';
import * as runtime from '../runtime';
import { emptyDir, FIXTURE_ZONE, PKG_DIR, removeScratchDirs } from './helpers';

const ISSUER = 'knext:zone:shop/storefront';
const AUDIENCE = 'knext:fn:shop/orders';
const AUTHORIZE = Symbol.for('knext.test.zoneSignerGlue.authorize');

mock.module('next/cache', () => ({ updateTag: () => {}, cacheTag: () => {}, cacheLife: () => {} }));
mock.module('server-only', () => ({}));
mock.module('@getknext/grpc/runtime', () => runtime);

interface Key {
  readonly pem: string;
  readonly publicKey: KeyObject;
  readonly kid: string;
}

function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const kid = createHash('sha256')
    .update(spki.subarray(spki.length - 32))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, publicKey, kid };
}

// ── the function: a verifier built to the token contract ─────────────────────

/** The public keys the function accepts, by kid (the zone's JWKS). */
const jwks = new Map<string, KeyObject>();
/** Every request that reached the function, with the claims it verified. */
const seen: { path: string; body: string; claims: Record<string, unknown>; kid: string }[] = [];
/** The RPCs the contract marks AUTH_PUBLIC. */
const PUBLIC_RPCS = new Set(['/orders.v1.CatalogService/GetMenu']);

function verifyCall(ctx: HandlerContext, body: string): void {
  const path = `/${ctx.service.typeName}/${ctx.method.name}`;
  const auth = ctx.requestHeader.get('authorization') ?? '';
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(auth);
  if (!m) throw new ConnectError('no bearer token', Code.Unauthenticated);
  const [, h, c, s] = m as unknown as [string, string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || Object.keys(header).length !== 3) {
    throw new ConnectError('bad header', Code.Unauthenticated);
  }
  const key = jwks.get(header.kid);
  if (!key || !verify(null, Buffer.from(`${h}.${c}`), key, Buffer.from(s, 'base64url'))) {
    throw new ConnectError('bad signature', Code.Unauthenticated);
  }
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  const ok =
    claims.iss === ISSUER &&
    claims.aud === AUDIENCE &&
    claims.method === path &&
    typeof claims.sub === 'string' &&
    (PUBLIC_RPCS.has(path) || claims.sub !== '') &&
    Number.isInteger(claims.iat) &&
    Number.isInteger(claims.exp) &&
    claims.exp - claims.iat > 0 &&
    claims.exp - claims.iat <= 60 &&
    now < claims.exp + 5 &&
    claims.iat <= now + 5;
  if (!ok) throw new ConnectError('claims refused', Code.Unauthenticated);
  seen.push({ path, body, claims, kid: header.kid });
}

let server: Server | undefined;
let url = '';

type Fn = (request: unknown, options?: unknown) => Promise<unknown>;
let server_: { getOrder: Fn; watchOrders: (r: unknown) => AsyncGenerator<unknown> };
let actions: { placeOrder: Fn };
let catalog: { getMenu: Fn };

beforeAll(async () => {
  const handler = connectNodeAdapter({
    routes: (router) => {
      router.service(OrdersService, {
        getOrder: (req, ctx) => {
          verifyCall(ctx, JSON.stringify(req));
          return { id: req.id, status: 'ok' };
        },
        placeOrder: (req, ctx) => {
          verifyCall(ctx, JSON.stringify(req));
          return { id: 'o-1' };
        },
        cancelOrder: (req, ctx) => {
          verifyCall(ctx, JSON.stringify(req));
          return {};
        },
        async *watchOrders(req, ctx) {
          verifyCall(ctx, JSON.stringify(req));
          yield { id: 'w-1', status: 'ok' };
        },
      });
      router.service(CatalogService, {
        getMenu: (req, ctx) => {
          verifyCall(ctx, JSON.stringify(req));
          return { items: ['menu'] };
        },
      });
    },
  });
  server = createServer(handler);
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const dir = emptyDir('signer-glue');
  for (const [rel, text] of generateFiles(FIXTURE_ZONE)) {
    const target = join(dir, 'src', 'generated', 'grpc', rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  mkdirSync(join(dir, 'src', 'knext'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'knext', 'authorize.ts'),
    `export async function authorize(ctx) {
  return globalThis[Symbol.for(${JSON.stringify(AUTHORIZE.description)})](ctx);
}
`,
  );
  symlinkSync(join(PKG_DIR, 'node_modules'), join(dir, 'node_modules'));
  const out = join(dir, 'src', 'generated', 'grpc', 'orders', 'v1');
  server_ = await import(join(out, 'orders_knext_server.ts'));
  actions = await import(join(out, 'orders_knext_actions.ts'));
  catalog = await import(join(out, 'catalog_knext_server.ts'));
});

afterAll(() => {
  server?.close();
  removeScratchDirs();
});

const ENV_KEYS = ['ORDERS_SERVICE_URL', 'ORDERS_SERVICE_PROTO_VERSION'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  runtime.registerTokenMinter(undefined);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A signing-key volume as kubelet lays it out; `publish` swaps `..data`. */
function keyVolume(prefix: string) {
  const dir = emptyDir(prefix);
  let n = 0;
  return {
    dir,
    publish(current: Key, previous?: Key) {
      n += 1;
      const version = `..v${n}`;
      mkdirSync(join(dir, version));
      writeFileSync(join(dir, version, 'current.key'), current.pem);
      writeFileSync(join(dir, version, 'current.kid'), current.kid);
      if (previous) {
        writeFileSync(join(dir, version, 'previous.key'), previous.pem);
        writeFileSync(join(dir, version, 'previous.kid'), previous.kid);
      }
      symlinkSync(version, join(dir, '..data_tmp'));
      renameSync(join(dir, '..data_tmp'), join(dir, '..data'));
      if (n === 1) {
        symlinkSync(join('..data', 'current.key'), join(dir, 'current.key'));
        symlinkSync(join('..data', 'current.kid'), join(dir, 'current.kid'));
      }
    },
  };
}

/** Wire the zone: env, authorize(), and the real signer over `keyDir`. */
function zone(keyDir: string, sub = 'alice'): void {
  seen.length = 0;
  process.env.ORDERS_SERVICE_URL = url;
  process.env.ORDERS_SERVICE_PROTO_VERSION = '1.2.0';
  (globalThis as Record<symbol, unknown>)[AUTHORIZE] = async () => ({ sub });
  runtime.registerTokenMinter(
    runtime.createZoneTokenSigner({
      keyDir,
      env: () => ({ KNEXT_ZONE_ISSUER: ISSUER }),
      // The function listens on 127.0.0.1 here, not on its cluster-local
      // address, so the audience is given rather than derived from the URL.
      audience: () => AUDIENCE,
    }),
  );
}

async function refusal(p: Promise<unknown>): Promise<ConnectError> {
  try {
    await p;
  } catch (err) {
    return ConnectError.from(err);
  }
  throw new Error('the call succeeded');
}

describe('every generated shape carries a token the function accepts', () => {
  it('an AUTH_USER query: sub is the verified user, method is the RPC called', async () => {
    const key = newKey();
    jwks.set(key.kid, key.publicKey);
    const vol = keyVolume('glue-query');
    vol.publish(key);
    zone(vol.dir);
    await server_.getOrder({ id: 'o-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.claims.sub).toBe('alice');
    expect(seen[0]?.claims.method).toBe('/orders.v1.OrdersService/GetOrder');
    expect(seen[0]?.kid).toBe(key.kid);
  });

  it('an action: a request field named sub or userId never becomes the token sub', async () => {
    const key = newKey();
    jwks.set(key.kid, key.publicKey);
    const vol = keyVolume('glue-action');
    vol.publish(key);
    zone(vol.dir);
    await actions.placeOrder(
      { sku: 's-1', quantity: 1, sub: 'mallory', userId: 'mallory', user_id: 'mallory' },
      { idempotencyKey: 'k-1' },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.claims.sub).toBe('alice');
    expect(seen[0]?.claims.method).toBe('/orders.v1.OrdersService/PlaceOrder');
    expect(seen[0]?.body).not.toContain('mallory');
  });

  it('a stream carries its own token', async () => {
    const key = newKey();
    jwks.set(key.kid, key.publicKey);
    const vol = keyVolume('glue-stream');
    vol.publish(key);
    zone(vol.dir);
    for await (const _ of server_.watchOrders({})) {
      // drain
    }
    expect(seen[0]?.claims.method).toBe('/orders.v1.OrdersService/WatchOrders');
    expect(seen[0]?.claims.sub).toBe('alice');
  });

  it('an AUTH_PUBLIC query: signed by the zone, with an empty sub', async () => {
    const key = newKey();
    jwks.set(key.kid, key.publicKey);
    const vol = keyVolume('glue-public');
    vol.publish(key);
    zone(vol.dir);
    await catalog.getMenu({ locale: 'en' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.claims.sub).toBe('');
    expect(seen[0]?.claims.iss).toBe(ISSUER);
  });

  it('a rotated key is used on the next call, without a restart', async () => {
    const a = newKey();
    const b = newKey();
    jwks.set(a.kid, a.publicKey);
    jwks.set(b.kid, b.publicKey);
    const vol = keyVolume('glue-rotate');
    vol.publish(a);
    zone(vol.dir);
    await server_.getOrder({ id: 'o-1' });
    vol.publish(b, a);
    await server_.getOrder({ id: 'o-2' });
    expect(seen.map((s) => s.kid)).toEqual([a.kid, b.kid]);
  });
});

describe('a call without a valid identity never leaves the zone', () => {
  it('no signing key mounted: FAILED_PRECONDITION, and nothing reaches the function', async () => {
    zone(emptyDir('glue-nokey'));
    const err = await refusal(actions.placeOrder({ sku: 's' }, { idempotencyKey: 'k' }));
    expect(err.code).toBe(Code.FailedPrecondition);
    expect(seen).toHaveLength(0);
  });

  it('authorize() returns an empty sub for an AUTH_USER RPC: refused, nothing reaches the function', async () => {
    const key = newKey();
    jwks.set(key.kid, key.publicKey);
    const vol = keyVolume('glue-emptysub');
    vol.publish(key);
    zone(vol.dir, '');
    const err = await refusal(server_.getOrder({ id: 'o-1' }));
    expect(err.code).toBe(Code.Unauthenticated);
    expect(seen).toHaveLength(0);
  });

  it('a key the function does not trust is refused by the function (the test verifier is real)', async () => {
    const untrusted = newKey();
    const vol = keyVolume('glue-untrusted');
    vol.publish(untrusted);
    zone(vol.dir);
    const err = await refusal(server_.getOrder({ id: 'o-1' }));
    expect(err.code).toBe(Code.Unauthenticated);
    expect(seen).toHaveLength(0);
  });
});

describe('the generator states each RPC auth in its token request', () => {
  const expected: Record<string, 'user' | 'public'> = {
    getOrder: 'user',
    placeOrder: 'user',
    cancelOrder: 'user',
    watchOrders: 'user',
    getMenu: 'public',
  };

  it('every mintCallToken call names auth, and it matches the RPC option', () => {
    const found: Record<string, string> = {};
    for (const [path, text] of generateFiles(FIXTURE_ZONE)) {
      if (!/_knext_(server|actions)\.ts$/.test(path)) continue;
      const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      const walk = (n: ts.Node, fn: string) => {
        let inFn = fn;
        if (ts.isFunctionDeclaration(n) && n.name) inFn = n.name.text.replace(/\$cached$/, '');
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === '$mintCallToken'
        ) {
          const arg = n.arguments[0];
          if (!arg || !ts.isObjectLiteralExpression(arg)) throw new Error(`${fn}: no object`);
          const auth = arg.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'auth',
          );
          if (!auth || !ts.isStringLiteral(auth.initializer)) {
            throw new Error(`${inFn}: the token request does not name its auth`);
          }
          found[inFn] = auth.initializer.text;
        }
        ts.forEachChild(n, (c) => walk(c, inFn));
      };
      walk(sf, '');
    }
    expect(found).toEqual(expected);
  });
});
