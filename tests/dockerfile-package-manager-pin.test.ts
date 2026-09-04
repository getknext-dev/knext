import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The image build must resolve the dependency tree with a PINNED package
 * manager.
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
 * **The mechanism changed and the requirement did not.** The images now install
 * with `bun`, which is not fetched at build time at all: it IS the base image,
 * already pinned by tag AND digest. That satisfies the original requirement more
 * strongly than a pinned `npm install -g` ever did, because there is no fetch to
 * go wrong. So this asserts the OUTCOME — nothing unpinned resolves the tree —
 * rather than the old mechanism, which would now fail on an image that is
 * strictly safer.
 */

const REPO_ROOT = join(__dirname, '..');
const DOCKERFILES = ['apps/file-manager/Dockerfile', 'apps/docs/Dockerfile'];

/**
 * Line-continuations joined so a wrapped `RUN` is one string, and COMMENTS
 * STRIPPED so prose cannot trip an assertion. The Dockerfiles explain that
 * there is no `npm i -g` layer any more — and that sentence matched the very
 * regex asserting its absence. The same trap already cost a round on the
 * vitest->bun codemod, which refused files that merely mentioned
 * `vi.resetModules` in a comment.
 */
const readJoined = (rel: string): string =>
  readFileSync(join(REPO_ROOT, rel), 'utf8')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

describe.each(DOCKERFILES)('%s — the package manager is pinned', (rel) => {
  it('installs no package manager at build time', () => {
    // The failure this replaces: `npm install -g pnpm` with no version. Any
    // global package-manager install reintroduces a build that can change
    // without the repo changing.
    const dockerfile = readJoined(rel);
    expect(dockerfile).not.toMatch(/npm\s+(install|i)\s+-g/);
    expect(dockerfile).not.toMatch(/corepack\s+enable/);
    expect(dockerfile).not.toMatch(/npm\s+install\s+-g\s+pnpm/);
  });

  it('resolves the tree with bun from the base image, pinned by tag AND digest', () => {
    const dockerfile = readJoined(rel);

    // The installer is bun...
    expect(dockerfile).toMatch(/RUN\s+bun\s+install/);
    // ...and it comes from a base image pinned both ways. Tag alone is mutable;
    // digest alone is unreadable in review. Both, so the pin is auditable.
    expect(dockerfile).toMatch(/FROM\s+oven\/bun:\d+\.\d+\.\d+-\w+@sha256:[0-9a-f]{64}/);
  });

  it('installs with --frozen-lockfile, so the image cannot resolve something the lockfile does not describe', () => {
    // Without it the image build silently re-resolves and can ship a tree that
    // no committed lockfile ever described — the same class of drift the pin
    // above prevents, one layer down.
    expect(readJoined(rel)).toMatch(/bun\s+install\s+--frozen-lockfile/);
  });
});
