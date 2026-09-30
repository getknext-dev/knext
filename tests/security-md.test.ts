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

  it('names the real pre-1.0 published version line (1.0.0-rc)', () => {
    // Sourced from packages/kn-next/package.json — never invent a version.
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, 'packages/kn-next/package.json'), 'utf-8'),
    ) as { version: string };
    expect(pkg.version).toMatch(/^1\.0\.0-rc\./);
    expect(content).toContain('1.0.0-rc');
  });
});
