/**
 * `checkBearer` in every runtime-contract copy compares the Bearer token with
 * `node:crypto` `timingSafeEqual`, the same primitive the Next routes use
 * (`apps/file-manager/src/app/api/cache/invalidate/auth.ts`) and the security
 * doc names. A hand-rolled byte/char loop is a second, undocumented auth
 * primitive, and these files are copied by users.
 *
 * Discovery is by SCAN (the copy-pin's own walker), not a path list, so a sixth
 * copy is checked tonight rather than ignored.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverRuntimeEntryCopies } from '../scripts/lib/runtime-entry-copies.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

function runtimeContractCopies(): string[] {
  return discoverRuntimeEntryCopies(REPO_ROOT).filter((p: string) =>
    /(^|\/)runtime-contract\.mjs(\.hbs)?$/.test(p),
  );
}

/** The text of `export function checkBearer(...) { ... }`, brace-matched. */
function checkBearerBody(source: string): string {
  const start = source.indexOf('export function checkBearer(');
  expect(start, 'checkBearer definition not found').toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in checkBearer');
}

describe('checkBearer uses timingSafeEqual in every runtime-contract copy', () => {
  it('scans at least the five known copies (a vacuous scan proves nothing)', () => {
    expect(runtimeContractCopies().length).toBeGreaterThanOrEqual(5);
  });

  for (const rel of runtimeContractCopies()) {
    describe(rel, () => {
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8');

      it('imports timingSafeEqual from node:crypto', () => {
        expect(source).toMatch(/import\s*\{[^}]*\btimingSafeEqual\b[^}]*\}\s*from\s*'node:crypto'/);
      });

      it('checkBearer calls timingSafeEqual after a length check', () => {
        const body = checkBearerBody(source);
        expect(body).toContain('timingSafeEqual(');
        expect(body).toMatch(/\.length\s*!==\s*\w+\.length/);
      });

      it('no hand-rolled compare helper or char loop remains in the auth path', () => {
        expect(source).not.toContain('constantTimeEqual');
        expect(checkBearerBody(source)).not.toContain('charCodeAt');
      });
    });
  }
});
