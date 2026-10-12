import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { frozenFileSet } from '../scripts/compat-credential-freeze-guard.mjs';
import { CREDENTIAL_LINES } from '../scripts/compat-credential-line.mjs';

/**
 * Dependabot must not touch the credential window's frozen or derived workflow
 * files.
 *
 * A grouped actions bump rewrites `uses:` pins across every workflow. Two kinds
 * of file cannot take that edit while a credential window is live:
 *   - FROZEN: the freeze guard (`scripts/compat-credential-freeze-guard.mjs`)
 *     refuses any PR that touches a file the credential harness executes while
 *     `rcTag` is non-null, and an inherited `rcBumpMarker` exempts nothing.
 *   - DERIVED: `compat-credential-v1.3.yml` is generated from the pinned tag's own
 *     `test-e2e-deploy.yml`, and a guard checks byte equality with its derivation.
 *     A hand (or bot) edit breaks it.
 * Both happened on a single bump PR (#2205): Lint & Test and the freeze guard
 * went red at once. `exclude-paths` on the github-actions entry keeps the bot
 * out of them; a human moves those pins under a reviewed marker / regeneration.
 *
 * THE EXPECTED SET IS DERIVED, NEVER LISTED HERE. The frozen half comes from
 * `frozenFileSet()` — the same function the freeze guard's CLI calls — and the
 * derived half from `CREDENTIAL_LINES[*].workflowFile`, the table the derivation
 * reads. A workflow that joins either set turns this test red until
 * dependabot.yml excludes it; one that leaves it turns it red until the stale
 * entry is dropped (a stale or over-broad exclude silently stops bumping pins).
 *
 * Scoped to workflow/action YAML: those are the only files Dependabot's
 * github-actions ecosystem rewrites.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

const DEPENDABOT_TARGET = /^\.github\/(workflows\/[^/]+|actions\/.+)\.ya?ml$/;

function expectedExcludes(): string[] {
  const out = new Set<string>();
  for (const f of frozenFileSet(REPO_ROOT) as Set<string>) {
    if (DEPENDABOT_TARGET.test(f)) out.add(f);
  }
  for (const spec of Object.values(CREDENTIAL_LINES) as { workflowFile: string }[]) {
    out.add(`.github/workflows/${spec.workflowFile}`);
  }
  return [...out].sort();
}

function actionsEntry(): { 'exclude-paths'?: unknown } {
  const cfg = parse(readFileSync(resolve(REPO_ROOT, '.github/dependabot.yml'), 'utf8')) as {
    updates: { 'package-ecosystem': string }[];
  };
  const entries = cfg.updates.filter((u) => u['package-ecosystem'] === 'github-actions');
  expect(entries.length, 'exactly one github-actions entry').toBe(1);
  return entries[0] as { 'exclude-paths'?: unknown };
}

describe('dependabot never rewrites credential-frozen or derived workflows', () => {
  it('the derived expectation is non-trivial (a vacuous set would pass anything)', () => {
    const expected = expectedExcludes();
    expect(expected).toContain('.github/workflows/test-e2e-deploy.yml');
    expect(expected).toContain('.github/workflows/compat-credential-freeze-guard.yml');
    expect(expected).toContain('.github/workflows/compat-credential-v1.3.yml');
  });

  it('the github-actions entry carries exclude-paths as a string array', () => {
    const paths = actionsEntry()['exclude-paths'];
    expect(Array.isArray(paths)).toBe(true);
    for (const p of paths as unknown[]) expect(typeof p).toBe('string');
  });

  it('excludes every frozen and derived workflow', () => {
    const paths = new Set((actionsEntry()['exclude-paths'] ?? []) as string[]);
    const missing = expectedExcludes().filter((f) => !paths.has(f));
    expect(
      missing,
      `not excluded from the github-actions bump:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('excludes nothing else (no stale entry, no glob that silences the channel)', () => {
    const paths = (actionsEntry()['exclude-paths'] ?? []) as string[];
    const expected = new Set(expectedExcludes());
    const extra = paths.filter((p) => !expected.has(p));
    expect(extra, `excluded but neither frozen nor derived:\n  ${extra.join('\n  ')}`).toEqual([]);
  });
});
