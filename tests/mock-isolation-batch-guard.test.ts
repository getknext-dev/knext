import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { BUN_BIN } from './helpers/runtime-binaries';

/**
 * #965: the six specs that pollute each other across one `bun test` process must
 * fail LOUD, naming the per-file runner — never with a phantom assertion buried
 * in an innocent sibling.
 *
 * This runs under bun (it imports `bun:test`, so vitest never collects it), and
 * spawns a NESTED `bun test` over the exact six-file batch #965 names. The batch
 * is expected to abort with the isolation banner and a non-zero exit.
 */

const REPO_ROOT = resolve(import.meta.dir, '..');

const BATCH = [
  'packages/kn-next/src/__tests__/build-run.test.ts',
  'packages/kn-next/src/__tests__/gc-build-no-storage.test.ts',
  'packages/kn-next/src/__tests__/artifact-contract-reality.test.ts',
  'packages/kn-next/src/__tests__/build-runtime-combination-coverage.test.ts',
  'tests/request-byte-cap.test.ts',
  'tests/mutation-prover-lane.test.ts',
].map((f) => resolve(REPO_ROOT, f));

describe('#965 cross-file mock pollution guard', () => {
  test('the named six-file batch aborts with a message pointing at the runner', () => {
    if (BUN_BIN === undefined) {
      throw new Error('no bun binary to spawn the batch with — cannot verify #965');
    }

    let output = '';
    let exitCode = 0;
    try {
      output = execFileSync(BUN_BIN, ['test', ...BATCH], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? 1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    // The batch must fail loud — never a silent green that hides the pollution.
    expect(exitCode).not.toBe(0);
    // ...and the failure must NAME the runner, not present a phantom assertion.
    expect(output).toContain('CROSS-FILE MOCK POLLUTION');
    expect(output).toContain('scripts/bun-test.mjs');
  });
});
