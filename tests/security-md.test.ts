import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A stranger evaluating knext for production has no stated vulnerability
 * reporting path today — GitHub surfaces a repo's root `SECURITY.md` in its
 * own "Security" tab and in `Report a vulnerability`, so its presence and
 * content are what make private reporting discoverable at all.
 *
 * These assertions are about the LOAD-BEARING content a stranger needs: a
 * private reporting channel (not a public issue), and which versions receive
 * fixes — not prose quality.
 */

const ROOT = resolve(import.meta.dirname, '..');
const PATH = resolve(ROOT, 'SECURITY.md');

describe('root SECURITY.md', () => {
  it('exists at the repo root', () => {
    expect(existsSync(PATH)).toBe(true);
  });

  const content = existsSync(PATH) ? readFileSync(PATH, 'utf-8') : '';

  it('directs reporters to GitHub Security Advisories, not a public issue', () => {
    expect(content).toMatch(/security advisor/i);
    expect(content).toMatch(/report a vulnerability/i);
  });

  it('tells reporters explicitly not to open a public issue', () => {
    expect(content).toMatch(/do not (?:open|file|create) (?:a )?(?:public )?issue/i);
  });

  it('states which versions are supported', () => {
    expect(content).toMatch(/supported versions?/i);
  });

  it('names the real published stable version line (derived major, e.g. 1.x)', () => {
    // Sourced from packages/kn-next/package.json — never invent a version. Since 1.0.0 the tree
    // carries a stable version, so the supported line is the MAJOR it belongs to.
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, 'packages/kn-next/package.json'), 'utf-8'),
    ) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    const major = pkg.version.split('.')[0];
    expect(content).toContain(`${major}.x`);
  });

  it('no longer describes knext as pre-1.0 once a stable version is in the tree', () => {
    expect(content).not.toMatch(/has not reached a `1\.0\.0` release/i);
    expect(content).not.toMatch(/\bpre-1\.0\b/i);
  });
});
