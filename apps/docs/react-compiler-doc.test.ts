/**
 * Keeps the "React Compiler" page's config snippets in sync with the exact
 * keys/packages the CI proof lane (`.github/workflows/react-compiler-proof.yml`)
 * actually exercised. React Compiler itself is upstream (Next.js / vinext),
 * not a knext config surface — so this test does not validate against a
 * knext schema, it validates the DOCS against the WORKFLOW that proved them,
 * which is the only ground truth available for an upstream feature.
 *
 * If a future round changes how the workflow enables the compiler (a
 * different config key, a dropped/added peer package) without updating this
 * page, that drift is exactly what this test exists to catch.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const PAGE = join(DOCS_DIR, 'react-compiler.mdx');
const WORKFLOW = resolve(import.meta.dirname, '../../.github/workflows/react-compiler-proof.yml');

const page = readFileSync(PAGE, 'utf-8');
const workflow = readFileSync(WORKFLOW, 'utf-8');

describe('docs — React Compiler', () => {
  it('is listed in the sidebar navigation', () => {
    const meta = JSON.parse(readFileSync(join(DOCS_DIR, 'meta.json'), 'utf-8')) as {
      pages: string[];
    };
    expect(meta.pages).toContain('react-compiler');
  });

  it('has front matter with a title and description', () => {
    expect(page).toMatch(/^---\n(?:.*\n)*?title: .+\n(?:.*\n)*?description: .+\n---/);
  });

  it('states the official-adapter config key the proof lane actually used', () => {
    expect(workflow).toContain('reactCompiler: true');
    expect(page).toContain('reactCompiler: true');
  });

  it('names every official-adapter peer package the proof lane installed', () => {
    const pkgs = ['babel-plugin-react-compiler'];
    for (const pkg of pkgs) {
      expect(workflow, `workflow should install ${pkg}`).toContain(pkg);
      expect(page, `docs should mention ${pkg}`).toContain(pkg);
    }
  });

  it('states the vinext config option the proof lane actually used — NOT a next.config key', () => {
    expect(workflow).toContain('react: { compiler: true }');
    expect(page).toContain('react: { compiler: true }');
  });

  it('names every vinext peer package the proof lane installed', () => {
    const pkgs = [
      '@vitejs/plugin-react',
      'babel-plugin-react-compiler',
      '@rolldown/plugin-babel',
      'oxc-transform-react',
    ];
    for (const pkg of pkgs) {
      expect(workflow, `workflow should install ${pkg}`).toContain(pkg);
      expect(page, `docs should mention ${pkg}`).toContain(pkg);
    }
  });

  it('states this is a client-rendering optimization, not a server/cold-start change', () => {
    expect(page).toMatch(/client[- ]?rendering|client[- ]?side/i);
    expect(page).toMatch(/cold start/i);
    expect(page).toMatch(/does not|never/i);
  });

  it('covers both v1.0 build targets by name', () => {
    expect(page).toMatch(/turbopack/i);
    expect(page).toMatch(/webpack/i);
    expect(page).toMatch(/vinext/i);
  });
});
