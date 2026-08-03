import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The image build must install a PINNED pnpm, and that pin must match the
 * workspace's `packageManager` field.
 *
 * Why this exists: `apps/file-manager/Dockerfile` used to run
 * `npm install -g pnpm` with no version. Every image build therefore installed
 * whatever pnpm was latest at that instant, and the build broke with no repo
 * change at all when pnpm shipped a release requiring `@pnpm/exe` native
 * binaries in the lockfile — the committed lockfile was produced by 10.4.1 and
 * has none, so `pnpm install --frozen-lockfile` failed inside the image with
 * "Cannot verify the identity of the @pnpm/exe.linux-x64 native binary".
 *
 * The wider point is a consistency one. This repo pins base images by digest
 * and GitHub Actions by commit SHA, specifically so that an upstream change
 * cannot silently alter a build. Leaving the package manager — the thing that
 * resolves the entire dependency tree — unpinned defeated that everywhere it
 * mattered most.
 *
 * Two separate assertions, because they fail for different reasons and a reader
 * of a red run should not have to guess which:
 *   1. the install is pinned at all;
 *   2. the pin equals `packageManager`.
 */

const REPO_ROOT = join(__dirname, '..');

const DOCKERFILES = ['apps/file-manager/Dockerfile'] as const;

/** `pnpm@10.4.1` -> `10.4.1`. Returns null if the field is absent or malformed. */
function packageManagerPnpmVersion(): string | null {
  const raw = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { packageManager?: string };
  const pm = pkg.packageManager;
  if (!pm) return null;
  const m = /^pnpm@(\d+\.\d+\.\d+)/.exec(pm);
  return m ? (m[1] ?? null) : null;
}

describe('Dockerfile pnpm pin', () => {
  it('the root package.json pins a pnpm version at all', () => {
    // If this fails there is nothing for the Dockerfile to match, and the
    // rest of this file is checking against a moving target.
    expect(packageManagerPnpmVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const rel of DOCKERFILES) {
    describe(rel, () => {
      const dockerfile = readFileSync(join(REPO_ROOT, rel), 'utf8');

      // Only real instruction lines — a comment mentioning the old unpinned
      // form (as the fix's own explanation does) must not trip the guard.
      const installLines = dockerfile
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => !l.startsWith('#'))
        .filter((l) => /\bnpm\s+(install|i)\b.*\s-g\b.*\bpnpm\b/.test(l));

      it('installs pnpm exactly once (so there is one pin to reason about)', () => {
        expect(installLines).toHaveLength(1);
      });

      it('pins the pnpm version — never bare `pnpm`', () => {
        const line = installLines[0] ?? '';
        expect(
          /\bpnpm@\d+\.\d+\.\d+\b/.test(line),
          `Unpinned pnpm install in ${rel}:\n  ${line}\n` +
            'An unpinned package manager makes the image build depend on whatever ' +
            'upstream published today. Pin it to the packageManager version.',
        ).toBe(true);
      });

      it('the pin matches package.json packageManager', () => {
        const expected = packageManagerPnpmVersion();
        const line = installLines[0] ?? '';
        const found = /\bpnpm@(\d+\.\d+\.\d+)\b/.exec(line)?.[1] ?? null;
        expect(
          found,
          `${rel} pins pnpm@${found}, but package.json packageManager is pnpm@${expected}. ` +
            'A lockfile written by one pnpm and installed by another is exactly the ' +
            'drift this guard exists to catch.',
        ).toBe(expected);
      });
    });
  }
});
