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
});
