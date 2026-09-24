import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
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
 *
 * REVIEW ROUND 2 (rev-1379) widened this from "check the one place the
 * original PR happened to touch" to a SCAN of every workflow that carries a
 * `nextjsRef` dispatch-input default or a `NEXTJS_REF` env fallback. The
 * original test only read `test-e2e-deploy.yml`'s env fallback, so changing
 * `test-e2e-deploy.yml`'s dispatch-input default (line 58) or ANYTHING in
 * `compat-vinext.yml` (lines 55, 78) stayed green. Every occurrence found by
 * the scan must either equal `credentialedNextRef` or be explicitly listed
 * in the manifest's `lockstepExceptions` — an unparseable occurrence (zero
 * or more than one match where exactly one is expected) is a hard failure,
 * never a silent skip.
 *
 * REVIEW ROUND 2 also ties the two public-facing docs pages that cite the
 * credentialed version (`docs/compat-matrix.md`, `apps/docs/content/docs/compat-matrix.mdx`)
 * to the same manifest value, and requires the docs site to plainly explain
 * (no issue/PR/ADR numbers — `apps/docs/content-hygiene.test.ts` enforces
 * that) that the scaffold ships a newer Next than the credentialed version.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(REPO_ROOT, '.github/compat-credentialed-next-version.json');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github/workflows');
const SCAFFOLD_PACKAGE_JSON_PATH = resolve(
  REPO_ROOT,
  'packages/kn-next/templates/app/package.json.hbs',
);
const COMPAT_MATRIX_MD_PATH = resolve(REPO_ROOT, 'docs/compat-matrix.md');
const COMPAT_MATRIX_MDX_PATH = resolve(REPO_ROOT, 'apps/docs/content/docs/compat-matrix.mdx');

interface LockstepException {
  file: string;
  kind: 'dispatch-default' | 'env-fallback';
  value: string;
  reason: string;
}

interface Manifest {
  credentialedNextRef: string;
  shippedNextPin: string;
  divergenceReason: string;
  lastReviewed: string;
  lockstepExceptions: LockstepException[];
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

/**
 * The `workflow_dispatch.inputs.nextjsRef.default` value, parsed by
 * indentation rather than a flat regex — `default:` also appears under
 * sibling inputs (e.g. `bun-version`), so a flat "next `default:` after
 * `nextjsRef:`" regex would silently read the WRONG input's value once a
 * later input line moved. This walks only the lines MORE indented than the
 * `nextjsRef:` key itself, stopping at the first sibling/dedent line, and
 * refuses (returns undefined) if that block contains zero or more than one
 * `default:` line, or if `nextjsRef:` itself appears more than once in the
 * file — both are "unparseable", not "not found".
 */
export function workflowDispatchNextjsRefDefault(workflowText: string): string | undefined {
  const lines = workflowText.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const keyMatch = lines[i].match(/^(\s*)nextjsRef:\s*$/);
    if (!keyMatch) continue;
    const indent = keyMatch[1].length;
    let blockDefault: string | undefined;
    let ambiguous = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (lineIndent <= indent) break;
      const defaultMatch = line.match(/^\s*default:\s*'([^']+)'\s*$/);
      if (defaultMatch) {
        if (blockDefault !== undefined) {
          ambiguous = true;
          break;
        }
        blockDefault = defaultMatch[1];
      }
    }
    if (!ambiguous && blockDefault !== undefined) found.push(blockDefault);
  }
  return found.length === 1 ? found[0] : undefined;
}

/** The scaffold's own `"next": "<version>"` dependency pin. */
export function scaffoldNextPin(packageJsonHbs: string): string | undefined {
  const hits = [...packageJsonHbs.matchAll(/"next":\s*"([^"]+)"/g)];
  return hits.length === 1 ? hits[0][1] : undefined;
}

interface NextjsRefOccurrence {
  file: string;
  kind: 'dispatch-default' | 'env-fallback';
  value: string | undefined;
}

/**
 * Every `nextjsRef` dispatch-input default and every `NEXTJS_REF` env
 * fallback across `.github/workflows/**`, scanned rather than enumerated —
 * the whole point per the round-2 finding is that a NEW lane (or a moved
 * line in an existing one) must be caught automatically, not by remembering
 * to update a hand-written list of files.
 */
export function scanNextjsRefOccurrences(workflowsDir: string): NextjsRefOccurrence[] {
  const occurrences: NextjsRefOccurrence[] = [];
  for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.ya?ml$/.test(entry.name)) continue;
    const file = `.github/workflows/${entry.name}`;
    const text = readFileSync(resolve(workflowsDir, entry.name), 'utf8');
    if (/^\s*nextjsRef:\s*$/m.test(text)) {
      occurrences.push({
        file,
        kind: 'dispatch-default',
        value: workflowDispatchNextjsRefDefault(text),
      });
    }
    if (/NEXTJS_REF:\s*\$\{\{\s*github\.event\.inputs\.nextjsRef\s*\|\|/.test(text)) {
      occurrences.push({ file, kind: 'env-fallback', value: workflowNextjsRef(text) });
    }
  }
  return occurrences;
}

/** The `vercel/next.js` version `docs/compat-matrix.md`'s intro claims. */
export function docsMatrixMdNextRef(text: string): string | undefined {
  const hits = [...text.matchAll(/against `vercel\/next\.js` \*\*v(\d+\.\d+\.\d+)\*\*/g)];
  return hits.length === 1 ? `v${hits[0][1]}` : undefined;
}

/** The Next.js version `apps/docs/content/docs/compat-matrix.mdx`'s callout claims. */
export function docsMatrixMdxNextRef(text: string): string | undefined {
  const hits = [...text.matchAll(/against Next\.js v(\d+\.\d+\.\d+)\./g)];
  return hits.length === 1 ? `v${hits[0][1]}` : undefined;
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
    expect(Array.isArray(manifest.lockstepExceptions)).toBe(true);
  });

  it('parses NEXTJS_REF from the real workflow exactly once (self-test)', () => {
    const line = `  NEXTJS_REF: \${{ github.event.inputs.nextjsRef || 'v9.9.9' }}\n`;
    expect(workflowNextjsRef(line)).toBe('v9.9.9');
    expect(workflowNextjsRef(`# ${line}`)).toBeUndefined();
    expect(workflowNextjsRef(`${line}${line}`)).toBeUndefined();
  });

  it('parses the workflow_dispatch nextjsRef default exactly once (self-test)', () => {
    const block = [
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      nextjsRef:',
      "        description: 'a ref'",
      '        required: false',
      "        default: 'v9.9.9'",
      '      bun-version:',
      '        required: false',
      "        default: '1.4.2'",
    ].join('\n');
    expect(workflowDispatchNextjsRefDefault(block)).toBe('v9.9.9');
    // A sibling input's `default:` must never leak into the nextjsRef result.
    expect(workflowDispatchNextjsRefDefault(block)).not.toBe('1.4.2');
    // No nextjsRef key at all -> unparseable, not "no default".
    expect(workflowDispatchNextjsRefDefault('on:\n  workflow_dispatch:\n')).toBeUndefined();
    // Two default: lines nested under one nextjsRef key -> ambiguous, refuse.
    const ambiguous = [
      '      nextjsRef:',
      "        default: 'v1.0.0'",
      "        default: 'v2.0.0'",
    ].join('\n');
    expect(workflowDispatchNextjsRefDefault(ambiguous)).toBeUndefined();
    // Two separate nextjsRef keys in the same file -> ambiguous, refuse.
    expect(workflowDispatchNextjsRefDefault(`${block}\n${block}`)).toBeUndefined();
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

  it("test-e2e-deploy.yml's NEXTJS_REF env fallback matches the manifest's documented credentialedNextRef", () => {
    const manifest = loadManifest();
    const ref = workflowNextjsRef(
      readFileSync(resolve(WORKFLOWS_DIR, 'test-e2e-deploy.yml'), 'utf8'),
    );
    expect(ref, 'could not find a single NEXTJS_REF default in test-e2e-deploy.yml').toBeDefined();
    expect(ref).toBe(manifest.credentialedNextRef);
  });

  it("the scaffold's next pin matches the manifest's documented shippedNextPin", () => {
    const manifest = loadManifest();
    const pin = scaffoldNextPin(readFileSync(SCAFFOLD_PACKAGE_JSON_PATH, 'utf8'));
    expect(
      pin,
      'could not find a single "next" pin in templates/app/package.json.hbs',
    ).toBeDefined();
    expect(pin).toBe(manifest.shippedNextPin);
  });

  describe('every nextjsRef occurrence across .github/workflows/** (scan, not enumerated list)', () => {
    it('the scan actually finds occurrences — a scanner that finds nothing is decorative', () => {
      const occurrences = scanNextjsRefOccurrences(WORKFLOWS_DIR);
      // Known today: test-e2e-deploy.yml and compat-vinext.yml each carry one
      // dispatch-default and one env-fallback = 4. This assertion is a floor,
      // not a ceiling, so a THIRD lane adding its own nextjsRef only grows it.
      expect(occurrences.length).toBeGreaterThanOrEqual(4);
    });

    it('every occurrence parses (no unparseable nextjsRef/NEXTJS_REF site)', () => {
      const occurrences = scanNextjsRefOccurrences(WORKFLOWS_DIR);
      const unparseable = occurrences.filter((o) => o.value === undefined);
      expect(
        unparseable,
        `unparseable nextjsRef occurrence(s): ${JSON.stringify(unparseable)}`,
      ).toEqual([]);
    });

    it('every occurrence matches credentialedNextRef, or is explicitly classified as an exception', () => {
      const manifest = loadManifest();
      const occurrences = scanNextjsRefOccurrences(WORKFLOWS_DIR);
      const drifted = occurrences.filter((o) => {
        if (o.value === undefined) return false; // reported by the parse test above
        if (o.value === manifest.credentialedNextRef) return false;
        const excused = manifest.lockstepExceptions.some(
          (ex) => ex.file === o.file && ex.kind === o.kind && ex.value === o.value,
        );
        return !excused;
      });
      expect(
        drifted,
        `nextjsRef occurrence(s) drifted from credentialedNextRef (${manifest.credentialedNextRef}) ` +
          `with no matching lockstepExceptions entry: ${JSON.stringify(drifted)}. Either restore the ` +
          `value, or add a reviewed entry to .github/compat-credentialed-next-version.json's ` +
          'lockstepExceptions.',
      ).toEqual([]);
    });
  });

  describe("docs' credentialed-version citations track the manifest (round-2 finding)", () => {
    it('docs/compat-matrix.md cites credentialedNextRef', () => {
      const manifest = loadManifest();
      const text = readFileSync(COMPAT_MATRIX_MD_PATH, 'utf8');
      const ref = docsMatrixMdNextRef(text);
      expect(
        ref,
        'could not find a single vercel/next.js version citation in docs/compat-matrix.md',
      ).toBeDefined();
      expect(ref).toBe(manifest.credentialedNextRef);
    });

    it('apps/docs/content/docs/compat-matrix.mdx cites credentialedNextRef', () => {
      const manifest = loadManifest();
      const text = readFileSync(COMPAT_MATRIX_MDX_PATH, 'utf8');
      const ref = docsMatrixMdxNextRef(text);
      expect(
        ref,
        'could not find a single Next.js version citation in the compat-matrix.mdx callout',
      ).toBeDefined();
      expect(ref).toBe(manifest.credentialedNextRef);
    });

    it('the public docs plainly explain the scaffold ships a newer Next than the credentialed version', () => {
      const text = readFileSync(COMPAT_MATRIX_MDX_PATH, 'utf8');
      // Plain-language, no issue/PR/ADR numbers (apps/docs/content-hygiene.test.ts
      // enforces that repo-wide) — just requires the explanation to exist and to
      // mention both the "newer" framing and the shipped minor line.
      expect(text).toMatch(/newer Next\.js release/i);
      expect(text).toMatch(/16\.3\.x/);
    });
  });
});
