import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADR-0042's A12 / Escalation 2' was discharged on a measurement whose subject is
// ONE command: `bun build --compile --minify --bytecode … .output/server/index.mjs`
// (docs/adr/gates/adr-0042-gates.json phase 3d; prose in
// docs/benchmarks/bun-exec-bytecode-coverage.md). Change any part of it and the
// discharge stops describing the artifact — while the alpine-image e2e stays
// green, because it proves the binary RUNS, which needs none of these.
//
// THE ENTRY IS AS LOAD-BEARING AS THE FLAGS, and a first version of this file
// guarded only the flags. The whole embedding argument is ENTRY-determined:
// `.output/server/index.mjs` reaches the app through a LITERAL specifier
// (import('./_chunks/ssr-renderer.mjs')), which bun's bundler follows and embeds;
// beta.4's `prod-server.js` import()s a COMPUTED path, which is unbundleable, and
// that is the shape #658 measured when it concluded the app is NOT in the binary.
// Swap the entry and all three flags remain, the label stays truthful, and A12's
// refuted premise becomes TRUE again. Caught by the system-designer gate.

const EXAMPLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATES = resolve(EXAMPLE_DIR, '../../docs/adr/gates/adr-0042-gates.json');

/**
 * Every token the recorded measurements are conditional on. `--compile` is here
 * because without it there is no binary, no embedding, and `--bytecode` is a
 * no-op — ADR-0042 Decision 2 makes it non-optional.
 */
const REQUIRED_TOKENS = [
  '--compile',
  '--minify',
  '--bytecode',
  '.output/server/index.mjs',
] as const;

function printLabels(): Map<string, string> {
  const res = spawnSync('./build.sh', ['--print-labels', 'linux-x64'], {
    cwd: EXAMPLE_DIR,
    encoding: 'utf8',
    timeout: 60_000,
  });
  // A build.sh that cannot print its labels is a failure, never a skip: a guard
  // that goes green when it cannot evaluate its subject is worse than no guard
  // (security.md, "unreachable is a FAILURE, never a pass").
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

/** build.sh with full-line comments removed — it documents its own flags at length. */
function scriptCode(): string {
  return readFileSync(resolve(EXAMPLE_DIR, 'build.sh'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

describe('bun-exec build command (ADR-0042 A12)', () => {
  it('passes every token the discharge is measured on, read from the array that runs the build', () => {
    const command = printLabels().get('dev.knext.build.command');
    expect(command, 'build.sh emitted no dev.knext.build.command label').toBeTruthy();
    for (const token of REQUIRED_TOKENS) {
      expect(
        command,
        `ADR-0042's A12 discharge is measured on \`${token}\`; build.sh no longer passes it. ` +
          'Either restore it, or re-open A12 and re-measure — the recorded +6.06 MB payload and ' +
          '34/34 embedding coverage do not describe this build any more.',
      ).toContain(token);
    }
  });

  it('builds and stamps from ONE array, so a hand-copied command cannot drift from it', () => {
    const code = scriptCode();

    // (a) exactly one definition of the command.
    const assignments = code.split('BUN_BUILD_CMD=(').length - 1;
    expect(
      assignments,
      `build.sh defines BUN_BUILD_CMD ${assignments}× (want exactly 1). Two definitions mean the ` +
        'label and the executed command are no longer one array.',
    ).toBe(1);

    // (b) each token appears exactly once INSIDE that array literal. Counting
    //     whole-file occurrences was the first version and it was wrong: the
    //     progress `echo` on step 2/3 legitimately names the entry path, so the
    //     entry could never be added to this assertion.
    const open = code.indexOf('BUN_BUILD_CMD=(');
    const close = code.indexOf(')', open);
    expect(close, 'BUN_BUILD_CMD=( is never closed').toBeGreaterThan(open);
    const arrayLiteral = code.slice(open, close);
    for (const token of REQUIRED_TOKENS) {
      const n = arrayLiteral.split(token).length - 1;
      expect(
        n,
        `\`${token}\` occurs ${n}× inside the BUN_BUILD_CMD array (want exactly 1)` +
          (n === 0
            ? ' — it is GONE from the command that actually runs.'
            : ' — a duplicate inside the array is ambiguous about what is executed.'),
      ).toBe(1);
    }

    // (c) no OTHER line reconstructs the command by hand. This is what catches a
    //     second copy living outside the array, which (b) cannot see.
    const strays = code
      .split('\n')
      .filter((l) => !l.includes('BUN_BUILD_CMD=(') && /bun build\s+--compile/.test(l));
    expect(
      strays,
      'a second, hand-written `bun build --compile …` exists outside BUN_BUILD_CMD. The label is ' +
        'stamped from the array, so a stray copy is free to drift from what is executed — which is ' +
        "precisely the failure build.sh's header says it built the single-array design to prevent.",
    ).toEqual([]);
  });

  it('stamps a toolchain that still matches what the discharge was measured against', () => {
    const labels = printLabels();
    expect(labels.get('dev.knext.build.target')).toBe('bun-linux-x64-musl');
    expect(labels.get('dev.knext.app.id'), 'app id not stamped').toMatch(/\S/);

    const version = labels.get('dev.knext.build.bun-version');
    // The invariant is that the version is stamped TRUTHFULLY, not that bun is
    // installed: `--print-labels` is a pure read of BUN_BUILD_CMD and works
    // without bun, and the ROOT vitest run collects this file in a job that has
    // no bun on PATH. An earlier draft asserted /^\d+\./ and reddened that job
    // for an environment fact rather than a defect.
    expect(
      version,
      'the bun-version label is absent — a recorded figure could no longer be attributed to a toolchain',
    ).toBeDefined();
    expect(
      version,
      `bun-version is \`${version}\`; want a semver when bun is on PATH, or the explicit sentinel ` +
        '`unknown` when it is not. Blank or invented is the failure.',
    ).toMatch(/^(\d+\.\d+\.\d+|unknown$)/);

    // STALENESS: the gate file must still SAY which toolchain its figures came
    // from. That is asserted here; whether the CURRENT bun matches it is
    // deliberately NOT.
    //
    // Why not — this repo has already paid for the other design. `security.md`
    // records that asserting a pinned VALUE in a PR-time test "reddened every
    // correct Dependabot bump and made editing the guard the routine way to get
    // green", and the resolved split is: assert FORM and SCOPE at PR time, and
    // resolve VALUES at RUN time in a nightly. `ci.yml` installs
    // `bun-version: latest` (4 sites), so a value assertion here would red every
    // PR the day bun ships a release, and the cheapest way to green it would be
    // to edit this number — which is exactly how the figures would drift while
    // looking maintained.
    //
    // Proved rather than assumed: a value assertion was written, and it went red
    // immediately against a second bun (1.2.2) already on this machine.
    //
    // THE GAP IS REAL AND IS NOT CLOSED BY THIS TEST. `bun` determines both the
    // bytecode format and the 92 MB runtime floor and is pinned NOWHERE — not
    // `package.json`, no `.bun-version`, and `bun-version: latest` in CI. The
    // real fixes are (a) pin bun, and (b) a nightly that resolves the running
    // toolchain against the recorded one, mirroring
    // `action-pin-resolution-nightly.yml`. Both are follow-up work, and saying so
    // here is better than a guard that would be routinely edited to stay green.
    const gates = JSON.parse(readFileSync(GATES, 'utf8')) as {
      phases: { phase: string; criteria?: { id: string; source?: string }[] }[];
    };
    const p3d1 = gates.phases.flatMap((p) => p.criteria ?? []).find((c) => c.id === 'P3d-1');
    expect(
      p3d1?.source,
      'ADR-0042 P3d-1 has no `source` — a measured value with no run ID or path',
    ).toBeTruthy();
    expect(
      /bun \d+\.\d+\.\d+/.test(p3d1?.source ?? ''),
      `ADR-0042 P3d-1's source no longer names the bun version its figures were measured on ` +
        `(got: ${p3d1?.source}). Without it the recorded bytecode payload and runtime floor cannot ` +
        'be attributed to a toolchain at all, and no nightly could ever check them for drift.',
    ).toBe(true);
  });
});
