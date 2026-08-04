import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverPinnableFiles,
  formatFinding,
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
