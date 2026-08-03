import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');

/**
 * Deliberate exceptions, each of which must be JUSTIFIED here. Empty is the
 * intended steady state — an entry is a hole in the rule, not a convenience.
 * A stale entry (naming a file that no longer exists) is itself a failure
 * below, so this cannot rot into an unread list.
 */
const PIN_EXEMPT: ReadonlyMap<string, string> = new Map();

/** `uses: owner/repo[/path]@<ref>` with an optional trailing comment. */
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(\S+?)@(\S+)\s*(?:#\s*(.*))?$/;

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
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
  const text = readFileSync(resolve(WORKFLOW_DIR, file), 'utf8');
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

  it('parses at least one `uses:` in every scanned workflow', () => {
    // Mutation-safety: if the extraction regex ever stops matching (a YAML style
    // change, say), the two suites above would go green over nothing.
    for (const file of COVERED) {
      expect(usesRefs(file).length, `${file} — no \`uses:\` steps parsed at all`).toBeGreaterThan(
        0,
      );
    }
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
    const signing = ['supply-chain.yml', 'operator-supply-chain.yml'];
    for (const file of signing) {
      const text = readFileSync(resolve(WORKFLOW_DIR, file), 'utf8');
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
    // staleness. Dependabot's `directory: '/'` covers .github/workflows as a
    // whole, so newly pinned files need no config change — assert that rather
    // than assume it.
    const dependabot = readFileSync(resolve(REPO_ROOT, '.github/dependabot.yml'), 'utf8');
    expect(dependabot).toContain("package-ecosystem: 'github-actions'");
    expect(dependabot).toMatch(/directory: '\/'/);
  });
});
