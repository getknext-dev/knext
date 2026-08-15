/**
 * The compute_ctl JWT trust anchor must never carry key material in git.
 *
 * WHY THIS EXISTS. An Ed25519 keypair was generated for the local Neon compose
 * experiment and BOTH halves were committed (the private half at
 * `local/compute_wrapper/private-key.pem`, later deleted — but this repo is
 * public, so git history is publication). The public half was then re-embedded,
 * still live, as the `compute_ctl_config.jwks` trust anchor in
 * `deploy/54-compute-files.yaml`: anyone could mint valid compute_ctl
 * control-API tokens from the leaked private key. Found by the security
 * sprint's history audit (S2), disposition: rotate (option 3).
 *
 * THE FIX SHAPE. The JWK follows the same pattern the file already uses for
 * `CLOUD_ADMIN_MD5_PLACEHOLDER`: the committed config is a TEMPLATE, the
 * entrypoints substitute the real values at boot from a Secret-mounted env,
 * and `gen-secrets.sh` generates the keypair PER CLUSTER (private half lives
 * only in the Secret). Absent the Secret, the entrypoint locks the door with a
 * random key nobody holds — the same fail-safe as the per-app random md5.
 *
 * WHAT THIS GUARDS (both halves, per #639):
 *   1. the REVOKED key is gone — none of its encodings appear in any tracked
 *      file (the half that proves absence);
 *   2. the sanctioned mechanism exists — placeholders in the template, a
 *      substitution in EVERY entrypoint that already substitutes the md5
 *      placeholder (scan, not enumerate), and a generator in gen-secrets.sh
 *      (the half that proves presence);
 *   3. no tracked file anywhere carries a PEM private-key block, so the next
 *      keypair cannot make the same mistake.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const COMPUTE_FILES = resolve(REPO_ROOT, 'packages/scale-zero-pg/deploy/54-compute-files.yaml');
const GEN_SECRETS = resolve(REPO_ROOT, 'packages/scale-zero-pg/deploy/gen-secrets.sh');

const computeFiles = readFileSync(COMPUTE_FILES, 'utf8');
const genSecrets = readFileSync(GEN_SECRETS, 'utf8');

/** Every git-tracked file, so history cruft and untracked junk don't false-positive. */
const trackedFiles: string[] = execFileSync('git', ['ls-files', '-z'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean);

/**
 * The revoked public key, reconstructed from halves so THIS file never contains
 * a bannable literal (the residue-scan lesson: a guard must not trip itself).
 */
const HEX_A = '0d8d1a97f5346e0077fbd7d4';
const HEX_B = '1a4fb73ca5a7b1c93d3b2c4de438c720de977a9d';
const revokedHex = HEX_A + HEX_B;
const revokedRawB64url = Buffer.from(revokedHex, 'hex')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
// The exact string that was committed: base64 of the hex string + trailing \n.
const revokedCommittedForm = Buffer.from(`${revokedHex}\n`).toString('base64');
const REVOKED_ENCODINGS = [revokedHex, revokedRawB64url, revokedCommittedForm];

const SELF = 'tests/compute-jwt-trust-guard.test.ts';
// Assembled so this guard cannot trip on its own source.
const PEM_PRIVATE = ['-----BEGIN', 'PRIVATE KEY-----'];

function readTracked(rel: string): string | null {
  try {
    const buf = readFileSync(resolve(REPO_ROOT, rel));
    // Binary files can't carry the text encodings we ban; skip NUL-bearing blobs.
    return buf.includes(0) ? null : buf.toString('utf8');
  } catch {
    return null; // deleted-but-still-listed; git status noise
  }
}

describe('compute JWT trust anchor — the revoked key is gone', () => {
  it('no tracked file contains the revoked public key in any encoding', () => {
    const offenders: string[] = [];
    for (const rel of trackedFiles) {
      if (rel === SELF) continue;
      const text = readTracked(rel);
      if (!text) continue;
      for (const enc of REVOKED_ENCODINGS) {
        if (text.includes(enc)) offenders.push(`${rel} (${enc.slice(0, 12)}…)`);
      }
    }
    expect(
      offenders,
      'the revoked compute_ctl JWK still appears in tracked files — its private half ' +
        'is public in git history, so any occurrence re-arms the leaked trust anchor',
    ).toEqual([]);
  });

  it('no tracked file carries a PEM private-key block', () => {
    // Matches RSA/EC/OPENSSH/PKCS8 variants: "-----BEGIN * PRIVATE KEY-----".
    const needle = new RegExp(`${PEM_PRIVATE[0]}[A-Z ]*${PEM_PRIVATE[1]}`);
    const offenders = trackedFiles.filter((rel) => {
      if (rel === SELF) return false;
      const text = readTracked(rel);
      return text !== null && needle.test(text);
    });
    expect(
      offenders,
      'a private-key block is committed — keys live in K8s Secrets only (security.md)',
    ).toEqual([]);
  });
});

describe('compute JWT trust anchor — the sanctioned mechanism exists', () => {
  it('BOTH homes of config.json are templates: placeholders, no literal key material', () => {
    // config.json lives twice: inline in 54-compute-files.yaml AND as
    // deploy/compute-files/config.json (the --from-file source). The audit's
    // first pass fixed only the inline copy — the file copy still carried the
    // revoked JWK. Same dual-home drift shape as the loadsoak SLOs, so both
    // copies are asserted here.
    const fileCopy = readTracked('packages/scale-zero-pg/deploy/compute-files/config.json');
    expect(fileCopy, 'the --from-file config.json copy is missing').toBeTruthy();
    for (const [label, text] of [
      ['54-compute-files.yaml (inline)', computeFiles],
      ['compute-files/config.json (file)', fileCopy as string],
    ] as const) {
      expect(text, `${label} lacks the kid placeholder`).toContain('JWT_JWK_KID_PLACEHOLDER');
      expect(text, `${label} lacks the x placeholder`).toContain('JWT_JWK_X_PLACEHOLDER');
      // The other half: inside compute_ctl_config, "x" and "kid" may ONLY carry
      // the placeholder — any other value is committed key material.
      const jwksBlock = text.slice(text.indexOf('"compute_ctl_config"'));
      const literalValues = [...jwksBlock.matchAll(/"(?:x|kid)":\s*"([^"]+)"/g)]
        .map((m) => m[1])
        .filter((v) => !v.includes('PLACEHOLDER'));
      expect(
        literalValues,
        `${label} carries a literal "x"/"kid" — key material belongs in the ` +
          'per-cluster Secret, never in git',
      ).toEqual([]);
    }
  });

  it('every entrypoint that substitutes the md5 placeholder also substitutes the JWK', () => {
    // Scan, not enumerate: count sed lines touching CLOUD_ADMIN_MD5_PLACEHOLDER;
    // each must also rewrite both JWK placeholders. A new entrypoint added later
    // is covered without anyone remembering this test.
    const subLines = (needle: string) =>
      computeFiles.split('\n').filter((l) => l.includes(needle) && /-e\s+"s\|/.test(l)).length;
    const md5Sites = subLines('CLOUD_ADMIN_MD5_PLACEHOLDER');
    expect(md5Sites, 'expected the template substitution sites').toBeGreaterThanOrEqual(3);
    for (const ph of ['JWT_JWK_X_PLACEHOLDER', 'JWT_JWK_KID_PLACEHOLDER']) {
      expect(
        subLines(ph),
        `an entrypoint substitutes the md5 placeholder but not ${ph} — ` +
          'that compute boots with a LITERAL placeholder as its trust anchor',
      ).toBeGreaterThanOrEqual(md5Sites);
    }
  });

  it('the entrypoints fail safe: absent env, the anchor becomes a random key nobody holds', () => {
    // Same pattern as the per-app random md5: missing Secret must lock the
    // door, never leave the placeholder or fall back to a committed value.
    expect(computeFiles).toMatch(/JWT_JWK_X[^\n]*urandom|urandom[^\n]*JWT_JWK_X/);
  });

  it('gen-secrets.sh generates the per-cluster keypair into a Secret', () => {
    expect(genSecrets).toContain('compute-jwt-trust');
    expect(genSecrets).toMatch(/genpkey|ed25519/i);
    // No-silent-rotation, same contract as every other Secret in this script.
    const section = genSecrets.slice(genSecrets.indexOf('compute-jwt-trust'));
    expect(section).toMatch(/already exists; leaving untouched/);
  });

  it('54-compute-files.yaml is a faithful regeneration of its deploy/compute-files/ sources', () => {
    // The yaml is GENERATED (its own header documents the kubectl command).
    // The rotation's first pass edited the generated copy and missed a source —
    // this asserts every source file appears verbatim (4-space indented) in the
    // generated ConfigMap, so an un-regenerated edit on either side goes red.
    for (const name of [
      'config.json',
      'entrypoint.sh',
      'entrypoint-ro.sh',
      'entrypoint-warm.sh',
      'lib-harden.sh',
    ]) {
      const body = readTracked(`packages/scale-zero-pg/deploy/compute-files/${name}`);
      expect(body, `source ${name} missing`).toBeTruthy();
      const indented = (body as string)
        .replace(/\n$/, '')
        .split('\n')
        .map((l) => (l.length ? `    ${l}` : l))
        .join('\n');
      expect(
        computeFiles.includes(indented),
        `54-compute-files.yaml is stale for ${name} — edit deploy/compute-files/ and ` +
          'regenerate (the kubectl command in the yaml header), never hand-edit the yaml',
      ).toBe(true);
    }
  });

  it('the base compute manifests mount the JWK envs from the Secret', () => {
    for (const rel of [
      'packages/scale-zero-pg/deploy/20-compute.yaml',
      'packages/scale-zero-pg/deploy/25-compute-warm.yaml',
      'packages/scale-zero-pg/deploy/26-compute-ro.yaml',
    ]) {
      const text = readTracked(rel);
      expect(text, `${rel} missing`).toBeTruthy();
      expect(text, `${rel} does not mount JWT_JWK_X from compute-jwt-trust`).toMatch(
        /JWT_JWK_X[\s\S]{0,200}compute-jwt-trust|compute-jwt-trust[\s\S]{0,200}JWT_JWK_X/,
      );
    }
  });
});
