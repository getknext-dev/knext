import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Wiring tests for `.github/workflows/published-bytes-freeze-guard.yml`
 * (#1663) — mirrors `tests/compat-credential-freeze-guard-workflow.test.ts`'s
 * shape/injection-safety pattern for the sibling guard.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/published-bytes-freeze-guard.yml');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
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

const JOB = 'published-bytes-freeze';

describe('published-bytes-freeze-guard.yml is valid and triggers on every PR (#1663)', () => {
  it('parses as YAML', () => {
    expect(() => load()).not.toThrow();
  });

  it('triggers on pull_request against any branch (stacked PRs included, no paths: scope)', () => {
    const { wf, text } = load();
    expect(wf.on?.pull_request?.branches).toEqual(['**']);
    const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));
    expect(onBlock).not.toMatch(/paths:/);
  });

  it('also triggers on merge_group — a future required check must not stall the queue', () => {
    const { wf } = load();
    expect('merge_group' in (wf.on ?? {})).toBe(true);
  });

  it('both top-level and job-level permissions are read-only', () => {
    const { wf } = load();
    expect(wf.permissions?.contents).toBe('read');
    const job = wf.jobs[JOB];
    expect(job.permissions?.contents).toBe('read');
    expect(Object.keys(job.permissions ?? {})).toEqual(['contents']);
  });
});

describe('queue-safe base/head SHAs', () => {
  it('job-level env computes BASE_SHA/HEAD_SHA from merge_group OR pull_request', () => {
    const { wf } = load();
    const job = wf.jobs[JOB];
    expect(job.env?.BASE_SHA).toContain('github.event.merge_group.base_sha');
    expect(job.env?.BASE_SHA).toContain('github.event.pull_request.base.sha');
    expect(job.env?.HEAD_SHA).toContain('github.event.merge_group.head_sha');
    expect(job.env?.HEAD_SHA).toContain('github.event.pull_request.head.sha');
  });
});

describe('injection safety: PR-controlled values flow through env:, never inline in run:', () => {
  it('the diff step uses BASE_SHA/HEAD_SHA as shell vars, never ${{ }} inline', () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find((s) => /Compute the files/.test(s.name ?? ''));
    expect(step, 'diff step not found').toBeTruthy();
    expect(String(step?.run)).toContain('"${BASE_SHA}');
    expect(String(step?.run)).toContain('${HEAD_SHA}"');
    expect(String(step?.run)).not.toMatch(/\$\{\{/);
  });

  it('the base/head/merge-base pin-read steps use BASE_SHA/HEAD_SHA as shell vars, never inline', () => {
    const { wf } = load();
    const baseStep = wf.jobs[JOB].steps.find((s) =>
      /Read the pin file at the PR's base commit/.test(s.name ?? ''),
    );
    const headStep = wf.jobs[JOB].steps.find((s) =>
      /Read the pin file at the PR's head commit/.test(s.name ?? ''),
    );
    const mergeBaseStep = wf.jobs[JOB].steps.find((s) =>
      /Read the pin file at the PR's merge base/.test(s.name ?? ''),
    );
    expect(baseStep, 'base pin-read step not found').toBeTruthy();
    expect(headStep, 'head pin-read step not found').toBeTruthy();
    expect(mergeBaseStep, 'merge-base pin-read step not found').toBeTruthy();
    expect(String(baseStep?.run)).toContain('--base-sha "${BASE_SHA}"');
    expect(String(headStep?.run)).toContain('--read-pin-at "${HEAD_SHA}"');
    expect(String(mergeBaseStep?.run)).toContain('git merge-base "${BASE_SHA}" "${HEAD_SHA}"');
    expect(String(mergeBaseStep?.run)).toContain('--read-pin-at "${MERGE_BASE}"');
    expect(String(baseStep?.run)).not.toMatch(/\$\{\{/);
    expect(String(headStep?.run)).not.toMatch(/\$\{\{/);
    expect(String(mergeBaseStep?.run)).not.toMatch(/\$\{\{/);
  });

  it('no step anywhere in the job interpolates ${{ }} directly into its run: script', () => {
    const { wf } = load();
    for (const step of wf.jobs[JOB].steps) {
      if (!step.run) continue;
      expect(step.run, `step "${step.name}" interpolates \${{ }} inline in run:`).not.toMatch(
        /\$\{\{/,
      );
    }
  });
});

describe('the base-commit diff uses three-dot notation AND --no-renames', () => {
  it('git diff --no-renames --name-only uses BASE_SHA...HEAD_SHA, not a two-dot range', () => {
    const { text } = load();
    expect(text).toMatch(/git diff --no-renames --name-only "\$\{BASE_SHA\}\.\.\.\$\{HEAD_SHA\}"/);
  });
});

describe('checkout resolves the credentialed rc tag', () => {
  it('fetch-depth: 0 AND fetch-tags: true are both set (a tag-diff needs both)', () => {
    const { wf } = load();
    const checkout = wf.jobs[JOB].steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(checkout?.with?.['fetch-tags']).toBe(true);
  });
});

describe('dependency install precedes the check invocation (the #1615-class defect, guarded here too)', () => {
  it('bun install runs before the published-bytes freeze check step', () => {
    const { wf } = load();
    const steps = wf.jobs[JOB].steps;
    const installIdx = steps.findIndex(
      (s) => typeof s.run === 'string' && /\bbun install --frozen-lockfile\b/.test(s.run),
    );
    const checkIdx = steps.findIndex(
      (s) => typeof s.run === 'string' && /published-bytes-freeze-check\.mjs/.test(s.run),
    );
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(checkIdx).toBeGreaterThan(installIdx);
  });
});

describe('the check is invoked with a changed-files file, no hardcoded scope flag', () => {
  it('the invocation passes --changed-files-file and nothing resembling a hand-listed scope', () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find(
      (s) => typeof s.run === 'string' && /published-bytes-freeze-check\.mjs/.test(s.run),
    );
    expect(step, 'check-invocation step not found').toBeTruthy();
    expect(String(step?.run)).toContain('--changed-files-file changed-files.txt');
    expect(String(step?.run)).not.toMatch(/--packages|--scope|--dirs/);
  });

  it('the invocation passes --base-pin-file, --head-pin-file and --merge-base-pin-file (round 2, PR #1680)', () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find(
      (s) => typeof s.run === 'string' && /published-bytes-freeze-check\.mjs/.test(s.run),
    );
    expect(String(step?.run)).toContain('--base-pin-file base-pin.json');
    expect(String(step?.run)).toContain('--head-pin-file head-pin.json');
    expect(String(step?.run)).toContain('--merge-base-pin-file merge-base-pin.json');
  });
});

describe('the base/head/merge-base pin reads precede the check invocation', () => {
  it('ordering: diff -> base pin -> head pin -> merge-base pin -> check', () => {
    const { wf } = load();
    const steps = wf.jobs[JOB].steps;
    const idx = (re: RegExp) => steps.findIndex((s) => re.test(s.name ?? ''));
    const diffIdx = idx(/Compute the files/);
    const baseIdx = idx(/Read the pin file at the PR's base commit/);
    const headIdx = idx(/Read the pin file at the PR's head commit/);
    const mergeBaseIdx = idx(/Read the pin file at the PR's merge base/);
    const checkIdx = steps.findIndex(
      (s) => typeof s.run === 'string' && /published-bytes-freeze-check\.mjs/.test(s.run),
    );
    for (const i of [diffIdx, baseIdx, headIdx, mergeBaseIdx, checkIdx]) {
      expect(i).toBeGreaterThanOrEqual(0);
    }
    expect(baseIdx).toBeGreaterThan(diffIdx);
    expect(headIdx).toBeGreaterThan(baseIdx);
    expect(mergeBaseIdx).toBeGreaterThan(headIdx);
    expect(checkIdx).toBeGreaterThan(mergeBaseIdx);
  });
});

describe('actionlint has no complaints about this workflow', () => {
  it('actionlint exits 0 on this file (skips gracefully if actionlint is not on PATH)', () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const probe = spawnSync('actionlint', ['--version'], { encoding: 'utf8' });
    if (probe.error) {
      // actionlint not installed in this environment — the real CI job
      // (`.github/workflows/actionlint.yml`) covers every workflow file by
      // directory scan regardless, so this is a local convenience check only.
      return;
    }
    const result = spawnSync('actionlint', [WORKFLOW_PATH], { encoding: 'utf8' });
    expect(result.stdout + result.stderr, 'actionlint findings').toBe('');
    expect(result.status).toBe(0);
  });
});

describe('release-line scope wiring (#2098)', () => {
  it('job env carries BASE_REF from merge_group OR pull_request, and the base-pin step receives it via a shell var', () => {
    const { wf } = load();
    const job = wf.jobs[JOB];
    expect(job.env?.BASE_REF).toContain('github.event.merge_group.base_ref');
    expect(job.env?.BASE_REF).toContain('github.event.pull_request.base.ref');
    const step = job.steps.find((s) =>
      /Read the pin file at the PR's base commit/.test(s.name ?? ''),
    );
    expect(String(step?.run)).toContain('published-bytes-select-pin.mjs');
    expect(String(step?.run)).toContain('--base-ref "${BASE_REF}"');
    expect(String(step?.run)).toContain('--base-pin-out base-pin.json');
    expect(String(step?.run)).toContain('>> "${GITHUB_ENV}"');
    expect(String(step?.run)).not.toMatch(/\$\{\{/);
  });

  it('the check receives the base commit version, so it can skip a base on another line', () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find((s) =>
      /Run the published-bytes freeze check/.test(s.name ?? ''),
    );
    expect(String(step?.run)).toContain('--base-version "${BASE_VERSION}"');
    expect(String(step?.run)).not.toMatch(/\$\{\{/);
  });

  it('the pin selection runs after dependency install (it imports the workspace helpers) and before the head/merge-base reads', () => {
    const { wf } = load();
    const steps = wf.jobs[JOB].steps;
    const idx = (re: RegExp) => steps.findIndex((s) => re.test(`${s.name ?? ''}\n${s.run ?? ''}`));
    const install = idx(/bun install --frozen-lockfile/);
    const select = idx(/published-bytes-select-pin\.mjs/);
    const head = idx(/Read the pin file at the PR's head commit/);
    expect(install).toBeGreaterThanOrEqual(0);
    expect(select).toBeGreaterThan(install);
    expect(head).toBeGreaterThan(select);
  });
});

describe('head/merge-base pin reads tolerate an absent pin file but not an unreadable one (#2118)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
    }).trim();

  const PIN = '.github/compat-credential-ref.json';
  type Case = 'absent' | 'present' | 'blob-missing';

  /** A real repo (with the select-pin script copied in) whose HEAD carries the pin in the given state. */
  function repo(c: Case): { root: string; sha: string } {
    const root = mkdtempSync(join(tmpdir(), 'pb-wf-read-'));
    dirs.push(root);
    git(root, 'init', '-q', '-b', 'trunk');
    git(root, 'config', 'user.email', 't@example.com');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, 'x.txt'), 'x');
    if (c !== 'absent') {
      mkdirSync(join(root, '.github'), { recursive: true });
      writeFileSync(join(root, PIN), '{"rcTag":"v1.0.0-rc.6"}\n');
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const sha = git(root, 'rev-parse', 'HEAD');
    if (c === 'blob-missing') {
      const blob = git(root, 'rev-parse', `${sha}:${PIN}`);
      rmSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
    }
    // Copied AFTER the commit so they stay untracked, outside the tree under test.
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(
      resolve(REPO_ROOT, 'scripts/published-bytes-select-pin.mjs'),
      join(root, 'scripts/published-bytes-select-pin.mjs'),
    );
    cpSync(resolve(REPO_ROOT, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
    cpSync(
      resolve(REPO_ROOT, 'scripts/publish-preflight.mjs'),
      join(root, 'scripts/publish-preflight.mjs'),
    );
    return { root, sha };
  }

  /** Runs the workflow step's OWN `run:` script, verbatim, against `root`. */
  function runStep(label: string, root: string, sha: string) {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find((s) =>
      new RegExp(`Read the pin file at the PR's ${label}`).test(s.name ?? ''),
    );
    expect(step, `step "Read the pin file at the PR's ${label}" not found`).toBeTruthy();
    return spawnSync('bash', ['-c', String(step?.run)], {
      cwd: root,
      encoding: 'utf8',
      // BASE_SHA = HEAD_SHA, so `git merge-base` resolves to the same commit
      // and both steps read the one fixture.
      env: { ...process.env, HEAD_SHA: sha, BASE_SHA: sha, PIN_FILE_SELECTED: PIN },
    });
  }

  for (const [label, out] of [
    ['head commit', 'head-pin.json'],
    ['merge base', 'merge-base-pin.json'],
  ] as const) {
    it(`the ${label} read: pin absent from the tree => unfrozen {"rcTag": null}, step passes`, () => {
      const { root, sha } = repo('absent');
      const r = runStep(label, root, sha);
      expect(r.status).toBe(0);
      expect(JSON.parse(readFileSync(join(root, out), 'utf8'))).toEqual({ rcTag: null });
    });

    it(`the ${label} read: pin present => its real content`, () => {
      const { root, sha } = repo('present');
      const r = runStep(label, root, sha);
      expect(r.status).toBe(0);
      expect(JSON.parse(readFileSync(join(root, out), 'utf8'))).toEqual({ rcTag: 'v1.0.0-rc.6' });
    });

    it(`the ${label} read: pin listed but blob missing => the step FAILS, never reads as absent`, () => {
      const { root, sha } = repo('blob-missing');
      const r = runStep(label, root, sha);
      expect(r.status).not.toBe(0);
      const written = existsSync(join(root, out)) ? readFileSync(join(root, out), 'utf8') : '';
      expect(written).not.toContain('"rcTag": null');
    });
  }
});
describe('#2342 — merged-in-parent pins are collected before, and passed to, the check', () => {
  it('ordering: merge-base pin -> merged-in collection -> check, and the check gets the file', () => {
    const { wf } = load();
    const steps = wf.jobs[JOB].steps;
    const mergeBaseIdx = steps.findIndex((s) =>
      /Read the pin file at the PR's merge base/.test(s.name ?? ''),
    );
    const collectIdx = steps.findIndex((s) =>
      /Collect the pins at merged-in parents/.test(s.name ?? ''),
    );
    const checkIdx = steps.findIndex(
      (s) => typeof s.run === 'string' && /published-bytes-freeze-check\.mjs/.test(s.run),
    );
    expect(mergeBaseIdx).toBeGreaterThanOrEqual(0);
    expect(collectIdx).toBeGreaterThan(mergeBaseIdx);
    expect(checkIdx).toBeGreaterThan(collectIdx);
    expect(String(steps[checkIdx]?.run)).toContain('--inherited-pins-file inherited-pins.json');
  });
});

/**
 * #2342 — END TO END against real git: the workflow's own steps (diff, the
 * base/head/merge-base pin reads, and the merged-in-parent collection) run
 * verbatim in a fixture repo, and their output files feed the real check CLI.
 * A `publishedBytesBumpMarker` that arrives with a merged-in branch
 * (integration/v2 -> main is the motivating shape) must not exempt a
 * published-bytes change; one the PR's own commits add must, including when
 * the PR also merged its base back in, and including the merge queue's own
 * merge commit (first parent = base, second = the PR head).
 *
 * The pinned rcTag is deliberately a tag that exists nowhere, so a PROCEED
 * decision ends at the check's fail-closed tag lookup (exit 1, "does not
 * resolve") instead of packing anything, while an honoured marker SKIPs
 * (exit 0) before the lookup. The check reads the real clock (it has no
 * --now flag), so the marker dates are derived from today.
 */
describe('#2342 — merged-in publishedBytesBumpMarker, executed against real git fixture repos', () => {
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const PIN = '.github/compat-credential-ref.json';
  const CORE_MANIFEST = 'packages/kn-next/package.json';
  const CORE_SRC = 'packages/kn-next/src/index.ts';
  const TAG = 'v1.0.0-rc.9990';
  const CHECK = resolve(REPO_ROOT, 'scripts/published-bytes-freeze-check.mjs');
  const EXEC_TIMEOUT_MS = 20_000;
  const day = (offset: number) =>
    new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const MERGED_IN = { date: day(-2), expires: day(3), reason: 'reviewed for the v2 line' };
  const OWN = { date: day(-1), expires: day(3), reason: 'this PR, reviewed for main' };
  const STEP_NAMES = [
    /Compute the files this PR changed/,
    /Read the pin file at the PR's base commit/,
    /Read the pin file at the PR's head commit/,
    /Read the pin file at the PR's merge base/,
    /Collect the pins at merged-in parents/,
  ];

  type Git = (...a: string[]) => string;
  type Put = (path: string, content: string) => void;
  const pinWith = (marker?: unknown) =>
    JSON.stringify({ rcTag: TAG, ...(marker ? { publishedBytesBumpMarker: marker } : {}) });

  function runScenario(
    build: (git: Git, put: Put) => { base: string; head: string },
    event: 'pull_request' | 'merge_group' = 'pull_request',
  ): { status: number | null; stdout: string; inherited: unknown[] } {
    const { wf } = load();
    const steps = STEP_NAMES.map((re) => {
      const s = wf.jobs[JOB].steps.find((st) => re.test(st.name ?? ''));
      if (!s?.run) throw new Error(`workflow step ${re} not found`);
      return s.run;
    });
    const dir = mkdtempSync(join(tmpdir(), 'pb-freeze-merge-'));
    try {
      const git: Git = (...a) =>
        execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], {
          cwd: dir,
          env: GIT_ENV,
          encoding: 'utf8',
        }).trim();
      const put: Put = (path, content) => {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), content);
      };
      git('init', '-q', '-b', 'main');
      const { base, head } = build(git, put);
      // The scripts the steps invoke, copied in AFTER the history is built so
      // they stay untracked and outside every tree under test.
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      for (const f of [
        'scripts/published-bytes-select-pin.mjs',
        'scripts/collect-merged-in-pins.mjs',
        'scripts/publish-preflight.mjs',
      ]) {
        cpSync(resolve(REPO_ROOT, f), join(dir, f));
      }
      cpSync(resolve(REPO_ROOT, 'scripts/lib'), join(dir, 'scripts/lib'), { recursive: true });
      const githubEnv = join(dir, 'github-env');
      writeFileSync(githubEnv, '');
      let env: Record<string, string | undefined> = {
        ...GIT_ENV,
        BASE_SHA: base,
        HEAD_SHA: head,
        BASE_REF: 'main',
        GITHUB_EVENT_NAME: event,
        GITHUB_ENV: githubEnv,
      };
      for (const run of steps) {
        execFileSync('bash', ['-c', run], {
          cwd: dir,
          env,
          encoding: 'utf8',
          timeout: EXEC_TIMEOUT_MS,
        });
        // What a later step sees of $GITHUB_ENV (PIN_FILE_SELECTED, BASE_VERSION).
        for (const line of readFileSync(githubEnv, 'utf8').split('\n')) {
          const eq = line.indexOf('=');
          if (eq > 0) env = { ...env, [line.slice(0, eq)]: line.slice(eq + 1) };
        }
      }
      const inherited = JSON.parse(readFileSync(join(dir, 'inherited-pins.json'), 'utf8'));
      const args = [
        CHECK,
        '--changed-files-file',
        join(dir, 'changed-files.txt'),
        '--base-pin-file',
        join(dir, 'base-pin.json'),
        '--head-pin-file',
        join(dir, 'head-pin.json'),
        '--merge-base-pin-file',
        join(dir, 'merge-base-pin.json'),
        '--inherited-pins-file',
        join(dir, 'inherited-pins.json'),
        '--base-version',
        String(env.BASE_VERSION ?? ''),
      ];
      const { GITHUB_STEP_SUMMARY: _drop, ...checkEnv } = process.env;
      const r = spawnSync(process.execPath, args, {
        encoding: 'utf8',
        env: checkEnv,
        timeout: EXEC_TIMEOUT_MS,
      });
      return { status: r.status, stdout: `${r.stdout}${r.stderr}`, inherited };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** main: a live v1.0 window (rcTag set, no marker) and a published package. */
  function seedMain(git: Git, put: Put): void {
    put(PIN, pinWith());
    put(CORE_MANIFEST, JSON.stringify({ name: '@getknext/core', version: '1.0.0' }));
    put(CORE_SRC, 'export const v = 0;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'main: live window');
  }
  /** integration: its own reviewed marker plus a published-bytes change. */
  function seedIntegration(git: Git, put: Put): void {
    git('checkout', '-q', '-b', 'integration', 'main');
    put(PIN, pinWith(MERGED_IN));
    put(CORE_SRC, 'export const v = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'integration: marker + core change');
  }
  /** pr: branched from main, with integration merged in (a real merge commit). */
  function mergeIntegrationIntoPr(git: Git): void {
    git('checkout', '-q', '-b', 'pr', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge integration', 'integration');
  }
  /** pr: branched from main, its OWN commit adds the marker and changes core. */
  function ownMarkerPr(git: Git, put: Put): void {
    git('checkout', '-q', '-b', 'pr', 'main');
    put(PIN, pinWith(OWN));
    put(CORE_SRC, 'export const v = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'own marker + core change');
  }
  const tips = (git: Git, head: string) => ({
    base: git('rev-parse', 'main'),
    head: git('rev-parse', head),
  });
  const MARKER_IGNORED_VIA_MERGE = /inherited from a branch merged into this PR/;
  const PROCEEDED = /does not resolve to a git tag/;
  const EXEMPTED = /introduced by this PR exempts it/;

  it('RED: a merge PR whose only marker came in with the merged branch', () => {
    const r = runScenario((git, put) => {
      seedMain(git, put);
      seedIntegration(git, put);
      mergeIntegrationIntoPr(git);
      return tips(git, 'pr');
    });
    expect(r.inherited).toEqual([{ publishedBytesBumpMarker: MERGED_IN }]);
    expect(r.stdout).toMatch(MARKER_IGNORED_VIA_MERGE);
    expect(r.stdout).toMatch(PROCEEDED);
    expect(r.status).toBe(1);
  }, 60_000);

  it('RED: the merge is buried under a later own commit that leaves the marker alone', () => {
    const r = runScenario((git, put) => {
      seedMain(git, put);
      seedIntegration(git, put);
      mergeIntegrationIntoPr(git);
      put('README.md', 'unrelated\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'own commit after the merge');
      return tips(git, 'pr');
    });
    expect(r.stdout).toMatch(PROCEEDED);
    expect(r.status).toBe(1);
  }, 60_000);

  it('GREEN: a merge PR that adds its OWN fresh marker on top of the merge', () => {
    const r = runScenario((git, put) => {
      seedMain(git, put);
      seedIntegration(git, put);
      mergeIntegrationIntoPr(git);
      put(PIN, pinWith(OWN));
      git('add', '-A');
      git('commit', '-q', '-m', 'own marker for main');
      return tips(git, 'pr');
    });
    expect(r.stdout).toMatch(EXEMPTED);
    expect(r.status).toBe(0);
  }, 60_000);

  it('GREEN: a plain PR whose own commit adds the marker (no merges in range)', () => {
    const r = runScenario((git, put) => {
      seedMain(git, put);
      ownMarkerPr(git, put);
      return tips(git, 'pr');
    });
    expect(r.inherited).toEqual([]);
    expect(r.stdout).toMatch(EXEMPTED);
    expect(r.status).toBe(0);
  }, 60_000);

  it('GREEN: an own-marker PR that later merged its (advanced) base branch — no false red', () => {
    const r = runScenario((git, put) => {
      seedMain(git, put);
      ownMarkerPr(git, put);
      git('checkout', '-q', 'main');
      put('README.md', 'main moved on\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'main advances');
      git('checkout', '-q', 'pr');
      git('merge', '-q', '--no-ff', '-m', 'merge main into pr', 'main');
      return tips(git, 'pr');
    });
    expect(r.stdout).toMatch(EXEMPTED);
    expect(r.status).toBe(0);
  }, 60_000);

  it("GREEN: merge_group — the queue's own merge (base + PR head) does not make the PR's marker inherited", () => {
    const r = runScenario((git, put) => {
      seedMain(git, put);
      ownMarkerPr(git, put);
      git('checkout', '-q', '-b', 'queue', 'main');
      git('merge', '-q', '--no-ff', '-m', 'merge queue: pr', 'pr');
      return tips(git, 'queue');
    }, 'merge_group');
    expect(r.inherited).toEqual([]);
    expect(r.stdout).toMatch(EXEMPTED);
    expect(r.status).toBe(0);
  }, 60_000);

  it('RED: merge_group — a queued PR that merged integration still carries an inherited marker', () => {
    const r = runScenario((git, put) => {
      seedMain(git, put);
      seedIntegration(git, put);
      mergeIntegrationIntoPr(git);
      git('checkout', '-q', '-b', 'queue', 'main');
      git('merge', '-q', '--no-ff', '-m', 'merge queue: pr', 'pr');
      return tips(git, 'queue');
    }, 'merge_group');
    expect(r.inherited).toEqual([{ publishedBytesBumpMarker: MERGED_IN }]);
    expect(r.stdout).toMatch(MARKER_IGNORED_VIA_MERGE);
    expect(r.status).toBe(1);
  }, 60_000);

  it('field-specific: a merged-in rcBumpMarker is not a publishedBytesBumpMarker', () => {
    const r = runScenario((git, put) => {
      seedMain(git, put);
      git('checkout', '-q', '-b', 'integration', 'main');
      put(PIN, JSON.stringify({ rcTag: TAG, rcBumpMarker: OWN }));
      git('add', '-A');
      git('commit', '-q', '-m', 'integration: rc marker only');
      git('checkout', '-q', '-b', 'pr', 'main');
      git('merge', '-q', '--no-ff', '-m', 'merge integration', 'integration');
      put(PIN, pinWith(OWN));
      put(CORE_SRC, 'export const v = 1;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'own marker');
      return tips(git, 'pr');
    });
    expect(r.inherited).toEqual([]);
    expect(r.stdout).toMatch(EXEMPTED);
    expect(r.status).toBe(0);
  }, 60_000);
});
