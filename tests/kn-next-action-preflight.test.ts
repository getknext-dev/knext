import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The GitHub Action's credential preflight (`packages/kn-next-action/preflight.mjs`)
 * loads its classifier from `@getknext/core`. It used to `import()` that bare
 * specifier from its OWN file — the action's checkout, which has no
 * node_modules — so the preflight could never load the classifier and failed
 * for every consumer (found dogfooding the docs deploy, #1481). It must resolve
 * from the step's working directory: the app, where `@getknext/core` is
 * installed.
 *
 * Runs the real script against a stub `@getknext/core` in a temp app dir and a
 * fake `kubectl` on PATH, so it needs neither a cluster nor a built dist.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PREFLIGHT = join(REPO_ROOT, 'packages/kn-next-action/preflight.mjs');
const ACTION = join(REPO_ROOT, 'packages/kn-next-action/action.yml');

function fakeKubectlDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knext-preflight-bin-'));
  const bin = join(dir, 'kubectl');
  writeFileSync(bin, '#!/bin/sh\necho \'{"status":{"resourceRules":[]}}\'\n');
  chmodSync(bin, 0o755);
  return dir;
}

/** An app dir whose node_modules carries a stub classifier that always passes. */
function appWithStubCore(): string {
  const app = mkdtempSync(join(tmpdir(), 'knext-preflight-app-'));
  writeFileSync(join(app, 'package.json'), '{"name":"app","private":true}\n');
  const core = join(app, 'node_modules/@getknext/core');
  mkdirSync(core, { recursive: true });
  writeFileSync(
    join(core, 'package.json'),
    JSON.stringify({
      name: '@getknext/core',
      type: 'module',
      exports: { './internal/credential-scope': './scope.js' },
    }),
  );
  writeFileSync(
    join(core, 'scope.js'),
    'export function classifyCredentialScope() { return { ok: true, findings: [], remedy: "" }; }\n',
  );
  return app;
}

function runPreflight(cwd: string) {
  return spawnSync('node', [PREFLIGHT, '--namespace', 'ns'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeKubectlDir()}:${process.env.PATH ?? ''}` },
  });
}

describe('kn-next-action preflight resolves @getknext/core from the app', () => {
  it('loads the classifier installed in the working directory', () => {
    const r = runPreflight(appWithStubCore());
    expect(r.stderr).not.toContain('Could not load the credential classifier');
    expect(r.stdout).toContain('correctly scoped');
    expect(r.status).toBe(0);
  });

  it('fails CLOSED, naming the fix, when the app has no @getknext/core', () => {
    const r = runPreflight(mkdtempSync(join(tmpdir(), 'knext-preflight-empty-')));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Could not load the credential classifier');
    expect(r.stderr).toContain('working-directory');
  });

  it('the action runs the preflight step in the app directory', () => {
    const action = parse(readFileSync(ACTION, 'utf8')) as {
      runs: { steps: { name?: string; 'working-directory'?: string }[] };
    };
    const step = action.runs.steps.find((s) => s.name === 'Credential preflight');
    expect(step?.['working-directory']).toBe('${{ inputs.working-directory }}');
  });
});
