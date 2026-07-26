import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TESTS for action SHA-pinning on the PUBLISH PATH (#522).
 *
 * Threat model: `.github/workflows/release.yml`'s `changesets/action` step is
 * handed `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` — a live npm publish
 * credential — plus `GITHUB_TOKEN`. `release-ghp.yml` hands `GITHUB_TOKEN` to a
 * job with `packages: write`. A mutable ref (`@v1`, `@v4`, a branch, a moving
 * major tag) means whoever can retag/repoint that ref decides what code runs
 * with those credentials in scope. `changesets/action@v1` is the worst case: on
 * that repo `v1` is a *branch*, not even a tag.
 *
 * This is the CI-supply-chain analogue of security.md's "pin images by digest;
 * reject `:latest`" rule. These tests are the tripwire so a future "tidy-up"
 * cannot quietly restore floating tags.
 *
 * Scope: the two publish-path workflows only. Other workflows are intentionally
 * out of scope for this change (see the PR body / issue #522).
 *
 * Like the other workflow guard tests, this scans the YAML as text so it adds no
 * runtime YAML dependency.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

const PINNED_WORKFLOWS = ['release.yml', 'release-ghp.yml'] as const;

/**
 * The pins of record, resolved from the real upstream repositories (see the PR
 * body for the `gh api` resolution trail). Locking the exact SHA here means a
 * silent re-point of a pin also fails the suite, not just a tag regression.
 */
const EXPECTED_PINS: Record<string, { sha: string; version: string }> = {
  'actions/checkout': { sha: '11d5960a326750d5838078e36cf38b85af677262', version: 'v4.4.0' },
  'actions/setup-node': { sha: '49933ea5288caeca8642d1e84afbd3f7d6820020', version: 'v4.4.0' },
  'actions/upload-artifact': { sha: 'ea165f8d65b6e75b540449e92b4886f43607fa02', version: 'v4.6.2' },
  'pnpm/action-setup': { sha: 'b906affcce14559ad1aafd4ab0e942779e9f58b1', version: 'v4.3.0' },
  'changesets/action': { sha: 'a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d', version: 'v1.9.0' },
};

/** `uses: owner/repo[/path]@<ref>` with an optional trailing comment. */
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(\S+?)@(\S+)\s*(?:#\s*(.*))?$/;

function workflowText(file: string): string {
  return readFileSync(resolve(REPO_ROOT, '.github/workflows', file), 'utf8');
}

interface UsesRef {
  file: string;
  line: number;
  action: string;
  ref: string;
  comment: string | undefined;
}

function usesRefs(file: string): UsesRef[] {
  const refs: UsesRef[] = [];
  const lines = workflowText(file).split('\n');
  for (const [index, text] of lines.entries()) {
    const match = USES_LINE.exec(text);
    // Capture groups 1 and 2 are non-optional in USES_LINE, so a match always
    // yields both; group 3 (the version comment) is genuinely optional.
    if (match === undefined || match === null) continue;
    const [, action, ref, comment] = match;
    if (action === undefined || ref === undefined) continue;
    refs.push({ file, line: index + 1, action, ref, comment: comment?.trim() });
  }
  return refs;
}

function allUsesRefs(): UsesRef[] {
  return PINNED_WORKFLOWS.flatMap((file) => usesRefs(file));
}

describe('publish-path workflows SHA-pin every third-party action (#522)', () => {
  it('finds the expected `uses:` steps in both publish-path workflows', () => {
    // Sanity: if the extraction regex ever stops matching, the assertions below
    // would vacuously pass over an empty list.
    for (const file of PINNED_WORKFLOWS) {
      expect(usesRefs(file).length).toBeGreaterThan(0);
    }
    const actions = new Set(allUsesRefs().map((entry) => entry.action));
    expect([...actions].sort()).toEqual(Object.keys(EXPECTED_PINS).sort());
  });

  it.each(PINNED_WORKFLOWS)('%s pins every `uses:` to a 40-hex commit SHA', (file) => {
    for (const entry of usesRefs(file)) {
      expect(
        entry.ref,
        `${file}:${entry.line} — ${entry.action}@${entry.ref} is not a 40-hex commit SHA`,
      ).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it.each(PINNED_WORKFLOWS)('%s has no `uses:` on a mutable tag or branch', (file) => {
    for (const entry of usesRefs(file)) {
      const mutable =
        /^v?\d+(?:\.\d+)*$/.test(entry.ref) || // v4, v1, 4.3.0, …
        /^(?:main|master|latest|next|HEAD)$/i.test(entry.ref) ||
        !/^[0-9a-f]{40}$/.test(entry.ref);
      expect(mutable, `${file}:${entry.line} — ${entry.action}@${entry.ref} is a mutable ref`).toBe(
        false,
      );
    }
  });

  it.each(PINNED_WORKFLOWS)('%s annotates every pin with its human-readable version', (file) => {
    for (const entry of usesRefs(file)) {
      expect(
        entry.comment,
        `${file}:${entry.line} — ${entry.action} pin needs a trailing "# vX.Y.Z" version comment`,
      ).toMatch(/^v\d+\.\d+\.\d+/);
    }
  });

  it('pins each action to the SHA of record, and the comment matches that version', () => {
    for (const entry of allUsesRefs()) {
      const expected = EXPECTED_PINS[entry.action];
      expect(expected, `unexpected action ${entry.action} on the publish path`).toBeDefined();
      expect(entry.ref, `${entry.file}:${entry.line} — ${entry.action}`).toBe(expected?.sha);
      expect(entry.comment, `${entry.file}:${entry.line} — ${entry.action}`).toBe(
        expected?.version,
      );
    }
  });

  it('pins the token-receiving changesets/action step specifically', () => {
    const text = workflowText('release.yml');
    const changesets = usesRefs('release.yml').filter(
      (entry) => entry.action === 'changesets/action',
    );
    expect(changesets).toHaveLength(1);
    expect(changesets[0]?.ref).toBe(EXPECTED_PINS['changesets/action']?.sha);
    // The step still receives the publish credential — that is exactly why the
    // pin is load-bearing, so assert the pairing has not drifted apart.
    const stepIdx = text.indexOf(`changesets/action@${EXPECTED_PINS['changesets/action']?.sha}`);
    expect(stepIdx).toBeGreaterThan(-1);
    expect(text.slice(stepIdx)).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
  });

  it('explains in each workflow header WHY the pins are load-bearing', () => {
    for (const file of PINNED_WORKFLOWS) {
      const header = workflowText(file).split('\nname:')[0] ?? '';
      expect(header, `${file} header must document the SHA-pin rule`).toMatch(/SHA-pin/i);
      expect(header, `${file} header must name the credential exposure`).toMatch(
        /token|credential/i,
      );
    }
  });

  it('does not change the load-bearing publish gating in release.yml', () => {
    // Pin-only change: the environment, the publish-blocking `needs: audit`, and
    // the repo guard must all survive untouched.
    const text = workflowText('release.yml');
    expect(text).toMatch(/^\s*environment: npm-publish$/m);
    expect(text).toMatch(/^\s*needs: audit$/m);
    expect(text).toContain("github.repository == 'getknext-dev/knext'");
  });

  it('keeps the github-actions ecosystem under Dependabot so pins do not go stale', () => {
    const dependabot = readFileSync(resolve(REPO_ROOT, '.github/dependabot.yml'), 'utf8');
    expect(dependabot).toContain("package-ecosystem: 'github-actions'");
  });
});
