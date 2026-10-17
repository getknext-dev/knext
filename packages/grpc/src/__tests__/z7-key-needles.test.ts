/**
 * The Z7 kind e2e's leak scan looks for a private key in the operator's logs, the
 * events, the published objects and the pods' logs. A scan finds only the shapes
 * it looks for, and the operator itself redacts a wider set than "the PEM body
 * lines" (redactKeyMaterial in zone_signing_key.go): the PEM, its body lines, and
 * the PEM, the 32-byte seed and the 64-byte private key in the four base64
 * encodings. A key logged as the []byte zap prints (base64 of the PEM), or as a
 * JWK `d` (base64url of the seed), would pass a body-line scan.
 *
 * So the needles (e2e/z7-identity-kind/key-needles.ts) must be that whole set, and
 * this pins it three ways: each class against a computation written out here by
 * hand; each class against a stand-in for the way a real logger would print that
 * form (a scan that cannot match its own examples is decoration); and the Go set
 * itself, so a widening of the operator's redaction fails here instead of silently
 * outrunning the scan.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLASSES, needlesFor, writeNeedles } from '../../e2e/z7-identity-kind/key-needles';

const dir = mkdtempSync(join(tmpdir(), 'knext-z7-needles-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A throwaway key whose standard base64 (of the seed and of the private key)
 * contains both `+` and `/`. The URL encodings differ from the standard ones only in
 * those two characters, so a key without them would let a broken URL encoder pass:
 * the test would depend on luck. Drawn fresh each run, never written to the repo.
 */
function pickKey() {
  for (let i = 0; i < 2000; i++) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const jwk = createPrivateKey(pem).export({ format: 'jwk' });
    const seed = Buffer.from(jwk.d as string, 'base64url');
    const pub = Buffer.from(jwk.x as string, 'base64url');
    // Go's ed25519.PrivateKey: the seed, then the public key.
    const priv = Buffer.concat([seed, pub]);
    const both = (b: Buffer) => /\+/.test(b.toString('base64')) && /\//.test(b.toString('base64'));
    // (The PEM's own base64 can never contain them: its bytes are ASCII, whose 6-bit groups
    // top out below 62 except for characters a PEM does not use. So only the seed and the
    // private key can tell a URL encoding from a standard one.)
    if (both(seed) && both(priv)) return { pem, seed, pub, priv };
  }
  throw new Error('no suitable throwaway key in 2000 draws');
}
const { pem: PEM, seed: SEED, pub: PUB, priv: PRIV } = pickKey();

const std = (b: Buffer) => b.toString('base64');
const stdNoPad = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
const url = (b: Buffer) => b.toString('base64').replaceAll('+', '-').replaceAll('/', '_');
const urlNoPad = (b: Buffer) => b.toString('base64url');

const RAW: Record<string, Buffer> = {
  pem: Buffer.from(PEM),
  seed: SEED,
  private: PRIV,
};
const ENC: Record<string, (b: Buffer) => string> = {
  std,
  url,
  'std-nopad': stdNoPad,
  'url-nopad': urlNoPad,
};

describe('the needle set is the operator redaction set', () => {
  const needles = needlesFor(PEM);

  it('has the PEM body lines and, for the PEM, the seed and the private key, the four encodings of each', () => {
    expect(Object.keys(needles).sort()).toEqual(
      [
        'pem-body-line',
        ...Object.keys(RAW).flatMap((r) => Object.keys(ENC).map((e) => `${r}-${e}`)),
      ].sort(),
    );
    expect(CLASSES.length).toBe(13);
  });

  it('computes every class independently of the helper', () => {
    for (const [r, raw] of Object.entries(RAW)) {
      for (const [e, enc] of Object.entries(ENC)) {
        expect(needles[`${r}-${e}`], `${r}-${e}`).toEqual([enc(raw)]);
      }
    }
    const body = PEM.split('\n').filter((l) => l && !l.startsWith('-----'));
    expect(needles['pem-body-line']).toEqual(body);
  });

  it('every needle is long enough that it cannot match by accident (and none is empty)', () => {
    for (const [cls, list] of Object.entries(needles)) {
      expect(list.length, cls).toBeGreaterThan(0);
      for (const n of list)
        expect(n.length, `${cls}: a needle of ${n.length}`).toBeGreaterThanOrEqual(40);
    }
  });

  it('the private key is the seed then the public key, 64 bytes (the Go layout)', () => {
    expect(PRIV.length).toBe(64);
    expect(PRIV.subarray(0, 32).equals(SEED)).toBe(true);
    expect(PRIV.subarray(32).equals(PUB)).toBe(true);
  });
});

describe('each class finds the way a real logger would print that form', () => {
  const needles = needlesFor(PEM);
  const contains = (haystack: string, cls: string) =>
    (needles[cls] as string[]).some((n) => haystack.includes(n));

  const printed: Record<string, string> = {
    // the PEM as a log field: a JSON-escaped string
    'pem-body-line': JSON.stringify({ pem: PEM }),
    // zap's []byte (a Secret's Data values, the PEM bytes): base64, padded
    'pem-std': JSON.stringify({ data: { 'current.key': std(RAW.pem as Buffer) } }),
    'pem-url': `data=${url(RAW.pem as Buffer)}`,
    'pem-std-nopad': `data=${stdNoPad(RAW.pem as Buffer)}`,
    'pem-url-nopad': `data=${urlNoPad(RAW.pem as Buffer)}`,
    // a JWK with its private member: d is the seed in unpadded base64url
    'seed-url-nopad': JSON.stringify({
      kty: 'OKP',
      crv: 'Ed25519',
      x: PUB.toString('base64url'),
      d: urlNoPad(SEED),
    }),
    'seed-std': `seed=${std(SEED)}`,
    'seed-url': `seed=${url(SEED)}`,
    'seed-std-nopad': `seed=${stdNoPad(SEED)}`,
    'private-std': `priv=${std(PRIV)}`,
    'private-url': `priv=${url(PRIV)}`,
    'private-std-nopad': `priv=${stdNoPad(PRIV)}`,
    'private-url-nopad': `priv=${urlNoPad(PRIV)}`,
  };

  for (const [cls, text] of Object.entries(printed)) {
    it(`${cls}`, () => {
      expect(contains(text, cls)).toBe(true);
    });
  }

  it('the public half, and another key, are not leaks', () => {
    const other = needlesFor(
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    );
    const publicOnly = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: PUB.toString('base64url') });
    for (const cls of CLASSES) {
      expect(contains(publicOnly, cls), `${cls} matched a public JWK`).toBe(false);
      expect(
        (other[cls] as string[]).some((n) => JSON.stringify(printed).includes(n)),
        `${cls} matched another key`,
      ).toBe(false);
    }
  });
});

describe('the helper writes the needles to private files and prints none of them', () => {
  it('one 0600 file per class, in a 0700 directory, and nothing on stdout or stderr', () => {
    const keyFile = join(dir, 'current.key');
    writeFileSync(keyFile, PEM, { mode: 0o600 });
    const out = join(dir, 'needles');
    const r = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, '../../e2e/z7-identity-kind/key-needles.ts'),
        keyFile,
        out,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(r.exitCode).toBe(0);
    const printed = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
    for (const list of Object.values(needlesFor(PEM))) {
      for (const n of list) expect(printed.includes(n)).toBe(false);
    }
    expect(readdirSync(out).sort()).toEqual([...CLASSES].sort());
    for (const f of readdirSync(out)) {
      expect(statSync(join(out, f)).mode & 0o777, f).toBe(0o600);
      expect(readFileSync(join(out, f), 'utf8').split('\n').filter(Boolean).length).toBeGreaterThan(
        0,
      );
    }
    expect(statSync(out).mode & 0o777).toBe(0o700);
  });

  it('writeNeedles refuses a key it cannot parse, rather than writing an empty set', () => {
    expect(() => writeNeedles('not a key', join(dir, 'none'))).toThrow();
  });
});

describe('the operator redaction set has not outgrown the scan', () => {
  const go = readFileSync(
    resolve(import.meta.dir, '../../../kn-next-operator/internal/controller/zone_signing_key.go'),
    'utf8',
  );
  it('redactKeyMaterial still covers the PEM, the seed and the private key in the same four encodings', () => {
    expect(go).toContain('for _, raw := range [][]byte{k.pem, k.priv.Seed(), k.priv} {');
    expect(go).toContain(
      'base64.StdEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.RawURLEncoding,',
    );
    // Its PEM-body-line needles, trimmed, skipping the header and footer lines.
    expect(go).toContain('!strings.HasPrefix(l, "-----")');
  });
});
describe('the needles are the PEM the operator holds, not the file the lane wrote', () => {
  // The lane exports the key with `jq -r`, which adds a newline after a PEM that
  // already ends in one. The operator logs (and a Secret holds) the PEM as
  // pem.EncodeToMemory wrote it, one trailing newline. Base64 of the PEM differs
  // from the second byte after the last full 3-byte group on, so a needle built
  // from the file would never match a key logged as the []byte zap prints. The
  // operator mutation M6b survived exactly this way on the first run.
  it('a key file with the extra trailing newline gives the same needles as the PEM itself', () => {
    expect(PEM.endsWith('\n')).toBe(true);
    expect(PEM.endsWith('\n\n')).toBe(false);
    const asExported = needlesFor(`${PEM}\n`);
    const asHeld = needlesFor(PEM);
    expect(asExported['pem-std']).toEqual(asHeld['pem-std']);
    for (const cls of CLASSES) expect(asExported[cls], cls).toEqual(asHeld[cls]);
  });

  it('a PEM without its trailing newline, or with Windows line endings, still finds the held PEM', () => {
    const held = needlesFor(PEM);
    for (const variant of [PEM.trimEnd(), PEM.replaceAll('\n', '\r\n'), `\n${PEM}\n\n`]) {
      const got = needlesFor(variant);
      for (const cls of CLASSES) expect(got[cls], cls).toEqual(held[cls]);
    }
  });

  it('finds a key logged as base64 of the held PEM even when the file had the extra newline', () => {
    const logged = JSON.stringify({ data: std(Buffer.from(PEM)) });
    const fromFile = needlesFor(`${PEM}\n`);
    expect((fromFile['pem-std'] as string[]).some((n) => logged.includes(n))).toBe(true);
  });
});
