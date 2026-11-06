import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The jev-hook mutation proof is sharded in CI (`safety-hook-mutation-proof`) because one job
 * could not finish it on the macOS leg. A shard split is only sound if the shards TOGETHER are
 * exactly the smoke set: a matrix that drops a shard, or a total that disagrees with the matrix,
 * silently stops proving mutants while the job stays green.
 */
const ROOT = resolve(import.meta.dir, '..');
const PROVER = resolve(ROOT, '.claude/hooks/jev-hooks-mutation-proof.py');
const CI = parse(readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<
    string,
    {
      strategy?: { matrix?: { os?: string[]; shard?: number[] } };
      steps?: { run?: string }[];
    }
  >;
};

function list(...args: string[]): string[] {
  const r = spawnSync('python3', ['-I', PROVER, '--list', ...args], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\n').filter(Boolean);
}

describe('jev-hook mutation-proof shards', () => {
  const job = CI.jobs['safety-hook-mutation-proof'];
  const run = (job?.steps ?? []).map((s) => s.run ?? '').join('\n');
  const total = Number(/--shard "\$\{\{ matrix\.shard \}\}\/(\d+)"/.exec(run)?.[1]);

  it('the CI job exists, runs on both platforms, and passes --smoke --shard i/N', () => {
    expect(job, 'safety-hook-mutation-proof job is missing').toBeDefined();
    expect(job.strategy?.matrix?.os).toEqual(['ubuntu-latest', 'macos-latest']);
    expect(run).toContain('jev-hooks-mutation-proof.py --smoke --shard');
    expect(Number.isInteger(total) && total > 1, 'no /N total in the --shard argument').toBe(true);
  });

  it('the matrix runs every shard 1..N exactly once (no dropped shard)', () => {
    const shards = job.strategy?.matrix?.shard ?? [];
    expect([...shards].sort((a, b) => a - b)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
  });

  it('the shards are disjoint and their union is exactly the smoke set', () => {
    const all = list('--smoke');
    expect(all.length).toBeGreaterThan(total); // non-vacuous: every shard has work
    const slices = Array.from({ length: total }, (_, i) =>
      list('--smoke', '--shard', `${i + 1}/${total}`),
    );
    for (const s of slices) expect(s.length).toBeGreaterThan(0);
    const union = slices.flat();
    expect(union.length).toBe(all.length); // disjoint (no mutant counted twice)
    expect(new Set(union)).toEqual(new Set(all)); // complete (none dropped)
  });

  it('a malformed or out-of-range --shard aborts instead of running an empty slice', () => {
    for (const spec of ['0/3', '4/3', 'x', '2']) {
      const r = spawnSync('python3', ['-I', PROVER, '--smoke', '--list', '--shard', spec], {
        encoding: 'utf8',
      });
      expect(r.status, `--shard ${spec} must abort`).not.toBe(0);
    }
  });

  it('the old combined step no longer runs the prover inside safety-hook-guard', () => {
    const guard = (CI.jobs['safety-hook-guard']?.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(guard).not.toContain('jev-hooks-mutation-proof.py');
    expect(guard).toContain('jev-hooks.test.sh'); // the suites themselves still gate it
    expect(guard).toContain('pr-risk.test.sh');
  });
});
