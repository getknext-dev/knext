#!/usr/bin/env node

/**
 * Generates the shared zone-identity token vectors,
 * `packages/grpc/testdata/z7-token-vectors.json`, that the Go and Rust
 * zone-function verifiers (templates/go, templates/rust) and the zone-side
 * signer all test against. One file, so the three implementations cannot
 * drift apart on what a valid token is.
 *
 *   bun packages/grpc/scripts/gen-z7-token-vectors.ts          # (re)write the file
 *   bun packages/grpc/scripts/gen-z7-token-vectors.ts --check  # exit 1 if it is stale
 *
 * TEST-ONLY KEYS. Every key here is derived from a public label (seed =
 * SHA-256 of the label), so anyone can recompute it: it is test material and
 * must never be trusted anywhere else. That is also why the file carries no
 * PEM: a seed is all a test needs, and no secret-scanner rule is tripped by
 * material that was never secret.
 *
 * Tokens are stored as their three base64url segments (join them with "."),
 * so the secret scanner's JWT rule does not flag tokens signed by a published
 * test key. Every case uses a fixed clock (`now`), so the file is
 * byte-for-byte reproducible: Ed25519 signatures are deterministic.
 *
 * `sequences` are the stateful half: several tokens presented one after the
 * other to ONE verifier at stated clock readings, to prove the replay rules
 * (a token seen before is refused until it expires; a full set refuses new
 * tokens and never forgets one early; an expired entry is purged; a token
 * refused for another reason is not recorded). The verifier is built with the
 * sequence's `capacity` (null = its default, `contract.defaultSeenCapacity`).
 * Every `jti` is derived from a public label, so the file is reproducible.
 *
 * Every negative case is SINGLE-FAULT: it is valid in every respect except the
 * one its `reason` names, so a verifier that drops that one check accepts it.
 * `packages/grpc/src/__tests__/z7-token-vectors.test.ts` holds both
 * properties: the file is what this script writes, and each case's outcome is
 * what an independent reference verifier computes.
 */

import { spawnSync } from 'node:child_process';
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
} from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VECTORS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../testdata/z7-token-vectors.json',
);

/** The fixed clock: 2026-01-01T00:00:00Z, in seconds. */
export const T0 = 1767225600;

const ISSUER = 'knext:zone:shop/storefront';
const AUDIENCE = 'knext:fn:shop/orders';
const ZONE_B_ISSUER = 'knext:zone:shop/admin';
const OTHER_AUDIENCE = 'knext:fn:shop/billing';
const USER_METHOD = '/example.v1.ExampleService/PutItem';
const OTHER_METHOD = '/example.v1.ExampleService/GetItem';
const PUBLIC_METHOD = '/catalog.v1.CatalogService/ListProducts';
const SUB = 'user-123';

/** Every reason a case may be refused with; the verifiers map their errors onto these. */
export const REASONS = Object.freeze([
  'no-token',
  'malformed',
  'bad-alg',
  'unknown-kid',
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
  'replayed',
  'seen-set-full',
] as const);

/**
 * How many tokens a verifier remembers by default, from the measured cost of
 * an entry at a realistic rate (see docs/security/threat-model.md, residual G1):
 * both verifiers must default to it, and both tests read it from here.
 */
export const DEFAULT_SEEN_CAPACITY = 65536;

/** A `jti` is 22-64 base64url characters: 22 is exactly 16 random bytes. */
export const JTI_CHARS = Object.freeze({ min: 22, max: 64 });

/** A reproducible jti: 16 bytes of SHA-256 over a public label, base64url (22 characters). */
export const jtiFor = (label: string): string =>
  createHash('sha256')
    .update(`knext z7 TEST VECTOR jti ${label}`, 'utf8')
    .digest()
    .subarray(0, 16)
    .toString('base64url');

/**
 * Every Ed25519 encoding of a small-order point (the eight points whose order
 * divides 8): the eight canonical encodings, then their non-canonical aliases
 * (x = 0 with the sign bit set, and y + p). A verifier that trusts one of
 * these as a public key accepts a forged token: with A of small order,
 * R = identity and S = 0 satisfies the cofactorless equation for many
 * messages, and for the identity for every message. The vectors test proves
 * each is small-order and that the eight canonical points are all of them.
 */
export const SMALL_ORDER_KEYS = Object.freeze([
  ['identity', '0100000000000000000000000000000000000000000000000000000000000000'],
  ['order-2', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
  ['order-4', '0000000000000000000000000000000000000000000000000000000000000000'],
  ['order-4-negated', '0000000000000000000000000000000000000000000000000000000000000080'],
  ['order-8', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'],
  ['order-8-negated', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa'],
  ['order-8-other', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'],
  ['order-8-other-negated', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85'],
  ['identity-x0-signed', '0100000000000000000000000000000000000000000000000000000000000080'],
  ['order-2-x0-signed', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
  ['order-4-y-plus-p', 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
  ['order-4-y-plus-p-signed', 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
  ['identity-y-plus-p', 'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
  ['identity-y-plus-p-signed', 'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
] as const);

/** y = p + 3: a valid point of large order, encoded non-canonically (y >= p). */
export const NON_CANONICAL_KEY = 'f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f';

/** y = 2: no point of the curve has it, so this encodes no public key at all. */
export const OFF_CURVE_KEY = '0200000000000000000000000000000000000000000000000000000000000000';

/**
 * JWK members that hold private or symmetric key material (RFC 7517/7518).
 * A JWK Set carrying any of them is refused whole: a published set must only
 * ever hold public keys, so one that does not is an operator fault to surface.
 */
export const PRIVATE_JWK_MEMBERS = Object.freeze(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);

/** Why a case is refused. */
export type Reason = (typeof REASONS)[number];

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

// PKCS#8 DER prefix of an Ed25519 private key (RFC 8410): the 32-byte seed follows.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface TestKey {
  name: string;
  label: string;
  seed: string;
  x: string;
  kid: string;
  raw: Buffer;
  privateKey: KeyObject;
}

type Fields = Record<string, unknown>;

function testKey(name: string): TestKey {
  const label = `knext z7 TEST VECTOR key ${name}: public test material, never trust it outside tests`;
  const seed = createHash('sha256').update(label, 'utf8').digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof x !== 'string') throw new Error(`no public key for ${name}`);
  const raw = Buffer.from(x, 'base64url');
  return { name, label, seed: b64url(seed), x, kid: kidOf(raw), raw, privateKey };
}

// kid: base64url (no padding) of the first 16 bytes of SHA-256 over the raw 32-byte key.
const kidOf = (raw: Uint8Array): string =>
  b64url(createHash('sha256').update(raw).digest().subarray(0, 16));

// The published shape of a raw 32-byte key that is not one of the test keys.
const rawJwk = (raw: Buffer) => ({
  kty: 'OKP',
  crv: 'Ed25519',
  x: b64url(raw),
  kid: kidOf(raw),
  alg: 'EdDSA',
  use: 'sig',
});

// The order of the Ed25519 group: S and S + L are the same scalar mod L.
const ORDER_L = (1n << 252n) + 27742317777372353535851937790883648493n;

/** The signature with its scalar S replaced by S + L (little-endian, still 32 bytes). */
function sPlusL(signature: string): string {
  const bytes = Buffer.from(signature, 'base64url');
  const s = BigInt(`0x${Buffer.from(bytes.subarray(32)).reverse().toString('hex')}`);
  const malleated = Buffer.from((s + ORDER_L).toString(16).padStart(64, '0'), 'hex').reverse();
  return b64url(Buffer.concat([bytes.subarray(0, 32), malleated]));
}

// R = the identity point, S = 0: the forgery a small-order public key admits.
const FORGED_SIGNATURE = b64url(Buffer.concat([Buffer.from([1]), Buffer.alloc(63)]));

// A private member on the key the set publishes (d: the test seed, as a
// leaked Ed25519 private key would be) or on another JWK in the same set.
function privateMemberSet(member: string, current: TestKey, previous: TestKey) {
  const set = jwkSet(current, previous);
  if (member === 'd') {
    return {
      keys: set.keys.map((k) => (k.kid === current.kid ? { ...k, d: current.seed } : k)),
    };
  }
  const extra =
    member === 'k'
      ? { kty: 'oct', kid: 'test-oct', k: 'AQAB' }
      : {
          kty: 'RSA',
          kid: 'test-rsa',
          n: 'AQAB',
          e: 'AQAB',
          [member]: member === 'oth' ? [{ r: 'AQAB', d: 'AQAB', t: 'AQAB' }] : 'AQAB',
        };
  return { keys: [...set.keys, extra] };
}

// The shape the operator publishes: alg and use are informational, the verifier ignores them.
const jwk = (key: TestKey) => ({
  kty: 'OKP',
  crv: 'Ed25519',
  x: key.x,
  kid: key.kid,
  alg: 'EdDSA',
  use: 'sig',
});

// The operator sorts a JWK Set by kid, so switching which key signs never rewrites the file.
const jwkSet = (...keys: TestKey[]) => ({
  keys: keys.map(jwk).sort((a, b) => (a.kid < b.kid ? -1 : 1)),
});

const header = (kid: string, overrides: Fields = {}): Fields => ({
  alg: 'EdDSA',
  typ: 'JWT',
  kid,
  ...overrides,
});

// Claims in the signer's order: iss, aud, method, sub, jti, iat, exp.
const claims = (overrides: Fields = {}): Fields => ({
  iss: ISSUER,
  aud: AUDIENCE,
  method: USER_METHOD,
  sub: SUB,
  jti: jtiFor('default'),
  iat: T0 - 10,
  exp: T0 + 50,
  ...overrides,
});

const encodeJSON = (value: unknown): string => b64url(Buffer.from(JSON.stringify(value), 'utf8'));
const encodeRaw = (text: string): string => b64url(Buffer.from(text, 'utf8'));

/** The three segments of a compact JWS whose signature covers exactly `h.p`. */
function signed(key: TestKey, h: string, p: string): string[] {
  const signature = sign(null, Buffer.from(`${h}.${p}`, 'ascii'), key.privateKey);
  return [h, p, b64url(signature)];
}

/** Sets the lowest leftover bit of a segment whose length leaves some (len % 4 of 2 or 3). */
function nonCanonical(segment: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  if (segment.length % 4 < 2) throw new Error('segment has no leftover bits');
  const last = alphabet.indexOf(segment.at(-1) ?? '');
  return segment.slice(0, -1) + alphabet[last | 1];
}

export function buildVectors() {
  const previous = testKey('zone-a-previous');
  const current = testKey('zone-a-current');
  const next = testKey('zone-a-next');
  const zoneB = testKey('zone-b-current');
  const outsider = testKey('outsider');
  const shortX = b64url(current.raw.subarray(0, 31));
  const shortKid = b64url(
    createHash('sha256').update(current.raw.subarray(0, 31)).digest().subarray(0, 16),
  );

  const jwks = {
    'zone-a-overlap': jwkSet(current, previous),
    'zone-a-current-only': jwkSet(current),
    'zone-a-rotating': jwkSet(current, next),
    'zone-a-and-b': jwkSet(current, zoneB),
    'zone-b': jwkSet(zoneB),
    'kid-not-derived-from-x': {
      keys: [{ kty: 'OKP', crv: 'Ed25519', kid: current.kid, x: next.x }],
    },
    'wrong-kty': { keys: [{ kty: 'EC', crv: 'Ed25519', kid: current.kid, x: current.x }] },
    'wrong-crv': { keys: [{ kty: 'OKP', crv: 'X25519', kid: current.kid, x: current.x }] },
    'short-x': { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: shortKid, x: shortX }] },
    'non-canonical-key': { keys: [rawJwk(Buffer.from(NON_CANONICAL_KEY, 'hex'))] },
    'off-curve-key': { keys: [rawJwk(Buffer.from(OFF_CURVE_KEY, 'hex'))] },
    ...Object.fromEntries(
      SMALL_ORDER_KEYS.map(([label, hex]) => [
        `small-order-${label}`,
        { keys: [rawJwk(Buffer.from(hex, 'hex'))] },
      ]),
    ),
    ...Object.fromEntries(
      PRIVATE_JWK_MEMBERS.map((m) => [`private-${m}`, privateMemberSet(m, current, previous)]),
    ),
  };

  const user = (key: TestKey, h: string, p: string) => ({
    jwks: 'zone-a-overlap',
    procedure: USER_METHOD,
    auth: 'AUTH_USER',
    now: T0,
    jws: signed(key, h, p) as string[] | null,
  });
  const accept = (sub: string) => ({ expect: 'accept' as const, sub });
  const reject = (reason: Reason) => ({ expect: 'reject' as const, reason });
  const std = (
    key: TestKey,
    h: Fields = header(key.kid),
    c: Fields = claims(),
  ): [TestKey, string, string] => [key, encodeJSON(h), encodeJSON(c)];

  const validUser = signed(...std(current));
  const tampered = [validUser[0], encodeJSON(claims({ sub: 'admin' })), validUser[2]];
  const validHeader = encodeJSON(header(current.kid));
  const validClaims = encodeJSON(claims());
  const hs256Header = encodeJSON(header(current.kid, { alg: 'HS256' }));
  const hs256 = createHmac('sha256', current.raw)
    .update(`${hs256Header}.${validClaims}`, 'ascii')
    .digest();
  const sigNonCanonical = [validUser[0], validUser[1], nonCanonical(validUser[2])];
  // The newline sits inside the payload segment; the signature covers it as received.
  const newline = `${validClaims.slice(0, 8)}\n${validClaims.slice(8)}`;
  // A token naming a raw key, carrying the small-order forgery as its signature.
  const forged = (hex: string) => [
    encodeJSON(header(kidOf(Buffer.from(hex, 'hex')))),
    validClaims,
    FORGED_SIGNATURE,
  ];

  /** The default claims without `name`: what a signer that never heard of it would mint. */
  const withoutClaim = (name: string): Fields => {
    const { [name]: _dropped, ...rest } = claims();
    return rest;
  };

  const cases = [
    // ── accepted ─────────────────────────────────────────────────────────────
    { name: 'valid-user', ...user(...std(current)), ...accept(SUB) },
    {
      name: 'valid-public',
      ...user(...std(current, undefined, claims({ method: PUBLIC_METHOD, sub: '' }))),
      procedure: PUBLIC_METHOD,
      auth: 'AUTH_PUBLIC',
      ...accept(''),
    },
    {
      name: 'valid-public-with-user',
      ...user(...std(current, undefined, claims({ method: PUBLIC_METHOD }))),
      procedure: PUBLIC_METHOD,
      auth: 'AUTH_PUBLIC',
      ...accept(SUB),
    },
    {
      name: 'valid-exp-inside-skew',
      ...user(...std(current, undefined, claims({ iat: T0 - 64, exp: T0 - 4 }))),
      ...accept(SUB),
    },
    {
      name: 'valid-iat-at-skew',
      ...user(...std(current, undefined, claims({ iat: T0 + 5, exp: T0 + 65 }))),
      ...accept(SUB),
    },
    {
      // A token with its own jti, for a test that presents two valid tokens to one verifier.
      name: 'valid-user-second-jti',
      ...user(...std(current, undefined, claims({ jti: jtiFor('second') }))),
      ...accept(SUB),
    },
    {
      // The previous key's token has its own jti, so a test can present it and a
      // current-key token to one verifier: one token is single-use, two are not one.
      name: 'rotation-previous-during-overlap',
      ...user(...std(previous, undefined, claims({ jti: jtiFor('previous') }))),
      ...accept(SUB),
    },
    {
      name: 'rotation-next-after-propagation',
      ...user(...std(next, undefined, claims({ jti: jtiFor('next') }))),
      jwks: 'zone-a-rotating',
      ...accept(SUB),
    },
    // ── refused: transport and encoding ──────────────────────────────────────
    { name: 'no-token', ...user(...std(current)), jws: null, ...reject('no-token') },
    {
      name: 'not-three-segments',
      ...user(...std(current)),
      jws: [validUser[0], validUser[1]],
      ...reject('malformed'),
    },
    {
      name: 'padded-segment',
      ...user(current, validHeader, `${validClaims}==`),
      ...reject('malformed'),
    },
    { name: 'newline-in-segment', ...user(current, validHeader, newline), ...reject('malformed') },
    {
      name: 'non-canonical-base64',
      ...user(...std(current)),
      jws: sigNonCanonical,
      ...reject('malformed'),
    },
    // ── refused: header ──────────────────────────────────────────────────────
    {
      name: 'alg-none',
      ...user(...std(current)),
      jws: [encodeJSON(header(current.kid, { alg: 'none' })), validClaims, ''],
      ...reject('bad-alg'),
    },
    {
      name: 'alg-hs256-with-public-key',
      ...user(...std(current)),
      jws: [hs256Header, validClaims, b64url(hs256)],
      ...reject('bad-alg'),
    },
    {
      name: 'alg-ed25519-name',
      ...user(...std(current, header(current.kid, { alg: 'Ed25519' }))),
      ...reject('bad-alg'),
    },
    {
      name: 'duplicate-header-alg',
      ...user(
        current,
        encodeRaw(`{"alg":"none","alg":"EdDSA","typ":"JWT","kid":"${current.kid}"}`),
        validClaims,
      ),
      ...reject('malformed'),
    },
    {
      // The same duplicate, with the second name escaped: still the name "alg".
      name: 'escaped-duplicate-header-alg',
      ...user(
        current,
        encodeRaw(`{"alg":"none","\\u0061lg":"EdDSA","typ":"JWT","kid":"${current.kid}"}`),
        validClaims,
      ),
      ...reject('malformed'),
    },
    {
      name: 'header-crit',
      ...user(...std(current, header(current.kid, { crit: ['exp'] }))),
      ...reject('malformed'),
    },
    {
      name: 'header-wrong-typ',
      ...user(...std(current, header(current.kid, { typ: 'at+jwt' }))),
      ...reject('malformed'),
    },
    {
      name: 'empty-kid',
      ...user(...std(current, header(''))),
      ...reject('malformed'),
    },
    // ── refused: key and signature ───────────────────────────────────────────
    { name: 'unknown-kid', ...user(...std(outsider)), ...reject('unknown-kid') },
    {
      name: 'wrong-key',
      ...user(...std(outsider, header(current.kid))),
      ...reject('bad-signature'),
    },
    {
      name: 'tampered-claims',
      ...user(...std(current)),
      jws: tampered,
      ...reject('bad-signature'),
    },
    {
      // S + L is the same scalar mod L: a verifier that reduces S accepts a
      // second encoding of a valid signature (malleability).
      name: 'signature-s-plus-l',
      ...user(...std(current)),
      jws: [validUser[0], validUser[1], sPlusL(validUser[2])],
      ...reject('bad-signature'),
    },
    {
      name: 'cross-zone',
      ...user(...std(zoneB, undefined, claims({ iss: ZONE_B_ISSUER }))),
      ...reject('unknown-kid'),
    },
    {
      name: 'cross-zone-forged-kid',
      ...user(...std(zoneB, header(current.kid))),
      ...reject('bad-signature'),
    },
    {
      name: 'cross-zone-misconfigured-jwks',
      ...user(...std(zoneB, undefined, claims({ iss: ZONE_B_ISSUER }))),
      jwks: 'zone-a-and-b',
      ...reject('wrong-issuer'),
    },
    {
      name: 'rotation-previous-after-overlap',
      ...user(...std(previous, undefined, claims({ jti: jtiFor('previous') }))),
      jwks: 'zone-a-current-only',
      ...reject('unknown-kid'),
    },
    {
      name: 'rotation-next-before-propagation',
      ...user(...std(next, undefined, claims({ jti: jtiFor('next') }))),
      ...reject('unknown-kid'),
    },
    {
      name: 'jwks-kid-not-derived-from-x',
      ...user(...std(next, header(current.kid))),
      jwks: 'kid-not-derived-from-x',
      ...reject('unknown-kid'),
    },
    {
      name: 'jwks-wrong-kty',
      ...user(...std(current)),
      jwks: 'wrong-kty',
      ...reject('unknown-kid'),
    },
    {
      name: 'jwks-wrong-crv',
      ...user(...std(current)),
      jwks: 'wrong-crv',
      ...reject('unknown-kid'),
    },
    {
      name: 'jwks-short-x',
      ...user(...std(current, header(shortKid))),
      jwks: 'short-x',
      ...reject('unknown-kid'),
    },
    {
      name: 'jwks-non-canonical-key',
      ...user(...std(current)),
      jwks: 'non-canonical-key',
      jws: forged(NON_CANONICAL_KEY),
      ...reject('unknown-kid'),
    },
    {
      name: 'jwks-off-curve-key',
      ...user(...std(current)),
      jwks: 'off-curve-key',
      jws: forged(OFF_CURVE_KEY),
      ...reject('unknown-kid'),
    },
    ...SMALL_ORDER_KEYS.map(([label, hex]) => ({
      name: `jwks-small-order-key-${label}`,
      ...user(...std(current)),
      jwks: `small-order-${label}`,
      jws: forged(hex),
      ...reject('unknown-kid'),
    })),
    // ── refused: a JWK Set carrying private key material ────────────────────
    ...PRIVATE_JWK_MEMBERS.map((m) => ({
      name: `jwks-private-member-${m}`,
      ...user(...std(current)),
      jwks: `private-${m}`,
      ...reject('bad-jwks'),
    })),
    // ── refused: claims ──────────────────────────────────────────────────────
    {
      name: 'duplicate-claim-sub',
      ...user(
        current,
        validHeader,
        encodeRaw(
          `{"iss":"${ISSUER}","aud":"${AUDIENCE}","method":"${USER_METHOD}","sub":"${SUB}","sub":"admin","jti":"${jtiFor('default')}","iat":${T0 - 10},"exp":${T0 + 50}}`,
        ),
      ),
      ...reject('malformed'),
    },
    {
      name: 'escaped-duplicate-claim-sub',
      ...user(
        current,
        validHeader,
        encodeRaw(
          `{"iss":"${ISSUER}","aud":"${AUDIENCE}","method":"${USER_METHOD}","sub":"${SUB}","s\\u0075b":"admin","jti":"${jtiFor('default')}","iat":${T0 - 10},"exp":${T0 + 50}}`,
        ),
      ),
      ...reject('malformed'),
    },
    {
      name: 'sub-null',
      ...user(...std(current, undefined, claims({ method: PUBLIC_METHOD, sub: null }))),
      procedure: PUBLIC_METHOD,
      auth: 'AUTH_PUBLIC',
      ...reject('malformed'),
    },
    {
      name: 'invalid-utf8-claims',
      ...user(
        current,
        validHeader,
        b64url(
          Buffer.concat([
            Buffer.from(
              `{"iss":"${ISSUER}","aud":"${AUDIENCE}","method":"${USER_METHOD}","sub":"user-`,
            ),
            Buffer.from([0xff]),
            Buffer.from(`","jti":"${jtiFor('default')}","iat":${T0 - 10},"exp":${T0 + 50}}`),
          ]),
        ),
      ),
      ...reject('malformed'),
    },
    {
      name: 'trailing-json',
      ...user(current, validHeader, encodeRaw(`${JSON.stringify(claims())} {}`)),
      ...reject('malformed'),
    },
    {
      name: 'unterminated-claims',
      ...user(current, validHeader, encodeRaw(JSON.stringify(claims()).slice(0, -1))),
      ...reject('malformed'),
    },
    {
      // An array of alternating names and values: a parser that skips the
      // "is this an object" check reads it as the claims.
      name: 'claims-array-of-pairs',
      ...user(current, validHeader, encodeJSON(Object.entries(claims()).flat())),
      ...reject('malformed'),
    },
    {
      name: 'missing-sub-claim',
      ...user(
        ...std(current, undefined, {
          iss: ISSUER,
          aud: AUDIENCE,
          method: PUBLIC_METHOD,
          jti: jtiFor('default'),
          iat: T0 - 10,
          exp: T0 + 50,
        }),
      ),
      procedure: PUBLIC_METHOD,
      auth: 'AUTH_PUBLIC',
      ...reject('malformed'),
    },
    {
      name: 'aud-array',
      ...user(...std(current, undefined, claims({ aud: [AUDIENCE] }))),
      ...reject('malformed'),
    },
    {
      name: 'exp-not-integer',
      ...user(...std(current, undefined, claims({ exp: T0 + 49.5 }))),
      ...reject('malformed'),
    },
    {
      name: 'lifetime-over-60',
      ...user(...std(current, undefined, claims({ iat: T0 - 10, exp: T0 + 51 }))),
      ...reject('lifetime'),
    },
    {
      name: 'exp-not-after-iat',
      ...user(...std(current, undefined, claims({ iat: T0, exp: T0 }))),
      ...reject('lifetime'),
    },
    {
      name: 'expired',
      ...user(...std(current, undefined, claims({ iat: T0 - 70, exp: T0 - 10 }))),
      ...reject('expired'),
    },
    {
      name: 'expired-at-skew-boundary',
      ...user(...std(current, undefined, claims({ iat: T0 - 65, exp: T0 - 5 }))),
      ...reject('expired'),
    },
    {
      name: 'issued-in-future',
      ...user(...std(current, undefined, claims({ iat: T0 + 6, exp: T0 + 66 }))),
      ...reject('not-yet-valid'),
    },
    {
      name: 'wrong-issuer',
      ...user(...std(current, undefined, claims({ iss: ZONE_B_ISSUER }))),
      ...reject('wrong-issuer'),
    },
    {
      name: 'wrong-audience',
      ...user(...std(current, undefined, claims({ aud: OTHER_AUDIENCE }))),
      ...reject('wrong-audience'),
    },
    {
      name: 'wrong-method',
      ...user(...std(current, undefined, claims({ method: OTHER_METHOD }))),
      ...reject('wrong-method'),
    },
    {
      name: 'user-empty-sub',
      ...user(...std(current, undefined, claims({ sub: '' }))),
      ...reject('missing-subject'),
    },
    // ── refused: the jti ─────────────────────────────────────────────────────
    {
      // A token with no jti cannot be remembered, so it could be replayed: refused.
      name: 'missing-jti',
      ...user(...std(current, undefined, withoutClaim('jti'))),
      ...reject('missing-jti'),
    },
    {
      name: 'jti-null',
      ...user(...std(current, undefined, claims({ jti: null }))),
      ...reject('malformed'),
    },
    {
      name: 'jti-too-short',
      ...user(...std(current, undefined, claims({ jti: 'A'.repeat(JTI_CHARS.min - 1) }))),
      ...reject('malformed'),
    },
    {
      name: 'jti-too-long',
      ...user(...std(current, undefined, claims({ jti: 'A'.repeat(JTI_CHARS.max + 1) }))),
      ...reject('malformed'),
    },
    {
      name: 'jti-not-base64url',
      ...user(...std(current, undefined, claims({ jti: `${'A'.repeat(JTI_CHARS.min - 1)}=` }))),
      ...reject('malformed'),
    },
    {
      name: 'jti-at-min-length',
      ...user(...std(current, undefined, claims({ jti: 'A'.repeat(JTI_CHARS.min) }))),
      ...accept(SUB),
    },
    {
      name: 'jti-at-max-length',
      ...user(...std(current, undefined, claims({ jti: 'A'.repeat(JTI_CHARS.max) }))),
      ...accept(SUB),
    },
  ];

  // ── the stateful half: tokens presented to ONE verifier, in order ───────────
  // A token with the default claims, its own jti and optional claim overrides.
  const token = (label: string, overrides: Fields = {}): string[] =>
    signed(...std(current, undefined, claims({ jti: jtiFor(label), ...overrides })));
  // The token's window: iat - 10 .. iat + 50 by default, so exp = T0 + 50.
  const at = (now: number, jws: string[]) => ({ now, jws });
  const accepted = (now: number, jws: string[], sub = SUB) => ({ ...at(now, jws), ...accept(sub) });
  const refused = (now: number, jws: string[], reason: Reason) => ({
    ...at(now, jws),
    ...reject(reason),
  });
  const sequence = (
    name: string,
    capacity: number | null,
    steps: Array<ReturnType<typeof accepted> | ReturnType<typeof refused>>,
    overrides: Fields = {},
  ) => ({
    name,
    jwks: 'zone-a-overlap',
    procedure: USER_METHOD,
    auth: 'AUTH_USER',
    capacity,
    ...overrides,
    steps,
  });
  const A = token('a');
  const B = token('b');
  const C = token('c');
  // A token that lives T0+31 .. T0+91 (exp is 60 s after iat): outlasts A and B.
  const late = (label: string, iat: number) => token(label, { iat, exp: iat + 60 });

  const sequences = [
    sequence('replay-same-token', null, [
      accepted(T0, A),
      refused(T0 + 1, A, 'replayed'),
      refused(T0 + 2, A, 'replayed'),
    ]),
    sequence('replay-until-exp-plus-skew', null, [
      accepted(T0, A),
      // exp = T0 + 50: still replayed at exp and just inside the skew ...
      refused(T0 + 50, A, 'replayed'),
      refused(T0 + 54, A, 'replayed'),
      // ... and at exp + skew the entry is gone, and the token is plainly expired.
      refused(T0 + 55, A, 'expired'),
    ]),
    sequence('distinct-jti-both-accepted', null, [accepted(T0, A), accepted(T0, B)]),
    sequence('cap-reached-refuses-new', 2, [
      accepted(T0, A),
      accepted(T0, B),
      refused(T0, C, 'seen-set-full'),
      // A refused token is not recorded: it is refused again, as full, not as replayed.
      refused(T0 + 1, C, 'seen-set-full'),
    ]),
    sequence('cap-reached-keeps-seen', 2, [
      accepted(T0, A),
      accepted(T0, B),
      refused(T0, C, 'seen-set-full'),
      // Full is not an excuse to forget: the tokens already seen are still refused.
      refused(T0 + 1, A, 'replayed'),
      refused(T0 + 1, B, 'replayed'),
    ]),
    sequence('expired-entry-purged', 2, [
      accepted(T0, A),
      accepted(T0, B),
      refused(T0 + 10, C, 'seen-set-full'),
      // A and B (exp T0 + 50) are purged at T0 + 55: there is room again.
      accepted(T0 + 56, late('d', T0 + 50)),
      accepted(T0 + 56, late('e', T0 + 50)),
      refused(T0 + 56, late('f', T0 + 50), 'seen-set-full'),
    ]),
    sequence('purge-is-per-entry', 2, [
      accepted(T0, A),
      accepted(T0 + 40, late('b', T0 + 35)),
      refused(T0 + 41, late('c', T0 + 36), 'seen-set-full'),
      // Only A (exp T0 + 50) has expired by T0 + 56: one place is free, not two.
      accepted(T0 + 56, late('c', T0 + 36)),
      refused(T0 + 57, late('d', T0 + 37), 'seen-set-full'),
      refused(T0 + 58, late('b', T0 + 35), 'replayed'),
    ]),
    sequence('refused-token-is-not-recorded', null, [
      // Valid signature, wrong RPC: refused before anything is remembered ...
      refused(T0, token('x', { method: OTHER_METHOD }), 'wrong-method'),
      // ... so the same jti on a token that is right is accepted, once.
      accepted(T0 + 1, token('x')),
      refused(T0 + 2, token('x'), 'replayed'),
    ]),
    sequence(
      'replay-public-rpc',
      null,
      [
        accepted(T0, token('p', { method: PUBLIC_METHOD, sub: '' }), ''),
        refused(T0 + 1, token('p', { method: PUBLIC_METHOD, sub: '' }), 'replayed'),
      ],
      { procedure: PUBLIC_METHOD, auth: 'AUTH_PUBLIC' },
    ),
  ];

  const keys = Object.fromEntries(
    [previous, current, next, zoneB, outsider].map((k) => [
      k.name,
      { label: k.label, seed: k.seed, kid: k.kid, x: k.x },
    ]),
  );

  return {
    $comment: [
      'TEST-ONLY. Shared zone-identity token vectors for the Go and Rust zone-function verifiers',
      'and the zone-side signer. Every key is derived from its public label (seed = SHA-256 of',
      'the UTF-8 label), so it is not a secret and must never be trusted outside tests.',
      'A token is its `jws` segments joined with "." (null = no Authorization header).',
      'Regenerate with `bun packages/grpc/scripts/gen-z7-token-vectors.ts`; never edit by hand.',
    ],
    contract: {
      alg: 'EdDSA',
      typ: 'JWT',
      kid: 'base64url (no padding) of the first 16 bytes of SHA-256 over the raw 32-byte public key',
      claims: ['iss', 'aud', 'method', 'sub', 'jti', 'iat', 'exp'],
      maxLifetimeSeconds: 60,
      clockSkewSeconds: 5,
      jtiChars: JTI_CHARS,
      defaultSeenCapacity: DEFAULT_SEEN_CAPACITY,
    },
    verifier: { issuer: ISSUER, audience: AUDIENCE },
    reasons: [...REASONS],
    keys,
    jwks,
    cases,
    sequences,
  };
}

export function render(vectors: ReturnType<typeof buildVectors>): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const vectors = buildVectors();
  if (process.argv.includes('--check')) {
    // Compared as data, not bytes: the committed file is biome-formatted.
    const committed = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
    if (JSON.stringify(committed) !== JSON.stringify(vectors)) {
      process.stderr.write(
        `${VECTORS_PATH} is stale: run bun packages/grpc/scripts/gen-z7-token-vectors.ts\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${VECTORS_PATH} is current (${vectors.cases.length} cases)\n`);
  } else {
    writeFileSync(VECTORS_PATH, render(vectors));
    // The repo's formatter owns the committed layout; --check compares data, not bytes.
    const biome = spawnSync('bunx', ['biome', 'format', '--write', VECTORS_PATH], {
      stdio: 'inherit',
    });
    if (biome.status !== 0) process.exit(biome.status ?? 1);
    process.stdout.write(`wrote ${VECTORS_PATH} (${vectors.cases.length} cases)\n`);
  }
}
