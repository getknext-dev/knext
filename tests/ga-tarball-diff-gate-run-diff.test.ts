import { afterEach, describe, expect, it, mock } from 'bun:test';
import { requireIsolatedProcess } from './helpers/require-isolated-process';

/**
 * GUARD TESTS for `scripts/ga-tarball-diff-gate.mjs`'s `defaultRunDiff` —
 * specifically the two branches nothing exercised before (#1622, #1639):
 *
 *   - `result.error` set (the child process could not even be spawned, e.g.
 *     ENOENT) — must re-throw that exact error.
 *   - `result.status === null` (the child was terminated by a signal, not a
 *     normal exit) — must throw an Error naming the signal.
 *
 * `tests/ga-tarball-diff-gate.test.ts` covers `main()`'s outcomes via an
 * INJECTED `runDiff`, which never exercises `defaultRunDiff` itself —
 * `defaultRunDiff` hardcodes `spawnSync` from `node:child_process` and takes
 * no injection point of its own, so the only way to reach these branches is
 * to mock the module `defaultRunDiff` imports from, before importing the
 * script under test.
 *
 * A SEPARATE FILE, not added to `tests/ga-tarball-diff-gate.test.ts`: bun's
 * `mock.module` is process-global and cannot be unregistered (see
 * `tests/helpers/require-isolated-process.ts`, #965). `scripts/bun-test.mjs`
 * already isolates one process per file, so this alone is not strictly
 * necessary for safety — but `requireIsolatedProcess` is called anyway, as a
 * loud guard against this file ever being batched ad hoc with another spec
 * outside the suite-of-record runner.
 */
requireIsolatedProcess('tests/ga-tarball-diff-gate-run-diff.test.ts');

const spawnSyncResult: {
  value: {
    error?: Error;
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  };
} = {
  value: { status: 0, signal: null, stdout: '', stderr: '' },
};

mock.module('node:child_process', () => ({
  spawnSync: () => spawnSyncResult.value,
  // `defaultRunDiff` is the only export under test here; `execFileSync` is
  // not called by it, so a real one is never needed by this file.
  execFileSync: () => {
    throw new Error('execFileSync is not expected to be called by defaultRunDiff');
  },
}));

const { defaultRunDiff } = await import('../scripts/ga-tarball-diff-gate.mjs');

afterEach(() => {
  spawnSyncResult.value = { status: 0, signal: null, stdout: '', stderr: '' };
});

describe('defaultRunDiff — spawnSync could not even start the child (#1622, #1639)', () => {
  it("re-throws spawnSync's own `.error` verbatim, never swallowing it", () => {
    const spawnError = Object.assign(new Error('spawnSync node ENOENT'), { code: 'ENOENT' });
    spawnSyncResult.value = {
      error: spawnError,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
    };
    expect(() => defaultRunDiff(['--rc-ref', 'v1.0.0-rc.1', '--ga-ref', 'HEAD'])).toThrow(
      spawnError,
    );
  });
});

describe('defaultRunDiff — the child was terminated by a signal, not a normal exit (#1622, #1639)', () => {
  it('throws, naming the signal, rather than returning a null/undefined status', () => {
    spawnSyncResult.value = { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
    expect(() => defaultRunDiff(['--rc-ref', 'v1.0.0-rc.1', '--ga-ref', 'HEAD'])).toThrow(
      /terminated by signal SIGTERM/,
    );
  });

  it('the message names the ACTUAL signal, not a hardcoded one (SIGKILL case)', () => {
    spawnSyncResult.value = { status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
    expect(() => defaultRunDiff(['--rc-ref', 'v1.0.0-rc.1', '--ga-ref', 'HEAD'])).toThrow(
      /terminated by signal SIGKILL/,
    );
  });
});

describe('defaultRunDiff — the ordinary exit path still works with the module mocked', () => {
  it("returns the child's exit status when there is no error and no signal", () => {
    spawnSyncResult.value = { status: 1, signal: null, stdout: '', stderr: '' };
    expect(defaultRunDiff(['--rc-ref', 'v1.0.0-rc.1', '--ga-ref', 'HEAD'])).toBe(1);
  });
});
