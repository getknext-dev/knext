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
] as const);

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
  // kid: base64url (no padding) of the first 16 bytes of SHA-256 over the raw 32-byte key.
  const kid = b64url(createHash('sha256').update(raw).digest().subarray(0, 16));
  return { name, label, seed: b64url(seed), x, kid, raw, privateKey };
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

// Claims in the signer's order: iss, aud, method, sub, iat, exp.
const claims = (overrides: Fields = {}): Fields => ({
  iss: ISSUER,
  aud: AUDIENCE,
  method: USER_METHOD,
  sub: SUB,
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
    { name: 'rotation-previous-during-overlap', ...user(...std(previous)), ...accept(SUB) },
    {
      name: 'rotation-next-after-propagation',
      ...user(...std(next)),
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
      ...user(...std(previous)),
      jwks: 'zone-a-current-only',
      ...reject('unknown-kid'),
    },
    {
      name: 'rotation-next-before-propagation',
      ...user(...std(next)),
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
    // ── refused: claims ──────────────────────────────────────────────────────
    {
      name: 'duplicate-claim-sub',
      ...user(
        current,
        validHeader,
        encodeRaw(
          `{"iss":"${ISSUER}","aud":"${AUDIENCE}","method":"${USER_METHOD}","sub":"${SUB}","sub":"admin","iat":${T0 - 10},"exp":${T0 + 50}}`,
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
            Buffer.from(`","iat":${T0 - 10},"exp":${T0 + 50}}`),
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
      claims: ['iss', 'aud', 'method', 'sub', 'iat', 'exp'],
      maxLifetimeSeconds: 60,
      clockSkewSeconds: 5,
    },
    verifier: { issuer: ISSUER, audience: AUDIENCE },
    reasons: [...REASONS],
    keys,
    jwks,
    cases,
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
