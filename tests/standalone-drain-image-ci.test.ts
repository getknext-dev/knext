import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import { skipViolation } from '../scripts/lib/bun-test-no-skip.mjs';
import { auditBlockingGate } from './helpers/blocking-gate';

/**
 * #1156 — the standalone-on-bun SIGTERM drain e2e has NO skip path; this asserts
 * it has somewhere to run, and that the somewhere actually reaches it.
 *
 * `packages/kn-next/src/__tests__/standalone-drain.docker-e2e.test.ts` fails
 * (never skips) when docker or bun is missing — the right shape for a drain
 * gate. But its `.docker-e2e.test.ts` suffix excludes it from the fast
 * `Lint & Test` lane (scripts/bun-test.mjs / vitest.config.ts both drop that
 * pattern unless the file is named explicitly), so the ONLY thing that runs it
 * is the `standalone-drain-bun-image` job. Delete that job and the suite goes
 * unreachable: nothing turns red, and the R3 shim / supervisor drain it protects
 * could regress with the same silence #1156 was filed against.
 *
 * These assertions guard the WIRING. The CONTENT half reads the job as text (the
 * SHA-pinned `uses:`, the exact e2e path it runs); the "is this job actually
 * blocking?" half is PARSED via tests/helpers/blocking-gate.ts (a text `if:`
 * anchor misses quoted-key and skippable-`needs:` disarms — #661).
 */

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const JOB_KEY = 'standalone-drain-bun-image:';
const E2E_PATH = 'packages/kn-next/src/__tests__/standalone-drain.docker-e2e.test.ts';

/** The job's own lines, bounded by the next top-level job key. */
function jobBlock(): string {
  const raw = readFileSync(CI_YML, 'utf8');
  expect(raw.length, 'ci.yml is empty or unreadable').toBeGreaterThan(1000);
  expect(raw, 'ci.yml no longer looks like a workflow').toMatch(/^jobs:/m);

  const start = raw.indexOf(`  ${JOB_KEY}`);
  expect(start, `no ${JOB_KEY} job in ci.yml`).toBeGreaterThan(-1);

  const rest = raw.slice(start + JOB_KEY.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('standalone-on-bun drain gate is wired into CI (#1156)', () => {
  it('runs the container e2e by its explicit path, not the fast suite', () => {
    const block = jobBlock();
    // Scope to the actual `run:` commands, not the whole block — the job's
    // leading comment also names E2E_PATH in prose (#1188), so asserting over
    // the whole block stays green even if a `run:` line is renamed away from
    // the real path while the comment still mentions it.
    const runCommands = [...block.matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(
      runCommands,
      'the job never invokes the standalone-drain docker e2e by its explicit path, so it is unreachable',
    ).toContain(E2E_PATH);
  });

  it('runs the runner that can collect a bun:test file (not vitest)', () => {
    const block = jobBlock();
    expect(block, 'the job never invokes scripts/bun-test.mjs').toMatch(/bun-test\.mjs/);
    // Scope the not-vitest check to the actual `run:` commands — the prose above
    // legitimately names `vitest.config.ts` as the file that excludes the suite.
    const runCommands = [...block.matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(runCommands, 'the e2e imports bun:test — a `run:` must not invoke vitest').not.toMatch(
      /vitest/,
    );
  });

  it('installs bun, which the image build + operator command need', () => {
    expect(jobBlock(), 'the job never installs bun').toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/);
  });

  it('builds @getknext/core, whose dist the image COPYs as the supervisor', () => {
    expect(jobBlock(), 'the job never builds @getknext/core').toMatch(
      /bun run --filter @getknext\/core build/,
    );
  });

  it('runs unconditionally on a PR and its failure fails the run (#661)', () => {
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'standalone-drain-bun-image',
      gateCommand: new RegExp(E2E_PATH.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
    });
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the e2e').toBe(1);
    // No `needs:` — the job stands alone, so its closure is just itself.
    expect(audit.needsClosure, 'the `needs` closure the audit walked').toEqual([
      'standalone-drain-bun-image',
    ]);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });
});

// #1226 — the Pages Router + custom-cacheHandler identity e2e for the compiled
// executable rides in the same job (it needs the same docker + bun) and has
// the same no-skip contract, so it needs the same wiring guard.
const PAGES_E2E_PATH = 'packages/kn-next/src/__tests__/standalone-pages.docker-e2e.test.ts';

describe('the compiled-exec Pages Router / cacheHandler identity e2e is wired into CI (#1226)', () => {
  it('a `run:` in the job invokes it by its explicit path, as a blocking step', () => {
    const runCommands = [...jobBlock().matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(runCommands, 'the job never runs the standalone-pages docker e2e').toContain(
      PAGES_E2E_PATH,
    );
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'standalone-drain-bun-image',
      gateCommand: new RegExp(PAGES_E2E_PATH.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
    });
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the e2e').toBe(1);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });

  it('the file exists, is a container e2e, and imports bun:test', () => {
    const full = resolve(REPO_ROOT, PAGES_E2E_PATH);
    expect(existsSync(full), `${PAGES_E2E_PATH} does not exist`).toBe(true);
    expect(PAGES_E2E_PATH).toMatch(/\.docker-e2e\.test\.ts$/);
    expect(readFileSync(full, 'utf8'), 'the e2e must import bun:test').toMatch(
      /from ['"]bun:test['"]/,
    );
  });
});

// #1264 round 3 — the standalone-node compile-cache bake's ONLY proof that the
// Dockerfile's ARG KNEXT_HEALTH_CHECK_PATH build-arg actually reaches the bake
// driver (rather than always falling back to /api/health) is this e2e: it rides
// in the same job (same docker + bun + @getknext/core setup) and has the same
// no-skip contract, so it needs the same wiring guard.
const CUSTOM_HEALTH_PATH_E2E_PATH =
  'packages/kn-next/src/__tests__/standalone-node-custom-health-path.docker-e2e.test.ts';

describe('the standalone-node custom-healthCheckPath bake e2e is wired into CI (#1264)', () => {
  it('a `run:` in the job invokes it by its explicit path, as a blocking step', () => {
    const runCommands = [...jobBlock().matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(
      runCommands,
      'the job never runs the standalone-node-custom-health-path docker e2e',
    ).toContain(CUSTOM_HEALTH_PATH_E2E_PATH);
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'standalone-drain-bun-image',
      gateCommand: new RegExp(CUSTOM_HEALTH_PATH_E2E_PATH.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
    });
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the e2e').toBe(1);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });

  it('the file exists, is a container e2e, and imports bun:test', () => {
    const full = resolve(REPO_ROOT, CUSTOM_HEALTH_PATH_E2E_PATH);
    expect(existsSync(full), `${CUSTOM_HEALTH_PATH_E2E_PATH} does not exist`).toBe(true);
    expect(CUSTOM_HEALTH_PATH_E2E_PATH).toMatch(/\.docker-e2e\.test\.ts$/);
    expect(readFileSync(full, 'utf8'), 'the e2e must import bun:test').toMatch(
      /from ['"]bun:test['"]/,
    );
  });
});

// #1327 — the ONLY proof that an app's own .env/.env.production never ships
// inside the standalone runtime image is this e2e: it rides in the same job
// (same docker + bun + @getknext/core setup) and has the same no-skip
// contract, so it needs the same wiring guard as its siblings above.
const ENV_NOT_IN_IMAGE_E2E_PATH =
  'packages/kn-next/src/__tests__/standalone-env-not-in-image.docker-e2e.test.ts';

describe('the .env-not-in-image e2e is wired into CI (#1327)', () => {
  it('a `run:` in the job invokes it by its explicit path, as a blocking step', () => {
    const runCommands = [...jobBlock().matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(runCommands, 'the job never runs the standalone-env-not-in-image docker e2e').toContain(
      ENV_NOT_IN_IMAGE_E2E_PATH,
    );
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'standalone-drain-bun-image',
      gateCommand: new RegExp(ENV_NOT_IN_IMAGE_E2E_PATH.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
    });
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the e2e').toBe(1);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });

  it('the file exists, is a container e2e, and imports bun:test', () => {
    const full = resolve(REPO_ROOT, ENV_NOT_IN_IMAGE_E2E_PATH);
    expect(existsSync(full), `${ENV_NOT_IN_IMAGE_E2E_PATH} does not exist`).toBe(true);
    expect(ENV_NOT_IN_IMAGE_E2E_PATH).toMatch(/\.docker-e2e\.test\.ts$/);
    expect(readFileSync(full, 'utf8'), 'the e2e must import bun:test').toMatch(
      /from ['"]bun:test['"]/,
    );
  });
});

// N2 (#1457) — the ONLY proof that the self-contained `--target
// standalone-bun-self-contained` stage actually builds and boots (and REALLY
// ships no node_modules / no .next/standalone, folds SIGTERM drain + :9464
// metrics into one process) is this e2e: it rides in the same job (same
// docker + bun + @getknext/core setup) and has the same no-skip contract, so
// it needs the same wiring guard as its siblings above.
const SELF_CONTAINED_IMAGE_E2E_PATH =
  'packages/kn-next/src/__tests__/standalone-self-contained-image.docker-e2e.test.ts';

describe('the self-contained image e2e is wired into CI (N2, #1457)', () => {
  it('a `run:` in the job invokes it by its explicit path, as a blocking step', () => {
    const runCommands = [...jobBlock().matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(
      runCommands,
      'the job never runs the standalone-self-contained-image docker e2e',
    ).toContain(SELF_CONTAINED_IMAGE_E2E_PATH);
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'standalone-drain-bun-image',
      gateCommand: new RegExp(
        SELF_CONTAINED_IMAGE_E2E_PATH.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'),
      ),
    });
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the e2e').toBe(1);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });

  // round-2 fix (m3): round 1 set KNEXT_REQUIRE_SC_EXEC=1 on this step "for
  // parity" with the N1 self-contained-executable gate's env contract, and
  // this test used to assert that env was present. But
  // standalone-self-contained-image.docker-e2e.test.ts never reads that flag
  // — it has NO skip path at all (its own header: "NO SKIP PATH — missing
  // docker/bun is a FAILURE"), so the env was decorative and asserting its
  // presence pinned decoration, not a real fail-closed guarantee. Assert the
  // opposite instead: this step must NOT carry an env var its suite ignores.
  it('does NOT set KNEXT_REQUIRE_SC_EXEC (the suite has no skip path to gate — the flag would be decorative)', () => {
    const block = jobBlock();
    const idx = block.indexOf(SELF_CONTAINED_IMAGE_E2E_PATH);
    expect(idx, 'the step that runs the e2e is missing').toBeGreaterThan(-1);
    // The step's own YAML (env: block sits above `run:`) — bounded to a
    // reasonable window around the step rather than the whole job, so an
    // unrelated step's env cannot false-positive this.
    const stepWindowStart = block.lastIndexOf('- name:', idx);
    const stepWindow = block.slice(
      stepWindowStart,
      idx + SELF_CONTAINED_IMAGE_E2E_PATH.length + 40,
    );
    expect(
      stepWindow,
      'the step sets KNEXT_REQUIRE_SC_EXEC, which the suite never reads — either remove the env or make the suite read it',
    ).not.toMatch(/KNEXT_REQUIRE_SC_EXEC:\s*['"]?1['"]?/);
    // And the suite itself really has no skip path — if it grows one later,
    // this assertion (and the env removal above) need revisiting together.
    const suiteText = readFileSync(resolve(REPO_ROOT, SELF_CONTAINED_IMAGE_E2E_PATH), 'utf8');
    expect(
      suiteText,
      'the suite gained a skip path — KNEXT_REQUIRE_SC_EXEC may no longer be decorative',
    ).not.toMatch(/skipIf|\bit\.skip\b|\bdescribe\.skip\b/);
  });

  // Round 3 (R2-B2): the suite's operator-command leg is the only proof that
  // the image boots AND drains under the command `knext deploy` runs today
  // (`bun run server.js`, PID 1 = the compat shim). Deleting those args from
  // its `docker run` leaves the container on the default ENTRYPOINT, where
  // every assertion still passes, so nothing inside the docker lane would
  // notice. Scan for it here, in the fast lane.
  it('the operator-command leg really runs `bun run server.js` and drains under it', () => {
    const suite = readFileSync(resolve(REPO_ROOT, SELF_CONTAINED_IMAGE_E2E_PATH), 'utf8');
    expect(
      suite,
      'the operator-command docker run no longer passes `bun run server.js` after the image',
    ).toMatch(/IMAGE,\s*"bun",\s*"run",\s*"server\.js",?\s*\]/);
    expect(
      suite,
      'the SIGTERM clean-drain proof is not run against the operator-command container',
    ).toMatch(/assertCleanDrain\(\s*OPERATOR_CONTAINER,/);
    expect(
      suite,
      'the SIGTERM clean-drain proof is not run against the default-ENTRYPOINT container',
    ).toMatch(/assertCleanDrain\(\s*CONTAINER,/);
    // Both containers run with a grace window far above the drain bound, so a
    // hardcap exit cannot pass as a clean drain.
    const grace = Number(
      suite.match(/const SHUTDOWN_GRACE_MS = ([\d_]+);/)?.[1]?.replace(/_/g, ''),
    );
    const bound = Number(suite.match(/const DRAIN_BOUND_MS = ([\d_]+);/)?.[1]?.replace(/_/g, ''));
    expect(grace, 'SHUTDOWN_GRACE_MS constant missing').toBeGreaterThan(0);
    expect(bound, 'DRAIN_BOUND_MS constant missing').toBeGreaterThan(0);
    expect(grace, 'the grace window must dwarf the drain bound').toBeGreaterThanOrEqual(bound * 4);
    const graceEnvs = suite.match(/`SHUTDOWN_GRACE_MS=\$\{SHUTDOWN_GRACE_MS\}`/g) ?? [];
    expect(graceEnvs.length, 'both containers must be started with the large grace window').toBe(2);
    // The async after() is what makes the marker discriminating.
    expect(suite).toMatch(/afterMs=\$\{AFTER_MS\}/);
  });

  it('the file exists, is a container e2e, and imports bun:test', () => {
    const full = resolve(REPO_ROOT, SELF_CONTAINED_IMAGE_E2E_PATH);
    expect(existsSync(full), `${SELF_CONTAINED_IMAGE_E2E_PATH} does not exist`).toBe(true);
    expect(SELF_CONTAINED_IMAGE_E2E_PATH).toMatch(/\.docker-e2e\.test\.ts$/);
    expect(readFileSync(full, 'utf8'), 'the e2e must import bun:test').toMatch(
      /from ['"]bun:test['"]/,
    );
  });
});

// Round 4 (R3-B1 / R3-B2, N2 #1457). The two SIGTERM drain legs of the
// self-contained e2e are the only proof that a scale-down drains in-flight
// work and waits for after(). Round 3's guards checked that the text
// `assertCleanDrain(OPERATOR_CONTAINER,` still appeared — which it does after
// `it(` becomes `it.todo(` — and listed three skip spellings out of many. And
// the fixture line that makes the after() marker discriminating (the await of
// `afterMs`) had no guard at all: deleting it stayed green in every lane.
// These scan for the SHAPE instead of enumerating spellings.
const DRAIN_FIXTURE_ROUTE =
  'packages/kn-next/src/__tests__/fixtures/standalone-drain-app/app/api/slow/route.ts';

function scSuite(): { raw: string; code: string } {
  const raw = readFileSync(resolve(REPO_ROOT, SELF_CONTAINED_IMAGE_E2E_PATH), 'utf8');
  expect(raw.length, 'the self-contained e2e is empty or unreadable').toBeGreaterThan(1000);
  return { raw, code: blankNonCode(raw) };
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** `const NAME = 1_234;` in the suite, as a number (fails the test if absent). */
function suiteConst(raw: string, name: string): number {
  const m = raw.match(new RegExp(`^const ${name} = ([\\d_]+);$`, 'm'));
  expect(m, `the suite no longer declares \`const ${name} = <number>;\``).not.toBeNull();
  return Number((m as RegExpMatchArray)[1].replace(/_/g, ''));
}

describe('the self-contained drain legs cannot be switched off or weakened (round 4)', () => {
  it('no test in the suite can be skipped, todo-ed, focused, inverted or aliased (scanned, not listed)', () => {
    const { code } = scSuite();
    // Scanned on the code-only view, so a comment that DISCUSSES `it.todo` is
    // not a finding while a call is. Each pattern is a family, not a spelling:
    //   - any member access on a test function (`it.todo`, `describe.if`,
    //     `test.failing`, `it.skipIf`, `it.only`, `it.each`, ... — every
    //     modifier bun has or grows goes through a `.`);
    //   - a modifier CALL on anything, so aliasing `const leg = it` and then
    //     `leg.skip(` is still caught;
    //   - the `x`/`f` prefixed globals (`xit`, `xdescribe`, `fit`);
    //   - re-binding a test function to another name.
    const forbidden: Array<[string, RegExp]> = [
      ['member access on it/test/describe', /\b(?:it|test|describe)\s*\.\s*[A-Za-z_$]/g],
      [
        'a skip/todo/if/only/failing/each modifier call',
        /\.\s*(?:skip|skipIf|todo|todoIf|if|only|failing|each|concurrent|serial)\s*\(/g,
      ],
      ['an x-/f-prefixed test global', /\b(?:xit|xtest|xdescribe|fit|fdescribe)\b/g],
      ['a test function re-bound to another name', /[=:,(]\s*(?:it|test|describe)\s*[,;)}\n]/g],
    ];
    // Import statements are checked on their own below (the bun:test one names
    // `describe` and `it` in a list, which is not a re-binding).
    const body = code.replace(/^import\b[^;]*;/gm, (m) => m.replace(/[^\n]/g, ' '));
    const hits: string[] = [];
    for (const [what, re] of forbidden) {
      for (const m of body.matchAll(re)) {
        hits.push(`line ${lineOf(code, m.index ?? 0)}: ${what} (\`${m[0].trim()}\`)`);
      }
    }
    expect(hits, `the self-contained e2e has a way to not run a test:\n${hits.join('\n')}`).toEqual(
      [],
    );
    // The bun:test import is the plain set, never renamed (`it as leg`).
    const imp = code.match(/import\s*\{([^}]*)\}\s*from\s*"/);
    expect(imp, 'the suite no longer imports from bun:test').not.toBeNull();
    const names = (imp as RegExpMatchArray)[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    expect(names, 'the bun:test import grew or renamed a binding').toEqual([
      'afterAll',
      'beforeAll',
      'describe',
      'expect',
      'it',
    ]);
  });

  it('exactly two `// drain-leg:` tagged tests, each a plain it() that drains its own container', () => {
    const { raw, code } = scSuite();
    const tags = [...raw.matchAll(/^[ \t]*\/\/ drain-leg:.*$/gm)];
    expect(tags.length, 'there must be exactly two `// drain-leg:` tags').toBe(2);
    const drained: string[] = [];
    for (const tag of tags) {
      const after = (tag.index ?? 0) + tag[0].length + 1;
      // The very next line is a plain `it(` — not a modifier, not a comment.
      const nextLine = raw.slice(after).split('\n')[0];
      expect(
        nextLine,
        `the line after "${tag[0].trim()}" must open a plain it(): ${nextLine}`,
      ).toMatch(/^\s*it\(\s*"/);
      // The leg's body, on the code-only view, runs to the next test or block.
      const rest = code.slice(after + nextLine.length);
      const end = rest.search(/\n\s*(?:it|describe)\s*\(|\n\}\);?\n/);
      const body = end === -1 ? rest : rest.slice(0, end);
      const call = body.match(/\bawait\s+assertCleanDrain\(\s*([A-Z_]+)\s*,/);
      expect(
        call,
        `the ${tag[0].trim()} leg no longer awaits assertCleanDrain(...)`,
      ).not.toBeNull();
      const before = body.slice(0, (call as RegExpMatchArray).index);
      expect(before, `the ${tag[0].trim()} leg can return before it drains`).not.toMatch(
        /\breturn\b|\bthrow\b/,
      );
      drained.push((call as RegExpMatchArray)[1]);
    }
    expect(drained.sort(), 'the two legs must drain the two different containers').toEqual([
      'CONTAINER',
      'OPERATOR_CONTAINER',
    ]);
    // And the in-file backstop: assertCleanDrain records a container only as its
    // LAST statement, and a top-level afterAll requires both.
    expect(raw).toMatch(/const OPERATOR_CONTAINER = `\$\{CONTAINER\}-operator-cmd`;/);
    expect(code, 'assertCleanDrain must record the container as its final statement').toMatch(
      /\.not\.toContain\(HARDCAP_LOG\);\s*drainLegsCompleted\.push\(container\);\s*\}/,
    );
    // On the code-only view (the message string's own parentheses are blanked).
    expect(code, 'the afterAll that requires both drain legs is gone').toMatch(
      /afterAll\(\(\) => \{\s*expect\(\s*\[\.\.\.drainLegsCompleted\]\.sort\(\),[^)]*\)\.toEqual\(\[CONTAINER, `\$\{CONTAINER\}\s*`\]\.sort\(\)\);\s*\}\);/,
    );
    expect(raw).toContain('.toEqual([CONTAINER, `${CONTAINER}-operator-cmd`].sort());');
  });

  it('the CI step runs the suite with --no-skip, so a skipped or todo test fails the lane', () => {
    const runLine = [...jobBlock().matchAll(/run:\s*([^\n]*)/g)]
      .map((m) => m[1])
      .filter((l) => l.includes(SELF_CONTAINED_IMAGE_E2E_PATH));
    expect(runLine.length, 'exactly one run: line invokes the self-contained e2e').toBe(1);
    // Round 5 (R4 minor, X20/X21): a bare `.toMatch(/--no-skip\b/)` is satisfied
    // by `--no-skip` sitting inside a YAML comment (` # --no-skip`, never part
    // of the command bun-test.mjs receives) and by `--no-skip=false` (`\b`
    // matches the boundary before `=`, but `argv.includes('--no-skip')` in
    // bun-test.mjs sees no such token). Parse the run string as a command line
    // instead: drop anything from an unquoted ` #` on (YAML's own comment
    // rule — everything after requires no quoting here, since the command has
    // none), then require the EXACT token, not a substring or prefix.
    const commandOnly = runLine[0].replace(/\s#.*$/, '');
    const tokens = commandOnly.trim().split(/\s+/);
    expect(
      tokens,
      `the self-contained e2e step must pass the literal --no-skip token to bun-test.mjs (not inside a YAML comment, not --no-skip=false): ${JSON.stringify(runLine[0])}`,
    ).toContain('--no-skip');
  });

  it('the drain lower bound cannot be met by an exit that skipped the after() work', () => {
    const { raw, code } = scSuite();
    const afterMs = suiteConst(raw, 'AFTER_MS');
    const requestMs = suiteConst(raw, 'REQUEST_MS');
    const preTermMs = suiteConst(raw, 'PRE_TERM_MS');
    const bound = suiteConst(raw, 'DRAIN_BOUND_MS');
    // The after() work must be long enough to separate "waited" from "did not".
    expect(
      afterMs,
      'AFTER_MS must be at least 1000 ms to be discriminating',
    ).toBeGreaterThanOrEqual(1000);
    expect(requestMs, 'REQUEST_MS must outlast PRE_TERM_MS').toBeGreaterThan(preTermMs);
    expect(preTermMs).toBeGreaterThan(0);
    expect(
      raw,
      'MIN_CLEAN_DRAIN_MS must be derived from the request, pre-TERM wait and after()',
    ).toMatch(/^const MIN_CLEAN_DRAIN_MS = REQUEST_MS - PRE_TERM_MS \+ AFTER_MS - 500;$/m);
    const min = requestMs - preTermMs + afterMs - 500;
    // A no-wait exit lands ~REQUEST_MS - PRE_TERM_MS after TERM: at least 500 ms short.
    expect(
      min - (requestMs - preTermMs),
      'the bound must sit above a no-wait exit',
    ).toBeGreaterThanOrEqual(500);
    expect(min, 'the lower bound must fit under the upper bound').toBeLessThan(bound);
    // ...and the constants are what the drain actually uses.
    expect(raw).toContain('/api/slow?ms=${REQUEST_MS}&afterMs=${AFTER_MS}&id=${reqId}');
    expect(code).toMatch(
      /await new Promise\(\(r\) => setTimeout\(r, PRE_TERM_MS\)\);\s*const termAt = Date\.now\(\);/,
    );
    // The upper half and the ordering are pinned by USE, not only by value:
    // a clean drain fits DRAIN_BOUND_MS (<= 15 s, far under the grace window),
    // `docker wait` gives up before a hardcap could end the container, and RAN
    // is required after START.
    expect(bound, 'DRAIN_BOUND_MS must stay tight').toBeLessThanOrEqual(15_000);
    expect(code, 'elapsedMs must be held under DRAIN_BOUND_MS').toMatch(
      /expect\(\s*elapsedMs,[^;]*\)\.toBeLessThan\(DRAIN_BOUND_MS\);/,
    );
    expect(raw, '`docker wait` must time out well before the hardcap').toMatch(
      /run\("docker", \["wait", container\], \{\s*timeout: DRAIN_BOUND_MS \* 2,\s*\}\);/,
    );
    expect(code, 'RAN must be required to come after START').toMatch(
      /expect\(\s*done,[^;]*\)\.toBeGreaterThan\(start\);/,
    );
    expect(code, 'elapsedMs must be held to MIN_CLEAN_DRAIN_MS').toMatch(
      /expect\(\s*elapsedMs,[^;]*\)\.toBeGreaterThanOrEqual\(MIN_CLEAN_DRAIN_MS\);/,
    );
  });

  it("the fixture's after() logs START, then awaits a timer of afterMs, then logs RAN — in that order", () => {
    const raw = readFileSync(resolve(REPO_ROOT, DRAIN_FIXTURE_ROUTE), 'utf8');
    const code = blankNonCode(raw);
    // A marker counts only where its opening quote is CODE (the doc comment
    // above the handler names both markers too; blanking erases that quote).
    const marker = (name: string): number[] =>
      [...raw.matchAll(new RegExp(`[\`'"]${name}:`, 'g'))]
        .map((m) => m.index ?? -1)
        .filter((i) => i >= 0 && code[i] === raw[i]);
    const starts = marker('AFTER_SENTINEL_START');
    const rans = marker('AFTER_SENTINEL_RAN');
    expect(starts.length, 'the fixture must log AFTER_SENTINEL_START exactly once').toBe(1);
    expect(rans.length, 'the fixture must log AFTER_SENTINEL_RAN exactly once').toBe(1);
    const waits = [
      ...code.matchAll(
        /\bawait\s+new\s+Promise\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*setTimeout\s*\(\s*\1\s*,\s*afterMs\s*\)\s*\)/g,
      ),
    ].map((m) => m.index ?? -1);
    expect(waits.length, 'the fixture must await exactly one setTimeout of afterMs').toBe(1);
    const afterCall = code.search(/\bafter\s*\(\s*async\b/);
    expect(afterCall, 'the fixture no longer registers an async after() callback').toBeGreaterThan(
      -1,
    );
    expect(afterCall, 'START must be logged inside the after() callback').toBeLessThan(starts[0]);
    expect(starts[0], 'START must come before the afterMs wait').toBeLessThan(waits[0]);
    expect(waits[0], 'the afterMs wait must come before RAN').toBeLessThan(rans[0]);
    // afterMs really is the request's `afterMs` query param, and START is gated on it.
    expect(raw).toMatch(/const afterMs = Number\(url\.searchParams\.get\("afterMs"\) \?\? "0"\);/);
    expect(code).toMatch(/if \(afterMs > 0\) \{/);
  });

  // The canaries live in an OS temp dir, never the checkout (a transient file
  // in the tree races every spec that walks it — temp-dirs-outside-the-repo).
  // bun-test.mjs discovers targets through `git ls-files`, which cannot name a
  // path outside the repo, so the parser is exercised on REAL bun output here
  // and the runner's use of it is pinned separately below.
  it('--no-skip rejects real bun output from a file that skips, todos or conditions a test off', () => {
    const canaries: Record<string, string> = {
      todo: "it.todo('not run', () => {});",
      if: "it.if(false)('not run', () => {});",
      skip: "it.skip('not run', () => {});",
      skipIf: "it.skipIf(true)('not run', () => {});",
      clean: "it('runs', () => { expect(1).toBe(1); });",
    };
    const dir = mkdtempSync(join(tmpdir(), 'knext-no-skip-'));
    const results: Record<string, { status: number | null; out: string }> = {};
    try {
      for (const [kind, extra] of Object.entries(canaries)) {
        const file = join(dir, `${kind}.test.ts`);
        writeFileSync(
          file,
          [
            "import { expect, it } from 'bun:test';",
            "it('a real test', () => { expect(1).toBe(1); });",
            extra,
            '',
          ].join('\n'),
        );
        const r = spawnSync(process.execPath, ['test', file], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 120_000,
        });
        results[kind] = { status: r.status, out: `${r.stdout}${r.stderr}` };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const kind of ['todo', 'if', 'skip', 'skipIf']) {
      // bun itself exits 0 — which is exactly why the flag exists.
      expect(
        results[kind].status,
        `bun unexpectedly failed it.${kind}:\n${results[kind].out}`,
      ).toBe(0);
      expect(
        skipViolation(results[kind].out),
        `--no-skip would let it.${kind} pass:\n${results[kind].out}`,
      ).toMatch(/^--no-skip: /);
    }
    expect(results.clean.status).toBe(0);
    expect(skipViolation(results.clean.out), results.clean.out).toBeNull();
    // No summary at all is a failure, not a pass.
    expect(skipViolation('')).toMatch(/^--no-skip: no `N pass` summary/);
  }, 300_000);

  it('bun-test.mjs applies --no-skip: reads the flag, and a violation fails the file', () => {
    const runner = blankNonCode(readFileSync(resolve(REPO_ROOT, 'scripts/bun-test.mjs'), 'utf8'));
    expect(runner).toMatch(/import \{ skipViolation \} from '[^']*';/);
    expect(runner).toMatch(/const noSkip = argv\.includes\('[^']*'\);/);
    expect(
      readFileSync(resolve(REPO_ROOT, 'scripts/bun-test.mjs'), 'utf8'),
      'the runner must read the --no-skip flag',
    ).toContain("const noSkip = argv.includes('--no-skip');");
    expect(runner, 'a zero-exit file must be checked under --no-skip').toMatch(
      /const violation = noSkip && code === 0 \? skipViolation\(output\) : null;/,
    );
    expect(runner, 'a violation must make the file fail').toMatch(
      /const ok = code === 0 && violation === null;/,
    );
    expect(runner, 'a failed file must be recorded as a failure').toMatch(
      /if \(!ok\) failures\.push\(\{ file, output \}\);/,
    );
  });
});

// Round 5 (R4-B1). The round-4 guard above ("assertCleanDrain must record the
// container as its final statement") is a TEXT match ending in
// `.not.toContain(HARDCAP_LOG);\s*drainLegsCompleted\.push\(container\);\s*\}`.
// A leg mutated to `drainLegsCompleted.push(container); if (container) return;`
// as the helper's FIRST statement still matches that trailing text — the
// original push is still there, unmoved, right before the closing brace — so
// every leg still gets "recorded" and every assertion after the early return
// silently never runs. Same story for weakening or deleting one assertion
// out of the helper's body: nothing here requires the SET of assertions to
// stay intact, only that the trailing shape survives.
//
// These checks parse `assertCleanDrain` with the TypeScript compiler — the
// same parser this repo's other structural guards already use for exactly
// this kind of question (see `tests/helpers/fail-on-red-gate.ts`, which walks
// a real AST rather than sub-string-matching an embedded script) — so the
// answer comes from the function's STRUCTURE, not from a spelling a mutation
// can dodge underneath an unchanged tail.
describe('assertCleanDrain cannot record its leg and skip the assertions that earned it (round 5, R4-B1)', () => {
  function parsedHelper(): {
    sourceFile: ts.SourceFile;
    fn: ts.FunctionDeclaration;
    raw: string;
    code: string;
  } {
    const { raw, code } = scSuite();
    const sourceFile = ts.createSourceFile(
      SELF_CONTAINED_IMAGE_E2E_PATH,
      raw,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let fn: ts.FunctionDeclaration | undefined;
    const walk = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'assertCleanDrain') fn = n;
      ts.forEachChild(n, walk);
    };
    walk(sourceFile);
    expect(
      fn,
      'assertCleanDrain is no longer a top-level function declaration',
    ).not.toBeUndefined();
    const found = fn as ts.FunctionDeclaration;
    expect(found.body, 'assertCleanDrain has no function body').not.toBeUndefined();
    return { sourceFile, fn: found, raw, code };
  }

  it('drainLegsCompleted.push( occurs exactly once in the whole file', () => {
    const { raw } = scSuite();
    const count = raw.split('drainLegsCompleted.push(').length - 1;
    expect(
      count,
      'drainLegsCompleted.push( must occur exactly once — one call, so it cannot be duplicated ahead of an early exit while the original stays at the tail',
    ).toBe(1);
  });

  it("the helper's FINAL statement is drainLegsCompleted.push(container) — structurally, not by trailing text", () => {
    const { fn } = parsedHelper();
    const body = fn.body as ts.Block;
    const stmts = body.statements;
    expect(stmts.length, 'assertCleanDrain has an empty body').toBeGreaterThan(0);
    const last = stmts[stmts.length - 1] as ts.Statement;
    let isPush = false;
    if (ts.isExpressionStatement(last) && ts.isCallExpression(last.expression)) {
      const callee = last.expression.expression;
      const args = last.expression.arguments;
      if (args.length === 1) {
        const arg = args[0] as ts.Expression;
        isPush =
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'drainLegsCompleted' &&
          callee.name.text === 'push' &&
          ts.isIdentifier(arg) &&
          arg.text === 'container';
      }
    }
    expect(
      isPush,
      `assertCleanDrain's last statement must be exactly drainLegsCompleted.push(container); found: ${last.getText()}`,
    ).toBe(true);
  });

  // Round 6 (R5-B1). Round 5's guard was a DENY-list (return/throw/try/if)
  // plus regexes over the helper's text. Every shape the round-5 review named
  // hollows it out with the fast lane green: `switch`, any loop, a labelled
  // break, an uncalled or swallowing arrow/function, `0 && expect(...)`, a
  // ternary, or a copy of the exit-"0" pin left in a comment or a string —
  // none of those trip a `return`/`throw`/`try`/`if` scan, and a comment or
  // string satisfies a text regex without the assertion ever running. An
  // ALLOW-list closes all of them at once: every top-level statement in the
  // body must be a plain declaration, the one permitted sleep, a real
  // `expect(...)` chain, or the final push — nothing else is even
  // syntactically capable of skipping an assertion, so there is no shape left
  // to enumerate.

  /** The exact permitted async-sleep shape: `new Promise((p) => setTimeout(p, PRE_TERM_MS))`. */
  function isPermittedPreTermPromise(expr: ts.Expression): boolean {
    if (!ts.isNewExpression(expr)) return false;
    if (!ts.isIdentifier(expr.expression) || expr.expression.text !== 'Promise') return false;
    const args = expr.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>);
    if (args.length !== 1) return false;
    const executor = args[0];
    if (!ts.isArrowFunction(executor)) return false;
    if (executor.parameters.length !== 1 || !ts.isIdentifier(executor.parameters[0].name)) {
      return false;
    }
    const param = executor.parameters[0].name.text;
    const body = executor.body;
    if (!ts.isCallExpression(body)) return false;
    if (!ts.isIdentifier(body.expression) || body.expression.text !== 'setTimeout') return false;
    if (body.arguments.length !== 2) return false;
    const [a0, a1] = body.arguments;
    return (
      ts.isIdentifier(a0) && a0.text === param && ts.isIdentifier(a1) && a1.text === 'PRE_TERM_MS'
    );
  }

  /** Unwraps a single leading `await`, if present. */
  function stripAwait(expr: ts.Expression): ts.Expression {
    return ts.isAwaitExpression(expr) ? expr.expression : expr;
  }

  interface ExpectChain {
    rootArgs: readonly ts.Expression[];
    matcherPath: string;
    matcherArgs: readonly ts.Expression[];
  }

  /**
   * Walks an `expect(...).a.b.c(...)` chain from the outside in. Returns null
   * — not an expect chain, for this test's purposes — if it is not rooted at
   * a bare `expect` identifier, if any link is optional (`?.`), or if `.soft`
   * appears anywhere, since a swallowed/soft assertion does not fail the run.
   */
  function parseExpectChain(expr: ts.Expression): ExpectChain | null {
    type Seg = { kind: 'call'; args: readonly ts.Expression[] } | { kind: 'prop'; name: string };
    const segs: Seg[] = [];
    let e: ts.Expression = expr;
    for (;;) {
      if (ts.isCallExpression(e)) {
        if (e.questionDotToken) return null;
        segs.push({ kind: 'call', args: e.arguments });
        e = e.expression;
        continue;
      }
      if (ts.isPropertyAccessExpression(e)) {
        if (e.questionDotToken) return null;
        if (e.name.text === 'soft') return null;
        segs.push({ kind: 'prop', name: e.name.text });
        e = e.expression;
        continue;
      }
      break;
    }
    if (!ts.isIdentifier(e) || e.text !== 'expect') return null;
    segs.reverse();
    const first = segs[0];
    if (!first || first.kind !== 'call') return null;
    const rest = segs.slice(1);
    const last = rest[rest.length - 1];
    if (!last || last.kind !== 'call') return null; // `expect(...)` with no matcher call at all
    const props = rest.slice(0, -1);
    if (props.some((s) => s.kind !== 'prop')) return null;
    return {
      rootArgs: first.args,
      matcherPath: props.map((s) => (s as { kind: 'prop'; name: string }).name).join('.'),
      matcherArgs: last.args,
    };
  }

  function isExpectStatement(expr: ts.Expression): boolean {
    return parseExpectChain(stripAwait(expr)) !== null;
  }

  function isDrainPush(expr: ts.Expression): boolean {
    if (!ts.isCallExpression(expr)) return false;
    if (!ts.isPropertyAccessExpression(expr.expression)) return false;
    if (!ts.isIdentifier(expr.expression.expression)) return false;
    if (expr.expression.expression.text !== 'drainLegsCompleted') return false;
    if (expr.expression.name.text !== 'push') return false;
    if (expr.arguments.length !== 1) return false;
    const arg = expr.arguments[0];
    return ts.isIdentifier(arg) && arg.text === 'container';
  }

  it('every top-level statement in assertCleanDrain is on an allow-list — a plain declaration, the one permitted sleep, a real expect(...) chain, or the final push (nothing else is syntactically able to skip an assertion)', () => {
    const { sourceFile, fn } = parsedHelper();
    const body = fn.body as ts.Block;
    const stmts = body.statements;
    const lineOf = (n: ts.Node) =>
      sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1;

    // 1) No function/arrow/method/accessor anywhere in the body except the
    // permitted sleep's own arrow. A switch/loop/labelled-break/if/try cannot
    // smuggle a skipped assertion behind an unreachable, uncalled, or
    // swallowing callback, because no callback is allowed to exist at all —
    // this closes the uncalled-arrow and nested-function rows directly,
    // without having to enumerate the wrapper shapes around them.
    let permittedPromiseNode: ts.Node | undefined;
    for (const stmt of stmts) {
      if (
        ts.isExpressionStatement(stmt) &&
        isPermittedPreTermPromise(stripAwait(stmt.expression))
      ) {
        permittedPromiseNode = stmt.expression;
      }
    }
    const badFns: string[] = [];
    const walkForFns = (n: ts.Node) => {
      if (n === permittedPromiseNode) return;
      if (
        ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) ||
        ts.isSetAccessorDeclaration(n)
      ) {
        badFns.push(`${ts.SyntaxKind[n.kind]} at line ${lineOf(n)}`);
        return; // its own body is irrelevant — the node itself is already disallowed
      }
      ts.forEachChild(n, walkForFns);
    };
    walkForFns(body);
    expect(
      badFns,
      `assertCleanDrain may not contain a function/arrow/method anywhere except the one permitted sleep:\n${badFns.join('\n')}`,
    ).toEqual([]);

    // 2) Every top-level statement's SHAPE is one of: a plain declaration,
    // the permitted sleep, an `expect(...)` chain, or the final push. Not
    // `switch`, not a loop of any kind, not a labelled statement, not `if`,
    // not `try`, not a bare block — any of those could wrap an assertion in
    // something that never actually runs it.
    const bad: string[] = [];
    stmts.forEach((stmt, i) => {
      const isLast = i === stmts.length - 1;
      if (ts.isVariableStatement(stmt)) return; // declarations only; function-freedom proven above
      if (ts.isExpressionStatement(stmt)) {
        const expr = stripAwait(stmt.expression);
        if (isPermittedPreTermPromise(expr)) return;
        if (isDrainPush(stmt.expression) && isLast) return;
        if (isExpectStatement(stmt.expression)) return;
      }
      bad.push(`${ts.SyntaxKind[stmt.kind]} at line ${lineOf(stmt)}`);
    });
    expect(
      bad,
      `assertCleanDrain has a statement that is not on the allow-list (declaration / the permitted sleep / an expect(...) chain / the final push):\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  it('the six assertions the helper is supposed to make are pinned on the AST — argument text plus matcher name — not by a text scan a comment or a string literal can satisfy', () => {
    const { sourceFile, fn } = parsedHelper();
    const body = fn.body as ts.Block;
    const facts: ExpectChain[] = [];
    for (const stmt of body.statements) {
      if (!ts.isExpressionStatement(stmt)) continue;
      const chain = parseExpectChain(stripAwait(stmt.expression));
      if (chain) facts.push(chain);
    }
    // Comments and string-literal contents are not statements, so a copy of
    // any pin left in either place cannot satisfy `facts` — only a real,
    // executing `expect(...)` chain can.
    const argText = (n: ts.Expression) => n.getText(sourceFile).replace(/\s+/g, ' ').trim();
    const has = (target: string, matcherPath: string, argIndex: number, argValue: string) =>
      facts.some(
        (f) =>
          f.rootArgs.length > 0 &&
          argText(f.rootArgs[0]) === target &&
          f.matcherPath === matcherPath &&
          f.matcherArgs.length > argIndex &&
          argText(f.matcherArgs[argIndex]) === argValue,
      );
    const pins: Array<[string, boolean]> = [
      ['the in-flight response status (200)', has('res.status', 'toBe', 0, '200')],
      [
        'the response body equality',
        facts.some(
          (f) =>
            f.rootArgs.length > 0 &&
            argText(f.rootArgs[0]) === 'await res.json()' &&
            f.matcherPath === 'toEqual',
        ),
      ],
      ['the exit-code parity check ("0")', has('waited.stdout.trim()', 'toBe', 0, '"0"')],
      ['the after() START marker', has('start', 'toBeGreaterThan', 0, '-1')],
      ['the after() RAN-after-START marker', has('done', 'toBeGreaterThan', 0, 'start')],
      ['the no-hardcap check', has('out', 'not.toContain', 0, 'HARDCAP_LOG')],
    ];
    const missing = pins.filter(([, found]) => !found).map(([name]) => name);
    expect(
      missing,
      `assertCleanDrain is missing assertions, pinned on the AST: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

describe('the CI path actually reaches the suite (both halves)', () => {
  it('the file the job names exists and is a container e2e', () => {
    const full = resolve(REPO_ROOT, E2E_PATH);
    expect(existsSync(full), `${E2E_PATH} does not exist`).toBe(true);
    expect(
      E2E_PATH,
      'the e2e must carry the `.docker-e2e.test.ts` suffix the fast lane excludes',
    ).toMatch(/\.docker-e2e\.test\.ts$/);
    // It must import bun:test (the runner the job uses), not vitest.
    const text = readFileSync(full, 'utf8');
    expect(text, 'the e2e must import bun:test').toMatch(/from ['"]bun:test['"]/);
  });
});
