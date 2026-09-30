import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Workflow-shape tests for the operator semver release line (#1667):
 * `.github/workflows/operator-supply-chain.yml` is the SAME publisher used
 * for `operator-vX.Y.Z` tags, `main` pushes and PRs — there is no second
 * publish workflow. These tests lock in the shape that makes that true:
 *
 *   - the workflow triggers on `operator-v*` tags (in addition to `main`)
 *   - a channel-determination step runs `hack/release-channel.sh` (the
 *     unit-tested tag-parsing logic, see tests/operator-release-channel.test.ts)
 *     and every publish-gated step downstream reads its outputs, rather than
 *     re-deriving `github.ref == 'refs/heads/main'` inline
 *   - there are TWO release-attach steps: one always-on-publish step keyed to
 *     the channel tag (immutable per version tag; rolling for operator-edge),
 *     and one gated to `is_stable == 'true'` that moves `operator-latest`
 *   - the release-attach steps never hardcode `tag_name: operator-latest`
 *     except in the stable-only step
 *
 * Same text-scan approach as tests/operator-supply-chain-workflow.test.ts —
 * no runtime YAML dependency.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/operator-supply-chain.yml');
const SCRIPT_PATH = resolve(REPO_ROOT, 'packages/kn-next-operator/hack/release-channel.sh');

function workflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

function stepBlocks(): string[] {
  const lines = workflowText().split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (/^\s*-\s+(name|uses):/.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

function stripComments(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('#') && !/^\s*-?\s*name:/.test(l))
    .join('\n');
}

const CHANNEL_RE = /id:\s*channel/;
const RELEASE_RE = /uses:\s*softprops\/action-gh-release/g;
const IMMUTABILITY_GUARD_RE = /check-release-immutable\.sh/;
const IMMUTABILITY_SCRIPT_PATH = resolve(
  REPO_ROOT,
  'packages/kn-next-operator/hack/check-release-immutable.sh',
);

describe('operator-supply-chain.yml: tag-triggered semver release line (#1667)', () => {
  it('the workflow triggers on push to operator-v* tags, reusing this same publisher', () => {
    const text = workflowText();
    const onBlock = text.split(/\npermissions:/)[0] ?? text;
    expect(onBlock, 'expected an `on:` block').toMatch(/^on:/m);
    expect(
      /tags:\s*\n\s*-\s*'operator-v\*'/.test(onBlock) ||
        /tags:\s*\[.*operator-v\*.*\]/.test(onBlock),
      'push trigger must include the operator-v* tag pattern',
    ).toBe(true);
    // Still triggers on main (the edge channel depends on it).
    expect(/branches:\s*\[main\]/.test(onBlock)).toBe(true);
  });

  it('runs hack/release-channel.sh as an id: channel step, before any publish-gated step', () => {
    const blocks = stepBlocks();
    const channelIdx = blocks.findIndex((b) => CHANNEL_RE.test(stripComments(b)));
    expect(channelIdx, 'expected a step with id: channel').toBeGreaterThanOrEqual(0);
    const channelBlock = blocks[channelIdx] ?? '';
    expect(
      /hack\/release-channel\.sh/.test(channelBlock),
      'the channel step must invoke hack/release-channel.sh',
    ).toBe(true);
    expect(
      />>\s*"?\$GITHUB_OUTPUT"?/.test(channelBlock),
      'the channel step must write its outputs to $GITHUB_OUTPUT',
    ).toBe(true);

    // Every downstream step gated on publish/is_stable must come AFTER this step.
    // stripComments avoids matching the header prose describing this very rule.
    const gatedIdx = blocks.findIndex(
      (b, i) =>
        i !== channelIdx && /steps\.channel\.outputs\.(publish|is_stable)/.test(stripComments(b)),
    );
    expect(
      gatedIdx,
      'expected at least one step gated on steps.channel.outputs.*',
    ).toBeGreaterThanOrEqual(0);
    expect(
      channelIdx,
      'the channel step must precede any step that reads its outputs',
    ).toBeLessThan(gatedIdx);
  });

  it('no step re-derives the publish decision from a literal github.ref main check', () => {
    // The whole point of centralizing in hack/release-channel.sh: nothing
    // downstream should hardcode `github.ref == 'refs/heads/main'` again.
    expect(
      /if:\s*github\.ref\s*==\s*'refs\/heads\/main'/.test(workflowText()),
      'no step may re-derive publish from a literal github.ref main check — use steps.channel.outputs.publish',
    ).toBe(false);
  });

  it('has exactly two release-attach steps: channel release + stable-only operator-latest move', () => {
    const releaseSteps = stepBlocks().filter((b) => {
      RELEASE_RE.lastIndex = 0;
      return RELEASE_RE.test(stripComments(b));
    });
    expect(releaseSteps.length, 'expected exactly two softprops/action-gh-release steps').toBe(2);

    const channelRelease = releaseSteps.find((b) => /steps\.channel\.outputs\.release_tag/.test(b));
    expect(
      channelRelease,
      'expected a release step keyed to steps.channel.outputs.release_tag',
    ).not.toBe(undefined);
    expect(
      /if:\s*steps\.channel\.outputs\.publish\s*==\s*'true'/.test(channelRelease ?? ''),
      'the channel release step must be gated on publish',
    ).toBe(true);
    expect(
      /make_latest:\s*["']?false["']?/.test(channelRelease ?? ''),
      "the channel release step must not claim make_latest (that is the stable-only step's job)",
    ).toBe(true);

    const latestMove = releaseSteps.find((b) => /tag_name:\s*operator-latest/.test(b));
    expect(latestMove, 'expected a release step with tag_name: operator-latest').not.toBe(
      undefined,
    );
    expect(
      /if:\s*steps\.channel\.outputs\.is_stable\s*==\s*'true'/.test(latestMove ?? ''),
      'operator-latest must be moved ONLY on a stable channel (is_stable == true)',
    ).toBe(true);
    expect(/make_latest:\s*["']?true["']?/.test(latestMove ?? '')).toBe(true);
  });

  it('the release-channel script exists and is executable shell', () => {
    const text = readFileSync(SCRIPT_PATH, 'utf8');
    expect(text.startsWith('#!/usr/bin/env bash')).toBe(true);
    // Sanity: the script must actually branch on the three channels this
    // workflow depends on.
    expect(text).toMatch(/refs\/tags\/operator-v\*/);
    expect(text).toMatch(/refs\/heads\/main/);
    expect(text).toMatch(/operator-edge/);
  });

  it('guards operator-vX.Y.Z release immutability BEFORE the channel release is published (#1667)', () => {
    const blocks = stepBlocks();
    const channelIdx = blocks.findIndex((b) => CHANNEL_RE.test(stripComments(b)));
    const guardIdx = blocks.findIndex((b) => IMMUTABILITY_GUARD_RE.test(stripComments(b)));
    const releaseIdx = blocks.findIndex((b) => {
      RELEASE_RE.lastIndex = 0;
      return RELEASE_RE.test(stripComments(b)) && /steps\.channel\.outputs\.release_tag/.test(b);
    });

    expect(channelIdx, 'expected the channel step').toBeGreaterThanOrEqual(0);
    expect(
      guardIdx,
      'expected an immutability-guard step invoking check-release-immutable.sh',
    ).toBeGreaterThanOrEqual(0);
    expect(releaseIdx, 'expected the channel release-attach step').toBeGreaterThanOrEqual(0);

    expect(channelIdx, 'the guard must run after the channel is known').toBeLessThan(guardIdx);
    expect(guardIdx, 'the guard must run BEFORE the release is published').toBeLessThan(releaseIdx);

    const guard = blocks[guardIdx] ?? '';
    // Only a real version tag is immutability-guarded — operator-edge and
    // operator-latest are mutable by design.
    expect(
      /if:\s*steps\.channel\.outputs\.is_version_tag\s*==\s*'true'/.test(guard),
      'the guard must be scoped to steps.channel.outputs.is_version_tag == true',
    ).toBe(true);
    expect(
      /steps\.channel\.outputs\.release_tag/.test(guard),
      'the guard must check the actual channel release tag, not a hardcoded one',
    ).toBe(true);
  });

  it('the immutability-guard script exists, fails loud on an existing asset, and never silently passes on API error', () => {
    const text = readFileSync(IMMUTABILITY_SCRIPT_PATH, 'utf8');
    expect(text.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(text).toMatch(/gh release view/);
    expect(text).toMatch(/install\.yaml/);
    // Three distinct outcomes must all be present: safe-to-publish (0),
    // already-published (1, fail loud), and unreachable API (non-zero, never
    // treated as a pass).
    expect(text).toMatch(/exit 0/);
    expect(text).toMatch(/exit 1/);
    expect(text).toMatch(/exit 2/);
  });
});

// ── #1667 review round 2: paths-filter restored for main, never for tags ────

const PATH_RELEVANT_SCRIPT_PATH = resolve(
  REPO_ROOT,
  'packages/kn-next-operator/hack/path-relevant.sh',
);

function jobBodies(): Map<string, string> {
  const text = workflowText();
  const jobsSection = text.split(/\njobs:\n/)[1] ?? '';
  const lines = jobsSection.split('\n');
  const jobs = new Map<string, string>();
  let currentId: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (currentId) jobs.set(currentId, currentLines.join('\n'));
    currentLines = [];
  };
  for (const line of lines) {
    // Top-level job keys are indented exactly two spaces, e.g. "  changes:".
    const jobHeader = /^  ([\w-]+):\s*$/.exec(line);
    if (jobHeader) {
      flush();
      currentId = jobHeader[1] ?? null;
    }
    currentLines.push(line);
  }
  flush();
  return jobs;
}

describe('operator-supply-chain.yml: push.paths restored for main only, never for tags (#1667 round 2)', () => {
  it('the push trigger itself carries no paths filter (it would apply to tag pushes too)', () => {
    const onBlock = workflowText().split(/\npermissions:/)[0] ?? '';
    const pushBlock = onBlock.split(/\n {2}push:\n/)[1]?.split(/\n {2}\w/)[0] ?? '';
    expect(pushBlock, 'expected a push: trigger block').not.toBe('');
    expect(
      /paths:/.test(pushBlock),
      'push: must not carry its own paths filter — the changes job restores it for main only',
    ).toBe(false);
  });

  it('a standalone `changes` job (push-event-only) computes relevance via path-relevant.sh', () => {
    const jobs = jobBodies();
    const changes = jobs.get('changes');
    expect(changes, 'expected a top-level `changes` job').not.toBe(undefined);
    expect(
      /if:\s*github\.event_name\s*==\s*'push'/.test(changes ?? ''),
      'the changes job must only run for push events',
    ).toBe(true);
    expect(
      /relevant:\s*\$\{\{\s*steps\.check\.outputs\.relevant\s*\}\}/.test(changes ?? ''),
      'the changes job must expose a `relevant` output',
    ).toBe(true);
    expect(
      /hack\/path-relevant\.sh/.test(changes ?? ''),
      'the changes job must invoke hack/path-relevant.sh',
    ).toBe(true);
    // Tag pushes must be treated as relevant WITHOUT calling the script — a
    // tag push may legitimately repoint at a commit whose own diff doesn't
    // touch these paths.
    expect(
      /refs\/tags\/operator-v\*/.test(changes ?? '') && /relevant=true/.test(changes ?? ''),
      'the changes job must short-circuit operator-v* tag pushes to relevant=true',
    ).toBe(true);
  });

  it('the main publish job depends on `changes` and is gated by its output (non-push events always run)', () => {
    const jobs = jobBodies();
    const main = jobs.get('operator-image-supply-chain');
    expect(main, 'expected the operator-image-supply-chain job').not.toBe(undefined);
    expect(
      /needs:\s*\[changes\]/.test(main ?? ''),
      'the main job must declare needs: [changes]',
    ).toBe(true);
    expect(
      /if:\s*github\.event_name\s*!=\s*'push'\s*\|\|\s*needs\.changes\.outputs\.relevant\s*==\s*'true'/.test(
        main ?? '',
      ),
      'the main job must be gated on non-push OR needs.changes.outputs.relevant == true',
    ).toBe(true);
  });

  it('the path-relevant script exists, diffs by path, and never silently skips a first push', () => {
    const text = readFileSync(PATH_RELEVANT_SCRIPT_PATH, 'utf8');
    expect(text.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(text).toMatch(/git .*diff --name-only/);
    expect(text).toMatch(/packages\/kn-next-operator\//);
    expect(text).toMatch(/operator-supply-chain\.yml/);
    // all-zeros before-SHA (a branch's first push) must resolve to relevant,
    // never to a silent false.
    expect(text).toMatch(/\^0\+\$/);
  });
});
