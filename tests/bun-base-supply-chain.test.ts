import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #1452 — the patched-Bun build runs least-privilege and fetches nothing unverified that could be
 * pinned. Comment lines are stripped: they explain the design and may name the forbidden forms.
 */
const dir = resolve(import.meta.dirname, '..', 'infra/bun-base');
const code = (f: string) =>
  readFileSync(resolve(dir, f), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
const build = code('build.sh');
const cloudbuild = code('cloudbuild.yaml');

describe('cloudbuild.yaml runs as the dedicated build SA', () => {
  it('pins serviceAccount to bun-base-build, never the default compute SA', () => {
    expect(cloudbuild).toMatch(
      /^serviceAccount: projects\/gsw-mcp\/serviceAccounts\/bun-base-build@gsw-mcp\.iam\.gserviceaccount\.com$/m,
    );
    expect(cloudbuild).not.toMatch(/compute@developer/);
    expect(cloudbuild).toMatch(/logging: CLOUD_LOGGING_ONLY/);
  });

  it('SBOMs the built artifacts, not only the source tree', () => {
    expect(cloudbuild).toMatch(/scan, dir:\/workspace\/out\b/);
    expect(cloudbuild).toContain('bun-artifacts.cdx.json.sha256');
  });
});

describe('build.sh verifies every pinnable fetch', () => {
  it.each([
    ['apk --allow-untrusted', /--allow-untrusted/],
    ['a script piped into a shell', /\|\s*(ba)?sh\b/],
    ['a key dropped into trusted.gpg.d', /trusted\.gpg\.d/],
  ])('never uses %s', (_n, re) => {
    expect(build).not.toMatch(re);
  });

  const pins = readFileSync(resolve(dir, 'fetch-pins.sha256'), 'utf8').trim().split('\n');
  it.each([
    ['bootstrap bun zip', 'bun-linux-x64.zip'],
    ['rustup-init', 'rustup-init'],
    ['apk-tools-static', 'apk-tools-static.apk'],
  ])('checks the %s against its in-repo sha256 pin', (_n, file) => {
    expect(pins.filter((l) => l.endsWith(`  ${file}`))).toHaveLength(1);
    expect(pins).toContainEqual(
      expect.stringMatching(new RegExp(`^[0-9a-f]{64}  ${file.replace(/\./g, '\\.')}$`)),
    );
    expect(build).toMatch(
      new RegExp(`(^|\\(cd /tmp && )pin ${file.replace(/\./g, '\\.')}\\)?$`, 'm'),
    );
  });

  it('the pin helper demands exactly one sha256sum line and runs sha256sum -c', () => {
    expect(build).toContain('grep -c .)" = 1 ] ||');
    expect(build).toContain('printf \'%s\\n\' "$line" | sha256sum -c -');
  });

  it('pins the apt.llvm.org key fingerprint and the LLVM package version', () => {
    expect(build).toMatch(/^LLVM_SIGNER_FPR='(?:[0-9A-F]{4} {1,2}){9}[0-9A-F]{4}'$/m);
    expect(build).toContain('[ "$fpr" = "${LLVM_SIGNER_FPR// /}" ] ||');
    expect(build).toContain('signed-by=/etc/apt/keyrings/apt.llvm.org.gpg');
    for (const pkg of ['clang', 'lld', 'llvm', 'libclang-rt', 'libclang-common']) {
      expect(build).toMatch(new RegExp(`${pkg}-\\$LLVM_MAJOR(-dev)?="\\$LLVM_PKG_VERSION"`));
    }
  });

  it('secret-scan hygiene: no NAME=<32+ hex> assignment in build.sh', () => {
    expect(build).not.toMatch(/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=['"]?[0-9A-Fa-f]{32,}/m);
  });

  it('verifies Alpine packages against the checked-in keys', () => {
    expect(build).toContain('--keys-dir "$WS/keys/$apkarch"');
    expect(build).toContain('sha256sum -c --strict SHA256SUMS');
    const sums = readFileSync(resolve(dir, 'keys/SHA256SUMS'), 'utf8').trim().split('\n');
    for (const arch of ['x86_64', 'aarch64']) {
      expect(sums.some((l) => new RegExp(`^[0-9a-f]{64}  ${arch}/\\S+\\.rsa\\.pub$`).test(l))).toBe(
        true,
      );
    }
  });
});
