import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatFinding,
  PINNED_WORKFLOWS,
  parsePins,
  resolveTagCommit,
  verifyWorkflows,
} from '../scripts/verify-action-pins.mjs';

/**
 * GUARD TESTS for the nightly SHA↔tag resolution check (#539).
 *
 * `tests/release-action-pins.test.ts` asserts the FORM and SCOPE of a publish-
 * path pin: a 40-hex SHA, an auditable `# vX.Y.Z` comment, and an allowlist of
 * which actions may appear on a credential-bearing workflow. It deliberately
 * does NOT assert the SHA VALUE — an earlier revision did, and it reddened
 * every correct Dependabot bump (#530/#532), training the reader to edit the
 * guard to get green.
 *
 * The residual gap that leaves: NOTHING checks that a pinned SHA actually
 * belongs to the tag its comment names. `uses: actions/setup-node@<40-hex>
 * # v7.0.0` passes CI whether or not that SHA is v7.0.0, or is even in that
 * repository. Until now the only thing between a mismatched pin and the npm
 * publish credential was a human reading the Dependabot diff — documented
 * practice, not enforcement (security.md).
 *
 * The fix is a NIGHTLY job, not a unit test, because the answer lives upstream
 * and changes over time: resolution has to happen at RUN time against the
 * GitHub API. Baking a resolved value into a committed assertion is exactly the
 * staleness failure that got the value assertion removed.
 *
 * These tests cover both halves:
 *   1. the workflow — scheduled, never a PR gate, fails loudly;
 *   2. the resolver — annotated-tag dereference, missing tags, mismatches, and
 *      the actionability of the message, all against an INJECTED api so the
 *      suite stays offline and deterministic.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');
const NIGHTLY = resolve(WORKFLOW_DIR, 'action-pin-resolution-nightly.yml');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** A canned GitHub API double: `path -> { status, body }`. */
function fakeApi(routes: Record<string, { status: number; body?: unknown }>) {
  const seen: string[] = [];
  const api = async (path: string): Promise<{ status: number; body: unknown }> => {
    seen.push(path);
    const route = routes[path];
    // A path with no canned route is a 404 — the same shape the real transport
    // returns, so `body` is never optional (the script's inferred signature).
    return route
      ? { status: route.status, body: route.body }
      : { status: 404, body: { message: 'Not Found' } };
  };
  return { api, seen };
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_TAGOBJ = 'c'.repeat(40);

describe('nightly SHA↔tag resolution — the workflow (#539)', () => {
  it('exists and runs on a schedule', () => {
    const text = read(NIGHTLY);
    expect(text).toMatch(/^on:/m);
    expect(text).toMatch(/^\s{2}schedule:/m);
    expect(text).toMatch(/- cron: '[^']+'/);
  });

  it('does not gate PRs and does not run on every push', () => {
    const text = read(NIGHTLY);
    // The trigger block only — a `push:`/`pull_request:` key anywhere in it
    // would couple every merge to third-party API availability, which is the
    // failure mode this design deliberately avoids.
    const triggers = text.split(/^on:/m)[1]?.split(/^jobs:/m)[0] ?? '';
    expect(triggers, 'nightly must not run on push').not.toMatch(/^\s{2}push:/m);
    expect(triggers, 'nightly must not run on pull_request').not.toMatch(/^\s{2}pull_request:/m);
    expect(triggers, 'manual re-runs must stay possible').toMatch(/workflow_dispatch/);
  });

  it('invokes the resolver script rather than reimplementing it inline', () => {
    expect(read(NIGHTLY)).toContain('scripts/verify-action-pins.mjs');
  });

  it('is least-privilege by default and only the alert job may write issues', () => {
    const text = read(NIGHTLY);
    const header = text.split(/^jobs:/m)[0] ?? '';
    expect(header).toMatch(/^permissions:\n\s{2}contents: read$/m);
    expect(text).toMatch(/issues: write/);
  });

  it('fails loudly — an idempotent pinned alert issue on a red scheduled run', () => {
    const text = read(NIGHTLY);
    const alert = text.split(/^\s{2}\S+-alert:/m)[1] ?? '';
    expect(alert, 'alert must be scheduled-only so a dispatch experiment files nothing').toContain(
      "github.event_name == 'schedule'",
    );
    expect(alert, 'alert must not be skipped when the check job fails').toContain('always()');
    expect(alert, 'alert must fire only on failure').toMatch(/result == 'failure'/);
    // Idempotency: look up an existing open issue by a FIXED title and comment
    // on it rather than filing a fresh one every red night.
    expect(alert).toContain('gh issue list');
    expect(alert).toContain('gh issue comment');
  });

  it('passes a token so the run is not anonymous-rate-limited', () => {
    expect(read(NIGHTLY)).toMatch(
      /GITHUB_TOKEN: \$\{\{ (github\.token|secrets\.GITHUB_TOKEN) \}\}/,
    );
  });

  it('covers every workflow that holds the npm publish credential', () => {
    // Scanned, not enumerated: a THIRD workflow gaining NPM_TOKEN must not
    // silently escape the nightly just because someone forgot a list entry.
    const credentialed = readdirSync(WORKFLOW_DIR)
      .filter((file) => file.endsWith('.yml'))
      // Comment lines are stripped: a workflow that only DISCUSSES the
      // credential (this nightly's own header does) does not hold it.
      .filter((file) =>
        read(resolve(WORKFLOW_DIR, file))
          .split('\n')
          .filter((line) => !/^\s*#/.test(line))
          .join('\n')
          .includes('secrets.NPM_TOKEN'),
      );
    expect(credentialed.length, 'no credentialed workflow found — scan is vacuous').toBeGreaterThan(
      0,
    );
    for (const file of credentialed) {
      expect(
        (PINNED_WORKFLOWS as string[]).includes(file),
        `${file} holds NPM_TOKEN but is not covered by the nightly resolution check`,
      ).toBe(true);
    }
  });
});

describe('nightly SHA↔tag resolution — pin parsing (#539)', () => {
  it('extracts owner, repo, SHA and claimed tag from a pinned uses line', () => {
    const pins = parsePins(
      ['jobs:', '  x:', '    steps:', `      - uses: pnpm/action-setup@${SHA_A} # v4.2.0`].join(
        '\n',
      ),
      'release.yml',
    );
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      file: 'release.yml',
      line: 4,
      action: 'pnpm/action-setup',
      owner: 'pnpm',
      repo: 'action-setup',
      sha: SHA_A,
      tag: 'v4.2.0',
    });
  });

  it('keeps the repo, not the subpath, when an action lives in a subdirectory', () => {
    const pins = parsePins(`      - uses: owner/repo/sub/dir@${SHA_A} # v1.2.3`, 'release.yml');
    expect(pins[0]).toMatchObject({ owner: 'owner', repo: 'repo', action: 'owner/repo/sub/dir' });
  });

  it('reports an unpinned or uncommented ref rather than skipping it silently', () => {
    const pins = parsePins(
      ['      - uses: actions/checkout@v5', `      - uses: actions/setup-node@${SHA_A}`].join('\n'),
      'release.yml',
    );
    // Both are malformed for this check's purposes; neither may vanish.
    expect(pins).toHaveLength(2);
    expect(pins.every((pin: { tag?: string }) => pin.tag === undefined)).toBe(true);
  });
});

describe('nightly SHA↔tag resolution — upstream resolution (#539)', () => {
  it('resolves a lightweight tag directly to its commit', async () => {
    const { api } = fakeApi({
      'repos/pnpm/action-setup/git/ref/tags/v4.2.0': {
        status: 200,
        body: { object: { type: 'commit', sha: SHA_A } },
      },
    });
    await expect(
      resolveTagCommit({ owner: 'pnpm', repo: 'action-setup', tag: 'v4.2.0', api }),
    ).resolves.toMatchObject({ kind: 'commit', sha: SHA_A });
  });

  it('DEREFERENCES an annotated tag to the commit it points at', async () => {
    // The detail that makes or breaks this check: for an annotated tag the ref
    // object is a `tag` object whose OWN sha is not the commit. Comparing that
    // to the pin would red every correct annotated-tag pin.
    const { api, seen } = fakeApi({
      'repos/pnpm/action-setup/git/ref/tags/v4.2.0': {
        status: 200,
        body: { object: { type: 'tag', sha: SHA_TAGOBJ } },
      },
      [`repos/pnpm/action-setup/git/tags/${SHA_TAGOBJ}`]: {
        status: 200,
        body: { object: { type: 'commit', sha: SHA_A } },
      },
    });
    const resolved = await resolveTagCommit({
      owner: 'pnpm',
      repo: 'action-setup',
      tag: 'v4.2.0',
      api,
    });
    expect(resolved).toMatchObject({ kind: 'commit', sha: SHA_A, annotated: true });
    expect(seen).toHaveLength(2);
  });

  it('treats a tag that does not exist upstream as a finding, not an error to swallow', async () => {
    // `changesets/action@v1` is the live example: `git/ref/tags/v1` 404s
    // because v1 is a BRANCH. A deleted or moved tag is exactly what we want
    // to hear about.
    const { api } = fakeApi({});
    await expect(
      resolveTagCommit({ owner: 'changesets', repo: 'action', tag: 'v1', api }),
    ).resolves.toMatchObject({ kind: 'tag-missing' });
  });

  it('does not pretend an API failure is a pass', async () => {
    const { api } = fakeApi({
      'repos/actions/checkout/git/ref/tags/v5.0.0': { status: 500, body: { message: 'boom' } },
    });
    await expect(
      resolveTagCommit({ owner: 'actions', repo: 'checkout', tag: 'v5.0.0', api }),
    ).resolves.toMatchObject({ kind: 'api-error', status: 500 });
  });
});

describe('nightly SHA↔tag resolution — verdicts (#539)', () => {
  function workflowDirWith(uses: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-'));
    for (const file of PINNED_WORKFLOWS as string[]) {
      writeFileSync(
        join(dir, file),
        ['jobs:', '  x:', '    steps:', `      - uses: ${uses}`].join('\n'),
      );
    }
    return dir;
  }

  const matchingApi = () =>
    fakeApi({
      'repos/actions/checkout/git/ref/tags/v5.0.0': {
        status: 200,
        body: { object: { type: 'commit', sha: SHA_A } },
      },
    }).api;

  it('is SILENT when every pin resolves to its claimed tag', async () => {
    const dir = workflowDirWith(`actions/checkout@${SHA_A} # v5.0.0`);
    const findings = await verifyWorkflows({ dir, api: matchingApi() });
    expect(findings).toEqual([]);
  });

  it('REDS on a pin whose SHA is well-formed but is not that tag', async () => {
    const dir = workflowDirWith(`actions/checkout@${SHA_B} # v5.0.0`);
    const findings = await verifyWorkflows({ dir, api: matchingApi() });
    expect(findings.length).toBe((PINNED_WORKFLOWS as string[]).length);
    expect(findings[0]).toMatchObject({
      reason: 'sha-mismatch',
      pinnedSha: SHA_B,
      actualSha: SHA_A,
    });
  });

  it('REDS on a fork-network commit that is not the tag commit upstream', async () => {
    // security.md: GitHub resolves any SHA in a repository's FORK NETWORK from
    // the parent path, so `git/commits/<sha>` returning 200 proves nothing. This
    // check never asks that question — it compares against the commit the TAG
    // resolves to in the canonical repo, so a fork-pushed commit can never
    // match. Same assertion shape as the mismatch above, stated separately
    // because it is a distinct threat, not a duplicate case.
    const forkSha = 'd'.repeat(40);
    const dir = workflowDirWith(`actions/checkout@${forkSha} # v5.0.0`);
    const findings = await verifyWorkflows({ dir, api: matchingApi() });
    expect(findings[0]).toMatchObject({ reason: 'sha-mismatch', actualSha: SHA_A });
  });

  it('REDS on a pin whose comment names a tag that no longer exists', async () => {
    const dir = workflowDirWith(`changesets/action@${SHA_A} # v1.5.0`);
    const findings = await verifyWorkflows({ dir, api: fakeApi({}).api });
    expect(findings[0]).toMatchObject({ reason: 'tag-missing' });
  });

  it('REDS on a pin with no version comment to resolve against', async () => {
    const dir = workflowDirWith(`actions/checkout@${SHA_A}`);
    const findings = await verifyWorkflows({ dir, api: matchingApi() });
    expect(findings[0]).toMatchObject({ reason: 'no-version-comment' });
  });

  it('names the action, workflow, line, claimed tag, pinned SHA and actual SHA', async () => {
    // "SHA mismatch" alone is not actionable: whoever reads the red nightly
    // must be able to act without re-deriving anything.
    const dir = workflowDirWith(`actions/checkout@${SHA_B} # v5.0.0`);
    const [finding] = await verifyWorkflows({ dir, api: matchingApi() });
    const message = formatFinding(finding);
    expect(message).toContain('actions/checkout');
    expect(message).toContain('release.yml');
    expect(message).toContain(':4');
    expect(message).toContain('v5.0.0');
    expect(message).toContain(SHA_B);
    expect(message).toContain(SHA_A);
  });

  it('scans every publish-path workflow, not just the first', async () => {
    expect((PINNED_WORKFLOWS as string[]).length).toBeGreaterThan(1);
    const dir = workflowDirWith(`actions/checkout@${SHA_B} # v5.0.0`);
    const findings = await verifyWorkflows({ dir, api: matchingApi() });
    const files = new Set(findings.map((finding: { file: string }) => finding.file));
    expect(Array.from(files).sort()).toEqual(Array.from(PINNED_WORKFLOWS as string[]).sort());
  });
});
