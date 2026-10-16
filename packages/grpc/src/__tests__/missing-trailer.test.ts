/**
 * A response that loses its status is fail-closed and never retried.
 *
 * gRPC carries the call status in an HTTP/2 trailer (`grpc-status`). A proxy on
 * the cold path that drops trailers turns a write that SUCCEEDED into a
 * response with no status; retrying it would apply the write twice. Connect
 * carries a stream's status in a final end-of-stream message, which a
 * truncated stream loses the same way.
 *
 * A real HTTP/2 server here answers every call with a well-formed message and
 * no status at all. The generated client must fail the call, with exactly ONE
 * request sent: for a write (never retried anyway), for a read (whose policy
 * allows three attempts, but only on UNAVAILABLE), and for a stream.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { createServer, type Http2Server, type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { create, toBinary } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { createConnectTransport, createGrpcTransport } from '@connectrpc/connect-node';
import {
  GetOrderResponseSchema,
  OrdersService,
  PlaceOrderResponseSchema,
  WatchOrdersResponseSchema,
} from '../../fixtures/zone/src/generated/grpc/orders/v1/orders_pb';
import { defineFunctionClient } from '../runtime';

const DEFINITION = {
  service: OrdersService,
  function: 'orders',
  urlEnv: 'ORDERS_SERVICE_URL',
  contractVersion: '1.2.0',
  deadlineMs: 10000,
  gatewayTimeoutMs: 300000,
  methods: {
    getOrder: { kind: 'read', retry: { maxAttempts: 3 } },
    placeOrder: { kind: 'mutation', idempotencyKey: 'required' },
    cancelOrder: { kind: 'mutation', idempotencyKey: 'required' },
    watchOrders: { kind: 'stream' },
  },
} as const;

function envelope(body: Uint8Array): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, Buffer.from(body)]);
}

const servers: Http2Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

/** A server that answers every call with a valid message and NO status. */
async function statusless(): Promise<{ url: string; hits: Record<string, number> }> {
  const hits: Record<string, number> = {};
  const server = createServer();
  server.on('stream', (stream: ServerHttp2Stream, headers) => {
    const path = String(headers[':path']);
    hits[path] = (hits[path] ?? 0) + 1;
    stream.on('data', () => {});
    stream.on('end', () => {
      const grpc = String(headers['content-type']).startsWith('application/grpc');
      const body = path.endsWith('/GetOrder')
        ? toBinary(GetOrderResponseSchema, create(GetOrderResponseSchema, { id: 'o-1' }))
        : path.endsWith('/PlaceOrder')
          ? toBinary(PlaceOrderResponseSchema, create(PlaceOrderResponseSchema, { id: 'o-1' }))
          : toBinary(WatchOrdersResponseSchema, create(WatchOrdersResponseSchema, { id: 'o-1' }));
      stream.respond({
        ':status': 200,
        'content-type': grpc ? 'application/grpc+proto' : 'application/connect+proto',
      });
      // A message, then the end of the HTTP/2 stream: no grpc-status trailer,
      // and no Connect end-of-stream message.
      stream.end(envelope(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

async function failure(p: Promise<unknown>): Promise<ConnectError> {
  try {
    await p;
  } catch (err) {
    return ConnectError.from(err);
  }
  throw new Error('the call succeeded without a status');
}

describe('a missing status is fail-closed and non-retryable', () => {
  it('gRPC read with no grpc-status trailer: fails, one request, no retry', async () => {
    const { url, hits } = await statusless();
    const client = defineFunctionClient(DEFINITION, {
      env: () => ({ ORDERS_SERVICE_URL: url }),
      createTransport: (baseUrl) => createGrpcTransport({ baseUrl }),
      sleep: async () => {},
      log: () => {},
    });
    const err = await failure(client.getOrder({ id: 'o-1' }));
    expect(err.code).not.toBe(Code.Unavailable);
    expect(err.code).toBe(Code.Internal);
    expect(err.rawMessage).toContain('missing');
    expect(hits['/orders.v1.OrdersService/GetOrder']).toBe(1);
  });

  it('gRPC write with no grpc-status trailer: fails, one request', async () => {
    const { url, hits } = await statusless();
    const client = defineFunctionClient(DEFINITION, {
      env: () => ({ ORDERS_SERVICE_URL: url }),
      createTransport: (baseUrl) => createGrpcTransport({ baseUrl }),
      sleep: async () => {},
      log: () => {},
    });
    const err = await failure(client.placeOrder({ sku: 's' }, { idempotencyKey: 'k-1' }));
    expect(err.code).toBe(Code.Internal);
    expect(hits['/orders.v1.OrdersService/PlaceOrder']).toBe(1);
  });

  it('Connect stream that ends with no end-of-stream status: fails, one request', async () => {
    const { url, hits } = await statusless();
    const client = defineFunctionClient(DEFINITION, {
      env: () => ({ ORDERS_SERVICE_URL: url, ORDERS_SERVICE_HTTP_VERSION: '2' }),
      createTransport: (baseUrl, httpVersion) => createConnectTransport({ baseUrl, httpVersion }),
      log: () => {},
    });
    const seen: string[] = [];
    const err = await failure(
      (async () => {
        for await (const m of client.watchOrders({})) seen.push(m.id);
      })(),
    );
    expect(err.rawMessage).toContain('EndStreamResponse');
    expect(hits['/orders.v1.OrdersService/WatchOrders']).toBe(1);
  });
});
