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
describe('hand-built tokens, signed by the zone key (mode raw)', () => {
  // The real signer will not mint a token with no sub for an AUTH_USER RPC, nor one
  // that lives past 60 s. The e2e still has to prove the FUNCTION refuses both, so
  // those two are built by hand with the zone's real key. A refusal then proves
  // something only if each differs from a control built the same way in exactly one
  // property; the control is itself pinned to the real signer's token.
  const raw: ProbeAuth = { ...base, mode: 'raw' };

  it('the real signer refuses to mint either of them, which is why they are hand-built', async () => {
    await expect(authorizationHeader({ ...base, sub: '' })).rejects.toThrow();
  });

  it('the raw control is the real signer token: same header, same claim set, same values, accepted', async () => {
    const signer = parts((await authorizationHeader(base)).header);
    const control = parts((await authorizationHeader(raw)).header);
    expect(control.header).toEqual(signer.header);
    expect(Object.keys(control.claims)).toEqual(Object.keys(signer.claims));
    for (const k of ['iss', 'aud', 'method', 'sub'])
      expect(control.claims[k]).toBe(signer.claims[k]);
    expect((control.claims.exp as number) - (control.claims.iat as number)).toBe(60);
    expect(control.signatureOk).toBe(true);
    expect(claimsOk(control)).toEqual({ ok: true, why: [] });
  });

  it('an empty sub: only sub differs from the control, and the real key signed it', async () => {
    const empty = parts((await authorizationHeader({ ...raw, sub: '' })).header);
    const control = parts((await authorizationHeader(raw)).header);
    expect(empty.header).toEqual(control.header);
    expect(empty.claims.sub).toBe('');
    expect(empty.signatureOk).toBe(true);
    expect(claimsOk(empty).why).toEqual(['sub']);
    for (const k of ['iss', 'aud', 'method']) expect(empty.claims[k]).toBe(control.claims[k]);
    expect((empty.claims.exp as number) - (empty.claims.iat as number)).toBe(60);
  });

  it('a lifetime over 60 s: only exp differs from the control, and the real key signed it', async () => {
    const long = parts((await authorizationHeader({ ...raw, lifetimeSeconds: 61 })).header);
    const control = parts((await authorizationHeader(raw)).header);
    expect(long.header).toEqual(control.header);
    expect((long.claims.exp as number) - (long.claims.iat as number)).toBe(61);
    expect(long.signatureOk).toBe(true);
    expect(claimsOk(long).why).toEqual(['lifetime']);
    for (const k of ['iss', 'aud', 'method', 'sub']) expect(long.claims[k]).toBe(control.claims[k]);
  });

  it('a lifetime of exactly 60 s is the control, not a variant', async () => {
    const sixty = parts((await authorizationHeader({ ...raw, lifetimeSeconds: 60 })).header);
    expect(claimsOk(sixty)).toEqual({ ok: true, why: [] });
  });

  it('needs the zone key directory', async () => {
    await expect(authorizationHeader({ ...raw, keyDir: undefined })).rejects.toThrow();
  });
});

describe('the probe command line', () => {
  it('--sub= sends an empty sub and --lifetime sets the token life, both signed by the key dir', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthenticated', message: 'nope' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    // Async: the server above lives in this process, so a blocking spawn would starve it.
    const run = async (extra: string[]) => {
      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, '../../e2e/z7-identity-kind/probe.ts'),
          '--base',
          `http://127.0.0.1:${port}`,
          '--host',
          'pricing.shop.svc.cluster.local',
          '--issuer',
          ISSUER,
          '--rpc',
          'put',
          '--auth',
          'raw',
          '--key-dir',
          KEY_DIR,
          ...extra,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      return { exitCode: await proc.exited, stdout: await new Response(proc.stdout).text() };
    };
    try {
      const emptySub = await run(['--sub=']);
      expect(emptySub.exitCode).toBe(0);
      const a = parts(seen[0]?.authorization);
      expect(a.claims.sub).toBe('');
      expect(a.signatureOk).toBe(true);

      const long = await run(['--sub', 'alice', '--lifetime', '61']);
      expect(long.exitCode).toBe(0);
      const b = parts(seen[1]?.authorization);
      expect((b.claims.exp as number) - (b.claims.iat as number)).toBe(61);
      expect(b.claims.sub).toBe('alice');

      // What it prints is one JSON line with the status and the Connect code only.
      const out = JSON.parse(emptySub.stdout);
      expect(out).toEqual({ status: 401, code: 'unauthenticated', kid: KID });
    } finally {
      server.close();
    }
  });
});
