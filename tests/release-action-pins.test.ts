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
 * The actions ALLOWED to run on the publish path — the credentialed surface, so
 * a new third-party action appearing here is a supply-chain change that must be
 * a deliberate edit, not a silent addition.
 *
 * Deliberately an allowlist of ACTIONS, not of SHAs. An earlier version pinned
 * the exact SHA + version of each entry, which made every legitimate Dependabot
 * bump fail this suite (proven: PRs #530/#532 bumped `actions/setup-node` from
 * v4.4.0 to v7.0.0 and CORRECTLY preserved the `@<40-hex> # vX.Y.Z` form, yet
 * went red here). That inverted the rule's intent: the point is that a ref is
 * IMMUTABLE and that Dependabot owns the bumps, not that a pin is frozen
 * forever. Worse, it trained the reader to edit this file to get green, which
 * is precisely how a supply-chain guard decays into a rubber stamp.
 *
 * Immutability and the auditable version comment are asserted structurally by
 * the tests below, which hold regardless of which version is current.
 */
const EXPECTED_ACTIONS: ReadonlySet<string> = new Set([
  'actions/checkout',
  'actions/setup-node',
  'actions/upload-artifact',
  'pnpm/action-setup',
  'changesets/action',
]);

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
    // Array.from, not spread: `tests/` is currently type-checked by no repo
    // script (see the open typecheck-gap issue), so a bare Set spread only
    // fails under a default-target tsc — avoid depending on that being fixed.
    expect(Array.from(actions).sort()).toEqual(Array.from(EXPECTED_ACTIONS).sort());
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

  it('admits only allowlisted actions onto the credentialed publish path', () => {
    for (const entry of allUsesRefs()) {
      expect(
        EXPECTED_ACTIONS.has(entry.action),
        `${entry.file}:${entry.line} — ${entry.action} is not allowlisted for the publish path. ` +
          'Adding a third-party action to a workflow that holds a registry-write credential is a ' +
          'supply-chain decision: review it, then add it to EXPECTED_ACTIONS deliberately.',
      ).toBe(true);
    }
  });

  it('pins every publish-path action immutably, whatever version is current', () => {
    // The invariant that actually matters, and the one that survives a bump:
    // a 40-hex commit SHA plus an auditable version comment. Asserting the
    // *value* of either would re-freeze the pins (see EXPECTED_ACTIONS).
    const seen = new Set<string>();
    for (const entry of allUsesRefs()) {
      seen.add(entry.action);
      expect(
        entry.ref,
        `${entry.file}:${entry.line} — ${entry.action} must be a 40-hex SHA`,
      ).toMatch(/^[0-9a-f]{40}$/);
      expect(
        entry.comment,
        `${entry.file}:${entry.line} — ${entry.action} pin needs a trailing "# vX.Y.Z" so the pin stays auditable`,
      ).toMatch(/^v\d+\.\d+\.\d+/);
    }
    // Guard against the file silently matching nothing (an empty program is the
    // failure mode that makes a green run meaningless).
    expect(seen.size, 'no `uses:` refs were parsed from the publish path at all').toBeGreaterThan(
      0,
    );
  });

  it('pins the token-receiving changesets/action step specifically', () => {
    const text = workflowText('release.yml');
    const changesets = usesRefs('release.yml').filter(
      (entry) => entry.action === 'changesets/action',
    );
    expect(changesets).toHaveLength(1);
    const ref = changesets[0]?.ref ?? '';
    // Structural, not value-based: whatever version Dependabot has moved this to,
    // the ref must be an immutable SHA. `changesets/action@v1` resolves to
    // refs/heads/v1 — a BRANCH — so a tag-looking ref here is the worst case in
    // the repo, not a cosmetic lapse.
    expect(ref, 'the changesets/action ref must be an immutable 40-hex SHA').toMatch(
      /^[0-9a-f]{40}$/,
    );
    // The step still receives the publish credential — that is exactly why the
    // pin is load-bearing, so assert the pairing has not drifted apart.
    const stepIdx = text.indexOf(`changesets/action@${ref}`);
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
