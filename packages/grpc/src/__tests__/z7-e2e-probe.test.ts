/**
 * The Z7 kind e2e's host-side probe (e2e/z7-identity-kind/probe-lib.ts).
 *
 * The e2e proves a function REFUSES a bad token. That proof is empty unless the
 * bad token is bad in exactly one way: a "foreign key" token that also had a
 * wrong claim would be refused for the wrong reason and would stay refused if
 * the signature check were removed. So these tests pin, against a reference
 * verifier built to the token contract, that
 *
 *   - the control token (the zone's real key, through the real signer) is
 *     accepted, and
 *   - every refused variant differs from it in ONE property and passes every
 *     other check the reference verifier makes.
 *
 * They also pin that the probe sets the Host header (the way the e2e reaches a
 * cluster-local function through the gateway) and that what it prints never
 * contains a token or key material.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync, type KeyObject, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizationHeader,
  callFunction,
  type ProbeAuth,
  summarize,
} from '../../e2e/z7-identity-kind/probe-lib';

const dir = mkdtempSync(join(tmpdir(), 'knext-z7-probe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ISSUER = 'knext:zone:shop/storefront';
const AUDIENCE = 'knext:fn:shop/pricing';
const METHOD = '/example.v1.ExampleService/PutItem';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;

function kidOf(pub: KeyObject): string {
  const spki = pub.export({ format: 'der', type: 'spki' });
  return createHash('sha256')
    .update(spki.subarray(spki.length - 32))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}
const KID = kidOf(publicKey);

const KEY_DIR = join(dir, 'signing-key');
mkdirSync(KEY_DIR);
writeFileSync(join(KEY_DIR, 'current.key'), PEM);
writeFileSync(join(KEY_DIR, 'current.kid'), KID);

const base: ProbeAuth = {
  mode: 'signer',
  keyDir: KEY_DIR,
  issuer: ISSUER,
  audience: AUDIENCE,
  method: METHOD,
  sub: 'alice',
};

interface Parts {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly signatureOk: boolean;
}

/** Split a Bearer header and check the signature under the REAL public key. */
function parts(authorization: string | undefined): Parts {
  const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(authorization ?? '');
  if (!m) throw new Error(`not a bearer JWT: ${authorization}`);
  return {
    header: JSON.parse(Buffer.from(m[1] as string, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(m[2] as string, 'base64url').toString('utf8')),
    signatureOk: verify(
      null,
      Buffer.from(`${m[1]}.${m[2]}`),
      publicKey,
      Buffer.from(m[3] as string, 'base64url'),
    ),
  };
}

/** The contract's checks, minus the signature: every claim a verifier tests. */
function claimsOk(p: Parts, now = Date.now()): { ok: boolean; why: string[] } {
  const why: string[] = [];
  const c = p.claims as Record<string, number | string>;
  if (
    JSON.stringify(Object.keys(c)) !== JSON.stringify(['iss', 'aud', 'method', 'sub', 'iat', 'exp'])
  )
    why.push('claim set');
  if (c.iss !== ISSUER) why.push('iss');
  if (c.aud !== AUDIENCE) why.push('aud');
  if (c.method !== METHOD) why.push('method');
  if (c.sub !== 'alice') why.push('sub');
  const iat = c.iat as number;
  const exp = c.exp as number;
  if (exp - iat > 60 || exp <= iat) why.push('lifetime');
  const s = Math.floor(now / 1000);
  if (s >= exp + 5) why.push('expired');
  if (iat > s + 5) why.push('future');
  return { ok: why.length === 0, why };
}

describe('the control token: the real signer over the zone key', () => {
  it('is accepted by a reference verifier (signature, header and every claim)', async () => {
    const { header } = await authorizationHeader(base);
    const p = parts(header);
    expect(p.header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: KID });
    expect(p.signatureOk).toBe(true);
    expect(claimsOk(p)).toEqual({ ok: true, why: [] });
  });
});

describe('every refused variant differs from the control in exactly one property', () => {
  it('foreign key: only the key (and so the kid) differs; the real key rejects its signature', async () => {
    const { header, kid } = await authorizationHeader({ ...base, mode: 'foreign' });
    const p = parts(header);
    expect(kid).not.toBe(KID);
    expect(p.header.kid).toBe(kid as string);
    expect(p.signatureOk).toBe(false);
    expect(claimsOk(p)).toEqual({ ok: true, why: [] });
  });

  it('forged kid: claims the real kid, signed by another key; only the signature fails', async () => {
    const { header } = await authorizationHeader({ ...base, mode: 'forged', kid: KID });
    const p = parts(header);
    expect(p.header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: KID });
    expect(p.signatureOk).toBe(false);
    expect(claimsOk(p)).toEqual({ ok: true, why: [] });
  });

  it('wrong function: only aud differs, signed by the real key', async () => {
    const { header } = await authorizationHeader({ ...base, audience: 'knext:fn:shop/inventory' });
    const p = parts(header);
    expect(p.signatureOk).toBe(true);
    expect(p.claims.aud).toBe('knext:fn:shop/inventory');
    expect(claimsOk(p).why).toEqual(['aud']);
  });

  it('wrong method: only method differs, signed by the real key', async () => {
    const { header } = await authorizationHeader({
      ...base,
      method: '/example.v1.ExampleService/GetItem',
    });
    const p = parts(header);
    expect(p.signatureOk).toBe(true);
    expect(claimsOk(p).why).toEqual(['method']);
  });

  it('wrong issuer: only iss differs, signed by the real key', async () => {
    const { header } = await authorizationHeader({ ...base, issuer: 'knext:zone:shop/other' });
    const p = parts(header);
    expect(p.signatureOk).toBe(true);
    expect(claimsOk(p).why).toEqual(['iss']);
  });

  it('expired: only the lifetime window is in the past, signed by the real key', async () => {
    const { header } = await authorizationHeader({ ...base, ageSeconds: 300 });
    const p = parts(header);
    expect(p.signatureOk).toBe(true);
    expect(claimsOk(p).why).toEqual(['expired']);
    expect((p.claims.exp as number) - (p.claims.iat as number)).toBe(60);
  });

  it('no token and a garbage token carry no usable JWT', async () => {
    expect((await authorizationHeader({ ...base, mode: 'none' })).header).toBeUndefined();
    expect((await authorizationHeader({ ...base, mode: 'garbage' })).header).toBe(
      'Bearer not.a.jwt',
    );
  });
});

describe('the probe leaves nothing of the key behind', () => {
  it('a foreign-key mint removes the temporary key directory it wrote', async () => {
    const before = new Set(
      (await import('node:fs'))
        .readdirSync(tmpdir())
        .filter((n) => n.startsWith('knext-z7-probe-key-')),
    );
    await authorizationHeader({ ...base, mode: 'foreign' });
    const after = (await import('node:fs'))
      .readdirSync(tmpdir())
      .filter((n) => n.startsWith('knext-z7-probe-key-') && !before.has(n));
    expect(after).toEqual([]);
  });
});

describe('callFunction', () => {
  it('sends the Host header it was given and the Authorization it was given', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthenticated', message: 'nope' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const out = await callFunction({
        base: `http://127.0.0.1:${port}`,
        host: 'pricing.shop.svc.cluster.local',
        procedure: METHOD,
        body: { id: 'a', value: 'b' },
        authorization: 'Bearer x.y.z',
      });
      expect(out.status).toBe(401);
      expect(out.body).toEqual({ code: 'unauthenticated', message: 'nope' });
      expect(seen[0]?.host).toBe('pricing.shop.svc.cluster.local');
      expect(seen[0]?.authorization).toBe('Bearer x.y.z');
      expect(seen[0]?.['content-type']).toBe('application/json');
    } finally {
      server.close();
    }
  });

  it('reports a connection failure as a thrown error, never as a status', async () => {
    await expect(
      callFunction({
        base: 'http://127.0.0.1:1',
        host: 'h',
        procedure: METHOD,
        body: {},
        authorization: undefined,
      }),
    ).rejects.toThrow();
  });
});

describe('summarize', () => {
  it('prints status, Connect code and the header kid, and never a token or a key', () => {
    const pem = PEM.split('\n').filter((l) => l && !l.startsWith('-----'))[0] as string;
    const line = summarize(
      { status: 401, body: { code: 'unauthenticated', message: `bad ${pem}` } },
      KID,
    );
    expect(JSON.parse(line)).toEqual({ status: 401, code: 'unauthenticated', kid: KID });
    expect(line).not.toContain(pem);
  });

  it('carries the body of a success so the e2e can compare a read-back value', () => {
    const line = summarize({ status: 200, body: { id: 'a', value: 'v' } }, undefined);
    expect(JSON.parse(line)).toEqual({
      status: 200,
      code: '',
      kid: '',
      body: { id: 'a', value: 'v' },
    });
  });
});
