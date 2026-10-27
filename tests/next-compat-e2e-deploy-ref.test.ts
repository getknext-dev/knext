import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { NEXT_MATRIX_VERSIONS, NEXT_PEER_RANGE } from '../packages/kn-next/src/next-compat';

/**
 * #2296: the official Next.js compatibility suite on this line must run at the
 * line's OWN Next floor. `next-compat.ts` declares that floor (the lower bound
 * of `NEXT_PEER_RANGE`); `test-e2e-deploy.yml` carries the ref every compat
 * cell tests, twice (the `nextjsRef` dispatch-input default and the
 * `NEXTJS_REF` env fallback a schedule run reads). Before this guard the peer
 * floor moved to 16.4.0 while both workflow defaults stayed at v16.3.8, so the
 * suite kept testing a Next the line no longer admits and nothing went red.
 *
 * `tests/nextjs-credential-lockstep.test.ts` ties the workflow to
 * `.github/compat-credentialed-next-version.json`; this file ties both of them
 * to `next-compat.ts`, so a floor bump that forgets the harness (or the
 * reverse) fails here.
 */
const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/test-e2e-deploy.yml');
const CREDENTIALED_VERSION_PATH = resolve(ROOT, '.github/compat-credentialed-next-version.json');

/** `>=16.4.0 <16.5.0` -> `16.4.0`; anything else -> undefined (fail closed). */
export function peerRangeFloor(range: string): string | undefined {
  const m = range.match(/^>=(\d+\.\d+\.\d+)\s+<\d+\.\d+\.\d+$/);
  return m ? m[1] : undefined;
}

/** The single `NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'vX' }}` fallback. */
export function envFallbackRef(text: string): string | undefined {
  const hits = [
    ...text.matchAll(
      /^[ \t]*NEXTJS_REF:[ \t]*\$\{\{\s*github\.event\.inputs\.nextjsRef\s*\|\|\s*'([^']+)'\s*\}\}[ \t]*$/gm,
    ),
  ];
  return hits.length === 1 ? hits[0][1] : undefined;
}

/** The `workflow_dispatch.inputs.nextjsRef.default`, read through a YAML parse. */
export function dispatchDefaultRef(text: string): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
  const wf = parse(text) as any;
  const value = wf?.on?.workflow_dispatch?.inputs?.nextjsRef?.default;
  return typeof value === 'string' ? value : undefined;
}

const floor = peerRangeFloor(NEXT_PEER_RANGE);
const expectedRef = floor === undefined ? undefined : `v${floor}`;
const workflowText = readFileSync(WORKFLOW_PATH, 'utf8');

describe("the compat harness tests this line's own Next floor (#2296)", () => {
  it('self-test: the floor parser reads a bounded range and refuses anything else', () => {
    expect(peerRangeFloor('>=16.4.0 <16.5.0')).toBe('16.4.0');
    expect(peerRangeFloor('>=9.10.11 <9.11.0')).toBe('9.10.11');
    expect(peerRangeFloor('^16.4.0')).toBeUndefined();
    expect(peerRangeFloor('>=16.4.0')).toBeUndefined();
  });

  it('self-test: the env-fallback parser needs exactly one trusted assignment', () => {
    const line = `  NEXTJS_REF: \${{ github.event.inputs.nextjsRef || 'v9.9.9' }}\n`;
    expect(envFallbackRef(line)).toBe('v9.9.9');
    expect(envFallbackRef(`${line}${line}`)).toBeUndefined();
    expect(envFallbackRef(`# ${line}`)).toBeUndefined();
  });

  it("next-compat.ts declares a parseable floor, and the first matrix leg is on the floor's minor", () => {
    expect(floor, `cannot read a floor from NEXT_PEER_RANGE ${NEXT_PEER_RANGE}`).toBeDefined();
    // #2594: the floor (16.4.0) is still the credential pin the harness tests,
    // but it carries critical advisories fixed in 16.4.1, so the cache-handler
    // spec leg (= the kn-next devDependency, next-minor-matrix.test.ts) runs the
    // patched release users get. Same minor as the floor, never below it; the
    // floor <-> NEXTJS_REF <-> manifest ties are the three tests below.
    const [fMaj, fMin, fPatch] = (floor as string).split('.').map(Number);
    const [lMaj, lMin, lPatch] = NEXT_MATRIX_VERSIONS[0].split('.').map(Number);
    expect(`${lMaj}.${lMin}`).toBe(`${fMaj}.${fMin}`);
    expect(lPatch).toBeGreaterThanOrEqual(fPatch);
  });

  it("test-e2e-deploy.yml's NEXTJS_REF env fallback is the next-compat.ts floor", () => {
    const ref = envFallbackRef(workflowText);
    expect(ref, 'no single NEXTJS_REF env fallback in test-e2e-deploy.yml').toBeDefined();
    expect(ref).toBe(expectedRef as string);
  });

  it("test-e2e-deploy.yml's nextjsRef dispatch default is the next-compat.ts floor", () => {
    const ref = dispatchDefaultRef(workflowText);
    expect(ref, 'no nextjsRef dispatch default in test-e2e-deploy.yml').toBeDefined();
    expect(ref).toBe(expectedRef as string);
  });

  it('the documented credentialedNextRef is the next-compat.ts floor', () => {
    const manifest = JSON.parse(readFileSync(CREDENTIALED_VERSION_PATH, 'utf8')) as {
      credentialedNextRef: string;
    };
    expect(manifest.credentialedNextRef).toBe(expectedRef as string);
  });
});
