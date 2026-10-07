/**
 * The scaffold-install nightly must walk the WHOLE stranger path from a parent
 * directory that has a lockfile: npm i -> create -> install -> build ->
 * deploy --dry-run. Phases 1-2 of the script stop before the build, which is
 * why they stayed green through a front-door build failure.
 *
 * This is the PR-time "form" half: it pins the shape of phase 3 and that the
 * workflow still runs the script. The "value" half is the nightly itself, and
 * its red-on-old-template behaviour is proved by running the script against
 * tarballs of the old and the new template.
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

describe('scaffold-install nightly: stranger path under a parent lockfile', () => {
  it('runs the steps in the documented order, in the parent dir first', () => {
    const order = [
      "'npm init'",
      "'npm i @getknext/core'",
      "'knext create'",
      "'npm install (app)'",
      "'knext build'",
      "'knext deploy --dry-run'",
    ].map((label) => script.indexOf(label));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('installs @getknext/core in the PARENT of the app, so a lockfile sits above it', () => {
    // The app dir is a CHILD of the dir the core install ran in.
    expect(script).toMatch(/appDir = join\(work3, 'my-app'\)/);
    expect(script).toMatch(/step\(\s*'npm i @getknext\/core',\s*'npm',\s*\[[^\]]*\],\s*work3,/);
  });

  it('never runs a bare `npx knext` (that name belongs to another package)', () => {
    expect(script).not.toMatch(/['"]npx['"]/);
    expect(script).toContain("node_modules', '.bin', 'knext'");
  });

  it('the workflow runs the script and leaves it enough time', () => {
    expect(workflow).toContain('node scripts/verify-scaffold-install.mjs');
    const minutes = Number(/scaffold-install:[\s\S]*?timeout-minutes:\s*(\d+)/.exec(workflow)?.[1]);
    expect(minutes).toBeGreaterThanOrEqual(30);
  });
});
