/**
 * A generated Server Action refreshes the service's cached reads whenever the
 * write may have reached the function, and only then.
 *
 * A write can commit on the function and still fail on the wire: the response
 * is lost to a reset, a deadline or a proxy that drops the status. The action
 * cannot tell that write from one that never ran, so it must `updateTag` anyway,
 * or every pod keeps serving pre-write reads until they revalidate. A failure
 * that is provably BEFORE the request was sent (authorize() refused, the
 * request does not fit the contract, the served version, the function URL, the
 * idempotency key or the token is missing) refreshes nothing.
 *
 * The actions module under test is generated NOW from the fixture contract,
 * so a generator change is what this test sees. `next/cache` is replaced by a
 * recorder; the function is a real HTTP server speaking the Connect protocol,
 * which also records the exact request bytes that reached it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  PlaceOrderRequestSchema,
  PlaceOrderResponseSchema,
} from '../../fixtures/zone/src/generated/grpc/orders/v1/orders_pb';
import { generateFiles } from '../generate';
import * as runtime from '../runtime';
import { emptyDir, FIXTURE_ZONE, linkWorkspaceRuntime, removeScratchDirs } from './helpers';

const TAG = 'knext:orders:orders.v1.OrdersService';
const AUTHORIZE = Symbol.for('knext.test.glueActionRefresh.authorize');

const tags: string[] = [];
mock.module('next/cache', () => ({
  updateTag: (tag: string) => {
    tags.push(tag);
  },
  cacheTag: () => {},
  cacheLife: () => {},
}));
mock.module('server-only', () => ({}));
mock.module('@getknext/grpc/runtime', () => runtime);

type Behaviour = 'ok' | 'reset' | 'truncated' | 'unavailable';
let behaviour: Behaviour = 'ok';
const received: { path: string; body: Uint8Array }[] = [];
let server: Server | undefined;
let url = '';

type Action = (request: unknown, options?: { idempotencyKey: string }) => Promise<unknown>;
let actions: { placeOrder: Action; cancelOrder: Action };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: String(req.url), body: new Uint8Array(Buffer.concat(chunks)) });
      if (behaviour === 'reset') {
        // The function read (and, say, committed) the write; the response is lost.
        req.socket.destroy();
        return;
      }
      if (behaviour === 'truncated') {
        // The success response is cut off after its headers: no complete answer arrives.
        res.writeHead(200, { 'content-type': 'application/proto', 'content-length': '64' });
        res.write(new Uint8Array([0x0a, 0x03]));
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      if (behaviour === 'unavailable') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'unavailable', message: 'lost after commit' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/proto' });
      res.end(toBinary(PlaceOrderResponseSchema, create(PlaceOrderResponseSchema, { id: 'o-1' })));
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const dir = emptyDir('action-refresh');
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
  linkWorkspaceRuntime(dir);
  actions = await import(
    join(dir, 'src', 'generated', 'grpc', 'orders', 'v1', 'orders_knext_actions.ts')
  );
});

afterAll(() => {
  server?.close();
  removeScratchDirs();
});

const ENV_KEYS = ['ORDERS_SERVICE_URL', 'ORDERS_SERVICE_PROTO_VERSION'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function ready(): void {
  behaviour = 'ok';
  tags.length = 0;
  received.length = 0;
  process.env.ORDERS_SERVICE_URL = url;
  process.env.ORDERS_SERVICE_PROTO_VERSION = '1.2.0';
  (globalThis as Record<symbol, unknown>)[AUTHORIZE] = async () => ({ sub: 'alice' });
  runtime.registerTokenMinter(() => 'tok.alice');
}

afterEach(() => {
  runtime.registerTokenMinter(undefined);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('the action succeeded');
}

const codeOf = (err: unknown) => (err instanceof ConnectError ? err.code : 'not a ConnectError');

describe('a write that reached the function refreshes the cached reads', () => {
  it('a write that succeeds refreshes them once', async () => {
    ready();
    await actions.placeOrder({ sku: 's-1', quantity: 1 }, { idempotencyKey: 'k-1' });
    expect(received.map((r) => r.path)).toEqual(['/orders.v1.OrdersService/PlaceOrder']);
    expect(tags).toEqual([TAG]);
  });

  for (const action of ['placeOrder', 'cancelOrder'] as const) {
    it(`${action}: the connection resets after the function read the write: refreshed`, async () => {
      ready();
      behaviour = 'reset';
      await failure(actions[action]({ sku: 's-1', id: 'o-1' }, { idempotencyKey: 'k-2' }));
      expect(received).toHaveLength(1);
      expect(tags, 'a write whose response was lost may have committed').toEqual([TAG]);
    });
  }

  it('the response is cut off after its headers (no complete status): refreshed', async () => {
    ready();
    behaviour = 'truncated';
    await failure(actions.placeOrder({ sku: 's-1', quantity: 1 }, { idempotencyKey: 'k-5' }));
    expect(received).toHaveLength(1);
    expect(tags).toEqual([TAG]);
  });

  it('the function answers an error after receiving the write: refreshed, not retried', async () => {
    ready();
    behaviour = 'unavailable';
    const err = await failure(
      actions.placeOrder({ sku: 's-1', quantity: 1 }, { idempotencyKey: 'k-3' }),
    );
    expect(codeOf(err)).toBe(Code.Unavailable);
    expect(received).toHaveLength(1);
    expect(tags).toEqual([TAG]);
  });
});

describe('a write refused before it was sent refreshes nothing', () => {
  it('authorize() refuses: its error, unchanged, and no refresh', async () => {
    ready();
    const refused = new Error('NEXT_REDIRECT');
    (globalThis as Record<symbol, unknown>)[AUTHORIZE] = async () => {
      throw refused;
    };
    expect(await failure(actions.placeOrder({ sku: 's' }, { idempotencyKey: 'k' }))).toBe(refused);
    expect(received).toHaveLength(0);
    expect(tags).toEqual([]);
  });

  it('the request does not fit the contract: INVALID_ARGUMENT, no refresh', async () => {
    ready();
    const err = await failure(actions.placeOrder({ quantity: 1.5 }, { idempotencyKey: 'k' }));
    expect(codeOf(err)).toBe(Code.InvalidArgument);
    expect(received).toHaveLength(0);
    expect(tags).toEqual([]);
  });

  it('the served version is not set: FAILED_PRECONDITION, no refresh', async () => {
    ready();
    delete process.env.ORDERS_SERVICE_PROTO_VERSION;
    const err = await failure(actions.placeOrder({ sku: 's' }, { idempotencyKey: 'k' }));
    expect(codeOf(err)).toBe(Code.FailedPrecondition);
    expect(tags).toEqual([]);
  });

  it('the function URL is not set: FAILED_PRECONDITION, no refresh', async () => {
    ready();
    delete process.env.ORDERS_SERVICE_URL;
    const err = await failure(actions.placeOrder({ sku: 's' }, { idempotencyKey: 'k' }));
    expect(codeOf(err)).toBe(Code.FailedPrecondition);
    expect(received).toHaveLength(0);
    expect(tags).toEqual([]);
  });

  it('no idempotency key (a bare form post): INVALID_ARGUMENT, no refresh', async () => {
    ready();
    const err = await failure(actions.placeOrder({ sku: 's' }));
    expect(codeOf(err)).toBe(Code.InvalidArgument);
    expect(received).toHaveLength(0);
    expect(tags).toEqual([]);
  });

  it('no token minter: FAILED_PRECONDITION, no refresh', async () => {
    ready();
    runtime.registerTokenMinter(undefined);
    const err = await failure(actions.placeOrder({ sku: 's' }, { idempotencyKey: 'k' }));
    expect(codeOf(err)).toBe(Code.FailedPrecondition);
    expect(received).toHaveLength(0);
    expect(tags).toEqual([]);
  });
});

describe('what reaches the function is the contract and nothing else', () => {
  it('a forged $typeName and $unknown field 99 never reach the wire', async () => {
    ready();
    await actions.placeOrder(
      {
        $typeName: 'orders.v1.PlaceOrderRequest',
        sku: 'a',
        quantity: 1,
        $unknown: [{ no: 99, wireType: 2, data: new Uint8Array([3, 0x41, 0x42, 0x43]) }],
      },
      { idempotencyKey: 'k-4' },
    );
    expect(received).toHaveLength(1);
    const body = received[0]?.body as Uint8Array;
    expect(body).toEqual(
      toBinary(PlaceOrderRequestSchema, create(PlaceOrderRequestSchema, { sku: 'a', quantity: 1 })),
    );
    expect(fromBinary(PlaceOrderRequestSchema, body).$unknown).toBeUndefined();
  });
});
