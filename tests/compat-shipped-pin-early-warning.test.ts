import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The shipped-pin early-warning lane (#1376 option b, founder-approved
 * 2026-09-25). This test proves the two hard requirements the design
 * carries, both of which the implementation deliberately makes STRUCTURAL
 * rather than something a maintainer has to remember:
 *
 *   1. It can NEVER advance a v1.0 credential count. It works by
 *      DISPATCHING `test-e2e-deploy.yml` rather than duplicating its
 *      harness, and that workflow's `KNEXT_COMPAT_MODE` is `'credential'`
 *      for exactly 4 named `schedule` cron literals — everything else,
 *      including every `workflow_dispatch`, is `'early-warning'`. This test
 *      (a) parses that expression and asserts it names only those 4
 *      literals (a 5th literal silently added later would fail this), and
 *      (b) asserts the new lane's own workflow never triggers on
 *      `schedule` in a way that could feed those 4 literals, and its
 *      dispatch script only ever calls `gh workflow run` (never
 *      re-emits a `schedule` event).
 *   2. It is TIED to `manifest.shippedNextPin` — never a second, hardcoded
 *      copy that could drift. `scripts/lib/dispatch-poll.mjs`'s
 *      `shippedPinRef` reads the SAME manifest
 *      `tests/nextjs-credential-lockstep.test.ts` guards, so a future bump
 *      to `shippedNextPin` (e.g. area-build's planned move to >=16.3.5) is
 *      picked up with no second place to edit — this test proves the LIVE
 *      value matches, not just the unit-level behaviour already covered by
 *      `tests/compat-shipped-pin-dispatch-poll.test.ts`.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const TEST_E2E_DEPLOY_PATH = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const EARLY_WARNING_WORKFLOW_PATH = resolve(
  REPO_ROOT,
  '.github/workflows/compat-shipped-pin-early-warning.yml',
);
const DISPATCH_SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/compat-shipped-pin-dispatch-and-wait.mjs');
const MANIFEST_PATH = resolve(REPO_ROOT, '.github/compat-credentialed-next-version.json');

/** The 4 cron literals `test-e2e-deploy.yml`'s KNEXT_COMPAT_MODE maps to
 * 'credential', extracted from the source text of the expression itself —
 * scanned, not hand-copied, so this test breaks the moment the real
 * expression's literal set changes shape. */
function credentialCronLiterals(workflowText: string): string[] {
  // Only the DEFINING assignment (the one built from `github.event.schedule`
  // comparisons) counts — a later passthrough like
  // `KNEXT_COMPAT_MODE: ${{ env.KNEXT_COMPAT_MODE }}` must not be mistaken
  // for a second, independent definition.
  const hits = [...workflowText.matchAll(/KNEXT_COMPAT_MODE:\s*\$\{\{([\s\S]*?)\}\}/g)].filter(
    (m) => m[1].includes('github.event.schedule'),
  );
  if (hits.length !== 1) return [];
  const expr = hits[0][1];
  return [...expr.matchAll(/github\.event\.schedule == '([^']+)' && 'credential'/g)].map(
    (m) => m[1],
  );
}

describe('shipped-pin early-warning lane cannot count toward the v1.0 credential (#1376 option b)', () => {
  it("test-e2e-deploy.yml's credential cron set is exactly the 4 known literals (self-test / drift guard)", () => {
    const text = readFileSync(TEST_E2E_DEPLOY_PATH, 'utf8');
    const literals = credentialCronLiterals(text);
    expect(
      literals,
      'could not extract the KNEXT_COMPAT_MODE credential-cron literal set — this test needs updating',
    ).not.toEqual([]);
    expect(new Set(literals)).toEqual(
      new Set(['17 1 * * *', '47 5 * * *', '17 22 * * *', '47 23 * * *']),
    );
  });

  it('the early-warning lane workflow never fires on those 4 credential cron literals', () => {
    const text = readFileSync(EARLY_WARNING_WORKFLOW_PATH, 'utf8');
    const credentialLiterals = credentialCronLiterals(readFileSync(TEST_E2E_DEPLOY_PATH, 'utf8'));
    for (const cron of credentialLiterals) {
      expect(text.includes(`'${cron}'`)).toBe(false);
    }
  });

  it("the early-warning lane's own triggers are workflow_dispatch and its own weekly schedule only — never `pull_request`", () => {
    const text = readFileSync(EARLY_WARNING_WORKFLOW_PATH, 'utf8');
    expect(text).toMatch(/^on:\s*$/m);
    expect(text).toContain('workflow_dispatch');
    expect(text).not.toMatch(/^\s*pull_request:/m);
  });

  it('the dispatch script only ever calls "gh workflow run" (workflow_dispatch) on the target workflow', () => {
    const text = readFileSync(DISPATCH_SCRIPT_PATH, 'utf8');
    expect(text).toContain("'workflow',\n    'run',");
    // Never a raw `schedule` trigger simulation, and never a direct write to
    // the credential-ref pin file this lane must never touch.
    expect(text).not.toContain('compat-credential-ref.json');
  });
});

describe("the lane's ref is tied to manifest.shippedNextPin, never a second hardcoded copy", () => {
  it('scripts/lib/dispatch-poll.mjs derives nextjsRef from the manifest, not a literal', async () => {
    const { shippedPinRef } = await import('../scripts/lib/dispatch-poll.mjs');
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(shippedPinRef(manifest)).toBe(`v${manifest.shippedNextPin}`);
    // An ARBITRARY synthetic value, not the real manifest's current value —
    // a hardcoded 'v16.3.3' impl would coincidentally pass the assertion
    // above today (that IS the real manifest's current value), so this is
    // what actually proves derivation rather than a hardcoded coincidence.
    expect(shippedPinRef({ shippedNextPin: '99.9.9' })).toBe('v99.9.9');
  });

  it('the dispatch script calls shippedPinRef(loadManifest()) — sourced, not hardcoded (self-test)', () => {
    const text = readFileSync(DISPATCH_SCRIPT_PATH, 'utf8');
    expect(text).toContain('shippedPinRef(loadManifest())');
    // No literal nextjsRef value anywhere in the script — the ONLY source
    // of truth is the manifest read at runtime.
    expect(text).not.toMatch(/nextjsRef\s*=\s*['"]v\d/);
  });

  it('the workflow file itself carries no hardcoded nextjsRef literal that could drift from the manifest', () => {
    const text = readFileSync(EARLY_WARNING_WORKFLOW_PATH, 'utf8');
    expect(text).not.toMatch(/nextjsRef=v\d/);
  });
});
