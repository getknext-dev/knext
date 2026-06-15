/**
 * Regression tests for the vinext → official Next.js Adapter migration.
 *
 * These tests assert that Nitro/Vinext build APIs are fully removed from the
 * kn-next framework packages, and that the official `output:'standalone'` path
 * is wired instead. Written RED-first per superteam TDD discipline.
 *
 * Tested invariants:
 *  - shared.ts no longer exports getNitroPreset or copyAdapters (Nitro-specific)
 *  - build.ts source does not reference NITRO_PRESET or getNitroPreset
 *  - deploy.ts source does not reference NITRO_PRESET or getNitroPreset
 *  - node-server.ts does not import Nitro's index.mjs; starts standalone server.js
 *  - config.ts runtime field comment does not mention "Nitro preset"
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Locate the kn-next src directory relative to this __tests__ file.
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(TESTS_DIR, '..');

function readSrc(relPath: string): string {
  return readFileSync(resolve(SRC, relPath), 'utf-8');
}

// ─── shared.ts: Nitro exports removed ────────────────────────────────────────

describe('shared.ts: Nitro APIs removed', () => {
  it('does NOT export getNitroPreset', async () => {
    const mod = await import('../cli/shared');
    expect('getNitroPreset' in mod).toBe(false);
  });

  it('does NOT export copyAdapters (Nitro .output copy removed)', async () => {
    const mod = await import('../cli/shared');
    expect('copyAdapters' in mod).toBe(false);
  });

  it('still exports loadConfig', async () => {
    const mod = await import('../cli/shared');
    expect(typeof (mod as Record<string, unknown>).loadConfig).toBe('function');
  });
});

// ─── build.ts: no Nitro build orchestration ───────────────────────────────────

describe('build.ts: no Nitro build orchestration', () => {
  it('does NOT contain NITRO_PRESET env var', () => {
    expect(readSrc('cli/build.ts')).not.toMatch(/NITRO_PRESET/);
  });

  it('does NOT call getNitroPreset', () => {
    expect(readSrc('cli/build.ts')).not.toContain('getNitroPreset');
  });

  it('does NOT call copyAdapters', () => {
    expect(readSrc('cli/build.ts')).not.toContain('copyAdapters');
  });
});

// ─── deploy.ts: no Nitro build orchestration ──────────────────────────────────

describe('deploy.ts: no Nitro build orchestration', () => {
  it('does NOT contain NITRO_PRESET env var', () => {
    expect(readSrc('cli/deploy.ts')).not.toMatch(/NITRO_PRESET/);
  });

  it('does NOT call getNitroPreset', () => {
    expect(readSrc('cli/deploy.ts')).not.toContain('getNitroPreset');
  });

  it('does NOT call copyAdapters', () => {
    expect(readSrc('cli/deploy.ts')).not.toContain('copyAdapters');
  });
});

// ─── node-server.ts: standalone runtime, not Nitro ───────────────────────────

describe('node-server.ts: starts Next.js standalone server, not Nitro', () => {
  it('does NOT import Nitro server (index.mjs / .output/server)', () => {
    const src = readSrc('adapters/node-server.ts');
    expect(src).not.toContain('index.mjs');
    expect(src).not.toContain('.output/server');
  });

  it('references the Next.js standalone server.js entry point', () => {
    expect(readSrc('adapters/node-server.ts')).toMatch(/server\.js/);
  });
});

// ─── config.ts: runtime field is standalone-oriented, not Nitro ──────────────

describe('config.ts: runtime field describes standalone, not Nitro preset', () => {
  it('does NOT describe runtime as a "Nitro preset"', () => {
    expect(readSrc('config.ts')).not.toMatch(/Nitro preset/i);
  });
});

// ─── apps/file-manager: no regression on the official adapter ─────────────────
// The app already uses the official NextAdapter via experimental.adapterPath.
// Verify the next-adapter.ts and next.config.ts remain on that path.

describe('apps/file-manager: official adapter, not Nitro', () => {
  const APP_SRC = resolve(TESTS_DIR, '../../../../apps/file-manager');

  function readApp(relPath: string): string {
    return readFileSync(resolve(APP_SRC, relPath), 'utf-8');
  }

  it('next-adapter.ts uses official NextAdapter interface (not Nitro)', () => {
    const src = readApp('next-adapter.ts');
    // Must import NextAdapter from 'next'
    expect(src).toMatch(/from\s+['"]next['"]/);
    // Must not use Nitro-style imports
    expect(src).not.toContain('index.mjs');
  });

  it('next.config.ts sets output:standalone and adapterPath (official adapter)', () => {
    const src = readApp('next.config.ts');
    expect(src).toContain("output: 'standalone'");
    expect(src).toContain('adapterPath');
  });
});
