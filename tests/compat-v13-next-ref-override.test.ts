import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lineSpec } from '../scripts/compat-credential-line.mjs';
import { lineSubstitutions } from '../scripts/compat-line-workflow.mjs';

/**
 * The v1.3 credential lane tests Next.js 16.4.3 while the v1.0 lane keeps its
 * own default.
 *
 * `test-e2e-deploy.yml` is the v1.0 lane's executing file (and frozen: editing
 * it moves the v1.0 fingerprint). So the 16.4.3 move for the 1.x security patch
 * is NOT made there: it is a declared v1.3-only substitution in the derived
 * `compat-credential-v1.3.yml` (`nextjsRefOverride` in the line spec). Both
 * halves are asserted, because either alone is decoration: a guard that only
 * checks the v1.3 lane stays green when the override leaks into v1.0, and one
 * that only checks v1.0 stays green when the v1.3 lane never gets 16.4.3.
 */
const ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** The v1.0 lane's Next ref, deliberately unchanged by the 16.4.3 move. */
const V10_REF = 'v16.3.8';
/** The ref the v1.3 lane runs. */
const V13_REF = 'v16.4.3';

const ENV_RE =
  /^[ \t]*NEXTJS_REF:[ \t]*\$\{\{\s*github\.event\.inputs\.nextjsRef\s*\|\|\s*'([^']+)'\s*\}\}[ \t]*$/gm;
const DISPATCH_RE =
  /nextjsRef:\n(?:[ \t]+(?:description|required):[^\n]*\n)*[ \t]+default:[ \t]*'([^']+)'/g;
const refs = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]);

describe('the v1.0 lane keeps its Next ref (the override must not touch it)', () => {
  const text = read('.github/workflows/test-e2e-deploy.yml');
  it('test-e2e-deploy.yml dispatch default and env fallback are both the 1.x ref', () => {
    expect(refs(text, DISPATCH_RE)).toEqual([V10_REF]);
    expect(refs(text, ENV_RE)).toEqual([V10_REF]);
  });
  it('the documented credentialedNextRef (the v1.0 lane) is the same ref', () => {
    const m = JSON.parse(read('.github/compat-credentialed-next-version.json'));
    expect(m.credentialedNextRef).toBe(V10_REF);
  });
});

describe('the v1.3 lane gets 16.4.3', () => {
  const text = read(`.github/workflows/${lineSpec('v1.3').workflowFile}`);
  it('the committed derived workflow carries 16.4.3 in both places and no other ref', () => {
    expect(refs(text, DISPATCH_RE)).toEqual([V13_REF]);
    expect(refs(text, ENV_RE)).toEqual([V13_REF]);
  });
  it('the line spec declares the override, and it is a derivation step (not a hand edit)', () => {
    const o = lineSpec('v1.3').nextjsRefOverride;
    expect(o).toEqual({ from: V10_REF, to: V13_REF });
    const ids = lineSubstitutions(lineSpec('v1.3')).map((s: { id: string }) => s.id);
    expect(ids).toContain('nextjs-ref-dispatch');
    expect(ids).toContain('nextjs-ref-env');
  });
  it('the Next the v1.3 lane tests is the Next the scaffold ships', () => {
    const hbs = read('packages/kn-next/templates/app/package.json.hbs');
    expect(/"next":\s*"([^"]+)"/.exec(hbs)?.[1]).toBe(V13_REF.slice(1));
  });
});
