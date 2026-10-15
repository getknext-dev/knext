/**
 * Every case the glue generator refuses, one test each. A refusal is a
 * `knext generate` that exits 1, names the RPC and the fix, and writes nothing.
 * Each is mutation-proved by `scripts/mutation-prove-2050-zone-glue.mjs`.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrdersService } from '../../fixtures/zone/src/generated/grpc/orders/v1/orders_pb';
import { generateFiles, runGenerate } from '../generate';
import { emitActionGuard } from '../glue-plugin';
import { capture, copyFixtureZone, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const ORDERS = 'proto/orders/v1/orders.proto';
const OPTIONS = 'proto/knext/v1/options.proto';
const OUT = join('src', 'generated', 'grpc');

function edit(zone: string, rel: string, from: string, to: string): void {
  const path = join(zone, rel);
  const text = readFileSync(path, 'utf8');
  if (text.split(from).length !== 2) throw new Error(`anchor not unique in ${rel}: ${from}`);
  writeFileSync(path, text.replace(from, to));
}

/** Generate into a fresh output dir; return [exit code, stderr]. */
async function refused(zone: string): Promise<{ code: number; err: string; wrote: boolean }> {
  rmSync(join(zone, OUT), { recursive: true, force: true });
  const c = capture();
  const code = await runGenerate({ cwd: zone, io: c.io });
  return { code, err: c.err(), wrote: existsSync(join(zone, OUT)) };
}

const PLACE_ORDER_AUTH =
  '  rpc PlaceOrder(PlaceOrderRequest) returns (PlaceOrderResponse) {\n    option (knext.v1.auth) = AUTH_USER;\n  }';

describe('glue refusals', () => {
  it('the fixture itself generates (the refusals below are not a broken baseline)', () => {
    expect(generateFiles(copyFixtureZone('refuse-baseline')).size).toBeGreaterThan(0);
  });

  it('refuses a unary RPC that does not state its auth option', async () => {
    const zone = copyFixtureZone('refuse-no-auth');
    edit(
      zone,
      ORDERS,
      PLACE_ORDER_AUTH,
      '  rpc PlaceOrder(PlaceOrderRequest) returns (PlaceOrderResponse);',
    );
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('orders.v1.OrdersService.PlaceOrder');
    expect(r.err).toContain('(knext.v1.auth)');
    expect(r.wrote).toBe(false);
  });

  it('refuses a streaming RPC that does not state its auth option', async () => {
    const zone = copyFixtureZone('refuse-no-auth-stream');
    edit(
      zone,
      ORDERS,
      '    option idempotency_level = NO_SIDE_EFFECTS;\n    option (knext.v1.auth) = AUTH_USER;\n  }\n}',
      '    option idempotency_level = NO_SIDE_EFFECTS;\n  }\n}',
    );
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('orders.v1.OrdersService.WatchOrders');
    expect(r.err).toContain('(knext.v1.auth)');
  });

  it('refuses an RPC whose auth is stated as AUTH_UNSPECIFIED', async () => {
    const zone = copyFixtureZone('refuse-unspecified');
    edit(zone, ORDERS, PLACE_ORDER_AUTH, PLACE_ORDER_AUTH.replace('AUTH_USER', 'AUTH_UNSPECIFIED'));
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('orders.v1.OrdersService.PlaceOrder');
  });

  it('refuses AUTH_PUBLIC on a write', async () => {
    const zone = copyFixtureZone('refuse-public-write');
    edit(zone, ORDERS, PLACE_ORDER_AUTH, PLACE_ORDER_AUTH.replace('AUTH_USER', 'AUTH_PUBLIC'));
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('orders.v1.OrdersService.PlaceOrder');
    expect(r.err).toContain('AUTH_PUBLIC');
    expect(r.err).toContain('NO_SIDE_EFFECTS');
    expect(r.wrote).toBe(false);
  });

  it('refuses AUTH_PUBLIC on an IDEMPOTENT write (IDEMPOTENT is still a write)', async () => {
    const zone = copyFixtureZone('refuse-public-idempotent');
    edit(
      zone,
      ORDERS,
      '    option idempotency_level = IDEMPOTENT;\n    option (knext.v1.auth) = AUTH_USER;',
      '    option idempotency_level = IDEMPOTENT;\n    option (knext.v1.auth) = AUTH_PUBLIC;',
    );
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('orders.v1.OrdersService.CancelOrder');
  });

  it('refuses AUTH_PUBLIC_MUTATION: the shipped options contract reserves it', async () => {
    const zone = copyFixtureZone('refuse-public-mutation');
    edit(
      zone,
      ORDERS,
      PLACE_ORDER_AUTH,
      PLACE_ORDER_AUTH.replace('AUTH_USER', 'AUTH_PUBLIC_MUTATION'),
    );
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('AUTH_PUBLIC_MUTATION');
    expect(r.wrote).toBe(false);
  });

  it('refuses AUTH_PUBLIC_MUTATION even when an edited options contract defines it', async () => {
    const zone = copyFixtureZone('refuse-public-mutation-defined');
    edit(
      zone,
      OPTIONS,
      '  reserved 3;\n  reserved "AUTH_PUBLIC_MUTATION";',
      '  AUTH_PUBLIC_MUTATION = 3;',
    );
    edit(
      zone,
      ORDERS,
      PLACE_ORDER_AUTH,
      PLACE_ORDER_AUTH.replace('AUTH_USER', 'AUTH_PUBLIC_MUTATION'),
    );
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('orders.v1.OrdersService.PlaceOrder');
    expect(r.err).toContain('AUTH_USER or AUTH_PUBLIC');
    expect(r.wrote).toBe(false);
  });

  it('refuses a contract built against an options file with no auth option at all', async () => {
    const zone = copyFixtureZone('refuse-old-options');
    // The options contract as it was before the auth option existed, and a
    // contract that therefore cannot state it.
    const options = readFileSync(join(zone, OPTIONS), 'utf8');
    writeFileSync(join(zone, OPTIONS), options.slice(0, options.indexOf('// Who may call an RPC')));
    writeFileSync(
      join(zone, ORDERS),
      readFileSync(join(zone, ORDERS), 'utf8').replaceAll(
        '    option (knext.v1.auth) = AUTH_USER;\n',
        '',
      ),
    );
    unlinkSync(join(zone, 'proto/orders/v1/catalog.proto'));
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('(knext.v1.auth)');
    expect(r.err).toContain('options.proto');
  });

  it('refuses a client-streaming RPC (only unary and server-streaming RPCs get glue)', async () => {
    const zone = copyFixtureZone('refuse-client-stream');
    edit(
      zone,
      ORDERS,
      '  rpc WatchOrders(WatchOrdersRequest) returns (stream WatchOrdersResponse) {',
      '  rpc WatchOrders(stream WatchOrdersRequest) returns (WatchOrdersResponse) {',
    );
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('orders.v1.OrdersService.WatchOrders');
    expect(r.err).toContain('server-streaming');
  });

  it('refuses a bidi-streaming RPC', async () => {
    const zone = copyFixtureZone('refuse-bidi');
    edit(
      zone,
      ORDERS,
      '  rpc WatchOrders(WatchOrdersRequest) returns (stream WatchOrdersResponse) {',
      '  rpc WatchOrders(stream WatchOrdersRequest) returns (stream WatchOrdersResponse) {',
    );
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('orders.v1.OrdersService.WatchOrders');
  });

  it('never emits an action for a streaming RPC, whatever asks for one', () => {
    const stream = OrdersService.methods.find((m) => m.localName === 'watchOrders');
    const write = OrdersService.methods.find((m) => m.localName === 'placeOrder');
    if (!stream || !write) throw new Error('fixture changed');
    expect(() => emitActionGuard(stream)).toThrow(/streaming/);
    expect(() => emitActionGuard(write)).not.toThrow();
  });

  it('refuses to generate without an authorize() hook in knext.grpc.json', async () => {
    const zone = copyFixtureZone('refuse-no-authorize');
    edit(zone, 'knext.grpc.json', '  "authorize": "src/knext/authorize.ts",\n', '');
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('authorize');
    expect(r.err).toContain('knext.grpc.json');
    expect(r.wrote).toBe(false);
  });

  it('refuses an authorize() hook that names a file that does not exist', async () => {
    const zone = copyFixtureZone('refuse-missing-authorize');
    unlinkSync(join(zone, 'src/knext/authorize.ts'));
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('src/knext/authorize.ts');
  });

  it('refuses two services in one file whose RPCs would export the same name', async () => {
    const zone = copyFixtureZone('refuse-collision');
    const path = join(zone, ORDERS);
    writeFileSync(
      path,
      `${readFileSync(path, 'utf8')}
// AuditService repeats an RPC name of OrdersService.
service AuditService {
  // GetOrder collides with OrdersService.GetOrder in the generated module.
  rpc GetOrder(AuditServiceGetOrderRequest) returns (AuditServiceGetOrderResponse) {
    option idempotency_level = NO_SIDE_EFFECTS;
    option (knext.v1.auth) = AUTH_USER;
  }
}

// AuditServiceGetOrderRequest names an order.
message AuditServiceGetOrderRequest {
  string id = 1;
}

// AuditServiceGetOrderResponse is its audit trail.
message AuditServiceGetOrderResponse {
  repeated string events = 1;
}
`,
    );
    const r = await refused(zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain('getOrder');
  });
});
