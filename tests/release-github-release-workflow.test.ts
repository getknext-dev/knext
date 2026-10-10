import { describe, expect, it } from 'bun:test';
import { jobJson, jobNeeds, jobs, workflowText } from './helpers/release-workflow';

/**
 * WORKFLOW GUARD for the one-readable-release-per-version flow (#2153).
 *
 * `release.yml` used to let `changesets/action` create four near-identical GitHub
 * releases per version. Now it must (a) create NONE of those, and (b) publish a
 * single `vX.Y.Z` release from a job that can write contents and nothing else.
 *
 * This is the publish path, so the halves that matter are asserted from the PARSED
 * workflow (comments cannot satisfy or trip them):
 *   - every `changesets/action` step has `create-github-releases: false`;
 *   - the release job still fails BEFORE publishing if the notes are missing;
 *   - the `github-release` job runs only after a successful `release`, holds
 *     `contents: write` and nothing else, and never sees the npm credential.
 *
 * Mutation-proved by `scripts/mutation-prove-readable-releases.mjs`.
 */

const RELEASE_JOB = 'release';
const NOTES_JOB = 'github-release';
const NOTES_SCRIPT = 'scripts/release-notes-body.mjs';

type Step = Record<string, unknown>;

function stepsOf(jobId: string): Step[] {
  const steps = jobs()[jobId]?.steps;
  return Array.isArray(steps) ? (steps as Step[]) : [];
}

describe('per-package GitHub releases are off', () => {
  const actionSteps = Object.entries(jobs()).flatMap(([jobId, job]) =>
    (Array.isArray(job.steps) ? (job.steps as Step[]) : [])
      .filter((s) => String(s.uses ?? '').startsWith('changesets/action@'))
      .map((s) => ({ jobId, step: s })),
  );

  it('non-vacuity: release.yml runs changesets/action in the version and publish jobs', () => {
    expect(actionSteps.map((a) => a.jobId).sort()).toEqual(['release', 'version-pr']);
  });

  it('every changesets/action step sets create-github-releases: false', () => {
    for (const { jobId, step } of actionSteps) {
      const withBlock = (step.with ?? {}) as Record<string, unknown>;
      expect(
        withBlock['create-github-releases'],
        `${jobId}: changesets/action must not create per-package releases`,
      ).toBe(false);
    }
  });
});

describe('the release job refuses to publish a version with no notes', () => {
  it('runs `release-notes-body.mjs --check` before the Publish step', () => {
    const steps = stepsOf(RELEASE_JOB);
    const check = steps.findIndex(
      (s) => String(s.run ?? '').includes(NOTES_SCRIPT) && String(s.run ?? '').includes('--check'),
    );
    const publish = steps.findIndex((s) => s.name === 'Publish');
    expect(check, 'no --check step in the release job').toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(-1);
    expect(check).toBeLessThan(publish);
  });

  it('the --check step carries no secrets (the credential is per-step env)', () => {
    const check = stepsOf(RELEASE_JOB).find((s) => String(s.run ?? '').includes('--check'));
    expect(JSON.stringify(check)).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/);
  });

  it('keeps every existing needs edge of the credentialed job', () => {
    expect(jobNeeds(RELEASE_JOB).sort()).toEqual(
      [
        'audit',
        'ga-tarball-diff',
        'pack',
        'publish-lane-guard',
        'publish-preflight',
        'version-pr',
      ].sort(),
    );
  });
});

describe('the github-release job', () => {
  const job = jobs()[NOTES_JOB] ?? {};
  const json = jobJson(NOTES_JOB);

  it('exists', () => {
    expect(jobs()[NOTES_JOB]).toBeDefined();
  });

  it('runs only after a successful release, behind the publish-lane guard', () => {
    expect(jobNeeds(NOTES_JOB)).toContain(RELEASE_JOB);
    expect(jobNeeds(NOTES_JOB)).toContain('publish-lane-guard');
    // No always()/failure()/cancelled(): those start a job after a FAILED need.
    expect(String(job.if ?? '')).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
  });

  it('is only ever run on the canonical repo', () => {
    expect(String(job.if ?? '')).toContain("github.repository == 'getknext-dev/knext'");
  });

  it('holds contents: write and NOTHING else', () => {
    expect(job.permissions).toEqual({ contents: 'write' });
  });

  it('has no environment and never sees the npm credential', () => {
    expect(job.environment).toBeUndefined();
    expect(json).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm-publish|id-token/);
    // The only secret it may read is the built-in token.
    const secrets = [...json.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    for (const s of secrets) expect(s).toBe('GITHUB_TOKEN');
  });

  it('uses no third-party action: gh CLI only (checkout and setup-node are first-party)', () => {
    const uses = stepsOf(NOTES_JOB)
      .map((s) => String(s.uses ?? ''))
      .filter(Boolean);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^actions\/(checkout|setup-node)@[0-9a-f]{40}$/);
    expect(json).not.toContain('changesets/action');
  });

  it('generates the body with the tested script and publishes it with gh', () => {
    const runs = stepsOf(NOTES_JOB)
      .map((s) => String(s.run ?? ''))
      .join('\n');
    expect(runs).toContain(NOTES_SCRIPT);
    expect(runs).toContain('--tags-file');
    expect(runs).toContain('gh release create');
    expect(runs).toContain('gh release edit');
    expect(runs).toContain('--notes-file');
    // The flags come from the script's outputs, not re-derived in bash.
    for (const k of ['tag', 'title', 'prerelease', 'latest'])
      expect(json).toContain(`steps.notes.outputs.${k}`);
  });

  it('checks out every tag, so the highest-stable decision sees them', () => {
    const checkout = stepsOf(NOTES_JOB).find((s) =>
      String(s.uses ?? '').startsWith('actions/checkout@'),
    );
    const withBlock = (checkout?.with ?? {}) as Record<string, unknown>;
    expect(withBlock['fetch-tags']).toBe(true);
  });

  it('is not a second publisher: no npm publish / changeset publish in it', () => {
    expect(json).not.toMatch(/npm publish|changeset publish|bun run release|bun publish/);
  });
});

describe('the credential stays in exactly one job', () => {
  it('only the release job references the npm token', () => {
    for (const [id] of Object.entries(jobs())) {
      const holds = /NPM_TOKEN|NODE_AUTH_TOKEN/.test(jobJson(id));
      expect(holds, `${id} holds the npm credential`).toBe(id === RELEASE_JOB);
    }
  });

  it('the workflow text names the new flow so the next reader finds it', () => {
    expect(workflowText()).toContain('#2153');
  });
});
