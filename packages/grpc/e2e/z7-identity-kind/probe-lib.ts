/**
 * The host-side half of the Z7 kind e2e: one Connect call to a zone function,
 * through the cluster's cluster-local gateway, carrying a token the caller
 * chooses. `run.sh` drives it (see probe.ts) to prove a function ACCEPTS the
 * zone's token and REFUSES everything else.
 *
 * Tokens come from the real signer (`createZoneTokenSigner`), so the control
 * call is the production code path over the zone's real key. Each refused
 * variant is built to differ from the control in exactly one property
 * (probe.test.ts pins that against a reference verifier), so a refusal can
 * only be that property's doing.
 *
 * Nothing here prints a token or a key: {@link summarize} is the only output
 * the CLI produces and it carries status, the Connect code and the token's
 * public `kid`.
 */

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZoneTokenSigner, TOKEN_TTL_SECONDS } from '../../src/signer';

/** How the call authenticates. */
export type AuthMode =
  /** No Authorization header at all. */
  | 'none'
  /** A bearer value that is not a JWT. */
  | 'garbage'
  /** The real signer over `keyDir` (a directory of `current.key` / `current.kid`). */
  | 'signer'
  /** The real signer over a freshly generated key the function has never seen. */
  | 'foreign'
  /** A token naming `kid` in its header, signed by a freshly generated key. */
  | 'forged'
  /**
   * A token built by hand and signed by the zone's real key in `keyDir`, for the
   * two claims the real signer refuses to mint: an empty `sub` for an AUTH_USER RPC
   * and a lifetime over 60 s. Everything else is the signer's token, byte for byte.
   */
  | 'raw';

export interface ProbeAuth {
  readonly mode: AuthMode;
  /** `signer`: the directory holding the key to sign with. */
  readonly keyDir?: string;
  /** The zone's issuer, `knext:zone:<namespace>/<zone>`. */
  readonly issuer: string;
  /** The audience, `knext:fn:<namespace>/<function>`. */
  readonly audience: string;
  /** The RPC the token is minted for, `/<package>.<Service>/<Method>`. */
  readonly method: string;
  readonly sub: string;
  /** How long ago the token was issued, in seconds. 0 (default) is now. */
  readonly ageSeconds?: number;
  /** `raw`: the token's life, `exp - iat`, in seconds. Default 60, the contract's maximum. */
  readonly lifetimeSeconds?: number;
  /** `forged`: the kid to claim. */
  readonly kid?: string;
  /** The function's name in the zone's contract (default `example`). */
  readonly functionName?: string;
}

export interface Authorization {
  /** The Authorization header value, or undefined for no header. */
  readonly header?: string;
  /** The `kid` in the token's header (public), when a token was built. */
  readonly kid?: string;
}

function b64url(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** The contract's kid: base64url of the first 16 bytes of SHA-256 over the raw public key. */
function kidFor(publicKey: KeyObject): string {
  const x = publicKey.export({ format: 'jwk' }).x;
  const raw = Buffer.from(typeof x === 'string' ? x : '', 'base64url');
  return createHash('sha256').update(raw).digest().subarray(0, 16).toString('base64url');
}

/**
 * Run `use` with a fresh Ed25519 key written as a signing-key directory, and
 * remove the directory afterwards whatever `use` does.
 */
async function withFreshKey<T>(use: (dir: string, kid: string) => Promise<T>): Promise<T> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const kid = kidFor(publicKey);
  const dir = mkdtempSync(join(tmpdir(), 'knext-z7-probe-key-'));
  try {
    writeFileSync(join(dir, 'current.key'), pem, { mode: 0o600 });
    writeFileSync(join(dir, 'current.kid'), kid, { mode: 0o600 });
    return await use(dir, kid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function mintWithSigner(keyDir: string, a: ProbeAuth): Promise<string> {
  const signer = createZoneTokenSigner({
    keyDir,
    env: () => ({ KNEXT_ZONE_ISSUER: a.issuer }),
    audience: () => a.audience,
    now: () => Date.now() - (a.ageSeconds ?? 0) * 1000,
  });
  return signer({
    function: a.functionName ?? 'example',
    method: a.method,
    auth: 'user',
    sub: a.sub,
  });
}

/** The Authorization header (and the public kid) for a call. */
export async function authorizationHeader(a: ProbeAuth): Promise<Authorization> {
  switch (a.mode) {
    case 'none':
      return {};
    case 'garbage':
      return { header: 'Bearer not.a.jwt' };
    case 'signer': {
      if (!a.keyDir) throw new Error('mode signer needs a key directory');
      const token = await mintWithSigner(a.keyDir, a);
      return { header: `Bearer ${token}`, kid: headerKid(token) };
    }
    case 'foreign':
      return withFreshKey(async (dir, kid) => ({
        header: `Bearer ${await mintWithSigner(dir, a)}`,
        kid,
      }));
    case 'raw': {
      if (!a.keyDir) throw new Error('mode raw needs the zone key directory');
      const pem = readFileSync(join(a.keyDir, 'current.key'), 'utf8');
      const kid = readFileSync(join(a.keyDir, 'current.kid'), 'utf8').trim();
      const iat = Math.floor((Date.now() - (a.ageSeconds ?? 0) * 1000) / 1000);
      const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
      const claims = b64url(
        JSON.stringify({
          iss: a.issuer,
          aud: a.audience,
          method: a.method,
          sub: a.sub,
          iat,
          exp: iat + (a.lifetimeSeconds ?? TOKEN_TTL_SECONDS),
        }),
      );
      const signature = sign(
        null,
        Buffer.from(`${header}.${claims}`, 'utf8'),
        createPrivateKey(pem),
      ).toString('base64url');
      return { header: `Bearer ${header}.${claims}.${signature}`, kid };
    }
    case 'forged': {
      if (!a.kid) throw new Error('mode forged needs the kid to claim');
      const { privateKey } = generateKeyPairSync('ed25519');
      const iat = Math.floor((Date.now() - (a.ageSeconds ?? 0) * 1000) / 1000);
      const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: a.kid }));
      const claims = b64url(
        JSON.stringify({
          iss: a.issuer,
          aud: a.audience,
          method: a.method,
          sub: a.sub,
          iat,
          exp: iat + TOKEN_TTL_SECONDS,
        }),
      );
      const signature = sign(null, Buffer.from(`${header}.${claims}`, 'utf8'), privateKey).toString(
        'base64url',
      );
      return { header: `Bearer ${header}.${claims}.${signature}`, kid: a.kid };
    }
  }
}

function headerKid(token: string): string {
  const h = JSON.parse(
    Buffer.from(token.split('.')[0] as string, 'base64url').toString('utf8'),
  ) as {
    kid?: string;
  };
  return h.kid ?? '';
}

export interface CallOptions {
  /** The gateway to dial, e.g. `http://127.0.0.1:18080` (a port-forward to kourier-internal). */
  readonly base: string;
  /** The function's cluster-local host name, sent as the Host header: what Knative routes on. */
  readonly host: string;
  /** The RPC path, `/<package>.<Service>/<Method>`. */
  readonly procedure: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
  readonly timeoutMs?: number;
}

export interface CallOutcome {
  readonly status: number;
  /** The parsed JSON body, or null when it was empty or not JSON. */
  readonly body: unknown;
}

/**
 * One Connect unary call (JSON). It uses node:http, not fetch, because the
 * route is chosen by the Host header and a fetch implementation is free to
 * ignore one. A failure to connect or to get a response THROWS: only a
 * response from the function is a status.
 */
export function callFunction(o: CallOptions): Promise<CallOutcome> {
  const url = new URL(o.procedure, o.base);
  const payload = JSON.stringify(o.body);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          host: o.host,
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'content-length': Buffer.byteLength(payload),
          ...(o.authorization === undefined ? {} : { authorization: o.authorization }),
        },
        timeout: o.timeoutMs ?? 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = null;
          try {
            body = text === '' ? null : JSON.parse(text);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error(`no response from ${o.host} within the timeout`)),
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * The one line the CLI prints. A Connect error body's `message` is dropped (it
 * is the server's free text); only its `code` is kept. A success body is kept
 * so a caller can compare a read-back value.
 */
export function summarize(outcome: CallOutcome, kid: string | undefined): string {
  const body = outcome.body as { code?: unknown } | null;
  const code = outcome.status >= 400 && typeof body?.code === 'string' ? body.code : '';
  const out: Record<string, unknown> = { status: outcome.status, code, kid: kid ?? '' };
  if (outcome.status >= 200 && outcome.status < 300) out.body = outcome.body;
  return JSON.stringify(out);
}
