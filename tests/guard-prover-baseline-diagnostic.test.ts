import { describe, expect, it } from 'bun:test';
import { baselineFailureReport } from '../scripts/lib/guard-prover.mjs';

// A prover that aborted "exits 1 before any mutation" named nothing, so the reason (a
// lane-env-dependent assertion) took a log-dig to find. The abort must surface WHICH
// assertions failed.
describe('guard-prover baseline abort diagnostic', () => {
  it('names the failing tests and the first error lines of the spec output', () => {
    const out = [
      '(pass) a > fine',
      'error: expect(received).toEqual(expected)',
      '(fail) b > pre.json matches the lane [2.21ms]',
      ' 40 pass',
      ' 1 fail',
    ].join('\n');
    const report = baselineFailureReport('tests/x.test.ts', 1, out);
    expect(report).toContain('(fail) b > pre.json matches the lane');
    expect(report).toContain('error: expect(received)');
    expect(report).not.toContain('(pass) a > fine');
    expect(report).toContain('tests/x.test.ts');
  });

  it('falls back to the output tail when no failure marker is recognised', () => {
    const report = baselineFailureReport('s', 2, 'boom\nlast line');
    expect(report).toContain('last line');
  });
});
