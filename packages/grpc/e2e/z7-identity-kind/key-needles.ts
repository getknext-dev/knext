#!/usr/bin/env bun
/**
 * `bun key-needles.ts <private-key.pem> <out-dir>`: the strings a leak of that key
 * would contain, one file per class, for the lane's leak scan (`grep -F -f`).
 *
 * The set is the one the operator itself redacts from every error it returns
 * (`redactKeyMaterial` in zone_signing_key.go): the PEM's body lines, and the PEM
 * text, the 32-byte seed and the 64-byte private key (seed then public key, Go's
 * ed25519.PrivateKey layout) each in the four base64 encodings, padded and
 * unpadded, standard and URL. Those are the shapes a key takes when it is logged:
 * the PEM as a string, a Secret's Data values and any []byte field (base64 of the
 * PEM, as zap prints them), a JWK's `d` (the seed in unpadded base64url).
 *
 * The needles go to files created 0600 in a 0700 directory and are NEVER printed:
 * this command writes nothing to stdout or stderr but the number of classes. The
 * scan names a class that matched (`seed-url-nopad`), never a needle.
 */

import { createPrivateKey } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENCODINGS = {
  std: (b: Buffer) => b.toString('base64'),
  url: (b: Buffer) => b.toString('base64').replaceAll('+', '-').replaceAll('/', '_'),
  'std-nopad': (b: Buffer) => b.toString('base64').replace(/=+$/, ''),
  'url-nopad': (b: Buffer) => b.toString('base64url'),
} as const;

const RAW_FORMS = ['pem', 'seed', 'private'] as const;

/** Every class a needle file is written for. */
export const CLASSES: readonly string[] = [
  'pem-body-line',
  ...RAW_FORMS.flatMap((r) => Object.keys(ENCODINGS).map((e) => `${r}-${e}`)),
];

/** A needle shorter than this could match by accident; none of the classes is. */
export const MIN_NEEDLE = 40;

/** Every class's needles for one PKCS#8 Ed25519 private key in PEM form. */
export function needlesFor(pem: string): Record<string, string[]> {
  const key = createPrivateKey(pem);
  // The PEM as the operator holds and logs it (Go's pem.EncodeToMemory: 64-character
  // lines, ONE trailing newline), not as the file happened to be written: `jq -r` adds
  // a newline after a PEM that already ends in one, and base64 of the file would then
  // differ from base64 of the held PEM from its last 3-byte group on. Re-exporting
  // the parsed key gives the canonical text whatever the input's whitespace.
  const canonical = key.export({ format: 'pem', type: 'pkcs8' }) as string;
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d || !jwk.x) {
    throw new Error('not an Ed25519 private key');
  }
  const seed = Buffer.from(jwk.d, 'base64url');
  const pub = Buffer.from(jwk.x, 'base64url');
  const raw: Record<(typeof RAW_FORMS)[number], Buffer> = {
    pem: Buffer.from(canonical),
    seed,
    private: Buffer.concat([seed, pub]),
  };
  const out: Record<string, string[]> = {
    'pem-body-line': canonical
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('-----')),
  };
  for (const r of RAW_FORMS) {
    for (const [e, encode] of Object.entries(ENCODINGS)) out[`${r}-${e}`] = [encode(raw[r])];
  }
  for (const [cls, list] of Object.entries(out)) {
    if (list.length === 0 || list.some((n) => n.length < MIN_NEEDLE)) {
      throw new Error(`class ${cls} has no needle of ${MIN_NEEDLE} characters or more`);
    }
  }
  return out;
}

/** Write one 0600 file per class into a 0700 directory. Returns the class count. */
export function writeNeedles(pem: string, outDir: string): number {
  const needles = needlesFor(pem);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  for (const [cls, list] of Object.entries(needles)) {
    writeFileSync(join(outDir, cls), `${list.join('\n')}\n`, { mode: 0o600 });
    chmodSync(join(outDir, cls), 0o600);
  }
  return Object.keys(needles).length;
}

if (import.meta.main) {
  const [keyFile, outDir] = process.argv.slice(2);
  if (!keyFile || !outDir) {
    console.error('usage: bun key-needles.ts <private-key.pem> <out-dir>');
    process.exit(64);
  }
  try {
    console.log(`${writeNeedles(readFileSync(keyFile, 'utf8'), outDir)} classes`);
  } catch (err) {
    // The parser's own message is dropped: nothing about the file is echoed.
    console.error(`key-needles: cannot build needles from ${keyFile}: ${(err as Error).name}`);
    process.exit(1);
  }
}
