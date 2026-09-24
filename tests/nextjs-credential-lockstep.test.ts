import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * NEXTJS credential lockstep (#1376).
 *
 * `test-e2e-deploy.yml`'s `NEXTJS_REF` (the Next.js ref every compat cell in
 * that workflow tests) and `packages/kn-next/templates/app/package.json.hbs`'s
 * `next` pin (the Next.js version the scaffold actually ships) currently
 * DIFFER on purpose: `NEXTJS_REF` defaults to `v16.2.0`, the scaffold pins
 * `16.3.3`. That gap is real and, for now, unavoidable — Next 16.3.0
 * introduced a CONFIRMED upstream regression (Turbopack + `adapterPath` +
 * `output:'standalone'` -> `ENOENT next-server.js.nft.json`, see #1372) that
 * breaks every harness deploy under Turbopack, so bumping the credential to
 * the shipped pin today would zero out both turbopack-credentialed lanes
 * with no fix available (#1376's options comment on the issue has the full
 * analysis).
 *
 * This is NOT an equality lockstep like `tests/vinext-pin-lockstep.test.ts`
 * (which requires the vinext pin to match everywhere byte-for-byte) —
 * equality is exactly what is infeasible here today. Instead, this guard
 * requires both real values to match what `.github/compat-credentialed-next-version.json`
 * DOCUMENTS: any future bump to either `NEXTJS_REF` or the scaffold's `next`
 * pin, without updating that manifest in the SAME PR, reds this test. A
 * bump is then a deliberate, reviewed decision — never silent drift — and
 * the manifest becomes the one citable source of "what Next version was
 * this credentialed on".
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(REPO_ROOT, '.github/compat-credentialed-next-version.json');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const SCAFFOLD_PACKAGE_JSON_PATH = resolve(
  REPO_ROOT,
  'packages/kn-next/templates/app/package.json.hbs',
);

interface Manifest {
  credentialedNextRef: string;
  shippedNextPin: string;
  divergenceReason: string;
  lastReviewed: string;
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

/** The `NEXTJS_REF` default: `NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'v16.2.0' }}`. */
export function workflowNextjsRef(workflowText: string): string | undefined {
  const hits = [
    ...workflowText.matchAll(
      /^\s*NEXTJS_REF:\s*\$\{\{\s*github\.event\.inputs\.nextjsRef\s*\|\|\s*'([^']+)'\s*\}\}/gm,
    ),
  ];
  return hits.length === 1 ? hits[0][1] : undefined;
}

/** The scaffold's own `"next": "<version>"` dependency pin. */
export function scaffoldNextPin(packageJsonHbs: string): string | undefined {
  const hits = [...packageJsonHbs.matchAll(/"next":\s*"([^"]+)"/g)];
  return hits.length === 1 ? hits[0][1] : undefined;
}

describe('NEXTJS_REF <-> scaffold next pin lockstep (#1376)', () => {
  it('the manifest exists and is well-formed', () => {
    const manifest = loadManifest();
    expect(typeof manifest.credentialedNextRef).toBe('string');
    expect(typeof manifest.shippedNextPin).toBe('string');
    expect(manifest.credentialedNextRef).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(manifest.shippedNextPin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.divergenceReason.length).toBeGreaterThan(0);
    expect(manifest.lastReviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('parses NEXTJS_REF from the real workflow exactly once (self-test)', () => {
    const line = `  NEXTJS_REF: \${{ github.event.inputs.nextjsRef || 'v9.9.9' }}\n`;
    expect(workflowNextjsRef(line)).toBe('v9.9.9');
    expect(workflowNextjsRef(`# ${line}`)).toBeUndefined();
    expect(workflowNextjsRef(`${line}${line}`)).toBeUndefined();
  });

  it('parses the scaffold next pin exactly once (self-test)', () => {
    expect(scaffoldNextPin('{ "dependencies": { "next": "9.9.9", "react": "19" } }')).toBe('9.9.9');
    expect(scaffoldNextPin('{ "dependencies": { "@types/next": "1" } }')).toBeUndefined();
    expect(
      scaffoldNextPin(
        '{ "dependencies": { "next": "1.0.0" }, "devDependencies": { "next": "2.0.0" } }',
      ),
    ).toBeUndefined();
  });

  it("test-e2e-deploy.yml's NEXTJS_REF matches the manifest's documented credentialedNextRef", () => {
    const manifest = loadManifest();
    const ref = workflowNextjsRef(readFileSync(WORKFLOW_PATH, 'utf8'));
    expect(ref, 'could not find a single NEXTJS_REF default in test-e2e-deploy.yml').toBeDefined();
    expect(
      ref,
      `test-e2e-deploy.yml's NEXTJS_REF (${ref}) drifted from the documented credentialedNextRef ` +
        `(${manifest.credentialedNextRef}) in ${MANIFEST_PATH} — update the manifest in the same PR ` +
        'as a deliberate decision (see #1376), or this bump is unreviewed drift.',
    ).toBe(manifest.credentialedNextRef);
  });

  it("the scaffold's next pin matches the manifest's documented shippedNextPin", () => {
    const manifest = loadManifest();
    const pin = scaffoldNextPin(readFileSync(SCAFFOLD_PACKAGE_JSON_PATH, 'utf8'));
    expect(
      pin,
      'could not find a single "next" pin in templates/app/package.json.hbs',
    ).toBeDefined();
    expect(
      pin,
      `the scaffold's next pin (${pin}) drifted from the documented shippedNextPin ` +
        `(${manifest.shippedNextPin}) in ${MANIFEST_PATH} — update the manifest in the same PR ` +
        'as a deliberate decision (see #1376), or this bump is unreviewed drift.',
    ).toBe(manifest.shippedNextPin);
  });
});
