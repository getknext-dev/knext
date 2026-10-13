/**
 * Guard for the CDN docs: every provider row the runtime knows has a docs page,
 * and each page's "Live verification" line matches the evidence file, so a
 * hand-typed "verified" cannot drift from what was actually run.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PURGE_ROWS } from '../../packages/kn-next/src/adapters/cdn-purge/rows.js';

const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const evidence: Record<string, { verified: boolean; run?: string }> = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'cdn-live-evidence.json'), 'utf-8'),
);

// The emulator is a test double, not a product: no docs page, no live run.
const providers = Object.keys(PURGE_ROWS).filter((p) => p !== 'emulator');

const pagePath = (p: string) => join(DOCS_DIR, `cdn-${p}.mdx`);
const MARKER = /^\*\*Live verification:\*\* (verified live|not recorded)\s*$/m;

describe('CDN docs', () => {
  it('knows the provider rows (an empty list would pass everything)', () => {
    expect(providers).toContain('cloudflare');
    expect(providers.length).toBeGreaterThanOrEqual(4);
  });

  it('has a concepts page and an OCI page', () => {
    expect(existsSync(join(DOCS_DIR, 'cdn.mdx'))).toBe(true);
    expect(existsSync(join(DOCS_DIR, 'cdn-oci.mdx'))).toBe(true);
  });

  for (const p of providers) {
    describe(p, () => {
      it('has a docs page', () => {
        expect(existsSync(pagePath(p))).toBe(true);
      });

      it('has an evidence entry', () => {
        expect(evidence[p]).toBeDefined();
      });

      it('shows a live-verification marker that matches the evidence', () => {
        const m = MARKER.exec(readFileSync(pagePath(p), 'utf-8'));
        expect(m).not.toBeNull();
        const verified = evidence[p]?.verified === true;
        if (verified) expect(typeof evidence[p]?.run).toBe('string');
        expect(m?.[1]).toBe(verified ? 'verified live' : 'not recorded');
      });
    });
  }

  it('lists every provider page in the nav', () => {
    const meta = readFileSync(join(DOCS_DIR, 'meta.json'), 'utf-8');
    for (const p of providers) expect(meta).toContain(`"cdn-${p}"`);
    expect(meta).toContain('"cdn"');
    expect(meta).toContain('"cdn-oci"');
  });

  it('only the purge-capable rows are described as purging', () => {
    const concepts = readFileSync(join(DOCS_DIR, 'cdn.mdx'), 'utf-8');
    for (const [name, row] of Object.entries(PURGE_ROWS) as [string, { purge: unknown }][]) {
      if (name === 'emulator') continue;
      const line = concepts.split('\n').find((l) => l.startsWith(`| \`${name}\``)) ?? '';
      expect(line).not.toBe('');
      expect(line.includes('**Yes**')).toBe(row.purge !== null);
    }
  });
});
