import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { standaloneCompileArgv } from '../packages/kn-next/src/cli/standalone-exec-build';

/**
 * #1596 — kn-next-action never installed Bun, and a stock `ubuntu-24.04` runner ships
 * none (github/actions/runner-images does not bundle it). `DEFAULT_RUNTIME_ID`
 * (artifact-contract.ts) is "bun" — a scaffolded app with no explicit
 * `runtime` compiles through `compileArtifactForDeploy` ->
 * `standaloneCompileArgv()`, whose argv[0] is the literal binary name the
 * deploy step shells out to. Every default-runtime deploy through the
 * documented GitHub Action pipeline therefore failed with ENOENT. Fix: a
 * SHA-pinned `oven-sh/setup-bun` step, ordered after the credential preflight
 * and before `Deploy`.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const ACTION_PATH = resolve(REPO_ROOT, 'packages/kn-next-action/action.yml');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

function loadAction(): { runs: { steps: Step[] } } {
  return parse(readFileSync(ACTION_PATH, 'utf8')) as { runs: { steps: Step[] } };
}

describe('kn-next-action installs Bun before deploying (default runtime is bun)', () => {
  it('the binary the compiled default-runtime build shells out to is literally "bun"', () => {
    // Ties this test to the real seam: if the default runtime's compile step
    // ever stops shelling out to a bare `bun`, this assertion (not just the
    // action-structure ones below) goes red and says why.
    const argv = standaloneCompileArgv({
      arch: 'linux-x64',
      server: 'server.js',
      root: '.next/standalone',
      outFile: 'out',
      marker: 'marker',
    });
    expect(argv[0]).toBe('bun');
  });

  it('has a step that installs Bun via oven-sh/setup-bun', () => {
    const steps = loadAction().runs.steps;
    const bunSteps = steps.filter((s) => (s.uses ?? '').includes('oven-sh/setup-bun'));
    expect(bunSteps).toHaveLength(1);
  });

  it('pins oven-sh/setup-bun by a full 40-hex commit SHA with an auditable `# vX.Y.Z` comment', () => {
    const raw = readFileSync(ACTION_PATH, 'utf8');
    const line = raw.split('\n').find((l) => l.includes('oven-sh/setup-bun'));
    expect(line).toBeDefined();
    expect(line).toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}\s*#\s*v\d+\.\d+\.\d+/);
  });

  it('the setup-bun step is ordered after both credential-preflight steps and before Deploy', () => {
    const steps = loadAction().runs.steps;
    const names = steps.map((s) => s.name);
    const kubeconfigCheckIdx = names.indexOf('Kubeconfig check');
    const preflightIdx = names.indexOf('Credential preflight');
    const bunIdx = steps.findIndex((s) => (s.uses ?? '').includes('oven-sh/setup-bun'));
    const deployIdx = names.indexOf('Deploy');

    expect(kubeconfigCheckIdx).toBeGreaterThanOrEqual(0);
    expect(preflightIdx).toBeGreaterThan(kubeconfigCheckIdx);
    expect(bunIdx).toBeGreaterThan(preflightIdx);
    expect(deployIdx).toBeGreaterThan(bunIdx);
  });

  it("the setup-bun step's bun-version pins the lockstep Bun (1.4.2)", () => {
    const steps = loadAction().runs.steps;
    const bunStep = steps.find((s) => (s.uses ?? '').includes('oven-sh/setup-bun'));
    expect(bunStep?.with?.['bun-version']).toBe('1.4.2');
  });

  it('the credential steps (configure access, kubeconfig check, credential preflight) keep their original relative order', () => {
    const steps = loadAction().runs.steps;
    const names = steps.map((s) => s.name);
    const configureIdx = names.indexOf('Configure cluster access');
    const kubeconfigCheckIdx = names.indexOf('Kubeconfig check');
    const preflightIdx = names.indexOf('Credential preflight');
    expect(configureIdx).toBe(0);
    expect(kubeconfigCheckIdx).toBe(1);
    expect(preflightIdx).toBe(2);
  });
});
