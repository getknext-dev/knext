import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * `.github/workflows/rust-crates.yml` always reports (#2441), so its summary
 * job can be made a REQUIRED status check.
 *
 * The lane used to be path-filtered at the trigger: a PR that did not touch
 * crates/ never started the workflow, so a required context would hang in
 * "Expected — waiting for status" forever. The shape this file holds:
 *
 *   - `pull_request` and `merge_group` carry NO trigger-level `paths:` (the
 *     workflow must start on every PR and every merge-queue entry; without
 *     `merge_group` the queue freezes on a required context);
 *   - a `changes` job decides whether a crate path changed;
 *   - the heavy `crates` job runs exactly when it did;
 *   - `cargo deny` and the crateRev drift guard run on every event, with no
 *     `if:` (the publish-lane guard requires both to be unconditional);
 *   - one `if: always()` summary job named `rust-crates gate` needs every real
 *     job and fails unless each concluded `success` — the only tolerated
 *     non-success is the heavy job SKIPPED because `changes` reported no crate
 *     change.
 *
 * The gate's verdict is tested by EXECUTING its own run script with each
 * combination of results, not by matching its text.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/rust-crates.yml');
const raw = readFileSync(WORKFLOW, 'utf8');

type Obj = Record<string, unknown>;
const doc = parse(raw) as Obj;
const on = (doc.on ?? (doc as Obj)[true as unknown as string]) as Obj;
const jobs = doc.jobs as Record<string, Obj>;

const GATE_ID = 'gate';
const GATE_NAME = 'rust-crates gate';
/** Every job in the workflow except the gate itself is a real job it must need. */
const realJobIds = Object.keys(jobs).filter((id) => id !== GATE_ID);

const stepsOf = (job: Obj): Obj[] => (Array.isArray(job.steps) ? (job.steps as Obj[]) : []);

describe('rust-crates.yml triggers (#2441)', () => {
  it('triggers on merge_group (a required context with no merge_group run freezes the queue)', () => {
    expect(Object.keys(on)).toContain('merge_group');
  });

  it('pull_request and merge_group start the workflow on EVERY change (no trigger-level path filter)', () => {
    for (const event of ['pull_request', 'merge_group']) {
      const cfg = (on[event] ?? {}) as Obj;
      expect(event in on).toBe(true);
      expect('paths' in cfg).toBe(false);
      expect('paths-ignore' in cfg).toBe(false);
    }
  });

  it('keeps the token read-only: contents: read, nothing else', () => {
    expect(doc.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(jobs)) expect(job.permissions).toBeUndefined();
  });
});

describe('rust-crates.yml summary gate job (#2441)', () => {
  const gate = jobs[GATE_ID] ?? {};

  it(`exists with the stable name "${GATE_NAME}"`, () => {
    expect(jobs[GATE_ID]).toBeDefined();
    expect(gate.name).toBe(GATE_NAME);
  });

  it('always runs (if: always()) so a failed or skipped need still reports', () => {
    expect(String(gate.if).trim()).toBe('always()');
  });

  it('needs every real job in the workflow', () => {
    expect(realJobIds.length).toBeGreaterThanOrEqual(4);
    expect([...(gate.needs as string[])].sort()).toEqual([...realJobIds].sort());
  });

  it('reads every need result it judges', () => {
    const env = (stepsOf(gate)[0]?.env ?? {}) as Obj;
    const values = Object.values(env).map(String);
    for (const id of realJobIds) {
      expect(values).toContain(`\${{ needs.${id}.result }}`);
    }
  });
});

describe('rust-crates.yml real jobs (#2441)', () => {
  it('the heavy crates job runs exactly when changes reported a crate change', () => {
    expect([jobs.crates.needs].flat()).toEqual(['changes']);
    expect(String(jobs.crates.if).trim()).toBe("needs.changes.outputs.crates == 'true'");
  });

  it('cargo deny runs over crates/ in a job with no if:, in a step with no if: and no continue-on-error', () => {
    const denyJobs = Object.values(jobs).filter((j) =>
      stepsOf(j).some((s) => /\bcargo deny check\b/.test(String(s.run ?? ''))),
    );
    expect(denyJobs.length).toBe(1);
    const deny = denyJobs[0];
    expect(deny.if).toBeUndefined();
    expect(deny.needs).toBeUndefined();
    expect((deny.defaults as Obj | undefined)?.run).toEqual({ 'working-directory': 'crates' });
    for (const s of stepsOf(deny)) {
      expect(s.if).toBeUndefined();
      expect(s['continue-on-error']).toBeUndefined();
    }
  });

  it('the crateRev drift guard job has no if: and no needs', () => {
    expect(jobs['crate-rev'].if).toBeUndefined();
    expect(jobs['crate-rev'].needs).toBeUndefined();
  });

  it('changes is path-scoped on pull_request and merge_group, and always relevant on (trigger-filtered) push', () => {
    const changes = jobs.changes;
    const output = String((changes.outputs as Obj).crates);
    expect(output).toContain("github.event_name == 'push'");
    const filter = stepsOf(changes).find((s) =>
      String(s.uses ?? '').startsWith('dorny/paths-filter@'),
    );
    expect(filter).toBeDefined();
    expect(String(filter?.uses)).toMatch(/^dorny\/paths-filter@[0-9a-f]{40}$/);
    const filters = String((filter?.with as Obj).filters);
    for (const p of [
      'crates/**',
      'packages/ffi/package.json',
      '.github/workflows/rust-crates.yml',
    ]) {
      expect(filters).toContain(`'${p}'`);
    }
  });
});

describe('rust-crates.yml gate verdict — the run script, executed (#2441)', () => {
  const step = stepsOf(jobs[GATE_ID] ?? {})[0] ?? {};
  const script = String(step.run ?? 'exit 99');

  const verdict = (crates: string, results: Partial<Record<string, string>>): number => {
    const all: Record<string, string> = {
      changes: 'success',
      crates: 'success',
      deny: 'success',
      'crate-rev': 'success',
      ...results,
    };
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      CRATES_CHANGED: crates,
    };
    for (const [id, result] of Object.entries(all)) {
      env[`RESULT_${id.toUpperCase().replace(/-/g, '_')}`] = result;
    }
    return spawnSync('bash', ['-c', script], { env, encoding: 'utf8' }).status ?? -1;
  };

  it('passes when nothing under the crate paths changed and the heavy job skipped', () => {
    expect(verdict('false', { crates: 'skipped' })).toBe(0);
  });

  it('passes when crates changed and every real job succeeded', () => {
    expect(verdict('true', {})).toBe(0);
  });

  for (const bad of ['failure', 'cancelled', 'skipped']) {
    it(`fails when crates changed and the heavy job is ${bad}`, () => {
      expect(verdict('true', { crates: bad })).not.toBe(0);
    });

    for (const id of ['deny', 'crate-rev', 'changes']) {
      it(`fails when ${id} is ${bad}, even with no crate change`, () => {
        expect(verdict('false', { crates: 'skipped', [id]: bad })).not.toBe(0);
      });
    }
  }

  it('judges changes on its own: a non-success changes fails even beside a successful crates job', () => {
    expect(verdict('true', { changes: 'failure' })).not.toBe(0);
  });

  it('fails closed when changes produced no answer (empty output)', () => {
    expect(verdict('', { crates: 'skipped' })).not.toBe(0);
  });

  it('a heavy job failure is not excused by "no crate change"', () => {
    expect(verdict('false', { crates: 'failure' })).not.toBe(0);
  });
});

/**
 * merge_group carries no GITHUB_BASE_REF (#2441 round 2). The crateRev guard
 * used to reach `fail(2, 'no base ref')` there, so the required gate went red on
 * every queue run. The step now hands the guard the queue's base commit. These
 * cases render the step's OWN `env:` against a simulated merge_group context and
 * run the REAL guard script with it in a throwaway repo — so dropping the env
 * line turns them red (exit 2), not just a text match.
 */
type Ctx = Record<string, unknown>;

/** Evaluates the only shapes this workflow uses: `${{ a.b.c }}` and `${{ a.b || c.d }}`. */
function renderExpr(value: unknown, ctx: Ctx): string {
  const text = String(value);
  const m = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(text);
  if (!m) return text;
  for (const term of m[1].split('||').map((t) => t.trim())) {
    if (!/^[a-z_][\w.-]*$/i.test(term)) throw new Error(`unsupported expression term: ${term}`);
    let cur: unknown = ctx;
    for (const key of term.split('.')) cur = (cur as Ctx | undefined)?.[key];
    if (cur) return String(cur);
  }
  return '';
}

const mergeGroupCtx = (baseSha: string): Ctx => ({
  github: {
    event_name: 'merge_group',
    base_ref: '',
    event: { merge_group: { base_sha: baseSha, head_sha: 'f'.repeat(40) } },
  },
});

describe('rust-crates.yml on merge_group — base resolution (#2441)', () => {
  const crateRevStep = stepsOf(jobs['crate-rev'] ?? {}).find((s) =>
    /check-ffi-crate-rev\.mjs/.test(String(s.run ?? '')),
  );
  const stepEnv = (ctx: Ctx): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries((crateRevStep?.env ?? {}) as Obj)) {
      out[k] = renderExpr(v, ctx);
    }
    return out;
  };

  const temps: string[] = [];
  afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  });

  const sh = (dir: string, ...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  const put = (dir: string, rel: string, body: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  const commit = (dir: string, msg: string) => {
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '--no-gpg-sign', '-qm', msg);
    return sh(dir, 'rev-parse', 'HEAD');
  };

  /**
   * A queue-shaped repo: `main` (the queue base) has the crates pinned; when
   * `unpinnedOnBase`, a later crate change lands on main WITHOUT a pin bump.
   * HEAD is the queue entry: one unrelated commit on top of the base.
   */
  const queueRepo = (unpinnedOnBase: boolean): { dir: string; baseSha: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'rust-crates-merge-group-'));
    temps.push(dir);
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 'test@example.com');
    sh(dir, 'config', 'user.name', 'test');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    cpSync(
      resolve(REPO_ROOT, 'scripts/check-ffi-crate-rev.mjs'),
      join(dir, 'scripts/check-ffi-crate-rev.mjs'),
    );
    put(dir, 'crates/knext-ffi/src/wire.rs', '// v1\n');
    put(dir, 'crates/knext-ffi-macros/src/lib.rs', '// v1\n');
    const pinned = commit(dir, 'crates v1');
    put(
      dir,
      'packages/ffi/package.json',
      `${JSON.stringify({ name: '@getknext/ffi', knextFfi: { crateRev: pinned } })}\n`,
    );
    commit(dir, 'pin crates v1');
    if (unpinnedOnBase) {
      put(dir, 'crates/knext-ffi/src/wire.rs', '// v2\n');
      commit(dir, 'crate change merged without a bump');
    }
    const baseSha = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'switch', '-qc', 'gh-readonly-queue/main/pr-1');
    put(dir, 'README.md', 'queued change\n');
    commit(dir, 'queued PR');
    return { dir, baseSha };
  };

  const runGuard = (dir: string, baseSha: string) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(GITHUB_|FFI_CRATE_REV_)/.test(k)) env[k] = v;
    }
    Object.assign(env, { GITHUB_EVENT_NAME: 'merge_group', GITHUB_BASE_REF: '' });
    Object.assign(env, stepEnv(mergeGroupCtx(baseSha)));
    const res = spawnSync('node', ['scripts/check-ffi-crate-rev.mjs'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  };

  it('the drift guard step exists', () => {
    expect(crateRevStep).toBeDefined();
  });

  it('the guard passes on a merge_group run when nothing drifted (empty GITHUB_BASE_REF, base SHA from the event)', () => {
    const { dir, baseSha } = queueRepo(false);
    const { status, out } = runGuard(dir, baseSha);
    expect(status, out).toBe(0);
    expect(out).toContain(baseSha);
  });

  it('the guard fails (exit 1, not 2) on a merge_group run when the crate rev is wrong', () => {
    const { dir, baseSha } = queueRepo(true);
    const { status, out } = runGuard(dir, baseSha);
    expect(status, out).toBe(1);
    expect(out).toContain('crates/knext-ffi/src/wire.rs');
  });

  it('on pull_request the step env is empty, so the guard keeps its origin/$GITHUB_BASE_REF fallback', () => {
    const prCtx: Ctx = {
      github: {
        event_name: 'pull_request',
        event: { pull_request: { base: { sha: 'a'.repeat(40) } } },
      },
    };
    for (const v of Object.values(stepEnv(prCtx))) expect(v).toBe('');
  });

  it('changes diffs a merge_group entry against the queue base commit, and a PR against its base', () => {
    const filter = stepsOf(jobs.changes).find((s) =>
      String(s.uses ?? '').startsWith('dorny/paths-filter@'),
    );
    const base = (filter?.with as Obj | undefined)?.base;
    expect(renderExpr(base, mergeGroupCtx('b'.repeat(40)))).toBe('b'.repeat(40));
    const prCtx: Ctx = { github: { event: { pull_request: { base: { sha: 'a'.repeat(40) } } } } };
    expect(renderExpr(base, prCtx)).toBe('a'.repeat(40));
  });
});
