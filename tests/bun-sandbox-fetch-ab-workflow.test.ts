import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const RUN_TRIALS_PATH = resolve(REPO_ROOT, 'test/bun-sandbox-fetch-ab/run-trials.mjs');
const FIXTURE_PKG_PATH = resolve(REPO_ROOT, 'test/bun-sandbox-fetch-ab/fixture/package.json');
const MIDDLEWARE_PATH = resolve(REPO_ROOT, 'test/bun-sandbox-fetch-ab/fixture/middleware.js');

function workflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

/** The `Run trials` step block (from its name: line to the next step). */
function runTrialsStep(): string {
  const text = workflowText();
  const start = text.indexOf('- name: Run trials');
  expect(start, 'expected a "Run trials" step').toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.search(/^\s*- name:/m);
  return text.slice(start, next === -1 ? undefined : start + 1 + next);
}

/** A minimal trial artifact in the shape run-trials.mjs writes. */
function artifact(runtime: string, outcomesPerTrial: Record<string, string>[]) {
  const shapes = Object.keys(outcomesPerTrial[0]);
  return {
    runtime,
    runtimeVersion: 'test',
    trials: outcomesPerTrial.length,
    probeTimeoutMs: 15000,
    echo: 'test',
    shapes,
    perTrial: outcomesPerTrial.map((byShape, i) => ({
      trial: i + 1,
      results: shapes.map((shape) => ({ shape, outcome: byShape[shape], ms: 1 })),
    })),
    generatedAt: new Date().toISOString(),
  };
}

function runAggregate(nodeArtifact: unknown, bunArtifact: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'knext-ab-agg-'));
  const nodePath = join(dir, 'ab-results-node.json');
  const bunPath = join(dir, 'ab-results-bun.json');
  writeFileSync(nodePath, JSON.stringify(nodeArtifact));
  writeFileSync(bunPath, JSON.stringify(bunArtifact));
  return execFileSync('node', [AGGREGATE_PATH, '--node', nodePath, '--bun', bunPath], {
    encoding: 'utf8',
  });
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

// ── #197 gate follow-ups (non-blocking nits closed) ───────────────────────────
describe('bun-sandbox-fetch A/B — #197 gate follow-ups', () => {
  it('passes the trials input via env indirection, never interpolated into the run script (GHA injection hardening)', () => {
    const step = runTrialsStep();
    // The untrusted dispatch input reaches the shell ONLY through an env var…
    expect(step).toMatch(/env:\s*\n\s+TRIALS:\s*\$\{\{\s*github\.event\.inputs\.trials/);
    expect(step).toMatch(/--trials\s+"\$TRIALS"/);
    // …and the run script itself must not template the input inline.
    const run = step.slice(step.indexOf('run:'));
    expect(
      /github\.event\.inputs\.trials/.test(run),
      'the run script must not interpolate github.event.inputs.trials directly',
    ).toBe(false);
  });

  it('run-trials.mjs rejects a non-positive or non-numeric --trials loudly (exit 2)', () => {
    for (const bad of ['0', '-3', 'banana', '2.5']) {
      const res = spawnSync('node', [RUN_TRIALS_PATH, '--runtime', 'node', '--trials', bad], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(res.status, `--trials ${bad} must exit 2, stderr: ${res.stderr}`).toBe(2);
      expect(res.stderr).toMatch(/--trials/);
    }
  });

  it('the fixture middleware comment states the ACTUAL echo port (8743), matching run-trials.mjs', () => {
    const middleware = readFileSync(MIDDLEWARE_PATH, 'utf8');
    const runTrials = readFileSync(RUN_TRIALS_PATH, 'utf8');
    const urlMatch = middleware.match(/HTTP_ECHO_URL\s*=\s*'https:\/\/127\.0\.0\.1:(\d+)/);
    expect(urlMatch, 'expected the hardcoded HTTP_ECHO_URL').not.toBeNull();
    const actualPort = (urlMatch as RegExpMatchArray)[1];
    expect(runTrials).toMatch(new RegExp(`ECHO_PORT\\s*=\\s*${actualPort}\\b`));
    // Any 127.0.0.1:<port> mention in the middleware comments must be the real
    // port — a stale copy-paste port (the #197 nit: 8443 vs 8743) misleads the
    // next investigator reading the fixture.
    for (const m of middleware.matchAll(/127\.0\.0\.1:(\d+)/g)) {
      expect(m[1], `stale port reference "${m[0]}" in middleware.js`).toBe(actualPort);
    }
  });

  it('aggregate prints a per-lane resolved/client-error/timeout breakdown', () => {
    const clean = { 'GET normal-fetch': 'resolved', 'POST normal-fetch': 'resolved' };
    const out = runAggregate(artifact('node', [clean]), artifact('bun', [clean]));
    expect(out).toMatch(/resolved/);
    expect(out).toMatch(/client-error/);
    expect(out).toMatch(/\| node \|/);
    expect(out).toMatch(/\| bun \|/);
  });

  it('a fast-failing lane cannot print an UNQUALIFIED "DOES NOT DISCRIMINATE" verdict', () => {
    // Bun lane fails every probe instantly with client errors — zero timeouts,
    // so the hang-rate criterion says "does not discriminate". The verdict must
    // carry a caution: those probes never got the CHANCE to hang.
    const nodeClean = { 'GET normal-fetch': 'resolved', 'POST normal-fetch': 'resolved' };
    const bunErrors = { 'GET normal-fetch': 'client-error', 'POST normal-fetch': 'client-error' };
    const out = runAggregate(artifact('node', [nodeClean]), artifact('bun', [bunErrors]));
    expect(out).toContain('DOES NOT DISCRIMINATE');
    expect(out).toMatch(/CAUTION/);
    // And a genuinely clean negative stays unqualified.
    const cleanOut = runAggregate(artifact('node', [nodeClean]), artifact('bun', [nodeClean]));
    expect(cleanOut).toContain('DOES NOT DISCRIMINATE');
    expect(cleanOut).not.toMatch(/CAUTION/);
  });
});
