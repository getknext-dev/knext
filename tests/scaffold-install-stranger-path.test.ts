/**
 * The scaffold-install nightly must walk the WHOLE stranger path from a parent
 * directory that has a lockfile: npm i -> create -> install -> build ->
 * deploy --dry-run, for the default target AND vinext. Phases 1-2 of the script
 * stop before the build, which is why they stayed green through a front-door
 * build failure.
 *
 * It must also test THIS CHECKOUT (packed tarballs), not a published tag: a
 * nightly pointed at a tag that predates a fix is red from the merge until the
 * release, and a nightly that is red by construction gets ignored.
 *
 * This is the PR-time "form" half: it pins the shape of phase 3 and that the
 * workflow still runs the script. The "value" half is the nightly itself, and
 * its red-on-old-template behaviour is proved by running the script with the
 * template reverted.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const script = readFileSync(join(root, 'scripts', 'verify-scaffold-install.mjs'), 'utf8');
const workflow = readFileSync(
  join(root, '.github', 'workflows', 'scaffold-install-nightly.yml'),
  'utf8',
);
const installSmoke = readFileSync(join(root, 'scripts', 'install-smoke.mjs'), 'utf8');

describe('scaffold-install nightly: stranger path under a parent lockfile', () => {
  it('runs the steps in the documented order, in the parent dir first', () => {
    const order = [
      "'npm init'",
      "'npm i @getknext/core'",
      ': knext create`',
      ': npm install (app)`',
      ': knext build`',
      ': knext deploy --dry-run`',
    ].map((label) => script.indexOf(label));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('installs @getknext/core in the PARENT of the app, so a lockfile sits above it', () => {
    // Every leg's app dir is a CHILD of the dir the core install ran in.
    expect(script).toMatch(/const appDir = join\(work3, leg\.dir\)/);
    expect(script).toMatch(/step\(\s*'npm i @getknext\/core',\s*'npm',\s*\[[^\]]*\],\s*work3,/);
  });

  it('covers both the default (node) target and vinext', () => {
    expect(script).toMatch(/name: 'node'/);
    expect(script).toMatch(/name: 'vinext'/);
    expect(script).toContain("'--builder', 'vinext'");
  });

  it('tests this checkout by default: packs the working tree, and published specs are opt-in', () => {
    expect(script).toContain('packCheckout(');
    expect(script).toContain('npmPackOne');
    expect(script).toContain('process.env.KNEXT_STRANGER_SPECS');
    // The old default pointed at a dist-tag that lags the tree under test.
    expect(script).not.toContain("'@getknext/core@next'");
  });

  it('never runs a bare `npx knext` (that name belongs to another package)', () => {
    expect(script).not.toMatch(/['"]npx['"]/);
    expect(script).toContain("node_modules', '.bin', 'knext'");
  });

  it('the workflow runs the script, builds the checkout (Bun off PATH) and leaves it enough time', () => {
    expect(workflow).toContain('node scripts/verify-scaffold-install.mjs');
    expect(workflow).toContain('KNEXT_BUN=');
    expect(workflow).toContain('install --frozen-lockfile');
    const minutes = Number(/scaffold-install:[\s\S]*?timeout-minutes:\s*(\d+)/.exec(workflow)?.[1]);
    expect(minutes).toBeGreaterThanOrEqual(30);
  });
});

describe('install-smoke asserts the default scaffold builds to the FLAT standalone path', () => {
  it('no longer tolerates a nested .next/standalone/<app>/server.js', () => {
    // The tolerant walker accepted any depth, so the harness's own parent
    // lockfile nested the output and the gate stayed green through the very
    // regression it exists to catch.
    expect(installSmoke).not.toContain('findStandaloneServer');
    expect(installSmoke).toMatch(/'\.next',\s*'standalone',\s*'server\.js'/);
  });
});
