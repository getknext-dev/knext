/**
 * Both pages that describe zone-function authentication are served for every
 * release line, so each must say plainly that the feature is Beta and v2-only.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCS = resolve(import.meta.dirname, 'content/docs');
const PHRASE =
  'Zone functions and their identity tokens are **Beta**. They are available on the **v2** line only; released 1.x has none of this.';

describe('zone-function auth passages state their stage', () => {
  for (const page of ['security.mdx', 'threat-model.mdx']) {
    it(`${page} says Beta, v2 only, no 1.x`, () => {
      const text = readFileSync(resolve(DOCS, page), 'utf8').replace(/\s*\n\s*/g, ' ');
      expect(text).toContain(PHRASE);
    });
  }
});
