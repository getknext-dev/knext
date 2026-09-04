import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  discoverPinnableFiles,
  formatFinding,
  GIT_FALLBACK_STATUSES,
  gitLsRemoteTag,
  PINNED_WORKFLOWS,
  parsePins,
  resolveTagCommit,
  verifyPins,
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

/**
 * Run the real script as a subprocess. The exit code is the entire contract
 * with the nightly, and no in-process import can observe it.
 */
function runScript(args: string[]): { status: number | null; output: string } {
  const script = resolve(REPO_ROOT, 'scripts/verify-action-pins.mjs');
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
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

/** What `gitLsRemoteTag` may answer — the contract every double must satisfy. */
type LsRemoteResult = ReturnType<typeof gitLsRemoteTag>;

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

  it('checks out WITHOUT persisting the credential into the checkout (#666 review)', () => {
    // `actions/checkout` defaults `persist-credentials: true`, which writes an
    // `http.https://github.com/.extraheader` AUTHORIZATION into the checkout's
    // LOCAL `.git/config`. That header applies to EVERY github.com URL, so the
    // "anonymous" git fallback would carry the runner's token — the very
    // identity the org IP allow list 403s — and #640 would be a no-op here.
    // Belt and braces: the resolver also isolates its own cwd (see the
    // "anonymous IN FACT" guards), because a future workflow may not.
    const text = read(NIGHTLY);
    const step = text.split(/uses: actions\/checkout@/)[1]?.split(/^\s{6}- name:/m)[0] ?? '';
    expect(step, 'the resolver job must not inherit a git credential').toMatch(
      /persist-credentials: false/,
    );
  });

  it('passes a token so the run is not anonymous-rate-limited', () => {
    expect(read(NIGHTLY)).toMatch(
      /GITHUB_TOKEN: \$\{\{ (github\.token|secrets\.GITHUB_TOKEN) \}\}/,
    );
  });

  it('does not overstate severity in the alert issue it files (#528 review)', () => {
    // The alert body is read by whoever triages a red night, BEFORE they open
    // the log. Since the check covers all workflows, a red caused by `ci.yml`
    // must not announce that a live npm publish credential is in scope —
    // overstating severity in exactly the direction this work exists to correct,
    // and misdirecting triage toward the release path.
    const alert = read(NIGHTLY).split(/^\s{2}\S+-alert:/m)[1] ?? '';
    expect(
      alert,
      'the alert body must not assert the finding is on the publish path — the check is repo-wide',
    ).not.toMatch(/publish path \(`release\.yml`/);
    expect(
      alert,
      'the alert body must not claim a live npm publish credential is in scope unconditionally',
    ).not.toMatch(/These workflows run with a live npm publish credential in scope/);
    // And positively: it must tell the reader that severity DEPENDS on which
    // workflow tripped, which is the actual triage question.
    expect(alert, 'the alert body must say severity depends on which workflow tripped').toMatch(
      /depends on which workflow/i,
    );
  });

  it('does not describe its own scope as publish-path-only', () => {
    const text = read(NIGHTLY);
    const header = text.split(/^on:/m)[0] ?? '';
    expect(header, 'the header must state the repo-wide scope').toMatch(/every workflow/i);
    const jobName = /^\s{4}name: (.+)$/m.exec(text.split(/^jobs:/m)[1] ?? '')?.[1] ?? '';
    expect(jobName, 'the job name must not still say "publish-path"').not.toMatch(/publish-path/i);
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

  it('turns a THROWN transport error into the same actionable report, not a stack trace', async () => {
    // DNS failure, TLS failure, offline runner: `fetch` REJECTS rather than
    // returning a 5xx. The verdict was already correct (exit 1 via an unhandled
    // rejection) but the operator got a raw stack trace instead of the per-pin
    // report — the same information gap the formatted findings exist to close.
    const api = async () => {
      throw new TypeError('fetch failed');
    };
    const resolved = await resolveTagCommit({
      owner: 'actions',
      repo: 'checkout',
      tag: 'v5.0.0',
      api,
    });
    expect(resolved).toMatchObject({ kind: 'api-error' });
    expect((resolved as { message?: string }).message).toMatch(/fetch failed/);
  });

  it('reports a thrown transport error per pin, and never as a pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-throw-'));
    writeFileSync(
      join(dir, 'ci.yml'),
      ['jobs:', '  x:', '    steps:', `      - uses: actions/checkout@${SHA_A} # v5.0.0`].join(
        '\n',
      ),
    );
    const findings = await verifyWorkflows({
      dir,
      api: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'api-error' });
    const message = formatFinding(findings[0]);
    // The underlying cause must survive into the report, and the verdict must be
    // unambiguous. "API error 0" would send the reader hunting an HTTP status
    // that does not exist, so the transport case gets its own wording.
    expect(message).toContain('ENOTFOUND');
    expect(message).toMatch(/Could not REACH the GitHub API/);
    expect(message).toMatch(/FAILURE, not a pass/);
    expect(message).not.toMatch(/API error 0/);
  });
});

describe('nightly SHA↔tag resolution — scope is every workflow (#528)', () => {
  it('DISCOVERS workflows from the directory rather than an enumerated list', async () => {
    // #528 extended the nightly past the publish path to every workflow — the
    // cosign/OIDC signing jobs first. Scanned, not enumerated: a workflow added
    // tomorrow must be resolved tonight without anyone editing a list. This is
    // the assertion that would go red if the default were re-pinned to
    // PINNED_WORKFLOWS.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-scope-'));
    // A name that appears in NO hard-coded list anywhere in the repo.
    writeFileSync(
      join(dir, 'brand-new-workflow.yml'),
      ['jobs:', '  x:', '    steps:', `      - uses: actions/checkout@${SHA_B} # v5.0.0`].join(
        '\n',
      ),
    );
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({
        'repos/actions/checkout/git/ref/tags/v5.0.0': {
          status: 200,
          body: { object: { type: 'commit', sha: SHA_A } },
        },
      }).api,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'brand-new-workflow.yml', reason: 'sha-mismatch' });
  });

  it('resolves each distinct action+tag ONCE across all workflows', async () => {
    // ~100 pins across 14 workflows; without de-duplication the nightly makes a
    // request per pin and rate-limits itself into a flaky red. De-duplication
    // must not change verdicts — the per-file findings below still hold.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-dedupe-'));
    for (const file of ['a.yml', 'b.yml', 'c.yml']) {
      writeFileSync(
        join(dir, file),
        ['jobs:', '  x:', '    steps:', `      - uses: actions/checkout@${SHA_A} # v5.0.0`].join(
          '\n',
        ),
      );
    }
    const { api, seen } = fakeApi({
      'repos/actions/checkout/git/ref/tags/v5.0.0': {
        status: 200,
        body: { object: { type: 'commit', sha: SHA_A } },
      },
    });
    expect(await verifyWorkflows({ dir, api })).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('still REDS every file when a de-duplicated resolution mismatches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-dedupe-red-'));
    for (const file of ['a.yml', 'b.yml']) {
      writeFileSync(
        join(dir, file),
        ['jobs:', '  x:', '    steps:', `      - uses: actions/checkout@${SHA_B} # v5.0.0`].join(
          '\n',
        ),
      );
    }
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({
        'repos/actions/checkout/git/ref/tags/v5.0.0': {
          status: 200,
          body: { object: { type: 'commit', sha: SHA_A } },
        },
      }).api,
    });
    expect(findings.map((finding: { file: string }) => finding.file).sort()).toEqual([
      'a.yml',
      'b.yml',
    ]);
  });

  it('treats an unreachable API as a FAILURE for every affected pin, never a pass', async () => {
    // security.md: "a checker that goes green when it cannot reach upstream is
    // worse than none." De-duplication must cache the FAILURE too, not drop it.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-unreachable-'));
    for (const file of ['a.yml', 'b.yml']) {
      writeFileSync(
        join(dir, file),
        ['jobs:', '  x:', '    steps:', `      - uses: actions/checkout@${SHA_A} # v5.0.0`].join(
          '\n',
        ),
      );
    }
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({
        'repos/actions/checkout/git/ref/tags/v5.0.0': { status: 503, body: { message: 'down' } },
      }).api,
    });
    expect(findings).toHaveLength(2);
    expect(findings.every((finding: { reason: string }) => finding.reason === 'api-error')).toBe(
      true,
    );
  });

  it('covers composite actions, not only .github/workflows (#528 review)', () => {
    // The scan boundary, asserted rather than documented. `.github/workflows` is
    // not the only place a `uses:` can live: this repo ships a ROOT `action.yml`
    // composite action, and `.github/actions/**` is the conventional home for
    // more. A pin added there must be resolved too, or "pinned by default" is
    // false for a whole class of file.
    const files = discoverPinnableFiles(REPO_ROOT);
    expect(files, 'the root composite action must be inside the scan').toContain('action.yml');
    for (const file of ['supply-chain.yml', 'operator-supply-chain.yml']) {
      expect(files, `${file} must be inside the scan`).toContain(`.github/workflows/${file}`);
    }
  });

  it('discovers a composite action dropped into .github/actions/**', () => {
    // The directory does not exist today. Assert the RULE, not the current tree,
    // so creating it later is covered without anyone remembering this file.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-composite-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(root, '.github', 'actions', 'nested'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'jobs: {}\n');
    writeFileSync(join(root, '.github', 'actions', 'nested', 'action.yml'), 'runs: {}\n');
    writeFileSync(join(root, 'action.yml'), 'runs: {}\n');
    expect(discoverPinnableFiles(root).sort()).toEqual([
      '.github/actions/nested/action.yml',
      '.github/workflows/ci.yml',
      'action.yml',
    ]);
  });

  it('REDS on an unpinned `uses:` inside a composite action', async () => {
    // The mutation that matters for the boundary: a floating ref in a composite
    // action must be a finding, exactly as it is in a workflow.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-composite-red-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, 'action.yml'),
      ['runs:', '  using: composite', '  steps:', '    - uses: actions/checkout@v7'].join('\n'),
    );
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'action.yml', reason: 'not-sha-pinned' });
  });

  it('does not invent a finding for a composite action that legitimately has no `uses:`', async () => {
    // The root action.yml is all `run:` steps today. "No pins parsed" is a
    // REGEX-BREAKAGE alarm, so it must not fire on a file that genuinely has
    // nothing to pin — a false red here trains people to ignore the nightly.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-nouses-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, 'action.yml'), ['runs:', '  using: composite'].join('\n'));
    expect(await verifyPins({ repoRoot: root, api: fakeApi({}).api })).toEqual([]);
  });

  it('STILL reds when a file mentions `uses:` but nothing parses (regex breakage)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-regex-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    // A `uses:` present in the text but in a shape the extractor cannot read is
    // exactly the silent-vacuum failure the alarm exists for.
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'steps:\n  - uses:\n');
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings[0]).toMatchObject({ reason: 'no-pins-parsed' });
  });

  it('FAILS when it can see no files at all — a checker that cannot reach its subject is not a pass', async () => {
    // security.md, quoted by this script at its own head: "a checker that goes
    // green when it cannot reach upstream is worse than none." The same applies
    // to its INPUT. Round 2's existsSync guards turned "no .github here" into
    // `✔ 0 file(s)` and exit 0, so a `working-directory:`, a checkout with
    // `path:`, or moving the script would have left the nightly permanently and
    // silently green. The PR-time form guard cannot protect the nightly — it
    // asserts over the repo tree at PR time, not over whatever the runner sees.
    const empty = mkdtempSync(join(tmpdir(), 'knext-pin-empty-'));
    const findings = await verifyPins({ repoRoot: empty, api: fakeApi({}).api });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'no-files-discovered' });
    expect(formatFinding(findings[0])).toMatch(/no workflow or action files/i);
  });

  it('exits NON-ZERO at run time when pointed at a tree with nothing to check', () => {
    // The run-time floor, proved by actually running the script — the unit test
    // above cannot see main()'s exit code, and the exit code is the whole
    // contract with the nightly.
    const empty = mkdtempSync(join(tmpdir(), 'knext-pin-empty-run-'));
    const script = resolve(REPO_ROOT, 'scripts/verify-action-pins.mjs');
    const result = spawnSync(process.execPath, [script, '--root', empty], { encoding: 'utf8' });
    expect(result.status, 'scanning zero files must FAIL, never report success').not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/no workflow or action files/i);
  });

  it('exits NON-ZERO on the RETIRED --dir flag rather than silently scanning cwd', () => {
    // `--dir` was the round-1 flag and is now unsupported. Ignoring it silently
    // would scan the wrong tree and print green — the same fail-open family as
    // the zero-file case. This hits the DEDICATED --dir branch; the catch-all
    // and the missing-value branch are separate paths, tested below. (An earlier
    // revision named this test "unrecognised flag" while only ever exercising
    // the --dir branch, so the catch-all's `return 1` could be deleted with the
    // suite still green.)
    const result = runScript(['--dir', '/tmp']);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/--dir/);
  });

  it.each([
    ['--nope'],
    ['-x'],
    ['/some/positional/path'],
    ['--root=/tmp'],
  ])('exits NON-ZERO on the unrecognised argument %s (the CATCH-ALL branch)', (arg) => {
    // Reaches the catch-all, not the --dir branch. `--root=/tmp` is included
    // deliberately: the parser accepts `--root <value>`, NOT `--root=value`,
    // so the equals form must be rejected rather than silently scanning cwd.
    //
    // The exit code alone is NOT a mutation proof, and asserting only on it made
    // this test depend on ambient network state (#630). Mutate the catch-all's
    // `return 1` to `continue` and the script falls through and SCANS — and that
    // scan's own exit code is whatever the network says. Both polarities have
    // been OBSERVED on the same mutant: where api.github.com rate-limited an
    // unauthenticated caller the scan exited non-zero and the old assertions
    // stayed GREEN; on a machine where it did not, the scan found every pin
    // valid, exited 0, and the old assertions went RED. Neither reading is the
    // rule — the point is that the verdict was decided by ambient network state
    // rather than by the code under test, in EITHER direction.
    //
    // Two changes make it deterministic and offline:
    //   1. `--root <empty dir>` — a fall-through scan then finds zero files, so
    //      it reaches the no-files floor WITHOUT firing ~140 live GitHub API
    //      calls from a unit-test run (the second half of #630).
    //   2. assert the output IS the usage block, nothing more. An absence-match
    //      on scan wording would couple this to unrelated output text — the
    //      usage string could plausibly grow the words "workflow/action files"
    //      and false-red four tests for no behavioural reason. Equality proves
    //      strictly more: nothing was scanned AND nothing else was printed.
    const empty = mkdtempSync(join(tmpdir(), 'knext-pin-catchall-'));
    const result = runScript(['--root', empty, arg]);
    expect(result.status, `${arg} must not be silently ignored`).not.toBe(0);
    expect(
      result.output,
      `${arg} must abort BEFORE scanning — a fall-through that happens to exit non-zero is not a rejection`,
    ).toBe(
      `✖ unrecognised argument: ${arg}\n  Usage: verify-action-pins.mjs [--root <repo-root>]\n`,
    );
  });

  it('rejects an unrecognised argument given ALONE, with no --root ahead of it', () => {
    // Coverage the case above cannot give: every entry there is
    // `['--root', empty, arg]`, so the bad flag is never the SOLE or FIRST
    // argument. The code is correct today — this keeps it that way without
    // making the test depend on the network. `cwd` is an empty tree, so a
    // mutated fall-through scans nothing and stays offline exactly as above.
    const empty = mkdtempSync(join(tmpdir(), 'knext-pin-catchall-alone-'));
    const script = resolve(REPO_ROOT, 'scripts/verify-action-pins.mjs');
    const result = spawnSync(process.execPath, [script, '--nope'], {
      encoding: 'utf8',
      cwd: empty,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toBe(
      '✖ unrecognised argument: --nope\n  Usage: verify-action-pins.mjs [--root <repo-root>]\n',
    );
  });

  it.each([
    [['--root']],
    [['--root', '--nope']],
  ])('exits NON-ZERO when --root has no value (%s)', (args) => {
    // The missing-value branch. Without it, `--root` alone resolved '' to cwd
    // and scanned the wrong tree — green from an invocation that asked for
    // something else entirely.
    const result = runScript(args);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/--root requires a path/i);
  });

  it('exits NON-ZERO from a path containing a SPACE or non-ASCII character', () => {
    // The direct-execution guard compares `import.meta.url` (percent-encoded)
    // against a raw `file://${process.argv[1]}`. From `/dir with space/`, those
    // differ, main() never runs, and the process exits 0 having verified
    // NOTHING — a genuine fail-open, and the exact claim this script's header
    // makes. Not reachable on the GH runner today, which is precisely why it
    // needs a test rather than an assumption.
    for (const dirName of ['dir with space', 'dir-ünïcode-✓']) {
      const home = mkdtempSync(join(tmpdir(), 'knext-pin-path-'));
      const scriptDir = join(home, dirName);
      mkdirSync(scriptDir, { recursive: true });
      const copied = join(scriptDir, 'verify-action-pins.mjs');
      copyFileSync(resolve(REPO_ROOT, 'scripts/verify-action-pins.mjs'), copied);
      // An empty tree, so a script that RUNS must fail on the zero-file floor.
      // Exit 0 here means it never executed main() at all.
      const empty = mkdtempSync(join(tmpdir(), 'knext-pin-path-cwd-'));
      const result = spawnSync(process.execPath, [copied, '--root', empty], {
        encoding: 'utf8',
        cwd: empty,
      });
      expect(result.status, `${dirName}: the script must actually RUN and fail`).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/no workflow or action files/i);
    }
  });

  it('flags a QUOTED-key `uses:` that the extractor cannot read', async () => {
    // `- "uses": evil/action@main` is a VALID Actions step that matches neither
    // regex. Round 2's narrowing lost this: it yielded zero findings where round
    // 1 reported `no-pins-parsed`. The alarm must key on the quoted form too, or
    // a composite action written entirely this way passes every guard silently.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-quoted-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      ['jobs:', '  x:', '    steps:', '      - "uses": evil/action@main'].join('\n'),
    );
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'no-pins-parsed' });
  });

  it('does NOT flag a LOCAL composite-action ref, which has nothing to pin', async () => {
    // `uses: ./.github/actions/foo` invokes THIS repository's own code at the
    // commit already checked out. There is no upstream tag to resolve and no SHA
    // to pin — pinning it is not merely unnecessary, it is impossible. But
    // `USES_LINE` needs an `@` so it parses nothing, and `mentionsUses` saw the
    // key, so the pair produced a `no-pins-parsed` FALSE RED. No such ref exists
    // in the tree today; this PR widens scope precisely toward local composite
    // actions, so the false red would arrive with the first one.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-local-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      ['jobs:', '  x:', '    steps:', '      - uses: ./.github/actions/foo'].join('\n'),
    );
    expect(await verifyPins({ repoRoot: root, api: fakeApi({}).api })).toEqual([]);
  });

  it.each([
    ["      - uses: './.github/actions/foo'", 'single-quoted value'],
    ['      - uses: "./.github/actions/foo"', 'double-quoted value'],
    ["      - uses: '../shared/action'", 'quoted parent-relative value'],
  ])('does NOT flag a local ref written as a %s (#630)', async (line) => {
    // The exclusion above keyed on an UNQUOTED ref, so the same false red
    // survived one quoting level away: `uses: './.github/actions/foo'` is a
    // valid step, has nothing to pin, and still produced `no-pins-parsed`. The
    // file already handled a quoted KEY, which is what makes the quoted VALUE
    // worth closing rather than leaving as a curiosity.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-local-quoted-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      ['jobs:', '  x:', '    steps:', line].join('\n'),
    );
    expect(await verifyPins({ repoRoot: root, api: fakeApi({}).api })).toEqual([]);
  });

  it('still flags a REMOTE ref in a file that also holds a QUOTED local one (#630)', async () => {
    // The widened exclusion must stay per-REF. A quoted local ref must not buy
    // the rest of the file an exemption.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-local-quoted-mixed-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      [
        'jobs:',
        '  x:',
        '    steps:',
        "      - uses: './.github/actions/foo'",
        '      - uses: actions/checkout@v7',
      ].join('\n'),
    );
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'not-sha-pinned', action: 'actions/checkout' });
  });

  it.each([
    ['      - uses: "./x', 'double-quote opened, never closed'],
    ["      - uses: './.github/actions/x", 'single-quote opened, never closed'],
    ['      - uses: "./x\'', 'MISMATCHED pair'],
  ])('still flags a ref whose quoting is broken (%s) — only a MATCHED pair is stripped', async (line) => {
    // The one new behavioural property the unquoting introduced, and previously
    // the only unproven one: `/^(["'])(.*)\1$/` requires the SAME quote at both
    // ends. Relaxing it to `/^["']?(.*?)["']?$/` leaves every other test green
    // while silently treating `uses: "./x` as a local ref — a stray quote
    // becoming a way to dress a ref up as local.
    //
    // Exploitability is near zero (an unterminated quote is invalid YAML, and
    // anything carrying an `@` is caught by `parsePins` regardless), so this is
    // hygiene. It is asserted anyway because an unproven claim attached to a
    // good test is the exact pattern this change exists to correct.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-badquote-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      ['jobs:', '  x:', '    steps:', line].join('\n'),
    );
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'no-pins-parsed' });
  });

  it.each([
    ['      - uses: docker://alpine:3.18', 'unquoted'],
    ["      - uses: 'docker://alpine:3.18'", 'quoted'],
  ])('STILL flags a %s docker:// ref — an unpinned image is loud by design', async (line) => {
    // Deliberate, not an oversight: `docker://` names a container image, and the
    // digest-pinning rule (security.md) wants an unpinned one noisy. Widening
    // the local-ref exclusion must not swallow it in either quoting form.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-docker-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      ['jobs:', '  x:', '    steps:', line].join('\n'),
    );
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'docker-ref-unpinned' });
  });

  it('tells a docker:// reader about the IMAGE, not about a regex bug', async () => {
    // Pre-existing mismatch this change is the first to codify: an unpinned
    // container image was reported as `no-pins-parsed`, whose text says "the
    // extraction regex or the file changed shape (a quoted key, say)" — sending
    // the reader after a regex bug when the real finding is an unpinned image.
    // This file has already been corrected twice for exactly that class of
    // misdirection, so it gets its own finding rather than a note.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-docker-text-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      ['jobs:', '  x:', '    steps:', '      - uses: docker://alpine:3.18'].join('\n'),
    );
    const [finding] = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    const text = formatFinding(finding);
    expect(text, 'the offending image must be named').toContain('docker://alpine:3.18');
    expect(text, 'say what it is: an unpinned container image').toMatch(/container image/i);
    expect(text, 'must not send the reader after the extraction regex').not.toMatch(
      /extraction regex/i,
    );
  });

  it('keeps the regex-breakage alarm distinct from the docker one in a MIXED file', async () => {
    // A file can hold both. Collapsing them would let one mask the other — the
    // silent-vacuum failure the `no-pins-parsed` alarm exists for.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-docker-mixed-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      ['steps:', '  - uses: docker://alpine:3.18', '  - "uses": evil/action@main'].join('\n'),
    );
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings.map((finding) => finding.reason).sort()).toEqual([
      'docker-ref-unpinned',
      'no-pins-parsed',
    ]);
  });

  it('still flags a REMOTE ref in a file that also has a local one', async () => {
    // The exclusion must be per-REF, not per-file: one local `uses:` must not
    // grant the rest of the file an exemption.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-local-mixed-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      [
        'jobs:',
        '  x:',
        '    steps:',
        '      - uses: ./.github/actions/foo',
        '      - uses: actions/checkout@v7',
      ].join('\n'),
    );
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'not-sha-pinned', action: 'actions/checkout' });
  });

  it('does not let a local-looking ref smuggle in an unpinned REMOTE action', async () => {
    // The exclusion keys on the REF starting with `./` or `../`, never on the
    // line merely containing one — otherwise `uses: evil/action@main # ./x`
    // would be waved through.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-local-smuggle-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      ['steps:', '  - uses: evil/action@main # ./.github/actions/foo'].join('\n'),
    );
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'not-sha-pinned', action: 'evil/action' });
  });

  it('flags a single-quoted key too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-quoted1-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), "steps:\n  - 'uses' : a/b@main\n");
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings[0]).toMatchObject({ reason: 'no-pins-parsed' });
  });

  it('descends a SYMLINKED directory under .github/actions', async () => {
    // `entry.isDirectory()` is FALSE for a symlink Dirent, so a symlinked
    // directory was never walked. Safe by omission, but it is a silent gap in a
    // boundary the commit message calls complete.
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-symlink-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(root, '.github', 'actions'), { recursive: true });
    mkdirSync(join(root, 'real-action'), { recursive: true });
    writeFileSync(
      join(root, 'real-action', 'action.yml'),
      ['runs:', '  steps:', '    - uses: actions/checkout@v7'].join('\n'),
    );
    symlinkSync(join(root, 'real-action'), join(root, '.github', 'actions', 'linked'), 'dir');
    expect(discoverPinnableFiles(root)).toContain('.github/actions/linked/action.yml');
    const findings = await verifyPins({ repoRoot: root, api: fakeApi({}).api });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'not-sha-pinned' });
  });

  it('does not loop forever on a symlink cycle', () => {
    const root = mkdtempSync(join(tmpdir(), 'knext-pin-cycle-'));
    mkdirSync(join(root, '.github', 'actions', 'a'), { recursive: true });
    // A directory that contains a link back to its own ancestor.
    symlinkSync(join(root, '.github', 'actions'), join(root, '.github', 'actions', 'a', 'loop'));
    expect(() => discoverPinnableFiles(root)).not.toThrow();
  });

  it('covers the OIDC-signing workflows in the real repo', () => {
    // The blast-radius argument #528 makes, asserted against the real tree: the
    // cosign keyless-signing workflows must be inside the nightly's scan. A
    // directory scan gives this for free — this test is what notices if the
    // scan is ever narrowed back to a list.
    const scanned = readdirSync(WORKFLOW_DIR).filter((file) => file.endsWith('.yml'));
    for (const file of ['supply-chain.yml', 'operator-supply-chain.yml']) {
      expect(scanned, `${file} must be inside the nightly's scan`).toContain(file);
    }
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
    const findings = await verifyWorkflows({ dir, api: matchingApi() });
    // Select the file under assertion rather than taking findings[0]: since
    // #528 the scan is a sorted DIRECTORY listing, so `release-ghp.yml` sorts
    // first. Indexing by position would assert on whichever file happens to
    // come first, which is not what this test is about.
    const finding = findings.find((entry: { file: string }) => entry.file === 'release.yml');
    expect(finding, 'expected a finding on release.yml').toBeDefined();
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

/**
 * #640 — the org IP-allow-list hole.
 *
 * MEASURED, not assumed: the nightly went red on 2026-08-04/05 with FOUR
 * findings, all of them `aquasecurity/trivy-action # v0.36.0`, all of them
 *
 *   GitHub API error 403: Although you appear to have the correct authorization
 *   credentials, the `aquasecurity` organization has an IP allow list enabled,
 *   and your IP address is not permitted to access this resource.
 *
 * The pins are CORRECT — `git ls-remote --tags https://github.com/aquasecurity/
 * trivy-action` returns `ed142fd…` for `refs/tags/v0.36.0^{}`, which is exactly
 * what all four workflows pin. The check was behaving correctly per security.md
 * ("an unreachable API is a FAILURE, never a pass"); it simply had NO WAY to
 * reach those four pins from a GitHub-hosted runner, so it was permanently red
 * — and a permanently-red gate is one people learn to ignore, which is worse
 * than the failure it was built to catch.
 *
 * The fix is to RESOLVE them another way, never to downgrade the failure. The
 * anonymous git protocol is not subject to the org's API IP allow list, and it
 * gives the SAME guarantee the API path gives: `refs/tags/<tag>^{}` is the
 * annotated-tag dereference, and the refs come from the CANONICAL repository, so
 * the fork-network immunity is preserved.
 *
 * What must NOT change, and is asserted below:
 *   - a 403 is not a pass — it is a REDIRECT to a second resolver, and if that
 *     resolver cannot answer either, the finding stands;
 *   - the fallback is reachable ONLY from 403/451. Any other status — 404, 429,
 *     500, a thrown transport — resolves or fails exactly as before, so this
 *     cannot silently cover a real mismatch on some other repo;
 *   - a genuine mismatch on an allowlisted-out repo STILL REDS, through the
 *     fallback.
 */
describe('nightly SHA↔tag resolution — org IP allow list (#640)', () => {
  const TRIVY_REF = 'repos/aquasecurity/trivy-action/git/ref/tags/v0.36.0';
  const IP_ALLOW_LIST_403 = {
    status: 403,
    body: {
      message:
        'Although you appear to have the correct authorization credentials, the `aquasecurity` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.',
    },
  };

  /**
   * A canned `git ls-remote` double that records what it was asked.
   *
   * Typed as the RESOLVER'S OWN return type, not `unknown`: the latter is not
   * assignable to the `lsRemote` parameter, so the root typecheck gate
   * (`tsc -p tsconfig.typecheck.json`, ci.yml "Typecheck (root tests/)") went
   * red once per call site. Caught here rather than in CI on the next round.
   */
  function fakeLsRemote(result: LsRemoteResult) {
    const seen: Array<{ owner: string; repo: string; tag: string }> = [];
    const lsRemote = (request: { owner: string; repo: string; tag: string }): LsRemoteResult => {
      seen.push(request);
      return result;
    };
    return { lsRemote, seen };
  }

  it('resolves a 403-blocked repo over the anonymous git protocol instead of failing blind', async () => {
    const { lsRemote, seen } = fakeLsRemote({ kind: 'commit', sha: SHA_A, annotated: true });
    const resolved = await resolveTagCommit({
      owner: 'aquasecurity',
      repo: 'trivy-action',
      tag: 'v0.36.0',
      api: fakeApi({ [TRIVY_REF]: IP_ALLOW_LIST_403 }).api,
      lsRemote,
    });
    expect(resolved).toMatchObject({ kind: 'commit', sha: SHA_A, via: 'git-ls-remote' });
    expect(seen).toEqual([{ owner: 'aquasecurity', repo: 'trivy-action', tag: 'v0.36.0' }]);
  });

  it('STILL REDS a genuine mismatch on a 403-blocked repo — the fallback verifies, it does not excuse', async () => {
    // The property that makes this a fix rather than a hole. If the fallback
    // resolved and then shrugged, #640 would have traded a noisy gate for a
    // silent one on precisely the four pins it stopped covering.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-403-mismatch-'));
    writeFileSync(
      join(dir, 'supply-chain.yml'),
      [
        'jobs:',
        '  x:',
        '    steps:',
        `      - uses: aquasecurity/trivy-action@${SHA_B} # v0.36.0`,
      ].join('\n'),
    );
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({ [TRIVY_REF]: IP_ALLOW_LIST_403 }).api,
      lsRemote: fakeLsRemote({ kind: 'commit', sha: SHA_A, annotated: true }).lsRemote,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      reason: 'sha-mismatch',
      pinnedSha: SHA_B,
      actualSha: SHA_A,
    });
  });

  it('goes GREEN on the four real trivy pins only because they genuinely resolve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-403-green-'));
    writeFileSync(
      join(dir, 'supply-chain.yml'),
      [
        'jobs:',
        '  x:',
        '    steps:',
        `      - uses: aquasecurity/trivy-action@${SHA_A} # v0.36.0`,
      ].join('\n'),
    );
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({ [TRIVY_REF]: IP_ALLOW_LIST_403 }).api,
      lsRemote: fakeLsRemote({ kind: 'commit', sha: SHA_A, annotated: true }).lsRemote,
    });
    expect(findings).toEqual([]);
  });

  it('keeps a 403 a FAILURE when the git fallback cannot answer either, and names BOTH causes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-403-blocked-'));
    writeFileSync(
      join(dir, 'supply-chain.yml'),
      [
        'jobs:',
        '  x:',
        '    steps:',
        `      - uses: aquasecurity/trivy-action@${SHA_A} # v0.36.0`,
      ].join('\n'),
    );
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({ [TRIVY_REF]: IP_ALLOW_LIST_403 }).api,
      lsRemote: fakeLsRemote({ kind: 'transport-error', message: 'Could not read from remote' })
        .lsRemote,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'api-error', status: 403 });
    const message = formatFinding(findings[0]);
    expect(message).toMatch(/IP allow list/);
    expect(message).toMatch(/git ls-remote/);
    expect(message).toMatch(/Could not read from remote/);
    expect(message).toMatch(/FAILURE, not a pass/);
  });

  it('SAYS which resolver answered when a mismatch came from the fallback (#666 review)', async () => {
    // `via` was recorded on the finding and rendered NOWHERE — a dead field
    // under a comment promising "the reader should know the API never
    // answered". Triaging a mismatch on an allow-listed repo starts with which
    // route produced the number, so print it.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-403-via-'));
    writeFileSync(
      join(dir, 'supply-chain.yml'),
      [
        'jobs:',
        '  x:',
        '    steps:',
        `      - uses: aquasecurity/trivy-action@${SHA_B} # v0.36.0`,
      ].join('\n'),
    );
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({ [TRIVY_REF]: IP_ALLOW_LIST_403 }).api,
      lsRemote: fakeLsRemote({ kind: 'commit', sha: SHA_A, annotated: true }).lsRemote,
    });
    expect(findings[0]).toMatchObject({ reason: 'sha-mismatch', via: 'git-ls-remote' });
    expect(formatFinding(findings[0])).toMatch(/git ls-remote/);
    expect(formatFinding(findings[0]), 'and why that route was taken').toMatch(
      /API (never answered|did not answer)/i,
    );
  });

  it('does NOT claim a fallback on a mismatch the API itself resolved', async () => {
    // Both halves. A `via` line printed unconditionally would tell the reader
    // the API was blocked on every ordinary mismatch, which is the same class
    // of misdirection in the opposite direction.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-via-absent-'));
    writeFileSync(
      join(dir, 'ci.yml'),
      ['jobs:', '  x:', '    steps:', `      - uses: some/action@${SHA_B} # v1.2.3`].join('\n'),
    );
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({
        'repos/some/action/git/ref/tags/v1.2.3': {
          status: 200,
          body: { object: { type: 'commit', sha: SHA_A } },
        },
      }).api,
      lsRemote: () => {
        throw new Error('the fallback must never be reached on a 200');
      },
    });
    expect(findings[0]).toMatchObject({ reason: 'sha-mismatch' });
    expect(formatFinding(findings[0])).not.toMatch(/ls-remote/);
  });

  it('reports a tag the git fallback cannot find as tag-missing, not as an API error', async () => {
    const resolved = await resolveTagCommit({
      owner: 'aquasecurity',
      repo: 'trivy-action',
      tag: 'v9.9.9',
      api: fakeApi({ 'repos/aquasecurity/trivy-action/git/ref/tags/v9.9.9': IP_ALLOW_LIST_403 })
        .api,
      lsRemote: fakeLsRemote({ kind: 'tag-missing' }).lsRemote,
    });
    expect(resolved).toMatchObject({ kind: 'tag-missing' });
  });

  it('does not blame a 404 for a tag the FALLBACK could not find (#666 round 3)', async () => {
    // `resolveTagCommit` set `via: 'git-ls-remote'` on the tag-missing branch,
    // `verifyPin` dropped it, and `formatFinding`'s tag-missing case never read
    // it — a dead field, and the rendering it would have corrected was wrong:
    // "NOT FOUND upstream (refs/tags/X 404s)" when the API actually 403'd and it
    // was git that returned an empty advertisement. Same confident-claim-from-
    // the-wrong-route defect just fixed for `unreadable-listing`. The verdict is
    // red either way; only the triage story was wrong.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-tagmissing-via-'));
    writeFileSync(
      join(dir, 'supply-chain.yml'),
      [
        'jobs:',
        '  x:',
        '    steps:',
        `      - uses: aquasecurity/trivy-action@${SHA_B} # v0.36.0`,
      ].join('\n'),
    );
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({ [TRIVY_REF]: IP_ALLOW_LIST_403 }).api,
      lsRemote: fakeLsRemote({ kind: 'tag-missing' }).lsRemote,
    });
    expect(findings[0]).toMatchObject({ reason: 'tag-missing', via: 'git-ls-remote' });
    const text = formatFinding(findings[0]);
    expect(text, 'must not claim a 404 the API never returned').not.toMatch(/404/);
    expect(text, 'must name the route that actually answered').toMatch(/ls-remote/);
  });

  it('still says 404 for a tag the API ITSELF reported missing', async () => {
    // Both halves. The correction above must not relabel the ordinary case: when
    // the API returned the 404, "404s" is the accurate story and there was no
    // fallback to name.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-tagmissing-api-'));
    writeFileSync(
      join(dir, 'ci.yml'),
      ['jobs:', '  x:', '    steps:', `      - uses: some/action@${SHA_B} # v1.2.3`].join('\n'),
    );
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({ 'repos/some/action/git/ref/tags/v1.2.3': { status: 404, body: {} } }).api,
      lsRemote: () => {
        throw new Error('the fallback must never be reached on a 404');
      },
    });
    expect(findings[0]).toMatchObject({ reason: 'tag-missing' });
    const text = formatFinding(findings[0]);
    expect(text).toMatch(/404/);
    expect(text, 'no fallback ran, so none may be named').not.toMatch(/ls-remote/);
  });

  it('NEVER reaches for the fallback on any status other than 403/451', async () => {
    // The "both halves" scan. A fallback wired to a broader set of statuses
    // would quietly cover a real mismatch, a rate limit, or an outage on EVERY
    // other repo — the exact hole security.md names.
    expect(Array.from(GIT_FALLBACK_STATUSES as Iterable<number>).sort()).toEqual([403, 451]);
    for (const status of [401, 404, 422, 429, 500, 502, 503]) {
      const { lsRemote, seen } = fakeLsRemote({ kind: 'commit', sha: SHA_A, annotated: false });
      const resolved = await resolveTagCommit({
        owner: 'actions',
        repo: 'checkout',
        tag: 'v5.0.0',
        api: fakeApi({
          'repos/actions/checkout/git/ref/tags/v5.0.0': { status, body: { message: 'nope' } },
        }).api,
        lsRemote,
      });
      expect(seen, `status ${status} must not reach the git fallback`).toEqual([]);
      expect(resolved).toMatchObject(
        status === 404 ? { kind: 'tag-missing' } : { kind: 'api-error', status },
      );
    }
  });

  it('does NOT reach for the fallback when the transport THREW rather than returned 403', async () => {
    const { lsRemote, seen } = fakeLsRemote({ kind: 'commit', sha: SHA_A, annotated: false });
    const resolved = await resolveTagCommit({
      owner: 'actions',
      repo: 'checkout',
      tag: 'v5.0.0',
      api: async () => {
        throw new TypeError('fetch failed');
      },
      lsRemote,
    });
    expect(seen).toEqual([]);
    expect(resolved).toMatchObject({ kind: 'api-error', status: 0 });
  });

  it('falls back on a 403 at the ANNOTATED-TAG hop too, not only the first one', async () => {
    // The second API call is as blockable as the first, and a fallback wired to
    // only one of them would leave the same permanently-red gate for any repo
    // whose ref read succeeds and whose tag-object read does not.
    const { lsRemote, seen } = fakeLsRemote({ kind: 'commit', sha: SHA_A, annotated: true });
    const resolved = await resolveTagCommit({
      owner: 'aquasecurity',
      repo: 'trivy-action',
      tag: 'v0.36.0',
      api: fakeApi({
        [TRIVY_REF]: { status: 200, body: { object: { type: 'tag', sha: SHA_TAGOBJ } } },
        [`repos/aquasecurity/trivy-action/git/tags/${SHA_TAGOBJ}`]: IP_ALLOW_LIST_403,
      }).api,
      lsRemote,
    });
    expect(resolved).toMatchObject({ kind: 'commit', sha: SHA_A, via: 'git-ls-remote' });
    expect(seen).toHaveLength(1);
  });

  it('resolves each 403-blocked action+tag ONCE, however many files pin it', async () => {
    // Four workflows pin trivy-action today. One subprocess per pin would make
    // the nightly pay for the outage four times over; caching the FAILURE too is
    // what keeps an unreachable fallback a failure for every dependent pin.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-403-memo-'));
    for (const file of ['a.yml', 'b.yml', 'c.yml', 'd.yml']) {
      writeFileSync(
        join(dir, file),
        [
          'jobs:',
          '  x:',
          '    steps:',
          `      - uses: aquasecurity/trivy-action@${SHA_A} # v0.36.0`,
        ].join('\n'),
      );
    }
    const { lsRemote, seen } = fakeLsRemote({ kind: 'commit', sha: SHA_A, annotated: true });
    const findings = await verifyWorkflows({
      dir,
      api: fakeApi({ [TRIVY_REF]: IP_ALLOW_LIST_403 }).api,
      lsRemote,
    });
    expect(findings).toEqual([]);
    expect(seen).toHaveLength(1);
  });
});

describe('nightly SHA↔tag resolution — the git ls-remote resolver itself (#640)', () => {
  /** A canned `git` runner: `{ status, stdout, stderr }`, plus the argv it saw. */
  function fakeGit(result: { status: number; stdout?: string; stderr?: string }) {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    return { run, calls };
  }

  it('DEREFERENCES an annotated tag — the `^{}` ref, never the tag object', () => {
    // Real output, captured from `git ls-remote --tags
    // https://github.com/aquasecurity/trivy-action refs/tags/v0.36.0*`:
    // a9c7b0f… is the TAG OBJECT and ed142fd… is the commit the workflows pin.
    // Taking the first line would red all four correct pins.
    const { run } = fakeGit({
      status: 0,
      stdout: [
        'a9c7b0f06e461e9d4b4d1711f154ee024b8d7ab8\trefs/tags/v0.36.0',
        'ed142fd0673e97e23eac54620cfb913e5ce36c25\trefs/tags/v0.36.0^{}',
        '',
      ].join('\n'),
    });
    expect(
      gitLsRemoteTag({ owner: 'aquasecurity', repo: 'trivy-action', tag: 'v0.36.0', run }),
    ).toEqual({
      kind: 'commit',
      sha: 'ed142fd0673e97e23eac54620cfb913e5ce36c25',
      annotated: true,
    });
  });

  it('resolves a LIGHTWEIGHT tag, which has no `^{}` line at all', () => {
    const { run } = fakeGit({ status: 0, stdout: `${SHA_A}\trefs/tags/v1.2.3\n` });
    expect(gitLsRemoteTag({ owner: 'some', repo: 'action', tag: 'v1.2.3', run })).toEqual({
      kind: 'commit',
      sha: SHA_A,
      annotated: false,
    });
  });

  it('does not accept a PREFIX match — v1.2.3 must not be answered by v1.2.30', () => {
    const { run } = fakeGit({ status: 0, stdout: `${SHA_B}\trefs/tags/v1.2.30\n` });
    expect(gitLsRemoteTag({ owner: 'some', repo: 'action', tag: 'v1.2.3', run })).toMatchObject({
      kind: 'tag-missing',
    });
  });

  it('reports a git failure as a transport error — never as a resolved or missing tag', () => {
    const { run } = fakeGit({
      status: 128,
      stderr: 'fatal: could not read from remote repository',
    });
    expect(
      gitLsRemoteTag({ owner: 'some', repo: 'action', tag: 'v1.2.3', run, sleep: () => {} }),
    ).toMatchObject({
      kind: 'transport-error',
    });
  });

  it('reports an EMPTY successful listing as a missing tag', () => {
    const { run } = fakeGit({ status: 0, stdout: '' });
    expect(gitLsRemoteTag({ owner: 'some', repo: 'action', tag: 'v9.9.9', run })).toMatchObject({
      kind: 'tag-missing',
    });
  });

  it('REFUSES to shell out for an owner, repo or tag that is not a plain identifier', () => {
    // This is the one place the checker builds a command line out of repository
    // content. A `uses:` line is attacker-influenced in a fork PR, so the ref is
    // validated BEFORE it can become argv — and refusing is a failure, never a
    // pass.
    for (const unsafe of [
      { owner: '--upload-pack=touch /tmp/pwned', repo: 'action', tag: 'v1.0.0' },
      { owner: 'some', repo: '../../etc', tag: 'v1.0.0' },
      { owner: 'some', repo: 'action', tag: '--upload-pack=sh' },
      { owner: 'some', repo: 'action', tag: 'v1.0.0;rm -rf /' },
      { owner: 'some', repo: 'action', tag: 'v1.0.0 --exec' },
    ]) {
      const { run, calls } = fakeGit({ status: 0, stdout: `${SHA_A}\trefs/tags/v1.0.0\n` });
      const resolved = gitLsRemoteTag({ ...unsafe, run });
      expect(resolved, `${JSON.stringify(unsafe)} must not resolve`).toMatchObject({
        kind: 'transport-error',
      });
      expect(calls, `${JSON.stringify(unsafe)} must never reach git`).toEqual([]);
    }
  });

  it('RETRIES a transport failure once — measured flakiness, not a hypothetical', () => {
    // Measured on this branch: the same `git ls-remote` that answers in ~0.7 s
    // intermittently times out when called repeatedly in quick succession
    // (upstream throttling). A single transient timeout would re-red the whole
    // nightly, which is the failure mode #640 exists to end. Retrying is NOT
    // softening the verdict — a second failure still fails.
    let attempt = 0;
    const run = () => {
      attempt += 1;
      return attempt === 1
        ? { status: -1, stdout: '', stderr: 'spawnSync git ETIMEDOUT' }
        : { status: 0, stdout: `${SHA_A}\trefs/tags/v1.2.3\n`, stderr: '' };
    };
    expect(
      gitLsRemoteTag({ owner: 'some', repo: 'action', tag: 'v1.2.3', run, sleep: () => {} }),
    ).toEqual({ kind: 'commit', sha: SHA_A, annotated: false });
    expect(attempt).toBe(2);
  });

  it('gives up after the retry — a second failure is still a FAILURE', () => {
    let attempt = 0;
    const run = () => {
      attempt += 1;
      return { status: -1, stdout: '', stderr: 'spawnSync git ETIMEDOUT' };
    };
    expect(
      gitLsRemoteTag({ owner: 'some', repo: 'action', tag: 'v1.2.3', run, sleep: () => {} }),
    ).toMatchObject({ kind: 'transport-error' });
    expect(attempt).toBe(2);
  });

  it('does NOT retry a successful listing that simply has no such tag', () => {
    // `tag-missing` is an ANSWER, and retrying an answer would double the cost
    // of the one case that is already conclusive.
    let attempt = 0;
    const run = () => {
      attempt += 1;
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(
      gitLsRemoteTag({ owner: 'some', repo: 'action', tag: 'v9.9.9', run, sleep: () => {} }),
    ).toMatchObject({ kind: 'tag-missing' });
    expect(attempt).toBe(1);
  });

  it('asks git ANONYMOUSLY — no credential helper, no token, no interactive prompt', () => {
    // The whole reason this path works is that it is NOT an authenticated
    // request: the org's IP allow list is evaluated against an authenticated
    // identity. A helper silently attaching the runner's token would put the
    // fallback right back behind the allow list it exists to get around.
    const { run, calls } = fakeGit({ status: 0, stdout: `${SHA_A}\trefs/tags/v1.2.3\n` });
    gitLsRemoteTag({ owner: 'some', repo: 'action', tag: 'v1.2.3', run });
    expect(calls).toHaveLength(1);
    const argv = calls[0];
    expect(argv).toContain('credential.helper=');
    expect(argv).toContain('ls-remote');
    expect(argv.join(' ')).toContain('https://github.com/some/action');
    expect(argv.join(' ')).not.toMatch(/@github\.com|token|Bearer/i);
  });

  it('reports an exit-0 listing it CANNOT READ as unreadable — never as a deleted tag', () => {
    // A truncated or garbled advertisement that still exits 0 is an UNREADABLE
    // ANSWER, not an upstream fact. Calling it `tag-missing` tells the reader
    // "the tag was deleted, renamed, or never existed" about a tag that may be
    // perfectly present — a confident claim derived from noise. The verdict was
    // already red either way (fail-closed); the defect is the misdirection.
    const { run } = fakeGit({ status: 0, stdout: 'ed142fd0673e97e2\x00\x00truncated' });
    const resolved = gitLsRemoteTag({
      owner: 'aquasecurity',
      repo: 'trivy-action',
      tag: 'v0.36.0',
      run,
      sleep: () => {},
    });
    expect(resolved).toMatchObject({ kind: 'unreadable-listing' });
    expect((resolved as { message?: string }).message).toMatch(/unreadable/i);
  });

  it('still calls a genuinely EMPTY listing a missing tag — the two must not collapse', () => {
    // Both halves. An empty advertisement IS the upstream answer "no such ref",
    // so widening the unreadable case to cover it would trade one mislabel for
    // another and lose the only conclusive negative this resolver can give.
    const { run } = fakeGit({ status: 0, stdout: '\n  \n' });
    expect(
      gitLsRemoteTag({ owner: 'some', repo: 'action', tag: 'v9.9.9', run, sleep: () => {} }),
    ).toMatchObject({ kind: 'tag-missing' });
  });

  it('keeps a well-formed listing that lacks the exact ref a MISSING tag', () => {
    // `v1.2.30` parsed fine — the answer was readable and said our ref is not
    // there. That is `tag-missing`, and must not be swept into `unreadable`.
    const { run } = fakeGit({ status: 0, stdout: `${SHA_B}\trefs/tags/v1.2.30\n` });
    expect(gitLsRemoteTag({ owner: 'some', repo: 'action', tag: 'v1.2.3', run })).toMatchObject({
      kind: 'tag-missing',
    });
  });

  it('renders an unreadable fallback listing as the FALLBACK failure, not as a deleted tag', async () => {
    const findings = await verifyPins({
      repoRoot: (() => {
        const root = mkdtempSync(join(tmpdir(), 'knext-pin-unreadable-'));
        mkdirSync(join(root, '.github/workflows'), { recursive: true });
        writeFileSync(
          join(root, '.github/workflows/supply-chain.yml'),
          [
            'jobs:',
            '  x:',
            '    steps:',
            `      - uses: aquasecurity/trivy-action@${SHA_A} # v0.36.0`,
          ].join('\n'),
        );
        return root;
      })(),
      api: fakeApi({
        'repos/aquasecurity/trivy-action/git/ref/tags/v0.36.0': {
          status: 403,
          body: { message: 'IP allow list' },
        },
      }).api,
      lsRemote: () => ({ kind: 'unreadable-listing', message: 'git ls-remote exit 0, unreadable' }),
    });
    expect(findings).toHaveLength(1);
    const message = formatFinding(findings[0]);
    expect(message).toMatch(/unreadable/i);
    expect(message, 'an unreadable answer is not the claim "the tag was deleted"').not.toMatch(
      /deleted, renamed, or never existed/,
    );
  });
});

describe('nightly SHA↔tag resolution — the fallback must be anonymous IN FACT (#666 review)', () => {
  /**
   * The round-1 anonymity guard asserted the half that does NOT decide
   * anonymity: it checked argv for `credential.helper=` against an injected
   * `run` double. Anonymity is decided by the AMBIENT GIT CONFIG the subprocess
   * reads, which no injected double can see — and on a GitHub runner
   * `actions/checkout` writes, into the checkout's LOCAL `.git/config`:
   *
   *   [http "https://github.com/"]
   *       extraheader = AUTHORIZATION: basic <token>
   *
   * `-c credential.helper=` clears HELPERS, not that header, and it applies to
   * EVERY github.com URL. Measured on this branch, git 2.51: running the round-1
   * resolver from such a checkout produced
   * `fatal: could not read Username for 'https://github.com'` — an
   * AUTHENTICATED request, i.e. exactly the identity the org IP allow list had
   * already 403'd. The whole fix was a no-op in the one environment it targets.
   *
   * So this guard executes the REAL `runGit` in a child process whose cwd is a
   * fixture repository carrying that key, and asserts on what git actually saw.
   */
  const FIXTURE_HEADER = 'AUTHORIZATION: basic ZG8tbm90LXVzZTpub3QtYS1yZWFsLXRva2Vu';
  const SCRIPT = resolve(REPO_ROOT, 'scripts/verify-action-pins.mjs');

  /** A checkout carrying the credential `actions/checkout` persists by default. */
  function credentialedCheckout(): string {
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-credentialed-'));
    const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    expect(git('init', '-q').status, 'fixture: git init').toBe(0);
    expect(
      git('config', '--local', 'http.https://github.com/.extraheader', FIXTURE_HEADER).status,
      'fixture: write the persisted credential',
    ).toBe(0);
    // VACUITY CONTROL. If the fixture does not really carry the credential,
    // every assertion below passes for the wrong reason.
    expect(
      git('config', '--list').stdout,
      'the fixture must really carry the credential, or this guard proves nothing',
    ).toContain('extraheader');
    return dir;
  }

  /** Call `runGit(args)` from the real script, in a child process rooted at `cwd`. */
  function runGitFrom(
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv = {},
  ): { status: number; stdout: string; stderr: string } {
    const source = `
      const m = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});
      console.log(JSON.stringify(m.runGit(${JSON.stringify(args)})));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, ...env },
    });
    expect(child.status, `child failed: ${child.stderr}`).toBe(0);
    return JSON.parse(child.stdout);
  }

  it('sees NO `http.extraheader` from the checkout it is running inside', () => {
    const dir = credentialedCheckout();
    const seen = runGitFrom(dir, ['config', '--list', '--show-origin']);
    expect(
      seen.stdout,
      'the persisted checkout credential must not be in scope for the anonymous fallback',
    ).not.toMatch(/extraheader/i);
    expect(seen.stdout, 'nor its value').not.toContain(FIXTURE_HEADER);
  });

  it('does not resolve the surrounding repository at all', () => {
    // The mechanism, asserted directly rather than through one of its symptoms:
    // git must not DISCOVER the checkout, because discovering it is what puts
    // its local config — credential and all — into scope.
    const dir = credentialedCheckout();
    const seen = runGitFrom(dir, ['rev-parse', '--show-toplevel']);
    const real = realpathSync(dir);
    expect(seen.status, 'git must find no repository here').not.toBe(0);
    expect(seen.stdout.trim()).not.toBe(real);
  });

  it('sees NO credential from the GLOBAL config scope either', () => {
    // A repo-less cwd closes the LOCAL scope, which is where
    // `actions/checkout` writes. It closes nothing above it: a global
    // `http.extraheader` — a self-hosted runner image, a corporate `~/.gitconfig`
    // — de-anonymises the request identically, and the symptom is the same
    // invisible 403. Asserted here because "we also set GIT_CONFIG_GLOBAL" is a
    // claim, and an unasserted claim is what finding 2 was.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-globalconfig-'));
    const config = join(dir, 'gitconfig');
    writeFileSync(config, `[http "https://github.com/"]\n\textraheader = ${FIXTURE_HEADER}\n`);
    const seen = runGitFrom(dir, ['config', '--list'], { GIT_CONFIG_GLOBAL: config });
    expect(seen.stdout, 'a global credential must not reach the anonymous fallback').not.toMatch(
      /extraheader/i,
    );
    // VACUITY CONTROL: that env var must really be in force for a plain git.
    const plain = spawnSync('git', ['config', '--list'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: config },
    });
    expect(plain.stdout, 'control: an ordinary git DOES read this global config').toMatch(
      /extraheader/i,
    );
  });

  it('sees NO credential from the ENV config scope (GIT_CONFIG_COUNT / _PARAMETERS)', () => {
    // The THIRD scope, and git's HIGHEST-PRECEDENCE one — it outranks local,
    // global and system alike. `GIT_CONFIG_NOSYSTEM` + `GIT_CONFIG_SYSTEM` +
    // `GIT_CONFIG_GLOBAL` + a repo-less cwd close the other three and touch this
    // one not at all. MEASURED on git 2.51 against the round-2 resolver: BOTH
    // forms below put an `http.…extraheader` into the supposedly anonymous
    // request. Nothing on a GitHub runner sets these today, which is exactly the
    // status the LOCAL scope had before #666 proved otherwise in the one
    // environment this fallback targets.
    const dir = mkdtempSync(join(tmpdir(), 'knext-pin-envconfig-'));
    const KEY = 'http.https://github.com/.extraheader';

    // Form 1: the counted key/value form.
    const counted = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: KEY,
      GIT_CONFIG_VALUE_0: FIXTURE_HEADER,
    };
    expect(
      runGitFrom(dir, ['config', '--list'], counted).stdout,
      'a GIT_CONFIG_COUNT credential must not reach the anonymous fallback',
    ).not.toMatch(/extraheader/i);

    // Form 2: the serialised `-c` form git uses to pass config to subprocesses.
    const params = { GIT_CONFIG_PARAMETERS: `'${KEY}'='${FIXTURE_HEADER}'` };
    expect(
      runGitFrom(dir, ['config', '--list'], params).stdout,
      'a GIT_CONFIG_PARAMETERS credential must not reach the anonymous fallback',
    ).not.toMatch(/extraheader/i);

    // VACUITY CONTROL, one per form: a plain git in identical conditions MUST
    // see each credential, or neither assertion above proves anything.
    for (const [label, env] of [
      ['GIT_CONFIG_COUNT', counted],
      ['GIT_CONFIG_PARAMETERS', params],
    ] as const) {
      const plain = spawnSync('git', ['config', '--list'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
      expect(plain.stdout, `control: an ordinary git DOES read ${label}`).toMatch(/extraheader/i);
    }
  });

  it('is not saved by the DEV machine happening to have no such config', () => {
    // Both halves, again: the guard above would pass on a laptop even with the
    // isolation removed IF the ambient config were clean. It is the fixture that
    // makes it bite, so assert the fixture is what is being read — a plain git
    // invocation from the same cwd MUST see the credential the resolver does not.
    const dir = credentialedCheckout();
    const plain = spawnSync('git', ['config', '--list'], { cwd: dir, encoding: 'utf8' });
    expect(plain.stdout, 'control: an ordinary git in this cwd DOES see it').toMatch(
      /extraheader/i,
    );
  });

  it('does not run with a HOME whose `~/.netrc` could answer a challenge (#666 round 3)', () => {
    // `~/.netrc` is NOT git config, so every guard above leaves it untouched:
    // git sets `CURLOPT_NETRC` to OPTIONAL, and libcurl then answers a 401
    // challenge from the netrc entry for that host. MEASURED against the round-2
    // resolver on git 2.51 (real github.com, a repo that does not exist, which
    // GitHub answers with a 401 rather than confirm non-existence): one
    // `Authorization: Basic` header went out. The 403 fallback path can reach a
    // challenged request — a private or deleted `uses:` repo does exactly that —
    // so this is reachable, not theoretical.
    //
    // The only lever over netrc is HOME — libcurl resolves the file from it, and
    // git exposes no config for it. So the property asserted here is that the
    // resolver's git subprocess does NOT run with the ambient HOME.
    //
    // Asserted OFFLINE, and on the REAL subprocess rather than a constructed env
    // object: `GIT_SSH_COMMAND` survives the `...process.env` spread, so pointing
    // an `ssh://` remote at a command that echoes `$HOME` makes git itself report
    // the HOME it actually ran with. No network, no loopback (`git-remote-http`
    // cannot reach 127.0.0.1 under this repo's sandbox), and no dependency on
    // whether the DEV machine happens to have a `~/.netrc`.
    const ambientHome = mkdtempSync(join(tmpdir(), 'knext-pin-netrc-home-'));
    writeFileSync(join(ambientHome, '.netrc'), 'machine github.com login do-not-use password x\n', {
      mode: 0o600,
    });
    const probe = { GIT_SSH_COMMAND: "sh -c 'echo OBSERVED_HOME=$HOME >&2; exit 1'" };
    const argv = ['ls-remote', 'ssh://github.com/getknext-dev/knext'];

    const seen = runGitFrom(ambientHome, argv, { ...probe, HOME: ambientHome });
    expect(
      seen.stderr,
      'the anonymous fallback must not run with a HOME that has a ~/.netrc in it',
    ).not.toContain(`OBSERVED_HOME=${ambientHome}`);
    expect(seen.stderr, 'git must still have reported the HOME it ran with').toMatch(
      /OBSERVED_HOME=/,
    );

    // VACUITY CONTROL: an ordinary git, same cwd, same env, MUST report the
    // ambient HOME — otherwise the assertion above passes for the wrong reason
    // (e.g. GIT_SSH_COMMAND never fired and the stderr was empty either way).
    const plain = spawnSync('git', argv, {
      cwd: ambientHome,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...probe, HOME: ambientHome },
    });
    expect(plain.stderr, 'control: an ordinary git DOES run with the ambient HOME').toContain(
      `OBSERVED_HOME=${ambientHome}`,
    );
  });
});
