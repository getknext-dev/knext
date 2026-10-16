import { describe, expect, it } from 'bun:test';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildVectors,
  REASONS,
  type Reason,
  T0,
  VECTORS_PATH,
} from '../../scripts/gen-z7-token-vectors';

/**
 * The shared zone-identity token vectors (packages/grpc/testdata), which the Go
 * and Rust zone-function verifiers and the zone-side signer all test against.
 *
 * Two properties hold the file honest:
 *   1. it is exactly what the generator writes (no hand edits, reproducible);
 *   2. every case's outcome is what an independent reference verifier,
 *      written here from the token contract, computes — and every negative
 *      case is refused for the reason it names, so a language verifier that
 *      drops one check fails that check's case and no other.
 */

type Vectors = ReturnType<typeof buildVectors>;
type Case = Vectors['cases'][number];
type JWK = Record<string, unknown>;

const committed: Vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));

class Refused extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

const refuse = (reason: Reason): never => {
  throw new Refused(reason);
};

/** Strict base64url: the URL alphabet only, no padding, canonical trailing bits. */
function b64(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) refuse('malformed');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) refuse('malformed');
  return bytes;
}

/** The top-level member names of a JSON object text, in order, duplicates kept. */
function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && expectKey) keys.push(JSON.parse(text.slice(i, j + 1)));
      expectKey = false;
      i = j;
    } else if (c === '{' || c === '[') {
      depth++;
      expectKey = c === '{' && depth === 1;
    } else if (c === '}' || c === ']') {
      depth--;
    } else if (c === ',' && depth === 1) {
      expectKey = true;
    }
  }
  return keys;
}

function object(bytes: Buffer): Record<string, unknown> {
  const text = bytes.toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse('malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse('malformed');
  const keys = topLevelKeys(text);
  if (new Set(keys).size !== keys.length) refuse('malformed');
  return value as Record<string, unknown>;
}

const kidOf = (raw: Buffer) =>
  createHash('sha256').update(raw).digest().subarray(0, 16).toString('base64url');

/** The usable keys of a JWK Set: Ed25519 OKP keys whose kid is derived from x. */
function usableKeys(set: { keys: JWK[] }): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const k of set.keys) {
    if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.x !== 'string') continue;
    const raw = Buffer.from(k.x, 'base64url');
    if (raw.length !== 32 || k.kid !== kidOf(raw)) continue;
    keys.set(k.kid, raw);
  }
  return keys;
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

type Skip = Partial<Record<Reason, true>>;

/** The contract's verifier. `skip` drops named checks, to show a case is single-fault. */
function referenceVerify(c: Case, skip: Skip = {}): string {
  if (c.jws === null) return refuse('no-token');
  if (c.jws.length !== 3) refuse('malformed');
  const [h, p, s] = c.jws as [string, string, string];
  const header = object(b64(h));
  const payloadBytes = b64(p);
  const signature = b64(s);
  for (const k of Object.keys(header)) if (!['alg', 'typ', 'kid'].includes(k)) refuse('malformed');
  if (header.typ !== 'JWT' || typeof header.kid !== 'string' || header.kid === '') {
    refuse('malformed');
  }
  if (header.alg !== 'EdDSA' && !skip['bad-alg']) refuse('bad-alg');
  const set = committed.jwks[c.jwks as keyof Vectors['jwks']];
  const raw = usableKeys(set).get(header.kid as string) ?? refuse('unknown-kid');
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  if (!skip['bad-signature'] && !verify(null, Buffer.from(`${h}.${p}`, 'ascii'), key, signature)) {
    refuse('bad-signature');
  }
  const claims = object(payloadBytes);
  for (const name of ['iss', 'aud', 'method', 'sub']) {
    if (typeof claims[name] !== 'string') refuse('malformed');
  }
  for (const name of ['iat', 'exp']) if (!Number.isSafeInteger(claims[name])) refuse('malformed');
  const iat = claims.iat as number;
  const exp = claims.exp as number;
  if (!skip.lifetime && !(exp - iat > 0 && exp - iat <= 60)) refuse('lifetime');
  if (!skip.expired && c.now >= exp + 5) refuse('expired');
  if (!skip['not-yet-valid'] && iat > c.now + 5) refuse('not-yet-valid');
  if (!skip['wrong-issuer'] && claims.iss !== committed.verifier.issuer) refuse('wrong-issuer');
  if (!skip['wrong-audience'] && claims.aud !== committed.verifier.audience) {
    refuse('wrong-audience');
  }
  if (!skip['wrong-method'] && claims.method !== c.procedure) refuse('wrong-method');
  if (!skip['missing-subject'] && c.auth === 'AUTH_USER' && claims.sub === '') {
    refuse('missing-subject');
  }
  return claims.sub as string;
}

function outcome(c: Case, skip?: Skip): { expect: 'accept'; sub: string } | Refused {
  try {
    return { expect: 'accept', sub: referenceVerify(c, skip) };
  } catch (err) {
    if (err instanceof Refused) return err;
    throw err;
  }
}

describe('z7 token vectors', () => {
  it('are exactly what the generator writes', () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildVectors())));
  });

  it('every case meets its expectation under the reference verifier', () => {
    for (const c of committed.cases) {
      const got = outcome(c);
      if (c.expect === 'accept') {
        expect({ name: c.name, got }).toEqual({
          name: c.name,
          got: { expect: 'accept', sub: c.sub },
        });
      } else {
        expect({ name: c.name, reason: got instanceof Refused ? got.reason : 'accepted' }).toEqual({
          name: c.name,
          reason: c.reason,
        });
      }
    }
  });

  // A case refused for one reason but also broken in another way would still
  // be refused by a verifier that dropped the named check: no mutation of
  // that check could ever be caught by it.
  it('every claim-, time- and signature-level negative is single-fault', () => {
    const singleFault: Reason[] = [
      'bad-signature',
      'lifetime',
      'expired',
      'not-yet-valid',
      'wrong-issuer',
      'wrong-audience',
      'wrong-method',
      'missing-subject',
    ];
    let checked = 0;
    for (const c of committed.cases) {
      if (c.expect !== 'reject' || !singleFault.includes(c.reason)) continue;
      const got = outcome(c, { [c.reason]: true });
      expect({ name: c.name, accepted: !(got instanceof Refused) }).toEqual({
        name: c.name,
        accepted: true,
      });
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(12);
    // alg confusion with a VALID EdDSA signature is caught only by the alg check.
    const algName = committed.cases.find((c) => c.name === 'alg-ed25519-name');
    expect(algName && !(outcome(algName, { 'bad-alg': true }) instanceof Refused)).toBe(true);
  });

  it('covers every negative case the contract names, and only known reasons', () => {
    const names = new Set(committed.cases.map((c) => c.name));
    for (const required of [
      'valid-user',
      'valid-public',
      'expired',
      'wrong-key',
      'unknown-kid',
      'no-token',
      'wrong-audience',
      'wrong-issuer',
      'cross-zone',
      'wrong-method',
      'alg-none',
      'alg-hs256-with-public-key',
      'lifetime-over-60',
      'user-empty-sub',
      'rotation-previous-during-overlap',
      'rotation-previous-after-overlap',
      'rotation-next-before-propagation',
      'rotation-next-after-propagation',
    ]) {
      expect({ required, present: names.has(required) }).toEqual({ required, present: true });
    }
    for (const c of committed.cases) {
      if (c.expect === 'reject') expect(REASONS).toContain(c.reason);
    }
  });

  it('every kid in a well-formed JWK Set is derived from its key, and the clock is fixed', () => {
    for (const [name, key] of Object.entries(committed.keys)) {
      expect({ name, kid: kidOf(Buffer.from(key.x, 'base64url')) }).toEqual({ name, kid: key.kid });
      // The seed is the SHA-256 of the public label: test material, never a secret.
      expect(createHash('sha256').update(key.label).digest('base64url')).toBe(key.seed);
    }
    for (const c of committed.cases) expect(c.now).toBe(T0);
  });

  it('stores no token in compact form (so no scanner mistakes test tokens for leaks)', () => {
    const text = readFileSync(VECTORS_PATH, 'utf8');
    expect(/ey[A-Za-z0-9_-]{17,}\.ey[A-Za-z0-9_-]{17,}\./.test(text)).toBe(false);
    expect(text).not.toContain('PRIVATE KEY');
  });
});
