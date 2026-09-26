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
      expect(l).toMatch(/^\s*(OCIR_USER|OCIR_TOKEN|username|password):\s+\$\{\{ secrets\.OCIR_(USER|TOKEN) \}\}\s*$/);
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

  it('builds linux/amd64 only, from Dockerfile.oke, with an immutable sha tag and no moving tag', () => {
    const platforms = lines.filter((l) => /^\s*platforms:/.test(l));
    expect(platforms.length).toBeGreaterThanOrEqual(2);
    for (const l of platforms) expect(l.trim()).toBe('platforms: linux/amd64');
    const files = lines.filter((l) => /^\s*file:/.test(l));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const l of files) expect(l.trim()).toBe('file: apps/docs/Dockerfile.oke');
    const tags = lines.filter((l) => /^\s*tags:/.test(l) && !l.includes('smoke'));
    expect(tags.length).toBe(1);
    expect(tags[0]).toContain('steps.meta.outputs.tag');
    expect(WF).toContain('tag=sha-${sha:0:7}-amd64');
    expect(CODE).not.toMatch(/:(latest|main-latest)\b/);
  });

  it('pushes only after the smoke boot, and the pushed step is the only push', () => {
    const smoke = lines.findIndex((l) => l.includes('- name: Smoke-boot the image'));
    const push = lines.findIndex((l) => /^\s*push: true\s*$/.test(l));
    expect(smoke).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(smoke);
    expect(lines.filter((l) => /^\s*push: true\s*$/.test(l)).length).toBe(1);
  });

  it('checks out by resolved 40-hex SHA and never inlines the ref input into a script', () => {
    expect(WF).toContain('ref: ${{ steps.meta.outputs.sha }}');
    expect(WF).toContain('ref: ${{ needs.publish.outputs.sha }}');
    const runBodies = CODE.split('\n').filter((l) => /\$\{\{\s*inputs\./.test(l));
    for (const l of runBodies) expect(l).toMatch(/^\s*INPUT_REF:/);
  });
});
