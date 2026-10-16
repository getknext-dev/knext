/**
 * The runtime half of the generated glue (`@getknext/grpc/runtime`): the
 * end-user check, the served-version read, the token-mint seam and the request
 * codec. Every one of them fails closed.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { create, toBinary } from '@bufbuild/protobuf';
import { BinaryReader, base64Encode } from '@bufbuild/protobuf/wire';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  GetOrderRequestSchema,
  PlaceOrderRequestSchema,
} from '../../fixtures/zone/src/generated/grpc/orders/v1/orders_pb';
import { protoVersionEnvFor, SERVICE_PROTO_VERSION_SUFFIX } from '../config';
import {
  decodeRequest,
  encodeRequest,
  mintCallToken,
  normalizeRequest,
  PUBLIC_SUBJECT,
  QUERY_CACHE_LIFE,
  registerTokenMinter,
  servedVersion,
  subjectSub,
  userSubject,
} from '../runtime';

const CTX = {
  function: 'orders',
  service: 'orders.v1.OrdersService',
  method: 'GetOrder',
  kind: 'read',
} as const;

async function code(p: Promise<unknown> | (() => unknown)): Promise<Code | 'ok' | 'other'> {
  try {
    if (typeof p === 'function') p();
    else await p;
    return 'ok';
  } catch (err) {
    return err instanceof ConnectError ? err.code : 'other';
  }
}

afterEach(() => registerTokenMinter(undefined));

describe('userSubject — the fail-closed end-user check', () => {
  it('a verified user becomes a user subject', async () => {
    const subject = await userSubject(async () => ({ sub: 'alice' }), CTX);
    expect(subject).toBe('user:alice');
    expect(subjectSub(subject)).toBe('alice');
  });

  it('passes the call context to authorize()', async () => {
    let seen: unknown;
    await userSubject((ctx) => {
      seen = ctx;
      return { sub: 'a' };
    }, CTX);
    expect(seen).toEqual(CTX);
  });

  it('rethrows what authorize() throws, unchanged (a redirect stays a redirect)', async () => {
    const thrown = new Error('NEXT_REDIRECT');
    await expect(
      userSubject(() => {
        throw thrown;
      }, CTX),
    ).rejects.toBe(thrown);
  });

  it('refuses a principal without a usable sub, as UNAUTHENTICATED', async () => {
    for (const bad of [
      undefined,
      null,
      {},
      { sub: '' },
      { sub: 42 },
      { sub: 'a\nb' },
      { sub: 'x'.repeat(513) },
    ]) {
      expect(await code(userSubject(async () => bad as never, CTX)), JSON.stringify(bad)).toBe(
        Code.Unauthenticated,
      );
    }
  });

  it('a user subject never equals the public subject, whatever the sub', async () => {
    const subject = await userSubject(async () => ({ sub: PUBLIC_SUBJECT }), CTX);
    expect(subject).not.toBe(PUBLIC_SUBJECT);
    expect(subjectSub(PUBLIC_SUBJECT)).toBeUndefined();
  });
});

describe('servedVersion — the served contract version, part of every cache key', () => {
  const ENV = 'ORDERS_SERVICE_PROTO_VERSION';

  it('one helper names the variable: <NAME>_SERVICE_PROTO_VERSION', () => {
    expect(protoVersionEnvFor('orders')).toBe(ENV);
    expect(protoVersionEnvFor('user-profile')).toBe('USER_PROFILE_SERVICE_PROTO_VERSION');
    expect(SERVICE_PROTO_VERSION_SUFFIX).toBe('_SERVICE_PROTO_VERSION');
  });

  it('returns the served version when it is at least the zone version', () => {
    expect(servedVersion('orders', ENV, '1.2.0', { [ENV]: '1.2.0' })).toBe('1.2.0');
    expect(servedVersion('orders', ENV, '1.2.0', { [ENV]: '1.3.1' })).toBe('1.3.1');
  });

  it('fails closed with FAILED_PRECONDITION when the variable is not set, naming it', async () => {
    expect(await code(() => servedVersion('orders', ENV, '1.2.0', {}))).toBe(
      Code.FailedPrecondition,
    );
    expect(() => servedVersion('orders', ENV, '1.2.0', { [ENV]: '' })).toThrow(`${ENV} is not set`);
  });

  it('fails closed on a version that is not MAJOR.MINOR.PATCH', async () => {
    expect(await code(() => servedVersion('orders', ENV, '1.2.0', { [ENV]: 'latest' }))).toBe(
      Code.FailedPrecondition,
    );
  });

  it('fails closed when the function is older than the zone (skew)', async () => {
    expect(await code(() => servedVersion('orders', ENV, '1.2.0', { [ENV]: '1.1.9' }))).toBe(
      Code.FailedPrecondition,
    );
  });

  it('reads the variable at call time', () => {
    const env: Record<string, string> = {};
    env[ENV] = '1.2.0';
    expect(servedVersion('orders', ENV, '1.2.0', env)).toBe('1.2.0');
    env[ENV] = '1.4.0';
    expect(servedVersion('orders', ENV, '1.2.0', env)).toBe('1.4.0');
  });
});

describe('mintCallToken — the identity-token seam', () => {
  it('fails closed when no minter is registered and the zone has no signing key', async () => {
    // With nothing registered the default zone signer mints; this process has
    // no mounted key and no KNEXT_ZONE_ISSUER, so a well-formed request for a
    // signed-in user is still refused before anything is sent.
    expect(
      await code(
        mintCallToken({
          function: 'orders',
          method: '/orders.v1.OrdersService/GetOrder',
          auth: 'user',
          sub: 'alice',
        }),
      ),
    ).toBe(Code.FailedPrecondition);
  });

  it('calls the registered minter with the function, the RPC and the sub', async () => {
    const seen: unknown[] = [];
    registerTokenMinter((req) => {
      seen.push(req);
      return 'tok-1';
    });
    const token = await mintCallToken({
      function: 'orders',
      method: '/orders.v1.OrdersService/GetOrder',
      sub: 'alice',
    });
    expect(token).toBe('tok-1');
    expect(seen).toEqual([
      { function: 'orders', method: '/orders.v1.OrdersService/GetOrder', sub: 'alice' },
    ]);
  });

  it('refuses an empty or non-string token from the minter', async () => {
    registerTokenMinter(() => '' as string);
    expect(await code(mintCallToken({ function: 'orders', method: '/a.B/C' }))).toBe(
      Code.Unauthenticated,
    );
  });

  it('is anchored on globalThis, so a duplicated module copy sees the same minter', async () => {
    registerTokenMinter(() => 'shared');
    const key = Symbol.for('knext.grpc.tokenMinter');
    expect(typeof (globalThis as Record<symbol, unknown>)[key]).toBe('function');
  });
});

describe('request codec — what crosses the cache key and the action boundary', () => {
  it('encodes deterministically and round-trips', () => {
    const a = encodeRequest(GetOrderRequestSchema, { id: 'o-1' });
    expect(encodeRequest(GetOrderRequestSchema, create(GetOrderRequestSchema, { id: 'o-1' }))).toBe(
      a,
    );
    expect(decodeRequest(GetOrderRequestSchema, a).id).toBe('o-1');
    expect(a).not.toBe(encodeRequest(GetOrderRequestSchema, { id: 'o-2' }));
  });

  it('normalizeRequest keeps only the contract fields of an untrusted input', () => {
    const m = normalizeRequest(GetOrderRequestSchema, { id: 'o-1', admin: true } as never);
    expect(m.id).toBe('o-1');
    expect('admin' in m).toBe(false);
  });

  it('refuses an input that does not fit the contract, as INVALID_ARGUMENT', async () => {
    expect(
      await code(() => normalizeRequest(PlaceOrderRequestSchema, { quantity: 1.5 } as never)),
    ).toBe(Code.InvalidArgument);
    expect(await code(() => decodeRequest(GetOrderRequestSchema, '%%%'))).toBe(
      Code.InvalidArgument,
    );
  });

  // Field 99 is in no fixture contract; 0x9a 0x06 is its tag (length-delimited).
  const FIELD_99 = { no: 99, wireType: 2, data: new Uint8Array([3, 0x41, 0x42, 0x43]) };
  const CLEAN = toBinary(
    PlaceOrderRequestSchema,
    create(PlaceOrderRequestSchema, { sku: 'a', quantity: 1 }),
  );
  const FORGED = {
    $typeName: 'orders.v1.PlaceOrderRequest',
    sku: 'a',
    quantity: 1,
  };

  /** Every field number on the wire, read with the contract's own reader. */
  function wireFields(bytes: Uint8Array): number[] {
    const r = new BinaryReader(bytes);
    const out: number[] = [];
    while (r.pos < r.len) {
      const [no, wt] = r.tag();
      out.push(no);
      r.skip(wt);
    }
    return out;
  }

  it('a forged $typeName with a $unknown field 99 forwards only the contract fields', () => {
    const m = normalizeRequest(PlaceOrderRequestSchema, {
      ...FORGED,
      $unknown: [FIELD_99],
    } as never);
    expect(m.$unknown).toBeUndefined();
    const wire = toBinary(PlaceOrderRequestSchema, m);
    expect(wireFields(wire)).toEqual([1, 2]);
    expect(wire).toEqual(CLEAN);
  });

  it('a $unknown entry whose data is a plain array forwards only the contract fields', () => {
    const m = normalizeRequest(PlaceOrderRequestSchema, {
      ...FORGED,
      $unknown: [{ no: 99, wireType: 2, data: [3, 0x41, 0x42, 0x43] }],
    } as never);
    expect(toBinary(PlaceOrderRequestSchema, m)).toEqual(CLEAN);
  });

  it('a caller-supplied $unknown is never encoded, even one the encoder would choke on', () => {
    for (const $unknown of [[{}], 'x', [{ no: 99, wireType: 2 }]]) {
      const m = normalizeRequest(PlaceOrderRequestSchema, { ...FORGED, $unknown } as never);
      expect(toBinary(PlaceOrderRequestSchema, m), JSON.stringify($unknown)).toEqual(CLEAN);
    }
  });

  it('the cache key of a forged request carries only the contract fields', () => {
    const key = encodeRequest(PlaceOrderRequestSchema, {
      ...FORGED,
      $unknown: [FIELD_99],
    } as never);
    expect(key).toBe(encodeRequest(PlaceOrderRequestSchema, { sku: 'a', quantity: 1 }));
  });

  it('decoding a request drops a field the contract does not have', () => {
    const withField99 = new Uint8Array([...CLEAN, 0x9a, 0x06, 3, 0x41, 0x42, 0x43]);
    expect(wireFields(withField99)).toEqual([1, 2, 99]);
    const m = decodeRequest(PlaceOrderRequestSchema, base64Encode(withField99));
    expect(m.$unknown).toBeUndefined();
    expect(toBinary(PlaceOrderRequestSchema, m)).toEqual(CLEAN);
  });

  it('a plain array, null or a primitive is not a request: INVALID_ARGUMENT', async () => {
    for (const bad of [[], ['a', 1], null, 'sku', 42]) {
      expect(
        await code(() => normalizeRequest(PlaceOrderRequestSchema, bad as never)),
        JSON.stringify(bad),
      ).toBe(Code.InvalidArgument);
      expect(
        await code(() => encodeRequest(GetOrderRequestSchema, bad as never)),
        JSON.stringify(bad),
      ).toBe(Code.InvalidArgument);
    }
  });

  it('the per-user cache life expires within an hour', () => {
    expect(QUERY_CACHE_LIFE.expire).toBeLessThanOrEqual(3600);
    expect(QUERY_CACHE_LIFE.revalidate).toBeLessThanOrEqual(QUERY_CACHE_LIFE.expire);
  });
});
