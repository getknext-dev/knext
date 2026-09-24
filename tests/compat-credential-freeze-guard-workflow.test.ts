import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const EXEC_TIMEOUT_MS = 10_000;

/**
 * Wiring tests for `.github/workflows/compat-credential-freeze-guard.yml`
 * (#1302, amended #1370 review) — the shape of the workflow itself, mirroring
 * `tests/actionlint-workflow.test.ts`'s pattern for the same injection-safety
 * and permissions concerns.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/compat-credential-freeze-guard.yml');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on?: { pull_request?: { branches?: string[] }; merge_group?: unknown };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

function load(): { text: string; wf: Workflow } {
  const text = readFileSync(WORKFLOW_PATH, 'utf8');
  return { text, wf: parse(text) as Workflow };
}

describe('compat-credential-freeze-guard.yml is valid and triggers on every PR (#1302)', () => {
  it('parses as YAML', () => {
    expect(() => load()).not.toThrow();
  });

  it('triggers on pull_request against any branch (stacked PRs included, no paths: scope)', () => {
    const { wf } = load();
    expect(wf.on?.pull_request?.branches).toEqual(['**']);
    // Deliberately NOT paths:-scoped to .github/workflows/** (unlike
    // actionlint.yml) — the frozen set spans scripts/, test/, and
    // .github/workflows/, so narrowing the trigger would blind the gate to
    // a scripts/e2e-*.sh-only PR.
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    const onBlock = raw.slice(raw.indexOf('\non:'), raw.indexOf('\npermissions:'));
    expect(onBlock).not.toMatch(/paths:/);
  });

  it('also triggers on merge_group (#1370 review) — a future required check must not stall the queue', () => {
    const { wf } = load();
    expect('merge_group' in (wf.on ?? {})).toBe(true);
  });

  it('both top-level and job-level permissions are read-only', () => {
    const { wf } = load();
    expect(wf.permissions?.contents).toBe('read');
    const job = wf.jobs['freeze-guard'];
    expect(job.permissions?.contents).toBe('read');
    // No other permission scope granted anywhere in the job.
    expect(Object.keys(job.permissions ?? {})).toEqual(['contents']);
  });
});

describe('queue-safe base/head SHAs (#1370 review)', () => {
  it('job-level env computes BASE_SHA/HEAD_SHA from merge_group OR pull_request, never pull_request alone', () => {
    const { wf } = load();
    const job = wf.jobs['freeze-guard'];
    expect(job.env?.BASE_SHA).toContain('github.event.merge_group.base_sha');
    expect(job.env?.BASE_SHA).toContain('github.event.pull_request.base.sha');
    expect(job.env?.HEAD_SHA).toContain('github.event.merge_group.head_sha');
    expect(job.env?.HEAD_SHA).toContain('github.event.pull_request.head.sha');
  });

  it('no step re-declares a pull_request-only BASE_SHA/HEAD_SHA env that would shadow the job-level one', () => {
    const { wf } = load();
    for (const step of wf.jobs['freeze-guard'].steps) {
      if (!step.env) continue;
      expect(Object.keys(step.env)).not.toContain('BASE_SHA');
      expect(Object.keys(step.env)).not.toContain('HEAD_SHA');
    }
  });
});

describe('injection safety: PR-controlled values flow through env:, never inline in run: (#1302)', () => {
  it('the diff step uses BASE_SHA/HEAD_SHA as shell vars, never $\\{\\{ \\}\\} inline', () => {
    const { wf } = load();
    const step = wf.jobs['freeze-guard'].steps.find((s) => /Compute the files/.test(s.name ?? ''));
    expect(step, 'diff step not found').toBeTruthy();
    expect(String(step?.run)).toContain('"${BASE_SHA}');
    expect(String(step?.run)).toContain('${HEAD_SHA}"');
    expect(String(step?.run)).not.toMatch(/\$\{\{/);
  });

  it('the base and head pin-read steps use BASE_SHA/HEAD_SHA as shell vars, never inline', () => {
    const { wf } = load();
    const baseStep = wf.jobs['freeze-guard'].steps.find((s) =>
      /Read the pin file at the PR's base commit/.test(s.name ?? ''),
    );
    const headStep = wf.jobs['freeze-guard'].steps.find((s) =>
      /Read the pin file at the PR's head commit/.test(s.name ?? ''),
    );
    expect(baseStep, 'base pin-read step not found').toBeTruthy();
    expect(headStep, 'head pin-read step not found').toBeTruthy();
    expect(String(baseStep?.run)).toContain('"${BASE_SHA}:.github/compat-credential-ref.json"');
    expect(String(headStep?.run)).toContain('"${HEAD_SHA}:.github/compat-credential-ref.json"');
    expect(String(baseStep?.run)).not.toMatch(/\$\{\{/);
    expect(String(headStep?.run)).not.toMatch(/\$\{\{/);
  });

  it('no step anywhere in the job interpolates ${{ }} directly into its run: script', () => {
    const { wf } = load();
    for (const step of wf.jobs['freeze-guard'].steps) {
      if (!step.run) continue;
      expect(step.run, `step "${step.name}" interpolates \${{ }} inline in run:`).not.toMatch(
        /\$\{\{/,
      );
    }
  });
});

describe('the base-commit diff uses three-dot notation AND --no-renames (#1370 review, round 2)', () => {
  it('git diff --no-renames --name-only uses BASE_SHA...HEAD_SHA, not a two-dot range', () => {
    const { text } = load();
    expect(text).toMatch(/git diff --no-renames --name-only "\$\{BASE_SHA\}\.\.\.\$\{HEAD_SHA\}"/);
  });

  it('--no-renames is present — without it, a renamed frozen file evades the guard (round 2 repro)', () => {
    const { text } = load();
    const diffLine = text
      .split('\n')
      .find((l) => l.includes('git diff') && l.includes('--name-only'));
    expect(diffLine, 'diff line not found').toBeTruthy();
    expect(diffLine).toContain('--no-renames');
  });
});

describe('rename-evasion mechanism, proved against real git (#1370 review round 2)', () => {
  it('WITHOUT --no-renames, git diff --name-only on a pure rename shows only the NEW path — the old (frozen) path vanishes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-freeze-rename-'));
    try {
      // -c commit.gpgsign=false: this repo's/runner's global git config may
      // set commit.gpgsign=true, which hangs `git commit` waiting on a
      // passphrase in a non-interactive test run.
      const run = (args: string[]) =>
        execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
          cwd: dir,
          encoding: 'utf8',
          timeout: EXEC_TIMEOUT_MS,
        });
      run(['init', '-q']);
      run(['config', 'user.email', 'test@example.com']);
      run(['config', 'user.name', 'Test']);
      // A big-enough file for git's similarity heuristic to call this a
      // rename rather than an unrelated delete+add.
      const body = Array.from({ length: 40 }, (_, i) => `line ${i} of the frozen script\n`).join(
        '',
      );
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts/e2e-cleanup.sh'), body);
      run(['add', '.']);
      run(['commit', '-q', '-m', 'base']);
      const baseSha = run(['rev-parse', 'HEAD']).trim();

      // The reviewer's exact repro.
      run(['mv', 'scripts/e2e-cleanup.sh', 'scripts/e2e-cleanup-x.sh']);
      run(['add', '-A']);
      run(['commit', '-q', '-m', 'rename']);
      const headSha = run(['rev-parse', 'HEAD']).trim();

      const withRenames = run(['diff', '--name-only', `${baseSha}...${headSha}`])
        .trim()
        .split('\n');
      const withoutRenames = run(['diff', '--no-renames', '--name-only', `${baseSha}...${headSha}`])
        .trim()
        .split('\n');

      // The vulnerable shape: rename detection on, the frozen old path is
      // simply absent — this is what let the pre-round-2 workflow miss it.
      expect(withRenames).not.toContain('scripts/e2e-cleanup.sh');
      // The fix: --no-renames reports it as delete-of-old + add-of-new, so
      // the frozen path IS in the list the guard's CLI receives.
      expect(withoutRenames).toContain('scripts/e2e-cleanup.sh');
      expect(withoutRenames).toContain('scripts/e2e-cleanup-x.sh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('the freeze state is read at BASE, the marker at HEAD (#1302, amended #1370)', () => {
  it('git show reads the pin at BASE_SHA into base-pin.json', () => {
    const { text } = load();
    expect(text).toMatch(
      /git show "\$\{BASE_SHA\}:\.github\/compat-credential-ref\.json" > base-pin\.json/,
    );
  });

  it('git show ALSO reads the pin at HEAD_SHA into head-pin.json (#1370 review)', () => {
    const { text } = load();
    expect(text).toMatch(
      /git show "\$\{HEAD_SHA\}:\.github\/compat-credential-ref\.json" > head-pin\.json/,
    );
  });

  it('both a missing historical base pin AND a missing head pin degrade to the unfrozen shape', () => {
    const { text } = load();
    const matches = text.match(/\{"rcTag":\s*null\}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the guard runs from a base-commit checkout of its OWN code (#1370 review — "the PR can rewrite its own gate")', () => {
  it('a worktree is added at BASE_SHA before the guard runs', () => {
    const { text } = load();
    expect(text).toMatch(/git worktree add --detach base-checkout "\$\{BASE_SHA\}"/);
  });

  it('the "Run the freeze guard" step invokes the script FROM base-checkout/, not the PR head copy', () => {
    const { wf } = load();
    const step = wf.jobs['freeze-guard'].steps.find((s) =>
      /Run the freeze guard/.test(s.name ?? ''),
    );
    expect(step, 'guard-invocation step not found').toBeTruthy();
    expect(String(step?.run)).toContain('base-checkout/scripts/compat-credential-freeze-guard.mjs');
    expect(String(step?.run)).toContain('--repo-root base-checkout');
    // Never invoked against the bare (PR-head) scripts/ path.
    expect(String(step?.run)).not.toMatch(
      /(?<!base-checkout\/)scripts\/compat-credential-freeze-guard\.mjs/,
    );
  });

  it('the checkout-worktree step runs BEFORE the guard-invocation step', () => {
    const { wf } = load();
    const steps = wf.jobs['freeze-guard'].steps;
    const worktreeIdx = steps.findIndex((s) => /Checkout the guard's own code/.test(s.name ?? ''));
    const runIdx = steps.findIndex((s) => /Run the freeze guard/.test(s.name ?? ''));
    expect(worktreeIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThan(worktreeIdx);
  });

  it('the guard invocation passes both --base-pin-file and --head-pin-file', () => {
    const { wf } = load();
    const step = wf.jobs['freeze-guard'].steps.find((s) =>
      /Run the freeze guard/.test(s.name ?? ''),
    );
    expect(String(step?.run)).toContain('--base-pin-file base-pin.json');
    expect(String(step?.run)).toContain('--head-pin-file head-pin.json');
  });
});

describe('the guard script runs with no hardcoded frozen-file list in the workflow itself (#1302)', () => {
  it('the "Run the freeze guard" step passes no --files/--frozen-set flag — derivation lives in the script', () => {
    const { wf } = load();
    const step = wf.jobs['freeze-guard'].steps.find((s) =>
      /Run the freeze guard/.test(s.name ?? ''),
    );
    expect(step, 'guard-invocation step not found').toBeTruthy();
    expect(String(step?.run)).toContain('compat-credential-freeze-guard.mjs');
    expect(String(step?.run)).not.toMatch(/--files|--frozen-set|--protected/);
  });
});

describe('the checkout has full history — required for both the diff and the base-commit pin read (#1302)', () => {
  it('fetch-depth: 0 is set on the checkout step', () => {
    const { wf } = load();
    const checkout = wf.jobs['freeze-guard'].steps.find((s) =>
      s.uses?.startsWith('actions/checkout'),
    );
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });
});
