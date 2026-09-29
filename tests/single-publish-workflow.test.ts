import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * #1614/#1616 — "pack once, publish that". Before this, THREE places packed
 * the `@getknext/*` fixed group from independent builds of the same commit:
 * `audit` (`bun pm pack` — measurably NOT the tool `changeset publish`
 * shells to for a bun workspace, #1614), `ga-tarball-diff` (its own worktree
 * build + `npm pack` of HEAD), and `release` itself
 * (`verify-published-group.mjs --pre`, also its own `npm pack`). The bytes
 * were MEASURED byte-identical (#1616), but "measured identical today" is
 * not "provably the same artifact".
 *
 * This test is a WORKFLOW-STRUCTURE proof, not a live run: it parses
 * `release.yml` with the same `yaml` library `workflow-script-install-
 * guard.mjs` uses and asserts the job graph + artifact wiring, so a future
 * edit that quietly reintroduces a redundant pack, or renames one side of
 * the artifact handoff, reds here rather than being discovered live.
 *
 * SCOPE, stated rather than assumed: `audit` does NOT consume the `pack`
 * job's artifact. It keeps its OWN `bun pm pack` step — deliberately, for a
 * DIFFERENT reason than tool parity: `siblingRangeProblems`
 * (`audit-published.mjs`) uses bun's divergent rewrite source (`bun.lock`,
 * not the manifest) to catch a stale lock (#942 F1), which the shared
 * `npm pack` artifact cannot reproduce. `audit` instead packs a SECOND time
 * with `npm pack` from its own (already-built) tree for the actual CVE
 * audit/SBOM target — a small, local, non-blocking duplication kept OUT of
 * this job's blast radius on purpose. So "every consumer" below means every
 * consumer of the SHARED artifact (`ga-tarball-diff`, `release`), not every
 * job that packs at all.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const RELEASE_YML = resolve(REPO_ROOT, '.github/workflows/release.yml');

function loadReleaseWorkflow(): any {
  return parse(readFileSync(RELEASE_YML, 'utf8'));
}

function jobNeeds(job: any): string[] {
  const needs = job?.needs;
  if (needs === undefined) return [];
  return Array.isArray(needs) ? needs : [needs];
}

function stepsOf(job: any): any[] {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function findStepByUses(steps: any[], usesPrefix: string): any[] {
  return steps.filter((s) => typeof s?.uses === 'string' && s.uses.startsWith(usesPrefix));
}

function findStepsByRun(steps: any[], pattern: RegExp): any[] {
  return steps.filter((s) => typeof s?.run === 'string' && pattern.test(s.run));
}

describe('release.yml — the `pack` job packs the fixed group ONCE (#1614/#1616)', () => {
  const workflow = loadReleaseWorkflow();
  const jobs = workflow.jobs ?? {};

  it('a `pack` job exists', () => {
    expect(jobs.pack).toBeDefined();
  });

  it('`pack` builds the publishable packages before packing', () => {
    const steps = stepsOf(jobs.pack);
    expect(findStepsByRun(steps, /bun run --filter @getknext\/lib build/).length).toBe(1);
  });

  it('`pack` packs with `scripts/pack-release-tarballs.mjs` (npm pack, not bun pm pack)', () => {
    const steps = stepsOf(jobs.pack);
    const packSteps = findStepsByRun(steps, /pack-release-tarballs\.mjs/);
    expect(packSteps).toHaveLength(1);
    for (const step of steps) {
      expect(String(step.run ?? '')).not.toMatch(/bun pm pack/);
    }
  });

  it('`pack` uploads exactly one artifact, named "release-tarballs"', () => {
    const steps = stepsOf(jobs.pack);
    const uploads = findStepByUses(steps, 'actions/upload-artifact@');
    expect(uploads).toHaveLength(1);
    expect(uploads[0].with?.name).toBe('release-tarballs');
    // Fail-closed, never skip: a missing artifact must fail the upload step.
    expect(uploads[0].with?.['if-no-files-found']).toBe('error');
  });
});

describe('release.yml — `ga-tarball-diff` consumes the pack-once artifact instead of re-packing HEAD (#1616)', () => {
  const workflow = loadReleaseWorkflow();
  const jobs = workflow.jobs ?? {};
  const job = jobs['ga-tarball-diff'];

  it('needs `pack`', () => {
    expect(jobNeeds(job)).toContain('pack');
  });

  it('downloads the "release-tarballs" artifact', () => {
    const downloads = findStepByUses(stepsOf(job), 'actions/download-artifact@');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].with?.name).toBe('release-tarballs');
  });

  it('does NOT run its own "Build publishable packages" step — no second HEAD build', () => {
    const steps = stepsOf(job);
    expect(findStepsByRun(steps, /bun run --filter @getknext\/lib build/)).toHaveLength(0);
  });

  it('points the gate at the downloaded artifact via PACK_ONCE_GA_DIR', () => {
    const gateStep = stepsOf(job).find(
      (s) => typeof s?.run === 'string' && /ga-tarball-diff-gate\.mjs/.test(s.run),
    );
    expect(gateStep).toBeDefined();
    const env = gateStep.env ?? {};
    expect(typeof env.PACK_ONCE_GA_DIR).toBe('string');
    expect(env.PACK_ONCE_GA_DIR).toContain('release-tarballs-head');
  });

  it("the download step's destination path matches PACK_ONCE_GA_DIR's directory name", () => {
    const downloads = findStepByUses(stepsOf(job), 'actions/download-artifact@');
    const gateStep = stepsOf(job).find(
      (s) => typeof s?.run === 'string' && /ga-tarball-diff-gate\.mjs/.test(s.run),
    );
    const downloadPath = String(downloads[0].with?.path ?? '');
    expect(downloadPath.length).toBeGreaterThan(0);
    expect(String(gateStep.env?.PACK_ONCE_GA_DIR ?? '')).toContain(downloadPath);
  });
});

describe('release.yml — `release` verifies against the pack-once artifact before publishing (#1616)', () => {
  const workflow = loadReleaseWorkflow();
  const jobs = workflow.jobs ?? {};
  const job = jobs.release;

  it('needs `pack`', () => {
    expect(jobNeeds(job)).toContain('pack');
  });

  it('downloads the "release-tarballs" artifact', () => {
    const downloads = findStepByUses(stepsOf(job), 'actions/download-artifact@');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].with?.name).toBe('release-tarballs');
  });

  it('passes --compare-dir to verify-published-group.mjs --pre, pointing at the downloaded artifact', () => {
    const downloads = findStepByUses(stepsOf(job), 'actions/download-artifact@');
    const downloadPath = String(downloads[0].with?.path ?? '');
    const verifyStep = stepsOf(job).find(
      (s) => typeof s?.run === 'string' && /verify-published-group\.mjs --pre/.test(s.run),
    );
    expect(verifyStep).toBeDefined();
    expect(String(verifyStep.run)).toContain('--compare-dir');
    expect(downloadPath.length).toBeGreaterThan(0);
    expect(String(verifyStep.run)).toContain(downloadPath);
  });

  it('still builds its own tree (required: changeset publish ships from the directory, not a tarball file)', () => {
    const steps = stepsOf(job);
    expect(findStepsByRun(steps, /bun run --filter @getknext\/lib build/).length).toBe(1);
  });
});

describe('release.yml — the artifact name is the SAME string everywhere (upload + both downloads)', () => {
  const workflow = loadReleaseWorkflow();
  const jobs = workflow.jobs ?? {};

  it('every upload-artifact/download-artifact step touching the pack-once artifact uses "release-tarballs"', () => {
    const names = new Set<string>();
    for (const jobId of ['pack', 'ga-tarball-diff', 'release']) {
      const job = jobs[jobId];
      const steps = stepsOf(job);
      for (const step of [
        ...findStepByUses(steps, 'actions/upload-artifact@'),
        ...findStepByUses(steps, 'actions/download-artifact@'),
      ]) {
        const name = step.with?.name;
        if (typeof name === 'string') names.add(name);
      }
    }
    expect(names).toEqual(new Set(['release-tarballs']));
  });
});

describe('release.yml — `audit` is DELIBERATELY out of scope for the shared artifact (documented, not an oversight)', () => {
  const workflow = loadReleaseWorkflow();
  const jobs = workflow.jobs ?? {};
  const job = jobs.audit;

  it('does not need `pack` and does not download its artifact', () => {
    expect(jobNeeds(job)).not.toContain('pack');
    expect(findStepByUses(stepsOf(job), 'actions/download-artifact@')).toHaveLength(0);
  });

  it('still audits npm-pack bytes (not bun-pack bytes) for the CVE/SBOM target (#1614)', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'scripts/audit-published.mjs'), 'utf8');
    expect(source).toContain('packPublishableGroup');
    expect(source).toContain('npmTarballs');
  });
});
