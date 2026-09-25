import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  artifactGatedSkipCount,
  CONDITIONAL_FORMS,
  SKIP_FORMS,
  scanSkips,
} from '../scripts/lib/test-skips.mjs';

/**
 * Every skipped test in the repo is DECLARED, with a reason (#927).
 *
 * WHY THIS FILE EXISTS, stated plainly because the history is the argument.
 * Sprint 2 reported a "no self-skipping guard survives" sweep as clean. It was
 * not: the ad-hoc scan behind it globbed the tests directory and the per-package
 * __tests__ directories but neither apps nor examples, and its pattern list
 * omitted `.skipIf` —
 * the form nearly every real skip here uses. It found one file. There were
 * ELEVEN; #932 retired one (node-compile-cache), leaving the ten declared below.
 *
 * The lesson is the one this repo keeps relearning: a sweep whose correctness
 * depends on remembering a directory and a spelling is not a sweep, and its
 * result is a claim rather than a measurement. So the question is now asked by a
 * committed scan over EVERY tracked spec file, and the answer is written down
 * here where changing it requires saying why.
 *
 * WHY A SKIP IS WORTH THIS MUCH CEREMONY. A `skipIf` whose predicate is false in
 * CI reports exactly the same green as a passing test. An artifact-gated skip —
 * one whose predicate vanishes when a BUILD ARTIFACT is absent — therefore
 * asserts nothing and says nothing wherever the artifact was not built. That is
 * the "control that reports success while inert" class sprint 1 named as this
 * project's most common defect, sitting inside the test suite itself.
 *
 * WHAT THIS GUARD ADDS BEYOND COUNTING (#932). Counting keeps the set from
 * growing silently, but it does not stop a NEW artifact-gated skip from being
 * declared with a plausible reason and no lane. So a second describe block below
 * detects artifact-gated skips mechanically (`artifactGatedSkipCount`) and
 * requires each to be either LANE-BACKED — a CI job that BUILDS the artifact and
 * sets a `KNEXT_REQUIRE_*` flag, verified against `ci.yml` — or in a FROZEN,
 * explicitly-reasoned grandfather set. The three sites #932 named are resolved
 * (two retired, one made fail-closed and lane-backed); the one weak site this
 * mechanism surfaced is grandfathered in the open rather than left hidden.
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
  'apps/file-manager/sigterm-drain-e2e.test.ts': {
    skips: { 'it.skipIf': 4 },
    reason:
      'Boots the shipped runtime entry against a real `.next/standalone` mirror, probed inside ' +
      'findStandaloneMirrorRoot(). LANE-BACKED (#932): the sigterm-drain-shipped job builds that ' +
      'standalone tree and sets KNEXT_REQUIRE_STANDALONE=1, so a missing build FAILS the lane ' +
      'rather than vanishing; off the flag (a local checkout) the cases skip.',
  },
  'apps/file-manager/sigterm-hardcap-e2e.test.ts': {
    skips: { 'it.skipIf': 1 },
    reason:
      'Same standalone gate as the drain e2e beside it: findStandaloneMirrorRoot() probes for the ' +
      'built `.next/standalone` mirror. LANE-BACKED (#932) by the sigterm-drain-shipped job, which ' +
      'runs both files with KNEXT_REQUIRE_STANDALONE=1 so a missing build fails rather than skips.',
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
      'Asserts the contract against a REAL .output tree. LANE-BACKED (#932): the skip is now ' +
      'fail-closed under KNEXT_REQUIRE_OUTPUT=1, and the bun-exec-alpine-image lane both sets ' +
      'that flag and builds .output (./build.sh) — so in CI a missing artifact FAILS, it does ' +
      'not vanish. Off the flag (a clean local checkout) the case skips rather than run against ' +
      'a tree that was never built. Wiring guarded by tests/artifact-contract-reality-ci.test.ts.',
  },
  'packages/kn-next/src/__tests__/cli-node-runtime.test.ts': {
    skips: { 'it.skipIf': 2 },
    reason:
      'Needs the tsup-built dist/ bundle to exercise node/bun parity on the shipped artifact. ' +
      'CI builds before running; a source-only checkout has nothing to run.',
  },
  'tests/e2e-native-rebuild-musl.docker-e2e.test.ts': {
    skips: { 'describe.skipIf': 1 },
    reason:
      'ENVIRONMENT-availability gate (docker daemon reachable), not artifact-gated — same class ' +
      'as the bunAvailable pattern this scanner already treats as non-artifact. Executes ' +
      'scripts/e2e-native-rebuild-musl.sh for real inside the pinned oven/bun:1.4.2-alpine image ' +
      '(#1230 round 6: ROOT-escape guard, sharp musl sibling load, --user pid-attribution); needs ' +
      'a working docker on the machine, which every CI runner that boots the bun lane already ' +
      'requires (scripts/e2e-deploy.sh itself refuses to run without docker once RUNTIME=bun).',
  },
  'tests/actionlint-workflow.test.ts': {
    skips: { 'describe.skipIf': 2 },
    reason:
      'ENVIRONMENT-availability gate (actionlint on PATH), not artifact-gated — same class as ' +
      'the dockerAvailable/bunAvailable pattern this scanner already treats as non-artifact ' +
      '(#1397 review). Executes the REAL pinned actionlint binary against a real composite-' +
      "action fixture, so it is not vacuous where actionlint is installed, and the gate's own " +
      'workflow already installs the same pinned binary fresh for the real check on every PR.',
  },
  'packages/kn-next/src/__tests__/compile-cache-health-bun.test.ts': {
    skips: { 'it.skipIf': 3 },
    reason:
      'Runs the compile-cache diagnostic under a REAL bun; the skips gate on bun AVAILABILITY ' +
      '(and its version), not on a build artifact. LANE-BACKED: the compile-cache-bun-probe job ' +
      'sets KNEXT_REQUIRE_BUN=1 (a missing bun then FAILS, never skips) and pins bun 1.4.2, and ' +
      'the file itself asserts that floor so the >=1.4 hardcap-warn case cannot silently skip on ' +
      'a pin downgrade. Wiring guarded by tests/compile-cache-health-bun-ci.test.ts.',
  },
};

/**
 * ARTIFACT-GATED skips that ARE backed by a CI lane (#932).
 *
 * An artifact-gated `skipIf` — one whose predicate vanishes when a BUILD ARTIFACT
 * is absent — reports the same green as a passing test wherever the artifact was
 * not built. `artifactGatedSkipCount` finds them mechanically. Each one listed
 * here names the REQUIRE flag that turns it fail-closed; the guard below then
 * proves, against `ci.yml`, that some job BOTH sets that flag to `1` AND runs the
 * spec — so the flag cannot exist while CI never sets it (#408), and a NEW
 * artifact-gated skip added without such a lane reds here.
 */
const LANE_BACKED: Record<string, { flag: string }> = {
  'packages/kn-next/src/__tests__/artifact-contract-reality.test.ts': {
    flag: 'KNEXT_REQUIRE_OUTPUT',
  },
  // Both gate on a `.next/standalone` mirror probed inside findStandaloneMirrorRoot()
  // — the helper-wrapped idiom the detector now traces one hop into. The
  // sigterm-drain-shipped job builds that standalone tree and sets
  // KNEXT_REQUIRE_STANDALONE=1, so a missing build FAILS the lane rather than
  // vanishing; off the flag (a local checkout) the cases skip.
  'apps/file-manager/sigterm-drain-e2e.test.ts': {
    flag: 'KNEXT_REQUIRE_STANDALONE',
  },
  'apps/file-manager/sigterm-hardcap-e2e.test.ts': {
    flag: 'KNEXT_REQUIRE_STANDALONE',
  },
};

/**
 * Artifact-gated skips with NO lane, grandfathered EXPLICITLY rather than hidden.
 *
 * FROZEN on purpose: a new artifact-gated skip cannot join this set by accident —
 * adding one is a visible, reviewable edit that has to state a reason, which is
 * the whole point. Everything here is a genuinely weak skip (green-by-skip in CI)
 * that this change surfaced but is out of scope to fix.
 */
const GRANDFATHERED_WEAK: Record<string, string> = Object.freeze({});

/**
 * The block of `ci.yml` belonging to the job that runs `testPath`, bounded by the
 * next top-level job key. Used to prove a flag and a test path are co-located in
 * ONE job rather than merely both present somewhere in the workflow.
 */
function jobBlocksContaining(ciYml: string, testPath: string): string[] {
  const jobStart = /\n {2}[a-z][a-z0-9-]*:\n/g;
  const starts = [...ciYml.matchAll(jobStart)].map((m) => m.index ?? 0);
  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const block = ciYml.slice(starts[i], starts[i + 1] ?? ciYml.length);
    if (block.includes(testPath)) blocks.push(block);
  }
  return blocks;
}

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

  it('a WEAK marker survives only where the skip really is weak (grandfathered)', () => {
    // #932 fixed the three it named (fail-closed under a flag, or retired), so
    // none of those still say WEAK. The ONLY declarations allowed to keep the
    // marker are the ones the artifact-gated guard grandfathered — a WEAK marker
    // outliving its fix is the stale-allowlist failure this suite guards against.
    const weakButNotGrandfathered = Object.entries(DECLARED)
      .filter(([f, e]) => /WEAK/.test(e.reason) && !(f in GRANDFATHERED_WEAK))
      .map(([f]) => f);
    expect(
      weakButNotGrandfathered,
      'these declarations say WEAK but are not grandfathered — if the skip was fixed, drop the ' +
        'marker; if it is genuinely weak, register it in GRANDFATHERED_WEAK',
    ).toEqual([]);
  });
});

describe('#932 every artifact-gated skip has a lane, or is explicitly grandfathered', () => {
  const files = specFiles();

  it('detects the artifact-gated skips it is meant to (non-vacuity)', () => {
    // If the detector silently stopped matching, every assertion below would
    // pass by finding nothing. The lane-backed subject is the floor.
    expect(
      artifactGatedSkipCount(
        read('packages/kn-next/src/__tests__/artifact-contract-reality.test.ts'),
      ),
      'the artifact-gated detector no longer sees the lane-backed subject',
    ).toBeGreaterThan(0);
  });

  it('every artifact-gated skip is lane-backed or explicitly grandfathered', () => {
    // THE #932 GUARD. A new artifact-gated skipIf added without a registered
    // lane is neither in LANE_BACKED nor in the frozen GRANDFATHERED_WEAK set,
    // so it reds here — the strengthening over the undeclared/count-drift checks
    // above, which a DECLARED entry alone would satisfy.
    const unregistered: string[] = [];
    for (const f of files) {
      if (artifactGatedSkipCount(read(f)) === 0) continue;
      if (LANE_BACKED[f] || GRANDFATHERED_WEAK[f]) continue;
      unregistered.push(f);
    }
    expect(
      unregistered,
      'these files have an artifact-gated skip (vanishes when a build artifact is absent) with no ' +
        'registered lane. Wire a CI lane that BUILDS the artifact and sets a KNEXT_REQUIRE_* flag, ' +
        'add it to LANE_BACKED — or, if it genuinely cannot run in CI, add it to ' +
        `GRANDFATHERED_WEAK with a reason:\n  ${unregistered.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every LANE_BACKED spec reads its flag AND a CI job sets it beside the test path', () => {
    const ciYml = read('.github/workflows/ci.yml');
    for (const [f, { flag }] of Object.entries(LANE_BACKED)) {
      // The spec must be artifact-gated (else the registration is stale) and
      // must actually READ the flag — a flag the test ignores is decoration.
      expect(
        artifactGatedSkipCount(read(f)),
        `${f} is LANE_BACKED but is no longer artifact-gated — drop it`,
      ).toBeGreaterThan(0);
      expect(
        read(f),
        `${f} never reads ${flag} — the flag would not convert its skip to a failure`,
      ).toContain(flag);

      // BOTH halves in ONE ci.yml job: the flag set to 1, and the test path run.
      const blocks = jobBlocksContaining(ciYml, f);
      expect(blocks.length, `no ci.yml job runs ${f}`).toBeGreaterThan(0);
      const flagRe = new RegExp(`${flag}:\\s*['"]?1['"]?`);
      const wired = blocks.some((b) => flagRe.test(b));
      expect(
        wired,
        `${f} runs in a ci.yml job that does NOT set ${flag}=1 — a missing artifact would skip, not ` +
          'fail (the #408 defect: the flag exists, CI never sets it)',
      ).toBe(true);
    }
  });

  it('every GRANDFATHERED_WEAK entry is a real, still-artifact-gated file with a tracked reason', () => {
    for (const [f, reason] of Object.entries(GRANDFATHERED_WEAK)) {
      expect(files, `${f} is grandfathered but is not a tracked spec file`).toContain(f);
      expect(
        artifactGatedSkipCount(read(f)),
        `${f} is grandfathered as artifact-gated but no longer is — drop it`,
      ).toBeGreaterThan(0);
      expect(reason.length, `${f}: grandfather reason is too thin`).toBeGreaterThan(60);
      expect(reason, `${f} is grandfathered but cites no tracking issue`).toMatch(/#\d+/);
    }
  });
});

describe('#932 the artifact-gated detector traces one function hop', () => {
  it('catches a skip whose predicate resolves to a helper whose BODY probes the filesystem', () => {
    // The repo idiom the inline+variable tracer was blind to: the existsSync is
    // inside a CALLED function, not on the RHS of the traced variable. Both
    // sigterm e2e specs are written exactly this way.
    const src = [
      'import { existsSync } from "node:fs";',
      'function findBuild(): string | null {',
      '  const dir = resolve(APP_DIR, ".next/standalone");',
      '  if (!existsSync(dir)) return null;',
      '  return dir;',
      '}',
      'const root = findBuild();',
      'const skipReason = root !== null ? null : "no standalone build";',
      'it.skipIf(skipReason !== null)("x", () => {});',
    ].join('\n');
    expect(artifactGatedSkipCount(src)).toBe(1);
  });

  it('the two sigterm e2e specs are now DETECTED as artifact-gated (they were scored 0)', () => {
    // The exact files the helper-wrapped blind spot let through. Both are
    // lane-backed via KNEXT_REQUIRE_STANDALONE, so LANE_BACKED keeps the #932
    // guard green for them — this asserts only that the detector now SEES them.
    for (const f of [
      'apps/file-manager/sigterm-drain-e2e.test.ts',
      'apps/file-manager/sigterm-hardcap-e2e.test.ts',
    ]) {
      expect(
        artifactGatedSkipCount(read(f)),
        `${f} is still invisible to the detector`,
      ).toBeGreaterThan(0);
    }
  });

  it('does NOT count a helper that gates on the environment rather than a build artifact', () => {
    // One hop must not over-count: an env/availability helper is a different
    // class with its own lanes, and a build lane must not be demanded for it.
    const src = [
      'function bunAvailable(): boolean { return process.env.BUN === "1"; }',
      'const bun = bunAvailable();',
      'it.skipIf(!bun)("x", () => {});',
    ].join('\n');
    expect(artifactGatedSkipCount(src)).toBe(0);
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
