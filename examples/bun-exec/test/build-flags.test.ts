import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADR-0042 Consequence 12 / A12 were DISCHARGED on 2026-08-17 by a measurement
// whose entire subject is three flags: `--compile --minify --bytecode`
// (docs/benchmarks/bun-exec-bytecode-coverage.md). Dropping `--bytecode` from
// build.sh would silently invalidate a discharged Phase 5 gate and NOTHING would
// go red -- the alpine-image e2e proves the binary RUNS and that the app is
// EMBEDDED, neither of which needs bytecode. That is the "guard stays green when
// its subject is removed" defect this repo keeps re-finding, so it gets a guard.
//
// TWO HALVES, deliberately:
//
//   1. The flags are actually PASSED. Asserted against `./build.sh
//      --print-labels` OUTPUT, not against the file's text -- that output is
//      printed from `BUN_BUILD_CMD`, the same array `build.sh` execs, so a
//      regression cannot hide behind a stale comment or an unused variable.
//   2. The flags come from ONE place. `build.sh`'s header claims "the label value
//      and the command that actually runs are ONE array, built once ... a
//      hand-copied string would be free to drift". Half 1 alone cannot see a
//      second copy appearing, and a second copy is exactly how half 1 starts
//      passing while the build stops carrying the flag.
//
// Mutation-proof (both halves, run before commit):
//   - delete ` --bytecode` from BUN_BUILD_CMD  -> half 1 reds
//   - add a second literal `--bytecode` anywhere in build.sh -> half 2 reds

const EXAMPLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every flag the measurement's conclusions are conditional on. `--compile` is
// here too: without it there is no binary, no embedding, and `--bytecode` is a
// no-op -- ADR-0042 Decision 2 makes it non-optional ("`node + vinext` is
// explicitly not a supported cell").
const REQUIRED_FLAGS = ['--compile', '--minify', '--bytecode'] as const;

function printLabels(): Map<string, string> {
  const res = spawnSync('./build.sh', ['--print-labels', 'linux-x64'], {
    cwd: EXAMPLE_DIR,
    encoding: 'utf8',
    timeout: 60_000,
  });
  // A build.sh that cannot even print its labels is a failure, never a skip:
  // a guard that goes green when it cannot evaluate its subject is worse than
  // no guard (security.md's "unreachable is a FAILURE, never a pass").
  expect(
    res.status,
    `./build.sh --print-labels failed (${res.status}): ${res.stderr || res.error?.message}`,
  ).toBe(0);

  const labels = new Map<string, string>();
  for (const line of res.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) labels.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return labels;
}

describe('bun-exec build flags (ADR-0042 A12)', () => {
  it('passes --compile --minify --bytecode, read from the array that runs the build', () => {
    const command = printLabels().get('dev.knext.build.command');
    expect(command, 'build.sh emitted no dev.knext.build.command label').toBeTruthy();
    for (const flag of REQUIRED_FLAGS) {
      expect(
        command,
        `ADR-0042's A12 discharge is measured on \`${flag}\`; build.sh no longer passes it. ` +
          'Either restore the flag, or re-open A12 and re-run ' +
          'docs/benchmarks/bun-exec-bytecode-coverage.md — the recorded +6.06 MB payload and 19 ms ' +
          'figures do not describe this build any more.',
      ).toContain(flag);
    }
  });

  it('stamps the label from the SAME array it execs — exactly one literal per flag', () => {
    const script = readFileSync(resolve(EXAMPLE_DIR, 'build.sh'), 'utf8');
    // Comments are stripped first: build.sh documents its own flags at length,
    // and counting those occurrences would make this assertion meaningless.
    const code = script
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    for (const flag of REQUIRED_FLAGS) {
      const occurrences = code.split(flag).length - 1;
      // The two failure directions mean opposite things, and a message naming
      // only one misdiagnoses the other. Found BY the mutation proof: removing
      // the flag drops the count to 0, and this assertion then reported that as
      // "a second occurrence".
      const why =
        occurrences === 0
          ? "the flag is GONE from the script's code entirely — see the sibling assertion, " +
            'which reads the label the build actually stamps.'
          : 'the stamped label and the executed command are no longer one array, so the ' +
            'provenance label can report flags the build does not use.';
      expect(
        occurrences,
        `\`${flag}\` occurs ${occurrences}× in build.sh's code (want exactly 1): ${why}`,
      ).toBe(1);
    }
  });

  it('records the target and bun version alongside, so a figure can be re-attributed', () => {
    const labels = printLabels();
    expect(labels.get('dev.knext.build.target')).toBe('bun-linux-x64-musl');
    expect(labels.get('dev.knext.build.bun-version'), 'bun version not stamped').toMatch(
      /^\d+\.\d+\.\d+/,
    );
    expect(labels.get('dev.knext.app.id'), 'app id not stamped').toMatch(/\S/);
  });
});
