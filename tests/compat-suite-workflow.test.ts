import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * GUARD TEST for .github/workflows/test-e2e-deploy.yml (#89 / ADR-0007 A3-2).
 *
 * The official Next.js deploy-harness nightly used to FAIL at the `build-next`
 * job with "Error: No pnpm version is specified": `pnpm/action-setup@v4` had no
 * `version:` input, and because knext is checked out into a sub-path (`path:
 * knext`), the action could NOT resolve a repo-root `packageManager` field at
 * the workspace root. With pnpm unresolved the `build-next` job died and the
 * actual `deploy-tests` shards were SKIPPED — so the official compatibility
 * suite never ran a single test.
 *
 * This test mechanically prevents that regression: EVERY `pnpm/action-setup`
 * step in the compat-suite workflow must pin an explicit `version`, and that
 * version must match the repo's pinned pnpm (`packageManager` in package.json)
 * so the two never drift.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const ROOT_PKG_PATH = resolve(REPO_ROOT, 'package.json');

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function loadWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
}

/** The pnpm version the repo pins via `packageManager` (e.g. "pnpm@10.4.1"). */
function pinnedPnpmVersion(): string {
  const pkg = JSON.parse(readFileSync(ROOT_PKG_PATH, 'utf8')) as {
    packageManager?: string;
  };
  const pm = pkg.packageManager ?? '';
  const match = pm.match(/^pnpm@(\d+\.\d+\.\d+)$/);
  expect(match, `package.json packageManager should pin pnpm, got "${pm}"`).not.toBeNull();
  return (match as RegExpMatchArray)[1];
}

function pnpmSetupSteps(): WorkflowStep[] {
  const wf = loadWorkflow();
  const jobs = wf.jobs ?? {};
  return Object.values(jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => typeof step.uses === 'string' && step.uses.startsWith('pnpm/action-setup'));
}

describe('compat-suite workflow pnpm pin (test-e2e-deploy.yml)', () => {
  it('has at least one pnpm/action-setup step (sanity)', () => {
    expect(pnpmSetupSteps().length).toBeGreaterThan(0);
  });

  it('every pnpm/action-setup step pins an explicit version', () => {
    for (const step of pnpmSetupSteps()) {
      const version = step.with?.version;
      expect(
        version,
        `pnpm/action-setup step "${step.name ?? step.uses}" must set with.version`,
      ).toBeDefined();
      expect(String(version).trim().length, 'pnpm version must be non-empty').toBeGreaterThan(0);
    }
  });

  it('the pinned pnpm version matches the repo packageManager field', () => {
    const expected = pinnedPnpmVersion();
    for (const step of pnpmSetupSteps()) {
      expect(
        String(step.with?.version),
        `pnpm version in "${step.name ?? step.uses}" must match packageManager pnpm@${expected}`,
      ).toBe(expected);
    }
  });
});
