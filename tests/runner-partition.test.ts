/**
 * Every test file is claimed by EXACTLY ONE runner (#871).
 *
 * During the bun migration the suite is split: a file importing `bun:test`
 * cannot run under vitest, and one importing `vitest` cannot run under bun. Both
 * sides derive their half by reading the files, which removes the hand-maintained
 * list — but it introduces a failure the list never had. If both sides disown a
 * file, nothing fails. The file simply stops running, and the suite stays green.
 *
 * That is not hypothetical. `ts-import-extension-guard.test.ts` builds a FIXTURE
 * containing the string `import vitest from "vitest"`, and both partitions
 * originally scanned raw source: vitest excluded it for importing `bun:test`,
 * the bun runner skipped it for "importing" vitest, and it ran nowhere at all.
 * It had been silently uncovered, and the only reason it surfaced was a
 * hand-count of what remained.
 *
 * So the partition is asserted rather than trusted, in both directions:
 *
 *   - a file claimed by NEITHER runner is lost coverage that nothing else
 *     reports;
 *   - a file claimed by BOTH is a file one runner cannot execute, which fails
 *     loudly — worth catching here anyway, because it means the two rules have
 *     drifted apart.
 *
 * This guard calls the SAME `importsFrom` both runners call. A guard carrying
 * its own copy of the rule passes while the runners disagree with it — which is
 * the shape of the bug it exists for.
 *
 * Neither a raw scan nor a blanked one works, and the second is the subtler
 * trap: `blankNonCode` blanks string CONTENTS, and a module specifier IS a
 * string, so `from "bun:test"` becomes `from "        "` and matches nothing.
 * Applied here that read as "all 333 files are orphaned"; applied to one runner
 * only it would have silently handed the whole suite to the other.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importsFrom } from '../scripts/lib/test-framework-import.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every tracked test file, exactly as both runners enumerate them. */
function testFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

interface Claim {
  file: string;
  bun: boolean;
  vitest: boolean;
}

function claims(): Claim[] {
  return testFiles().map((file) => {
    const src = readFileSync(resolve(repoRoot, file), 'utf8');
    return {
      file,
      bun: importsFrom(src, 'bun:test'),
      vitest: importsFrom(src, 'vitest'),
    };
  });
}

describe('the bun/vitest partition covers every test file (#871)', () => {
  it('finds test files at all — the guard must not pass vacuously', () => {
    expect(testFiles().length).toBeGreaterThan(100);
  });

  it('no test file is claimed by NEITHER runner', () => {
    // The silent case, and the reason this file exists. A file here runs
    // nowhere and nothing else in the suite notices.
    const orphaned = claims()
      .filter((c) => !c.bun && !c.vitest)
      .map((c) => c.file);
    expect(
      orphaned,
      'these import neither `bun:test` nor `vitest`, so no runner collects them ' +
        'and they are silently uncovered',
    ).toEqual([]);
  });

  it('no test file is claimed by BOTH runners', () => {
    // Loud rather than silent — one of the two runners will fail on it — but it
    // means the two derivation rules have drifted, so catch it here where the
    // message says that.
    const contested = claims()
      .filter((c) => c.bun && c.vitest)
      .map((c) => c.file);
    expect(
      contested,
      'these import BOTH test frameworks; whichever runner collects one will fail on it',
    ).toEqual([]);
  });

  it('the derivation rules are read from the runners, not restated here', () => {
    // A guard carrying its own COPY of the rule passes while the runners
    // disagree with it. Assert they CALL the shared helper — not merely that
    // the name appears, which the leftover `import { importsFrom }` line
    // satisfies on its own. A mutation run proved that: reverting the config to
    // a raw regex left this green.
    const vitestConfig = readFileSync(resolve(repoRoot, 'vitest.config.ts'), 'utf8');
    const bunRunner = readFileSync(resolve(repoRoot, 'scripts/bun-test.mjs'), 'utf8');
    for (const [name, src] of [
      ['vitest.config.ts', vitestConfig],
      ['scripts/bun-test.mjs', bunRunner],
    ] as const) {
      expect(
        src,
        `${name} must use the shared \`importsFrom\` rather than its own regex — a raw ` +
          'scan lets a fixture string orphan a test, and a blanked scan never matches ' +
          'at all because a module specifier IS a string',
      ).toMatch(/importsFrom\(\s*readFileSync/);
    }
  });
});
