/**
 * The zone-side identity-token signer (`createZoneTokenSigner`): the token one
 * zone sends with every call to its functions.
 *
 * Every token is checked here the way a function's verifier checks it, with an
 * INDEPENDENT Ed25519 verify (`node:crypto` `verify`, the public key exported
 * as SPKI, not the signer's own derivation), and against the token contract:
 *
 * - header exactly `{"alg":"EdDSA","typ":"JWT","kid":"<kid>"}`, the kid being
 *   base64url (no padding) of the first 16 bytes of SHA-256 over the raw
 *   32-byte public key;
 * - claims exactly `iss`, `aud`, `method`, `sub`, `jti`, `iat`, `exp`, with
 *   `exp - iat <= 60` and integer seconds, and a `jti` that is at least 128
 *   random bits, different on every mint;
 * - `sub` from the verified user only: non-empty for an AUTH_USER RPC, empty
 *   for AUTH_PUBLIC, and nothing else the caller passes can set it.
 *
 * The key is read from the mounted Secret's files, laid out as kubelet lays
 * out a Secret volume (`current.key -> ..data/current.key`, `..data` a symlink
 * swapped atomically on update), and re-read when it changes.
 */

import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash, generateKeyPairSync, type KeyObject, verify } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Code, ConnectError } from '@connectrpc/connect';
import { urlEnvFor } from '../config';
import {
  audienceFromServiceUrl,
  createZoneTokenSigner,
  mintCallToken,
  registerTokenMinter,
  SIGNING_KEY_DIR,
  type TokenRequest,
  ZONE_ISSUER_ENV,
  type ZoneSignerOptions,
} from '../runtime';
import { emptyDir, PKG_DIR, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);
afterEach(() => registerTokenMinter(undefined));

const ISSUER = 'knext:zone:shop/storefront';
const URL_ENV = 'ORDERS_SERVICE_URL';
const FN_URL = 'http://orders.shop.svc.cluster.local';
const AUDIENCE = 'knext:fn:shop/orders';
const GET_ORDER = '/orders.v1.OrdersService/GetOrder';
const NOW_MS = 1_800_000_000_123;

interface TestKey {
  readonly pem: string;
  readonly publicKey: KeyObject;
  /** The kid, computed here from the SPKI encoding (not the signer's code path). */
  readonly kid: string;
}

function newKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  // An Ed25519 SPKI is a fixed 12-byte prefix and the raw 32-byte key.
  const raw = spki.subarray(spki.length - 32);
  const kid = createHash('sha256').update(raw).digest().subarray(0, 16).toString('base64url');
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, publicKey, kid };
}

/**
 * A directory laid out as kubelet lays out a Secret volume. `publish` writes a
 * new timestamped directory and swaps `..data` to it by rename, as kubelet does.
 */
function secretVolume(prefix: string): {
  dir: string;
  publish(files: Record<string, string>): void;
} {
  const dir = emptyDir(prefix);
  let generation = 0;
  let linked = false;
  return {
    dir,
    publish(files) {
      generation += 1;
      const version = `..2026_10_16_00_00_0${generation}`;
      mkdirSync(join(dir, version));
      for (const [name, content] of Object.entries(files))
        writeFileSync(join(dir, version, name), content);
      symlinkSync(version, join(dir, '..data_tmp'));
      renameSync(join(dir, '..data_tmp'), join(dir, '..data'));
      if (!linked) {
        for (const name of ['current.key', 'current.kid', 'previous.key', 'previous.kid'])
          symlinkSync(join('..data', name), join(dir, name));
        linked = true;
      }
    },
  };
}

function mountedKey(prefix: string, key: TestKey = newKey()) {
  const vol = secretVolume(prefix);
  vol.publish({ 'current.key': key.pem, 'current.kid': key.kid });
  return { ...vol, key };
}

function signer(keyDir: string, overrides: Partial<ZoneSignerOptions> = {}) {
  const env: Record<string, string | undefined> = {
    [ZONE_ISSUER_ENV]: ISSUER,
    [URL_ENV]: FN_URL,
  };
  return {
    env,
    mint: createZoneTokenSigner({ keyDir, env: () => env, now: () => NOW_MS, ...overrides }),
  };
}

const USER_CALL: TokenRequest = {
  function: 'orders',
  method: GET_ORDER,
  auth: 'user',
  sub: 'alice',
};

interface Decoded {
  readonly headerJson: string;
  readonly header: Record<string, unknown>;
  readonly claimsJson: string;
  readonly claims: Record<string, unknown>;
  readonly verified: boolean;
}

/** Decode and verify a token with node:crypto alone. */
function decode(token: string, publicKey: KeyObject): Decoded {
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  const [h, c, s] = parts as [string, string, string];
  for (const seg of parts) expect(seg).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  const headerJson = Buffer.from(h, 'base64url').toString('utf8');
  const claimsJson = Buffer.from(c, 'base64url').toString('utf8');
  const header = JSON.parse(headerJson);
  const claims = JSON.parse(claimsJson);
  // Every token minted here carries its kid in the JWS header, where the Go and
  // Rust verifiers read it, and never in the claims.
  expect(Object.keys(header)).toEqual(['alg', 'typ', 'kid']);
  expect(Object.keys(claims)).not.toContain('kid');
  return {
    headerJson,
    header,
    claimsJson,
    claims,
    verified: verify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')),
  };
}

async function failure(p: unknown): Promise<ConnectError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ConnectError) return err;
    throw err;
  }
  throw new Error('the mint succeeded');
}

describe('the token: shape, claims, signature', () => {
  it('is an EdDSA JWS whose header is exactly alg, typ and the contract kid', async () => {
    const { dir, key } = mountedKey('signer-header');
    const t = decode(await signer(dir).mint(USER_CALL), key.publicKey);
    expect(t.verified).toBe(true);
    expect(t.headerJson).toBe(`{"alg":"EdDSA","typ":"JWT","kid":"${key.kid}"}`);
  });

  it('carries exactly iss, aud, method, sub, jti, iat and exp, as the contract defines them', async () => {
    const { dir, key } = mountedKey('signer-claims');
    const t = decode(await signer(dir).mint(USER_CALL), key.publicKey);
    expect(Object.keys(t.claims)).toEqual(['iss', 'aud', 'method', 'sub', 'jti', 'iat', 'exp']);
    expect(t.claims).toEqual({
      iss: ISSUER,
      aud: AUDIENCE,
      method: GET_ORDER,
      sub: 'alice',
      jti: expect.any(String),
      iat: Math.floor(NOW_MS / 1000),
      exp: Math.floor(NOW_MS / 1000) + 60,
    });
  });

  it('gives every token a jti: at least 128 random bits, base64url, never repeated', async () => {
    const { dir, key } = mountedKey('signer-jti');
    // One clock reading for every mint: only the jti can tell the tokens apart.
    const { mint } = signer(dir);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const { claims } = decode(await mint(USER_CALL), key.publicKey);
      const jti = claims.jti;
      expect(typeof jti).toBe('string');
      expect(jti as string).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
      expect(Buffer.from(jti as string, 'base64url').length).toBeGreaterThanOrEqual(16);
      seen.add(jti as string);
    }
    expect(seen.size).toBe(2000);
  });

  it("the jti is signed: swapping it for another token's jti breaks the signature", async () => {
    const { dir, key } = mountedKey('signer-jti-signed');
    const { mint } = signer(dir);
    const a = await mint(USER_CALL);
    const b = decode(await mint(USER_CALL), key.publicKey).claims;
    const [h, , s] = a.split('.') as [string, string, string];
    const swapped = Buffer.from(
      JSON.stringify({ ...decode(a, key.publicKey).claims, jti: b.jti }),
    ).toString('base64url');
    expect(
      verify(null, Buffer.from(`${h}.${swapped}`), key.publicKey, Buffer.from(s, 'base64url')),
    ).toBe(false);
  });

  it('lives at most 60 seconds, in integer seconds', async () => {
    const { dir, key } = mountedKey('signer-ttl');
    const { claims } = decode(await signer(dir).mint(USER_CALL), key.publicKey);
    expect(Number.isInteger(claims.iat)).toBe(true);
    expect(Number.isInteger(claims.exp)).toBe(true);
    const ttl = (claims.exp as number) - (claims.iat as number);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('mints a fresh token per call, from the clock at call time', async () => {
    const { dir, key } = mountedKey('signer-fresh');
    let now = NOW_MS;
    const { mint } = signer(dir, { now: () => now });
    const first = decode(await mint(USER_CALL), key.publicKey).claims;
    now += 30_000;
    const second = decode(await mint(USER_CALL), key.publicKey).claims;
    expect((second.iat as number) - (first.iat as number)).toBe(30);
  });

  it('a token for one RPC does not verify as a token for another (method is signed)', async () => {
    const { dir, key } = mountedKey('signer-method');
    const token = await signer(dir).mint(USER_CALL);
    const [h, , s] = token.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({
        ...decode(token, key.publicKey).claims,
        method: '/orders.v1.OrdersService/CancelOrder',
      }),
    ).toString('base64url');
    expect(
      verify(null, Buffer.from(`${h}.${forged}`), key.publicKey, Buffer.from(s, 'base64url')),
    ).toBe(false);
  });
});

describe('the kid', () => {
  it('is base64url of the first 16 bytes of SHA-256 over the raw public key', async () => {
    const { dir, key } = mountedKey('signer-kid');
    const { header } = decode(await signer(dir).mint(USER_CALL), key.publicKey);
    expect(header.kid).toBe(key.kid);
    expect(key.kid).toHaveLength(22);
  });

  it('tolerates a trailing newline in current.kid', async () => {
    const key = newKey();
    const vol = secretVolume('signer-kid-newline');
    vol.publish({ 'current.key': key.pem, 'current.kid': `${key.kid}\n` });
    const { header } = decode(await signer(vol.dir).mint(USER_CALL), key.publicKey);
    expect(header.kid).toBe(key.kid);
  });

  it('refuses to sign when current.kid does not match current.key', async () => {
    const key = newKey();
    const vol = secretVolume('signer-kid-mismatch');
    vol.publish({ 'current.key': key.pem, 'current.kid': newKey().kid });
    const err = await failure(signer(vol.dir).mint(USER_CALL));
    expect(err.code).toBe(Code.FailedPrecondition);
    expect(err.rawMessage).toContain('current.kid');
  });
});

describe('the key: read from the mounted Secret, re-read when it changes', () => {
  it('picks up a rotated key (kubelet swaps ..data) without a restart', async () => {
    const a = newKey();
    const b = newKey();
    const vol = secretVolume('signer-rotate');
    vol.publish({ 'current.key': a.pem, 'current.kid': a.kid });
    const { mint } = signer(vol.dir);
    const before = decode(await mint(USER_CALL), a.publicKey);
    expect(before.header.kid).toBe(a.kid);
    expect(before.verified).toBe(true);

    vol.publish({
      'current.key': b.pem,
      'current.kid': b.kid,
      'previous.key': a.pem,
      'previous.kid': a.kid,
    });
    const after = decode(await mint(USER_CALL), b.publicKey);
    expect(after.header.kid).toBe(b.kid);
    expect(after.verified).toBe(true);
    expect(decode(await mint(USER_CALL), a.publicKey).verified).toBe(false);
  });

  it('picks up a key rewritten in place (a plain directory, not a Secret volume)', async () => {
    const a = newKey();
    const b = newKey();
    const dir = emptyDir('signer-inplace');
    writeFileSync(join(dir, 'current.key'), a.pem);
    writeFileSync(join(dir, 'current.kid'), a.kid);
    const { mint } = signer(dir);
    expect(decode(await mint(USER_CALL), a.publicKey).header.kid).toBe(a.kid);
    writeFileSync(join(dir, 'current.key'), b.pem);
    writeFileSync(join(dir, 'current.kid'), b.kid);
    const after = decode(await mint(USER_CALL), b.publicKey);
    expect(after.header.kid).toBe(b.kid);
    expect(after.verified).toBe(true);
  });

  it('signs with current.* only, never the staged next.* or the previous.* key', async () => {
    const current = newKey();
    const next = newKey();
    const previous = newKey();
    const vol = secretVolume('signer-slots');
    vol.publish({
      'current.key': current.pem,
      'current.kid': current.kid,
      'next.key': next.pem,
      'next.kid': next.kid,
      'previous.key': previous.pem,
      'previous.kid': previous.kid,
    });
    const t = decode(await signer(vol.dir).mint(USER_CALL), current.publicKey);
    expect(t.header.kid).toBe(current.kid);
    expect(t.verified).toBe(true);
  });

  it('fails closed, naming the path, when the Secret is not mounted (an empty directory)', async () => {
    const dir = emptyDir('signer-empty');
    const err = await failure(signer(dir).mint(USER_CALL));
    expect(err.code).toBe(Code.FailedPrecondition);
    expect(err.rawMessage).toContain(join(dir, 'current.key'));
  });

  it('fails closed when only the staged next.* key is present', async () => {
    const next = newKey();
    const dir = emptyDir('signer-next-only');
    writeFileSync(join(dir, 'next.key'), next.pem);
    writeFileSync(join(dir, 'next.kid'), next.kid);
    expect((await failure(signer(dir).mint(USER_CALL))).code).toBe(Code.FailedPrecondition);
  });

  it('refuses a key that is not Ed25519', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    }) as string;
    const dir = emptyDir('signer-rsa');
    writeFileSync(join(dir, 'current.key'), rsa);
    writeFileSync(join(dir, 'current.kid'), 'AAAAAAAAAAAAAAAAAAAAAA');
    const err = await failure(signer(dir).mint(USER_CALL));
    expect(err.code).toBe(Code.FailedPrecondition);
    expect(err.rawMessage).toContain('Ed25519');
  });

  it('refuses a key file that is not a PEM key, without echoing its content', async () => {
    const dir = emptyDir('signer-garbage');
    const content = 'not-a-key-SECRET-MATERIAL-1234567890';
    writeFileSync(join(dir, 'current.key'), content);
    writeFileSync(join(dir, 'current.kid'), 'AAAAAAAAAAAAAAAAAAAAAA');
    const err = await failure(signer(dir).mint(USER_CALL));
    expect(err.code).toBe(Code.FailedPrecondition);
    expect(err.message).not.toContain('SECRET-MATERIAL');
    expect(String(err.cause ?? '')).not.toContain('SECRET-MATERIAL');
  });
});

describe('sub: the verified user, and only the verified user', () => {
  it('an AUTH_USER call without a sub is refused before anything is signed', async () => {
    const { dir } = mountedKey('signer-user-nosub');
    const { mint } = signer(dir);
    for (const sub of [undefined, '']) {
      const err = await failure(mint({ function: 'orders', method: GET_ORDER, auth: 'user', sub }));
      expect(err.code).toBe(Code.Unauthenticated);
    }
  });

  it('a request that does not say its auth is treated as AUTH_USER (fails closed)', async () => {
    const { dir } = mountedKey('signer-noauth');
    const err = await failure(signer(dir).mint({ function: 'orders', method: GET_ORDER }));
    expect(err.code).toBe(Code.Unauthenticated);
  });

  it('refuses a sub with a control character or over 512 characters', async () => {
    const { dir } = mountedKey('signer-badsub');
    const { mint } = signer(dir);
    for (const sub of ['al\nice', 'x'.repeat(513)]) {
      const err = await failure(mint({ ...USER_CALL, sub }));
      expect(err.code).toBe(Code.Unauthenticated);
    }
  });

  it('an AUTH_PUBLIC call carries an empty sub, and is still signed by the zone', async () => {
    const { dir, key } = mountedKey('signer-public');
    const t = decode(
      await signer(dir).mint({ function: 'orders', method: GET_ORDER, auth: 'public' }),
      key.publicKey,
    );
    expect(t.verified).toBe(true);
    expect(t.claims.sub).toBe('');
    expect(t.claims.iss).toBe(ISSUER);
  });

  it('nothing else in the token request reaches the token: a body field named sub or userId is ignored', async () => {
    const { dir, key } = mountedKey('signer-body');
    const request = {
      ...USER_CALL,
      userId: 'mallory',
      body: { sub: 'mallory', userId: 'mallory' },
      claims: { sub: 'mallory', aud: 'knext:fn:shop/payments' },
      iss: 'knext:zone:shop/attacker',
      aud: 'knext:fn:shop/payments',
    } as TokenRequest;
    const t = decode(await signer(dir).mint(request), key.publicKey);
    expect(t.claims).toEqual({
      iss: ISSUER,
      aud: AUDIENCE,
      method: GET_ORDER,
      sub: 'alice',
      jti: expect.any(String),
      iat: Math.floor(NOW_MS / 1000),
      exp: Math.floor(NOW_MS / 1000) + 60,
    });
    expect(t.claimsJson).not.toContain('mallory');
  });
});

describe('iss, aud and method come from the zone, never from the caller', () => {
  it('fails closed when the zone has no issuer', async () => {
    const { dir } = mountedKey('signer-noiss');
    const s = signer(dir);
    delete s.env[ZONE_ISSUER_ENV];
    const err = await failure(s.mint(USER_CALL));
    expect(err.code).toBe(Code.FailedPrecondition);
    expect(err.rawMessage).toContain(ZONE_ISSUER_ENV);
  });

  it('refuses an issuer that is not knext:zone:<namespace>/<zone>', async () => {
    const { dir } = mountedKey('signer-badiss');
    const s = signer(dir);
    for (const bad of [
      'storefront',
      'knext:zone:storefront',
      'knext:fn:shop/orders',
      'knext:zone:Shop/x',
    ]) {
      s.env[ZONE_ISSUER_ENV] = bad;
      expect((await failure(s.mint(USER_CALL))).code).toBe(Code.FailedPrecondition);
    }
  });

  it('reads the issuer at call time', async () => {
    const { dir, key } = mountedKey('signer-iss-calltime');
    const s = signer(dir);
    s.env[ZONE_ISSUER_ENV] = 'knext:zone:shop/checkout';
    expect(decode(await s.mint(USER_CALL), key.publicKey).claims.iss).toBe(
      'knext:zone:shop/checkout',
    );
  });

  it('derives aud from the function address the operator renders', () => {
    expect(audienceFromServiceUrl('orders', URL_ENV, FN_URL)).toBe(AUDIENCE);
    expect(
      audienceFromServiceUrl('orders', URL_ENV, 'http://orders-v2.shop.svc.cluster.local:8080/'),
    ).toBe('knext:fn:shop/orders-v2');
  });

  it('derives the BackendService and namespace from every address in the shared binding fixture', () => {
    // The operator's Go test renders exactly this env from these bindings, so a
    // change to the address shape on the operator side reds this test.
    const fixture = JSON.parse(
      readFileSync(
        join(PKG_DIR, '..', 'kn-next-operator/internal/controller/testdata/zone-binding-env.json'),
        'utf8',
      ),
    ) as {
      namespace: string;
      cases: {
        bindings: { name: string; service: string; state: string }[];
        env: Record<string, string>;
      }[];
    };
    let bound = 0;
    for (const c of fixture.cases) {
      for (const b of c.bindings) {
        if (b.state !== 'Bound') continue;
        const env = urlEnvFor(b.name);
        expect(audienceFromServiceUrl(b.name, env, c.env[env])).toBe(
          `knext:fn:${fixture.namespace}/${b.service}`,
        );
        bound += 1;
      }
    }
    expect(bound).toBeGreaterThan(0);
  });

  it('refuses an address that is not a cluster-local function address', async () => {
    for (const bad of [
      undefined,
      '',
      'not a url',
      'http://127.0.0.1:8080',
      'http://orders.shop.svc.cluster.local.evil.example',
      'http://orders.svc.cluster.local',
      'http://a.b.shop.svc.cluster.local',
      'ftp://orders.shop.svc.cluster.local',
    ]) {
      expect(() => audienceFromServiceUrl('orders', URL_ENV, bad), String(bad)).toThrow(
        ConnectError,
      );
    }
  });

  it('fails closed when the function address names another namespace than the zone', async () => {
    const { dir } = mountedKey('signer-ns');
    const s = signer(dir);
    s.env[URL_ENV] = 'http://orders.payments.svc.cluster.local';
    const err = await failure(s.mint(USER_CALL));
    expect(err.code).toBe(Code.FailedPrecondition);
  });

  it('refuses a method that is not a fully qualified RPC path', async () => {
    const { dir } = mountedKey('signer-badmethod');
    const { mint } = signer(dir);
    for (const method of [
      'GetOrder',
      '/GetOrder',
      '/OrdersService/GetOrder',
      'orders.v1.OrdersService/GetOrder',
      '/a.B/C/D',
    ]) {
      expect((await failure(mint({ ...USER_CALL, method }))).code, method).toBe(Code.Internal);
    }
  });
});

describe('the default signer and the minter seam', () => {
  it('with no minter registered, mintCallToken uses the mounted-Secret signer, and fails closed without it', async () => {
    const saved = process.env[ZONE_ISSUER_ENV];
    process.env[ZONE_ISSUER_ENV] = ISSUER;
    process.env[URL_ENV] = FN_URL;
    try {
      const err = await failure(mintCallToken(USER_CALL));
      expect(err.code).toBe(Code.FailedPrecondition);
      expect(err.rawMessage).toContain(join(SIGNING_KEY_DIR, 'current.key'));
    } finally {
      if (saved === undefined) delete process.env[ZONE_ISSUER_ENV];
      else process.env[ZONE_ISSUER_ENV] = saved;
      delete process.env[URL_ENV];
    }
  });

  it('the default key directory is the operator mount', () => {
    expect(SIGNING_KEY_DIR).toBe('/var/run/knext/signing-key');
  });

  it('a registered signer is what mintCallToken uses', async () => {
    const { dir, key } = mountedKey('signer-registered');
    registerTokenMinter(signer(dir).mint);
    const t = decode(await mintCallToken(USER_CALL), key.publicKey);
    expect(t.verified).toBe(true);
    expect(t.claims.sub).toBe('alice');
  });
});

describe('nothing secret is logged or echoed', () => {
  it('neither a success nor a refusal writes to the console, and errors carry no key or token', async () => {
    const { dir, key } = mountedKey('signer-quiet');
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const s = signer(dir);
      const token = await s.mint(USER_CALL);
      const errors: ConnectError[] = [];
      errors.push(await failure(s.mint({ ...USER_CALL, sub: '' })));
      s.env[URL_ENV] = 'http://orders.payments.svc.cluster.local';
      errors.push(await failure(s.mint(USER_CALL)));
      writeFileSync(join(dir, '..data', 'current.kid'), 'AAAAAAAAAAAAAAAAAAAAAA');
      s.env[URL_ENV] = FN_URL;
      errors.push(await failure(s.mint(USER_CALL)));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      const pemBody = key.pem.split('\n')[1] as string;
      for (const err of errors) {
        const text = `${err.message} ${err.stack ?? ''} ${String(err.cause ?? '')}`;
        expect(text).not.toContain(token);
        expect(text).not.toContain(pemBody);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      rmSync(join(dir, '..data', 'current.kid'), { force: true });
    }
  });
});
