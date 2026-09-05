import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONDITIONAL_FORMS, SKIP_FORMS, scanSkips } from '../scripts/lib/test-skips.mjs';

/**
 * Every skipped test in the repo is DECLARED, with a reason (#927).
 *
 * WHY THIS FILE EXISTS, stated plainly because the history is the argument.
 * Sprint 2 reported a "no self-skipping guard survives" sweep as clean. It was
 * not: the ad-hoc scan behind it globbed the tests directory and the per-package
 * __tests__ directories but neither apps nor examples, and its pattern list
 * omitted `.skipIf` —
 * the form nearly every real skip here uses. It found one file. There are
 * ELEVEN.
 *
 * The lesson is the one this repo keeps relearning: a sweep whose correctness
 * depends on remembering a directory and a spelling is not a sweep, and its
 * result is a claim rather than a measurement. So the question is now asked by a
 * committed scan over EVERY tracked spec file, and the answer is written down
 * here where changing it requires saying why.
 *
 * WHY A SKIP IS WORTH THIS MUCH CEREMONY. A `skipIf` whose predicate is false in
 * CI reports exactly the same green as a passing test. Two sites below vanish
 * when a build artifact is missing — `artifact-contract-reality` and
 * `compile-cache-health-bun` — so on any machine that did not build the artifact
 * they assert nothing and say nothing. That is the "control that reports success
 * while inert" class sprint 1 named as this project's most common defect, and it
 * is sitting inside the test suite itself.
 *
 * WHAT THIS GUARD DOES **NOT** CLAIM. It does not claim the skips below are all
 * fine — `artifact-contract-reality` and the compile-cache trio are flagged in
 * their own entries as genuinely weak, and #932 tracks them. It claims only that
 * the set is known, counted, and cannot grow silently. That is a smaller claim
 * than "no self-skipping guard survives", and it is the one that is true.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * The declared skips: path -> { form -> count } plus a reason.
 *
 * COUNTS ARE EXACT, deliberately. A range would let a twelfth skip appear in an
 * already-declared file without anyone noticing, which is most of how this set
 * grew to eleven files unobserved in the first place.
 */
const DECLARED: Record<string, { skips: Record<string, number>; reason: string }> = {
  'apps/file-manager/bun-portability.test.ts': {
    skips: { 'it.skipIf': 2 },
    reason:
      'Boots the standalone server under a real bun binary; skipped where bun is absent from ' +
      'PATH. CI installs bun for this lane, so the predicate is true where it counts.',
  },
  'apps/file-manager/node-compile-cache.test.ts': {
    skips: { 'it.skipIf': 1 },
    reason:
      'Requires a built .next tree. WEAK: silently vanishes on a machine that has not built, ' +
      'so a green run here is not evidence the assertion ran. Tracked by #932.',
  },
  'apps/file-manager/sigterm-drain-e2e.test.ts': {
    skips: { 'it.skipIf': 4 },
    reason:
      'Container e2e — needs docker and a built image. Gated so a laptop run does not fail on ' +
      'a missing daemon; the alpine e2e lane runs it for real.',
  },
  'apps/file-manager/sigterm-hardcap-e2e.test.ts': {
    skips: { 'it.skipIf': 1 },
    reason:
      'Same docker gate as the drain e2e beside it: needs a container runtime and a built ' +
      'image, so it is gated rather than failing on a machine without a daemon.',
  },
  'examples/bun-exec/test/request-byte-cap.test.ts': {
    skips: { 'describe.skipIf': 1 },
    reason:
      'Needs the compiled single executable. The byte-cap lane builds it; elsewhere the suite ' +
      'has nothing to exercise.',
  },
  'examples/bun-exec/test/runtime-contract.test.ts': {
    skips: { 'describe.skipIf': 2 },
    reason:
      'Needs the compiled single executable, as above. The byte-cap and vinext lanes build it; ' +
      'a plain checkout has no binary for the contract assertions to run against.',
  },
  'examples/bun-exec/test/sigterm-hardcap-e2e.test.ts': {
    skips: { 'describe.skipIf': 1 },
    reason:
      'Needs the compiled single executable AND a container runtime — the hardcap is only ' +
      'observable on a real SIGTERM to a real container, which a host run cannot stage.',
  },
  'packages/db/src/__tests__/integration/live-postgres.test.ts': {
    skips: { 'describe.skipIf': 2, 'describe.skip': 1 },
    reason:
      'Two env-gated live-Postgres lanes (LIVE), plus ONE UNCONDITIONAL describe.skip: the ' +
      'pgvector hnsw() block, gated on scale-zero-pg#178 per ADR-0021 decision 4 and kept ' +
      'compiling so flipping the gate later needs no rewrite. The unconditional one is the ' +
      'only permanently-off block in the repo and is declared here so it stays visible.',
  },
  'packages/kn-next/src/__tests__/artifact-contract-reality.test.ts': {
    skips: { 'it.skipIf': 1 },
    reason:
      'Asserts the contract against a REAL .output tree. WEAK: `it.skipIf(!existsSync(...))` ' +
      'means the whole point of the file evaporates wherever the sample was not built, and ' +
      'nothing reports that it did. Tracked by #932.',
  },
  'packages/kn-next/src/__tests__/cli-node-runtime.test.ts': {
    skips: { 'it.skipIf': 2 },
    reason:
      'Needs the tsup-built dist/ bundle to exercise node/bun parity on the shipped artifact. ' +
      'CI builds before running; a source-only checkout has nothing to run.',
  },
  'packages/kn-next/src/__tests__/compile-cache-health-bun.test.ts': {
    skips: { 'it.skipIf': 3 },
    reason:
      'Requires a real bun and a warmed cache dir. WEAK for the same reason as the two above. ' +
      'Tracked by #932.',
  },
};

const specFiles = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((f) => /\.(test|spec)\.(ts|tsx|mjs)$/.test(f))
    .sort();

const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

describe('#927 every skipped test is declared', () => {
  const files = specFiles();

  it('finds a real corpus of spec files (non-vacuity)', () => {
    // The original sweep's actual bug was a glob that matched too little and
    // then reported clean. A floor here makes that specific failure loud.
    expect(files.length).toBeGreaterThan(300);
  });

  it('the scan reaches apps/ and examples/ — the directories the first sweep missed', () => {
    // Named explicitly rather than left to the glob, because "the glob covers
    // everything" is exactly what was believed last time.
    expect(files.some((f) => f.startsWith('apps/'))).toBe(true);
    expect(files.some((f) => f.startsWith('examples/'))).toBe(true);
    expect(files.some((f) => f.startsWith('packages/'))).toBe(true);
    expect(files.some((f) => f.startsWith('tests/'))).toBe(true);
  });

  it('no spec file skips without a declaration', () => {
    const undeclared: string[] = [];
    for (const f of files) {
      const counts = scanSkips(read(f));
      if (Object.keys(counts).length === 0) continue;
      if (!DECLARED[f]) undeclared.push(`${f}: ${JSON.stringify(counts)}`);
    }
    expect(
      undeclared,
      'these files skip tests and are not declared in DECLARED — add an entry saying why, or ' +
        `remove the skip:\n  ${undeclared.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every declaration matches the file EXACTLY (a new skip in a known file reds)', () => {
    const drift: string[] = [];
    for (const [f, entry] of Object.entries(DECLARED)) {
      const actual = scanSkips(read(f));
      if (JSON.stringify(actual) !== JSON.stringify(entry.skips)) {
        drift.push(
          `${f}: declared ${JSON.stringify(entry.skips)}, found ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(drift, drift.join('\n  ')).toEqual([]);
  });

  it('every declaration points at a file that still exists and still skips', () => {
    // Fail closed the other way: a declaration for a file that stopped skipping
    // is stale text, and stale text in an allowlist is how a carve-out outlives
    // its reason.
    for (const f of Object.keys(DECLARED)) {
      expect(files, `${f} is declared but is not a tracked spec file`).toContain(f);
      expect(
        Object.keys(scanSkips(read(f))).length,
        `${f} no longer skips anything — drop its declaration`,
      ).toBeGreaterThan(0);
    }
  });

  it('every declaration carries a substantive reason', () => {
    for (const [f, entry] of Object.entries(DECLARED)) {
      expect(entry.reason.length, `${f}: reason is too thin to be one`).toBeGreaterThan(60);
    }
  });

  it('the WEAK skips are named as weak and tracked', () => {
    // The honest part. Three sites vanish when a build artifact is absent and
    // report the same green as a passing test. Declaring them is not endorsing
    // them, and the distinction is asserted rather than left to the prose.
    const weak = Object.entries(DECLARED).filter(([, e]) => /WEAK/.test(e.reason));
    expect(weak.length).toBeGreaterThan(0);
    for (const [f, e] of weak) {
      expect(e.reason, `${f} is marked WEAK but cites no tracking issue`).toMatch(/#\d+/);
    }
  });
});

describe('#927 the skip scanner itself', () => {
  it('counts skipIf separately from skip (the spelling the first sweep missed)', () => {
    expect(scanSkips('it.skipIf(cond)("x", () => {});')).toEqual({ 'it.skipIf': 1 });
    expect(scanSkips('it.skip("x", () => {});')).toEqual({ 'it.skip': 1 });
  });

  it('a COMMENT mentioning it.skip is not a skip', () => {
    // Several files discuss skips in prose, including this one's subjects. A
    // scanner that could not tell the difference would have to be weakened.
    expect(scanSkips('// we removed the it.skip( here\nconst a = 1;')).toEqual({});
  });

  it('covers every form the repo could use', () => {
    // Non-vacuity for the form list itself: dropping a form from SKIP_FORMS
    // would silently stop counting it, which is the original bug exactly.
    expect(SKIP_FORMS).toContain('it.skipIf');
    expect(SKIP_FORMS).toContain('describe.skip');
    expect(SKIP_FORMS).toContain('it.todo');
    expect(CONDITIONAL_FORMS.every((f) => f.endsWith('.skipIf'))).toBe(true);
  });
});
