import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TEST for .github/workflows/bun-sandbox-fetch-ab.yml — the
 * discriminating-repro A/B for docs/compat/upstream-bun-sandbox-fetch-bug.md.
 *
 * The workflow exists to produce (or honestly fail to produce) the evidence an
 * oven-sh/bun filing requires. Its validity rests on invariants that a casual
 * edit could silently destroy:
 *
 * 1. DISPATCH-ONLY: it is an investigation tool, never a schedule — a cron
 *    here would burn CI on a non-gate and blur the compat lane's cadence
 *    ledger.
 * 2. BOTH LANES: the matrix must cover node AND bun with fail-fast disabled —
 *    a one-lane run cannot discriminate anything.
 * 3. CONSTANT CLIENT: the trial driver must be invoked under `node` in both
 *    lanes (the serving runtime is the only variable); bun must only be set up
 *    lane-gated.
 * 4. THE CRITERION: the discrimination thresholds live in aggregate.mjs and
 *    must not be silently weakened — a lowered bar would fabricate
 *    file-worthiness.
 * 5. PINNED FIXTURE: the fixture pins next@16.2.0 EXACTLY — the version the
 *    6/6 CI red record was produced against; a floating range would test a
 *    different claim.
 *
 * Text-scan (not YAML-parse) for the same reason as
 * compat-suite-workflow.test.ts: no new runtime dependency.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/bun-sandbox-fetch-ab.yml');
const AGGREGATE_PATH = resolve(REPO_ROOT, 'test/bun-sandbox-fetch-ab/aggregate.mjs');
const FIXTURE_PKG_PATH = resolve(REPO_ROOT, 'test/bun-sandbox-fetch-ab/fixture/package.json');

function workflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

describe('bun-sandbox-fetch A/B workflow (discriminating-repro invariants)', () => {
  it('is dispatch-only: workflow_dispatch present, no schedule trigger', () => {
    const text = workflowText();
    expect(text).toMatch(/^\s*workflow_dispatch:/m);
    // No cron anywhere — comments included; nobody sneaks a schedule in.
    expect(text).not.toMatch(/^\s*schedule:/m);
    expect(text).not.toMatch(/^\s*-?\s*cron:/m);
  });

  it('runs BOTH runtimes on the same runner class with fail-fast disabled', () => {
    const text = workflowText();
    expect(text).toMatch(/runtime:\s*\[node,\s*bun\]/);
    expect(text).toMatch(/fail-fast:\s*false/);
    // One runner class only — a mixed-runner A/B would reintroduce a confound.
    const runsOn = [...text.matchAll(/^\s*runs-on:\s*(\S+)/gm)].map((m) => m[1]);
    expect(runsOn.length).toBeGreaterThan(0);
    expect(new Set(runsOn)).toEqual(new Set(['ubuntu-latest']));
  });

  it('keeps the probe client constant: the trial driver runs under node, bun setup is lane-gated', () => {
    const text = workflowText();
    expect(text).toMatch(/node test\/bun-sandbox-fetch-ab\/run-trials\.mjs/);
    // The setup-bun step must be conditioned on the bun lane, so the node
    // lane's PATH never even contains bun.
    const setupBunIdx = text.indexOf('uses: oven-sh/setup-bun');
    expect(setupBunIdx).toBeGreaterThan(-1);
    const before = text.slice(Math.max(0, setupBunIdx - 400), setupBunIdx);
    expect(before).toMatch(/if:\s*matrix\.runtime\s*==\s*'bun'/);
  });

  it('states the discrimination criterion in the aggregate step and pins its thresholds in aggregate.mjs', () => {
    const aggregate = readFileSync(AGGREGATE_PATH, 'utf8');
    // The exact thresholds from the doc's criterion (bun >= 50%, node <= 5%).
    expect(aggregate).toMatch(/BUN_MATERIAL_HANG_RATE\s*=\s*0\.5\b/);
    expect(aggregate).toMatch(/NODE_CLEAN_HANG_RATE\s*=\s*0\.05\b/);
    // Both verdict branches exist — the tool is allowed to say "no".
    expect(aggregate).toContain('DISCRIMINATES');
    expect(aggregate).toContain('DOES NOT DISCRIMINATE');
  });

  it('pins the fixture to next@16.2.0 exactly (the version behind the 6/6 CI record)', () => {
    const pkg = JSON.parse(readFileSync(FIXTURE_PKG_PATH, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.next).toBe('16.2.0');
  });
});
