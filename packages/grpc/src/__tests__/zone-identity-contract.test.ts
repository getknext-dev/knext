/**
 * The zone signer against the two artifacts the other halves of the zone
 * identity token are tested against, so no half can drift alone:
 *
 * 1. The operator's shared fixture
 *    (`packages/kn-next-operator/internal/controller/testdata/zone-identity-contract.json`),
 *    which the operator's Go test renders the zone's and the function's
 *    Knative Services from: where the signing-key Secret is mounted, what its
 *    files are called, the variable naming the zone, and the issuer and
 *    audience the function's verifier is held to. The function templates'
 *    verifier defaults (Go and Rust) are held to the same fixture here.
 * 2. The shared token vectors (`packages/grpc/testdata/z7-token-vectors.json`),
 *    which the Go and Rust verifiers run: given each accept case's seed key,
 *    clock and claims, the signer mints exactly that token, byte for byte.
 *
 * Both files are read, never skipped: a missing file is a failure.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { urlEnvFor } from '../config';
import { createZoneTokenSigner, SIGNING_KEY_DIR, ZONE_ISSUER_ENV } from '../runtime';
import { emptyDir, PKG_DIR, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const REPO = join(PKG_DIR, '..', '..');
const FIXTURE_PATH = join(
  REPO,
  'packages/kn-next-operator/internal/controller/testdata/zone-identity-contract.json',
);
const VECTORS_PATH = join(PKG_DIR, 'testdata/z7-token-vectors.json');

interface ZoneIdentityContract {
  namespace: string;
  zone: {
    name: string;
    signingKeyMountDir: string;
    signingKeyFiles: string[];
    signingKeyFileMode: number;
    issuerEnv: string;
    issuer: string;
  };
  function: {
    name: string;
    jwksMountDir: string;
    jwksFile: string;
    issuerEnv: string;
    issuer: string;
    audienceEnv: string;
    audience: string;
  };
}

interface VectorKey {
  seed: string;
  kid: string;
  x: string;
}

interface VectorCase {
  name: string;
  procedure: string;
  auth: 'AUTH_USER' | 'AUTH_PUBLIC';
  now: number;
  jws: string[] | null;
  expect: 'accept' | 'reject';
  sub?: string;
}

interface Vectors {
  verifier: { issuer: string; audience: string };
  keys: Record<string, VectorKey>;
  cases: VectorCase[];
}

const contract: ZoneIdentityContract = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const vectors: Vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));

/** RFC 8410 PKCS#8 for an Ed25519 seed: a fixed 16-byte prefix, then the 32-byte seed. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function pemFromSeed(seed: string): string {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed, 'base64url')]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
}

const json = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

/** The address the operator renders for a function, as the signer's audience source. */
const functionUrl = (name: string, namespace: string) =>
  `http://${name}.${namespace}.svc.cluster.local`;

describe("the operator's zone identity fixture", () => {
  it('mounts the signing key where the signer reads it, and names the issuer variable it reads', () => {
    expect(contract.zone.signingKeyMountDir).toBe(SIGNING_KEY_DIR);
    expect(contract.zone.issuerEnv).toBe(ZONE_ISSUER_ENV);
    // The function's verifier is held to the issuer the zone signs as.
    expect(contract.function.issuer).toBe(contract.zone.issuer);
  });

  it('lays out the Secret files the signer signs from: current.key and current.kid', async () => {
    expect(contract.zone.signingKeyFiles).toEqual([
      'current.key',
      'current.kid',
      'previous.key',
      'previous.kid',
    ]);
    // A volume holding exactly the fixture's files, at the fixture's mode, with
    // a different key in previous.*: the signer signs with the current one.
    const current = vectors.keys['zone-a-current'];
    const previous = vectors.keys['zone-a-previous'];
    if (!current || !previous) throw new Error('the vectors lost their zone-a keys');
    const material: Record<string, string> = {
      current: pemFromSeed(current.seed),
      previous: pemFromSeed(previous.seed),
    };
    const kids: Record<string, string> = { current: current.kid, previous: previous.kid };
    const dir = emptyDir('contract-volume');
    for (const file of contract.zone.signingKeyFiles) {
      const [slot, ext] = file.split('.') as [string, string];
      writeFileSync(join(dir, file), ext === 'key' ? material[slot] : kids[slot]);
      chmodSync(join(dir, file), contract.zone.signingKeyFileMode);
    }
    const env = {
      [contract.zone.issuerEnv]: contract.zone.issuer,
      [urlEnvFor(contract.function.name)]: functionUrl(contract.function.name, contract.namespace),
    };
    const token = await createZoneTokenSigner({ keyDir: dir, env: () => env })({
      function: contract.function.name,
      method: '/orders.v1.OrdersService/GetOrder',
      auth: 'user',
      sub: 'alice',
    });
    const [h, c, s] = token.split('.') as [string, string, string];
    expect(json(h)).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: current.kid });
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(current.x, 'base64url'),
    ]);
    const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'))).toBe(
      true,
    );
  });

  it("mints the issuer and audience the function's verifier is held to", async () => {
    expect(contract.zone.issuer).toBe(`knext:zone:${contract.namespace}/${contract.zone.name}`);
    expect(contract.function.audience).toBe(
      `knext:fn:${contract.namespace}/${contract.function.name}`,
    );
    const key = vectors.keys['zone-a-current'];
    if (!key) throw new Error('the vectors lost zone-a-current');
    const dir = emptyDir('contract-claims');
    writeFileSync(join(dir, 'current.key'), pemFromSeed(key.seed));
    writeFileSync(join(dir, 'current.kid'), key.kid);
    const env = {
      [contract.zone.issuerEnv]: contract.zone.issuer,
      [urlEnvFor(contract.function.name)]: functionUrl(contract.function.name, contract.namespace),
    };
    const token = await createZoneTokenSigner({ keyDir: dir, env: () => env })({
      function: contract.function.name,
      method: '/orders.v1.OrdersService/GetOrder',
      auth: 'user',
      sub: 'alice',
    });
    const claims = json(token.split('.')[1] as string);
    expect(claims.iss).toBe(contract.function.issuer);
    expect(claims.aud).toBe(contract.function.audience);
  });

  // The other side of the fixture's function half: the Go and Rust templates'
  // verifier defaults. One constant each, read from source, anchored exactly once.
  it("holds the function templates' verifier defaults to the fixture's function half", () => {
    const jwksPath = `${contract.function.jwksMountDir}/${contract.function.jwksFile}`;
    const sources: [string, RegExp, string][] = [
      ['templates/go/internal/auth/auth.go', /const DefaultJWKSPath = "([^"]*)"/g, jwksPath],
      [
        'templates/go/internal/auth/auth.go',
        /\tEnvIssuer += "([^"]*)"/g,
        contract.function.issuerEnv,
      ],
      [
        'templates/go/internal/auth/auth.go',
        /\tEnvAudience += "([^"]*)"/g,
        contract.function.audienceEnv,
      ],
      ['templates/rust/src/auth.rs', /pub const DEFAULT_JWKS_PATH: &str = "([^"]*)";/g, jwksPath],
      [
        'templates/rust/src/auth.rs',
        /pub const ENV_ISSUER: &str = "([^"]*)";/g,
        contract.function.issuerEnv,
      ],
      [
        'templates/rust/src/auth.rs',
        /pub const ENV_AUDIENCE: &str = "([^"]*)";/g,
        contract.function.audienceEnv,
      ],
    ];
    for (const [file, pattern, want] of sources) {
      const found = [...readFileSync(join(REPO, file), 'utf8').matchAll(pattern)].map((m) => m[1]);
      expect({ file, pattern: pattern.source, found }).toEqual({
        file,
        pattern: pattern.source,
        found: [want],
      });
    }
  });
});

describe('the shared token vectors', () => {
  const accepts = vectors.cases.filter((c) => c.expect === 'accept');

  it('carry the kid in the JWS header only: never in the claims', () => {
    expect(accepts.length).toBeGreaterThanOrEqual(7);
    for (const c of accepts) {
      const [h, p] = c.jws as [string, string, string];
      expect({ name: c.name, header: Object.keys(json(h)) }).toEqual({
        name: c.name,
        header: ['alg', 'typ', 'kid'],
      });
      expect({ name: c.name, claims: Object.keys(json(p)) }).toEqual({
        name: c.name,
        claims: ['iss', 'aud', 'method', 'sub', 'iat', 'exp'],
      });
    }
  });

  it('the signer, given each accept case’s seed key, clock and claims, mints it byte for byte', async () => {
    const byKid = new Map(Object.values(vectors.keys).map((k) => [k.kid, k]));
    const fn = /^knext:fn:([^/]+)\/([^/]+)$/.exec(vectors.verifier.audience);
    if (!fn) throw new Error('the vectors name no function audience');
    const [, namespace, name] = fn as unknown as [string, string, string];
    const env = {
      [ZONE_ISSUER_ENV]: vectors.verifier.issuer,
      [urlEnvFor(name)]: functionUrl(name, namespace),
    };
    let reproduced = 0;
    for (const c of accepts) {
      const [h, p] = c.jws as [string, string, string];
      const kid = json(h).kid as string;
      const key = byKid.get(kid);
      if (!key) throw new Error(`${c.name}: no seed key for its kid`);
      const dir = emptyDir(`contract-vector-${c.name}`);
      writeFileSync(join(dir, 'current.key'), pemFromSeed(key.seed));
      writeFileSync(join(dir, 'current.kid'), key.kid);
      // The case's mint time is its iat; everything else comes from the case.
      const iat = json(p).iat as number;
      const mint = createZoneTokenSigner({ keyDir: dir, env: () => env, now: () => iat * 1000 });
      const token = await mint({
        function: name,
        method: c.procedure,
        auth: c.auth === 'AUTH_PUBLIC' ? 'public' : 'user',
        sub: c.sub,
      });
      expect({ name: c.name, token }).toEqual({ name: c.name, token: (c.jws as [string, string, string]).join('.') });
      reproduced++;
    }
    expect(reproduced).toBe(accepts.length);
  });
});
