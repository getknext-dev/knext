import { describe, expect, it } from 'bun:test';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildVectors,
  NON_CANONICAL_KEY,
  OFF_CURVE_KEY,
  PRIVATE_JWK_MEMBERS,
  REASONS,
  type Reason,
  SMALL_ORDER_KEYS,
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
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('malformed');
  }
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

// edwards25519, in affine coordinates over BigInt: enough to decode a public
// key strictly and to compute [8]A, written from RFC 8032 rather than taken
// from any of the verifiers it checks.
const FIELD_P = (1n << 255n) - 19n;
const fmod = (a: bigint) => ((a % FIELD_P) + FIELD_P) % FIELD_P;
function fpow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = fmod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % FIELD_P;
    b = (b * b) % FIELD_P;
  }
  return result;
}
const finv = (a: bigint) => fpow(a, FIELD_P - 2n);
const CURVE_D = fmod(-121665n * finv(121666n));
const SQRT_M1 = fpow(2n, (FIELD_P - 1n) / 4n);
type Point = { x: bigint; y: bigint };

/**
 * RFC 8032 §5.1.3 decoding, strict: null for y >= p, a y off the curve, or
 * x = 0 signed. `lax` reduces y mod p and ignores the sign of x = 0 instead,
 * as many verifiers do, to name the point a non-canonical encoding aliases.
 */
function decodePoint(raw: Buffer, lax = false): Point | null {
  const le = BigInt(`0x${Buffer.from(raw).reverse().toString('hex')}`);
  const sign = le >> 255n;
  let y = le & ((1n << 255n) - 1n);
  if (y >= FIELD_P) {
    if (!lax) return null;
    y -= FIELD_P;
  }
  const x2 = fmod((y * y - 1n) * finv(CURVE_D * y * y + 1n));
  let x = fpow(x2, (FIELD_P + 3n) / 8n);
  if (fmod(x * x - x2) !== 0n) x = fmod(x * SQRT_M1);
  if (fmod(x * x - x2) !== 0n) return null;
  if (x === 0n && sign === 1n && !lax) return null;
  if ((x & 1n) !== sign) x = FIELD_P - x;
  return { x, y };
}

function addPoints(a: Point, b: Point): Point {
  const t = fmod(CURVE_D * a.x * b.x * a.y * b.y);
  return {
    x: fmod((a.x * b.y + b.x * a.y) * finv(1n + t)),
    y: fmod((a.y * b.y + a.x * b.x) * finv(1n - t)),
  };
}

/** [8]P is the identity: P lies in the small-order (torsion) subgroup. */
function smallOrder(p: Point): boolean {
  let q = p;
  for (let i = 0; i < 3; i++) q = addPoints(q, q);
  return q.x === 0n && q.y === 1n;
}

/** A public key a verifier may trust: a canonical encoding of a point outside the small-order subgroup. */
function strongKey(raw: Buffer): boolean {
  const point = decodePoint(raw);
  return point !== null && !smallOrder(point);
}

/**
 * The usable keys of a JWK Set: Ed25519 OKP keys whose kid is derived from x
 * and whose x is a strong key. A set in which any JWK carries private key
 * material is refused whole.
 */
function usableKeys(set: { keys: JWK[] }, skip: Skip = {}): Map<string, Buffer> {
  if (!skip['bad-jwks'] && set.keys.some((k) => PRIVATE_JWK_MEMBERS.some((m) => m in k))) {
    refuse('bad-jwks');
  }
  const keys = new Map<string, Buffer>();
  for (const k of set.keys) {
    if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.x !== 'string') continue;
    const raw = Buffer.from(k.x, 'base64url');
    if (raw.length !== 32 || k.kid !== kidOf(raw)) continue;
    if (!skip['weak-key'] && !strongKey(raw)) continue;
    keys.set(k.kid, raw);
  }
  return keys;
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A check to drop: a refusal reason, or `weak-key` (trust any 32-byte x). */
type Skip = Partial<Record<Reason | 'weak-key', true>>;

/** A `jti` is 22-64 base64url characters (a 128-bit random id is exactly 22). */
const JTI_FORMAT = /^[A-Za-z0-9_-]{22,64}$/;

/** What a verifier takes from a token it accepts, for the replay set. */
interface Accepted {
  readonly sub: string;
  readonly iss: string;
  readonly jti: string;
  readonly exp: number;
}

/** The contract's verifier. `skip` drops named checks, to show a case is single-fault. */
function referenceVerify(
  c: Pick<Case, 'jws' | 'jwks' | 'now' | 'procedure' | 'auth'>,
  skip: Skip = {},
): Accepted {
  if (c.jws === null) return refuse('no-token');
  // The mounted JWKS is read before the token is looked at.
  const keys = usableKeys(committed.jwks[c.jwks as keyof Vectors['jwks']], skip);
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
  const raw = keys.get(header.kid as string) ?? refuse('unknown-kid');
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
  if (!('jti' in claims)) {
    if (!skip['missing-jti']) refuse('missing-jti');
  } else if (typeof claims.jti !== 'string' || !JTI_FORMAT.test(claims.jti)) {
    refuse('malformed');
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
  return {
    sub: claims.sub as string,
    iss: claims.iss as string,
    jti: (claims.jti ?? '') as string,
    exp,
  };
}

function outcome(c: Case, skip?: Skip): { expect: 'accept'; sub: string } | Refused {
  try {
    return { expect: 'accept', sub: referenceVerify(c, skip).sub };
  } catch (err) {
    if (err instanceof Refused) return err;
    throw err;
  }
}

type Sequence = Vectors['sequences'][number];
type Step = Sequence['steps'][number];

/**
 * The contract's replay set, written from the contract: keyed by (iss, jti), an
 * entry lives until exp + skew and is then purged; a token seen before is
 * `replayed`, even when the set is full; a new token into a full set is
 * `seen-set-full` and is never recorded. A token is recorded only after every
 * other check has passed. Returns each step's outcome, in order.
 */
function runSequence(seq: Sequence, skip: Skip = {}): Array<'accept' | Reason> {
  const capacity = seq.capacity ?? committed.contract.defaultSeenCapacity;
  const seen = new Map<string, number>();
  return seq.steps.map((step: Step) => {
    const c = { ...seq, jws: step.jws, now: step.now };
    try {
      const got = referenceVerify(c, skip);
      for (const [key, expiry] of seen) if (expiry <= step.now) seen.delete(key);
      const key = `${got.iss}\n${got.jti}`;
      if (!skip.replayed && seen.has(key)) refuse('replayed');
      if (!skip['seen-set-full'] && !seen.has(key) && seen.size >= capacity) {
        refuse('seen-set-full');
      }
      seen.set(key, got.exp + committed.contract.clockSkewSeconds);
      return 'accept' as const;
    } catch (err) {
      if (err instanceof Refused) return err.reason;
      throw err;
    }
  });
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
      'bad-jwks',
      'missing-jti',
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
    expect(checked).toBeGreaterThanOrEqual(22);
    // alg confusion with a VALID EdDSA signature is caught only by the alg check.
    const algName = committed.cases.find((c) => c.name === 'alg-ed25519-name');
    expect(algName && !(outcome(algName, { 'bad-alg': true }) instanceof Refused)).toBe(true);
  });

  it('every replay sequence meets its expectation under the reference replay set', () => {
    expect(committed.sequences.length).toBeGreaterThanOrEqual(8);
    for (const seq of committed.sequences) {
      const got = runSequence(seq);
      expect({ name: seq.name, got }).toEqual({
        name: seq.name,
        got: seq.steps.map((st) => (st.expect === 'accept' ? 'accept' : st.reason)),
      });
    }
  });

  // A refusal for `replayed` or `seen-set-full` must be the replay set's doing
  // alone: a verifier without that rule must not refuse the step for that reason.
  it('every replay-set refusal is single-fault', () => {
    let checked = 0;
    for (const seq of committed.sequences) {
      seq.steps.forEach((st, i) => {
        if (st.expect !== 'reject' || (st.reason !== 'replayed' && st.reason !== 'seen-set-full')) {
          return;
        }
        const got = runSequence(seq, { [st.reason]: true })[i];
        expect({ name: seq.name, step: i, still: got === st.reason }).toEqual({
          name: seq.name,
          step: i,
          still: false,
        });
        checked++;
      });
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it('the contract names the replay rules, and the sequences cover each of them', () => {
    expect(committed.contract.claims).toEqual(['iss', 'aud', 'method', 'sub', 'jti', 'iat', 'exp']);
    expect(committed.contract.defaultSeenCapacity).toBeGreaterThan(0);
    expect(committed.contract.jtiChars).toEqual({ min: 22, max: 64 });
    const names = new Set(committed.sequences.map((s) => s.name));
    for (const required of [
      'replay-same-token',
      'replay-until-exp-plus-skew',
      'distinct-jti-both-accepted',
      'cap-reached-refuses-new',
      'cap-reached-keeps-seen',
      'expired-entry-purged',
      'purge-is-per-entry',
      'refused-token-is-not-recorded',
    ]) {
      expect({ required, present: names.has(required) }).toEqual({ required, present: true });
    }
    for (const seq of committed.sequences) {
      for (const st of seq.steps) if (st.expect === 'reject') expect(REASONS).toContain(st.reason);
    }
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
      'missing-jti',
      'jti-null',
      'jti-too-short',
      'jti-too-long',
      'jti-not-base64url',
      'rotation-previous-during-overlap',
      'rotation-previous-after-overlap',
      'rotation-next-before-propagation',
      'rotation-next-after-propagation',
      'signature-s-plus-l',
      'escaped-duplicate-header-alg',
      'escaped-duplicate-claim-sub',
      'jwks-non-canonical-key',
      'jwks-off-curve-key',
      ...SMALL_ORDER_KEYS.map(([label]) => `jwks-small-order-key-${label}`),
      ...PRIVATE_JWK_MEMBERS.map((m) => `jwks-private-member-${m}`),
    ]) {
      expect({ required, present: names.has(required) }).toEqual({ required, present: true });
    }
    for (const c of committed.cases) {
      if (c.expect === 'reject') expect(REASONS).toContain(c.reason);
    }
  });

  it('the small-order keys are every encoding of every small-order point', () => {
    const canonical = new Set<string>();
    for (const [label, hex] of SMALL_ORDER_KEYS) {
      const raw = Buffer.from(hex, 'hex');
      const point = decodePoint(raw, true);
      expect({ label, smallOrder: point !== null && smallOrder(point) }).toEqual({
        label,
        smallOrder: true,
      });
      if (decodePoint(raw) !== null) canonical.add(`${point?.x}:${point?.y}`);
    }
    // The small-order subgroup has exactly eight points: all are here.
    expect(canonical.size).toBe(8);
    expect(SMALL_ORDER_KEYS.length).toBe(14);
    // The non-canonical key is a real point of large order, only badly encoded.
    const aliased = decodePoint(Buffer.from(NON_CANONICAL_KEY, 'hex'), true);
    expect(decodePoint(Buffer.from(NON_CANONICAL_KEY, 'hex'))).toBeNull();
    expect(aliased !== null && !smallOrder(aliased)).toBe(true);
    // The off-curve key is no point at all.
    expect(decodePoint(Buffer.from(OFF_CURVE_KEY, 'hex'), true)).toBeNull();
  });

  // Each weak-key case is refused only because its key is not trusted: a
  // verifier that trusts any 32-byte x refuses it for another reason, or
  // accepts it — the identity key admits the forgery for every message.
  it('every weak-key negative is single-fault, and the identity-key forgery is real', () => {
    const weak = committed.cases.filter(
      (c) =>
        c.name.startsWith('jwks-small-order-key-') ||
        c.name.endsWith('-curve-key') ||
        c.name === 'jwks-non-canonical-key',
    );
    expect(weak.length).toBe(SMALL_ORDER_KEYS.length + 2);
    for (const c of weak) {
      const got = outcome(c, { 'weak-key': true });
      expect({
        name: c.name,
        unknownKid: got instanceof Refused && got.reason === 'unknown-kid',
      }).toEqual({ name: c.name, unknownKid: false });
    }
    const identity = committed.cases.find((c) => c.name === 'jwks-small-order-key-identity');
    expect(identity && outcome(identity, { 'weak-key': true })).toEqual({
      expect: 'accept',
      sub: 'user-123',
    });
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
