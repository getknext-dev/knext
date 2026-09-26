import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD TESTS for `.github/workflows/docs-oke-image.yml`, the workflow that
 * pushes the docs OKE image to OCIR with a registry credential. Scans the YAML
 * as text (no YAML dependency), like the other workflow guards.
 */
const ROOT = resolve(import.meta.dirname, '..');
const WF = readFileSync(resolve(ROOT, '.github/workflows/docs-oke-image.yml'), 'utf8');
const lines = WF.split('\n');

const stripComments = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/^\s*#.*$/, ''))
    .join('\n');
const CODE = stripComments(WF);

describe('docs-oke-image workflow', () => {
  it('pins EVERY `uses:` by 40-hex SHA with a `# vX.Y.Z` comment (and the scan is alive)', () => {
    const uses = lines.filter((l) => /^\s*(-\s+)?uses:/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(6);
    for (const l of uses) {
      expect(l).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+\s*$/);
    }
  });

  it('top-level permissions are read-only contents, with no write scope', () => {
    expect(WF).toMatch(/^permissions:\n {2}contents: read\n/m);
    // The only write scope is the single job-level `contents: write` on `bump`.
    const writes = lines.filter((l) => /:\s*write\s*$/.test(l));
    expect(writes).toEqual(['      contents: write']);
    const idx = lines.indexOf('      contents: write');
    expect(lines.slice(0, idx).lastIndexOf('  bump:')).toBeGreaterThan(-1);
    expect(WF).not.toContain('id-token');
    expect(WF).not.toContain('packages: write');
  });

  it('never echoes the secrets', () => {
    const secretRefs = CODE.split('\n').filter((l) => /secrets\./.test(l));
    // Every reference is an env assignment or an action `with:` input.
    for (const l of secretRefs) {
      expect(l).toMatch(
        /^\s*(OCIR_USER|OCIR_TOKEN|username|password):\s+\$\{\{ secrets\.OCIR_(USER|TOKEN) \}\}\s*$/,
      );
    }
    expect(secretRefs.length).toBe(4);
    // No shell command mentions the variables other than testing emptiness.
    const shellUses = CODE.split('\n').filter(
      (l) => /\$\{?OCIR_(USER|TOKEN)/.test(l) && !/^\s*\[ -n "\$OCIR_(USER|TOKEN)" \]/.test(l),
    );
    expect(shellUses).toEqual([]);
    // No inline `${{ secrets.* }}` inside a `run:` script body.
    expect(CODE).not.toMatch(/echo[^\n]*secrets\./);
  });

  it('fails closed on missing secrets BEFORE checkout or any third-party action', () => {
    const guard = lines.findIndex((l) => l.includes('- name: Require OCIR credentials'));
    const firstUses = lines.findIndex((l) => /^\s*(-\s+)?uses:/.test(l));
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstUses);
    const guardBlock = lines.slice(guard, firstUses).join('\n');
    expect(guardBlock).toContain('[ -n "$OCIR_USER" ]');
    expect(guardBlock).toContain('[ -n "$OCIR_TOKEN" ]');
    expect(guardBlock).toMatch(/exit 1/);
  });

  it('builds linux/amd64 only, from Dockerfile.oke, with provenance off', () => {
    const platforms = lines.filter((l) => /^\s*platforms:/.test(l));
    expect(platforms.length).toBeGreaterThanOrEqual(1);
    for (const l of platforms) expect(l.trim()).toBe('platforms: linux/amd64');
    const files = lines.filter((l) => /^\s*file:/.test(l));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const l of files) expect(l.trim()).toBe('file: apps/docs/Dockerfile.oke');
    const prov = lines.filter((l) => /^\s*provenance:/.test(l));
    expect(prov.length).toBeGreaterThanOrEqual(1);
    for (const l of prov) expect(l.trim()).toBe('provenance: false');
    expect(WF).toContain('tag=sha-${sha:0:7}-amd64');
  });

  it('the ONLY registry tag is the immutable sha tag — no second (moving) tag', () => {
    // Every reference to the registry image in executable code is exactly ${IMAGE}:${TAG}.
    const publishCode = CODE.slice(CODE.indexOf('  publish:'), CODE.indexOf('  bump:'));
    const refs = publishCode.match(/\$\{IMAGE\}[^\s"'@`\\]*/g) ?? [];
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const r of refs) expect(r).toBe('${IMAGE}:${TAG}');
    expect(CODE).not.toMatch(/\$\{\{\s*env\.IMAGE\s*\}\}/);
    expect(CODE).not.toMatch(/:(latest|main|docs|main-latest)\b/);
    // Exactly one tag-to-registry and one push command.
    expect(lines.filter((l) => /docker tag\b/.test(l)).length).toBe(1);
    expect(lines.filter((l) => /docker push\b/.test(l)).length).toBe(1);
  });

  it('pushes the SAME image that was smoke-booted and scanned — no second build', () => {
    expect(CODE).not.toMatch(/^\s*push:\s*true\s*$/m);
    expect(lines.filter((l) => /docker\/build-push-action@/.test(l)).length).toBe(1);
    expect(WF).toContain('docker tag knext-docs:smoke "${IMAGE}:${TAG}"');
    // And the registry is asked which digest it serves; a mismatch fails.
    expect(WF).toMatch(/imagetools inspect "\$\{IMAGE\}:\$\{TAG\}"/);
    expect(WF).toMatch(/\[ "\$remote" = "\$digest" \]/);
  });

  it('pushes only after the smoke boot AND the Trivy gate', () => {
    const smoke = lines.findIndex((l) => l.includes('- name: Smoke-boot the image'));
    const trivy = lines.findIndex((l) => l.includes('- name: Trivy scan'));
    const push = lines.findIndex((l) => /docker push\b/.test(l));
    expect(smoke).toBeGreaterThan(-1);
    expect(trivy).toBeGreaterThan(smoke);
    expect(push).toBeGreaterThan(trivy);
  });

  it('the Trivy gate scans the smoke image, fails on HIGH/CRITICAL, and is not soft-failed', () => {
    const i = lines.findIndex((l) => l.includes('- name: Trivy scan'));
    const block = lines.slice(i, i + 12).join('\n');
    expect(block).toMatch(/uses: aquasecurity\/trivy-action@[0-9a-f]{40}/);
    expect(block).toContain('image-ref: knext-docs:smoke');
    expect(block).toMatch(/severity: HIGH,CRITICAL/);
    expect(block).toMatch(/exit-code: "1"/);
    expect(WF).not.toMatch(/continue-on-error/);
  });

  it('the smoke asserts HTTP 200 explicitly on a docs page plus a content marker', () => {
    expect(WF).toContain("-w '%{http_code}'");
    expect(WF).toContain('[ "$code" = "200" ]');
    expect(WF).toContain('/docs/scale-to-zero');
    expect(WF).toMatch(/grep -q 'cold starts' \/tmp\/page\.html/);
    expect(CODE).not.toMatch(/curl -[a-zA-Z]*f/);
  });

  it('runs only on push-to-main and manual dispatch — never a PR trigger — with a narrow path filter', () => {
    expect(CODE).not.toMatch(/^\s*pull_request_target:/m);
    expect(CODE).not.toMatch(/^\s*pull_request:/m);
    const on = WF.slice(WF.indexOf('\non:'), WF.indexOf('\npermissions:'));
    const paths = on.split('\n').filter((l) => /^\s+- '/.test(l));
    expect(paths).toEqual(["      - 'apps/docs/**'"]);
  });

  it('never persists checkout credentials', () => {
    expect(CODE).not.toMatch(/persist-credentials:\s*true/);
    const publish = WF.slice(WF.indexOf('  publish:'), WF.indexOf('  bump:'));
    expect(publish).toMatch(/persist-credentials: false/);
  });

  it('checks out by resolved 40-hex SHA and never inlines the ref input into a script', () => {
    expect(WF).toContain('ref: ${{ steps.meta.outputs.sha }}');
    expect(WF).toContain('ref: ${{ needs.publish.outputs.sha }}');
    const runBodies = CODE.split('\n').filter((l) => /\$\{\{\s*inputs\./.test(l));
    for (const l of runBodies) expect(l).toMatch(/^\s*INPUT_REF:/);
  });

  it('Dockerfile.oke: digest-pinned runtime base, non-root, whole-base upgrade, no unpinned curl', () => {
    const df = readFileSync(resolve(ROOT, 'apps/docs/Dockerfile.oke'), 'utf8');
    const froms = df.split('\n').filter((l) => /^FROM\s/.test(l));
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const l of froms) expect(l).toMatch(/@sha256:[0-9a-f]{64}/);
    expect(df).toMatch(/^USER 65532:65532$/m);
    expect(df).toMatch(/^RUN apk upgrade --no-cache$/m);
    expect(df).not.toMatch(/apk add[^\n]*curl/);
  });
});
