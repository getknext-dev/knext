/**
 * Honesty gate for the v1.0 announcement-kit drafts (#1568).
 *
 * These drafts describe a credential (14 consecutive nightly compat runs x 4
 * runtime/builder cells) that has NOT finished yet. Three claims must never
 * appear as a plain, unqualified statement in this directory:
 *
 *  1. A millisecond cold-start number (e.g. "61 ms", "200ms"). The only
 *     cluster measurement to date is a tie, not a number worth publishing,
 *     and the 61 ms figure that exists in the repo is a local warm
 *     micro-benchmark, not a cold-start credential claim.
 *  2. Superlative framing ("fastest", "most optimal", and friends).
 *  3. A filled-in "14/14" (or "14 of 14") consecutive-run claim without the
 *     `[FILL AT GA` placeholder marker sitting in the same file — the
 *     credential window is still open, so any 14/14 in these drafts today
 *     must be a marked placeholder, never a result.
 *
 * Scoped to *.md files directly in docs/release/ (the announcement kit),
 * not the whole docs/release tree (which also holds unrelated research notes
 * like the rc.1/rc.2 notes and bench write-ups that predate this gate).
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RELEASE_DIR = resolve(import.meta.dirname);

const KIT_FILES = ['v1.0.0.md', 'v1.0.0-launch-post.md', 'v1.0.0-demo-script.md'];

const MS_COLD_START_RE = /\b\d+(\.\d+)?\s?ms\b.*cold\s?start|cold\s?start.*\b\d+(\.\d+)?\s?ms\b/i;
const SUPERLATIVE_RE = /\bfastest\b|\bmost optimal\b/i;
const FOURTEEN_OF_FOURTEEN_RE = /\b14\s*(\/|of)\s*14\b/i;
const PLACEHOLDER_MARKER = '[FILL AT GA';

function readKitFile(name: string): string {
  return readFileSync(join(RELEASE_DIR, name), 'utf-8');
}

describe('announcement kit honesty (#1568)', () => {
  it('every announcement-kit file exists', () => {
    const present = readdirSync(RELEASE_DIR);
    for (const name of KIT_FILES) {
      expect(present).toContain(name);
    }
  });

  for (const name of KIT_FILES) {
    describe(name, () => {
      it('never states a millisecond cold-start number', () => {
        const text = readKitFile(name);
        const hit = MS_COLD_START_RE.test(text);
        expect(hit).toBe(false);
      });

      it('never uses superlative framing', () => {
        const text = readKitFile(name);
        expect(SUPERLATIVE_RE.test(text)).toBe(false);
      });

      it('never claims a filled-in 14/14 without the placeholder marker present', () => {
        const text = readKitFile(name);
        if (FOURTEEN_OF_FOURTEEN_RE.test(text)) {
          expect(text.includes(PLACEHOLDER_MARKER)).toBe(true);
        }
      });
    });
  }
});
