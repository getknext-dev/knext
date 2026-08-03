import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverPinnableFiles, mentionsUses } from '../scripts/verify-action-pins.mjs';

/**
 * GUARD TESTS for action SHA-pinning across EVERY workflow (#528).
 *
 * `tests/release-action-pins.test.ts` covers the two publish-path workflows —
 * the ones holding `secrets.NPM_TOKEN` — and deliberately stopped there (#522).
 * This file closes the rest of the surface, in the blast-radius order #528 asks
 * for: `supply-chain.yml` and `operator-supply-chain.yml` run **cosign keyless
 * signing over OIDC**, so an action that can move its own ref runs inside a job
 * holding an `id-token: write` token able to sign artifacts under this repo's
 * identity. No standing secret, but that is not "no blast radius".
 *
 * SCANNED, NOT ENUMERATED. The list of covered workflows is `readdirSync` over
 * `.github/workflows`, so a NEW workflow is pinned by default: adding one with
 * `uses: foo/bar@v1` fails this suite the moment it lands, rather than waiting
 * for someone to remember a list entry. `.claude/rules/workflow.md`: "an
 * enumerated list of call sites is how the second one gets missed; make an
 * unparseable construct FAIL rather than pass."
 *
 * DIVISION OF LABOUR — do not collapse these:
 *   - this file asserts a pin's FORM (a 40-hex SHA + an auditable `# vX.Y.Z`
 *     comment). It does NOT assert the SHA VALUE. An earlier revision of the
 *     publish-path guard did, and it reddened every CORRECT Dependabot bump
 *     (#530/#532), making "edit the supply-chain guard" the routine way to get
 *     green — how a control decays into a rubber stamp.
 *   - `scripts/verify-action-pins.mjs`, run by the nightly, resolves each pin
 *     against its claimed tag UPSTREAM at RUN time. That is where SHA VALUES are
 *     checked, because the answer lives upstream and legitimately changes.
 *
 * Scans the YAML as text, like the sibling workflow guards, so it adds no
 * runtime YAML dependency.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * Deliberate exceptions, each of which must be JUSTIFIED here. Empty is the
 * intended steady state — an entry is a hole in the rule, not a convenience.
 * A stale entry (naming a file that no longer exists) is itself a failure
 * below, so this cannot rot into an unread list.
 */
const PIN_EXEMPT: ReadonlyMap<string, string> = new Map();

/** `uses: owner/repo[/path]@<ref>` with an optional trailing comment. */
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(\S+?)@(\S+)\s*(?:#\s*(.*))?$/;

/**
 * The file set, from the SHARED discovery in scripts/verify-action-pins.mjs —
 * never a second `readdirSync` here. An earlier revision re-derived the workflow
 * half locally and imported the shared function for one test; the two agreed
 * only by luck, which is exactly the drift a single definition is supposed to
 * remove. Paths are repo-root-relative, so they cover `action.yml` and
 * `.github/actions/**` as well as `.github/workflows`.
 */
function workflowFiles(): string[] {
  return (discoverPinnableFiles(REPO_ROOT) as string[]).slice().sort();
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
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  for (const [index, line] of text.split('\n').entries()) {
    // Skip comment lines: a header that DISCUSSES `uses: actions/setup-node@…`
    // (several of ours do, explaining the rule) is documentation, not a step.
    if (/^\s*#/.test(line)) continue;
    const match = USES_LINE.exec(line);
    if (match === undefined || match === null) continue;
    const [, action, ref, comment] = match;
    if (action === undefined || ref === undefined) continue;
    refs.push({ file, line: index + 1, action, ref, comment: comment?.trim() });
  }
  return refs;
}

const FILES = workflowFiles();
const COVERED = FILES.filter((file) => !PIN_EXEMPT.has(file));

describe('every workflow SHA-pins every action (#528)', () => {
  it('finds workflows to scan at all', () => {
    // Without this, a broken directory path would make every `it.each` below
    // pass vacuously over an empty list.
    expect(FILES.length).toBeGreaterThan(5);
    expect(COVERED.length).toBeGreaterThan(0);
    // And the composite-action half of the boundary is really in the set — a
    // regression that dropped it would otherwise only show as a smaller number.
    expect(FILES, 'the root composite action must be in the scanned set').toContain('action.yml');
  });

  it.each(COVERED)('%s pins every `uses:` to an immutable 40-hex SHA', (file) => {
    for (const entry of usesRefs(file)) {
      expect(
        /^[0-9a-f]{40}$/.test(entry.ref),
        `${file}:${entry.line} — ${entry.action}@${entry.ref} is a MUTABLE ref. ` +
          'Whoever can move that tag or branch decides what code runs in this job. ' +
          'Pin it as `owner/repo@<40-hex-sha> # vX.Y.Z` (resolve the SHA upstream).',
      ).toBe(true);
    }
  });

  it.each(COVERED)('%s annotates every pin with the tag it claims', (file) => {
    for (const entry of usesRefs(file)) {
      expect(
        entry.comment,
        `${file}:${entry.line} — ${entry.action} needs a trailing "# vX.Y.Z" comment. ` +
          'A bare SHA tells a reader nothing about what version they are running, and ' +
          'scripts/verify-action-pins.mjs has nothing to resolve the pin against.',
      ).toMatch(/^v\d+\.\d+\.\d+/);
    }
  });

  it('parses a `uses:` from every file that has one — including quoted keys', () => {
    // Mutation-safety: if the extraction regex ever stops matching (a YAML style
    // change, a quoted key), the two suites above would go green over nothing.
    //
    // Conditional on `mentionsUses`, not unconditional, because a composite
    // action may legitimately have no steps to pin — the repo's own `action.yml`
    // is all `run:` steps today. `mentionsUses` is the SHARED, deliberately
    // weaker matcher from the script: it accepts `"uses":` and `'uses' :` as
    // well, so a step written in quoted-key form REDS here instead of vanishing
    // from both guards.
    let parsed = 0;
    for (const file of COVERED) {
      const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      const found = usesRefs(file).length;
      parsed += found;
      if (mentionsUses(text)) {
        expect(found, `${file} — mentions \`uses:\` but nothing parsed`).toBeGreaterThan(0);
      }
    }
    // Global non-vacuity floor: the per-file check above is silent on a tree
    // where NOTHING mentions `uses:` at all.
    expect(
      parsed,
      'no pins parsed anywhere — the extractor or the tree changed shape',
    ).toBeGreaterThan(20);
  });

  it('carries no stale pin exemption', () => {
    for (const [file, reason] of PIN_EXEMPT) {
      expect(FILES, `${file} is exempted from SHA-pinning but does not exist`).toContain(file);
      expect(reason.length, `${file}'s exemption must state WHY`).toBeGreaterThan(20);
    }
  });

  it('pins the actions inside the OIDC signing jobs specifically', () => {
    // #528's blast-radius argument in assertion form. These two workflows run
    // cosign KEYLESS signing: the job holds an OIDC token that can sign
    // artifacts under this repo's identity, so a movable action ref there is the
    // highest remaining exposure after the publish path.
    const signing = [
      '.github/workflows/supply-chain.yml',
      '.github/workflows/operator-supply-chain.yml',
    ];
    for (const file of signing) {
      // Membership in the scanned set, not just on disk: a file the discovery
      // stopped returning would otherwise still pass this test.
      expect(COVERED, `${file} must be inside the scanned set`).toContain(file);
      const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      expect(text, `${file} must still be the OIDC-signing workflow this guard targets`).toContain(
        'id-token: write',
      );
      const cosign = usesRefs(file).filter((entry) => entry.action === 'sigstore/cosign-installer');
      expect(cosign.length, `${file} must still install cosign`).toBeGreaterThan(0);
      for (const entry of cosign) {
        expect(entry.ref, `${file}:${entry.line} — cosign-installer must be SHA-pinned`).toMatch(
          /^[0-9a-f]{40}$/,
        );
      }
    }
  });

  it('keeps the github-actions ecosystem under Dependabot so pins do not go stale', () => {
    // Pinning without a bump channel just trades a supply-chain risk for
    // staleness. `/` covers .github/workflows and the ROOT action.yml — assert
    // that rather than assume it.
    const dependabot = readFileSync(resolve(REPO_ROOT, '.github/dependabot.yml'), 'utf8');
    expect(dependabot).toContain("package-ecosystem: 'github-actions'");
    expect(dependabot).toMatch(/(directory|directories):/);
    expect(dependabot, 'the repo root must be a scanned directory').toMatch(/'\/'/);
  });

  it("covers NESTED composite actions in Dependabot's directory scope", () => {
    // `/` does NOT reach `.github/actions/**/action.yml` — Dependabot scans a
    // directory, not a tree. Without this, a composite action added there would
    // be pinned-by-default by the guard above yet never BUMPED: pinned and
    // frozen, which is the staleness failure with extra steps.
    const dependabot = readFileSync(resolve(REPO_ROOT, '.github/dependabot.yml'), 'utf8');
    expect(dependabot, 'nested composite actions need their own directory entry').toMatch(
      /\.github\/actions/,
    );
  });

  it('gives Dependabot a bump channel wide enough for the pins it now owns', () => {
    // ~20 distinct actions across every workflow. With the default
    // `open-pull-requests-limit: 5` and no grouping, a week's bumps can exceed
    // the limit and the surplus silently waits — which is the staleness half of
    // the trade this file warns about, reintroduced by scale rather than by
    // decision. A group collapses them into one PR.
    const dependabot = readFileSync(resolve(REPO_ROOT, '.github/dependabot.yml'), 'utf8');
    expect(dependabot, 'the github-actions ecosystem needs a `groups:` entry').toMatch(
      /^\s*groups:/m,
    );
    // Scanned, not enumerated: the group must match every action, so a newly
    // pinned one joins it without a config edit.
    expect(dependabot, "the group's patterns must be a catch-all, not a list").toMatch(/'\*'/);
  });

  it('applies the SAME assertions to composite actions as to workflows', () => {
    // Previously this test re-implemented the per-match checks over a separately
    // obtained file list, which meant the composite-action half was covered by a
    // WEAKER, duplicated rule — per-match only, with no "mentions uses but
    // nothing parsed" alarm. Now that COVERED comes from the shared discovery,
    // every suite above already runs over those files; this test's job is to
    // assert that membership rather than to re-check the contents.
    const pinnable = discoverPinnableFiles(REPO_ROOT) as string[];
    expect(pinnable, 'the root composite action must be in scope').toContain('action.yml');
    for (const file of pinnable) {
      expect(COVERED, `${file} must be inside the assertion set, not merely discovered`).toContain(
        file,
      );
    }
  });
});
