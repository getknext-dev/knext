import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
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
    expect(runLine[0], 'the self-contained e2e step must pass --no-skip to bun-test.mjs').toMatch(
      /bun-test\.mjs\s+(?:\S+\s+)*--no-skip\b/,
    );
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

  it('bun-test.mjs --no-skip fails a file that skips or todos, and only under the flag', () => {
    const canaries: Record<string, string> = {
      todo: "it.todo('not run', () => {});",
      if: "it.if(false)('not run', () => {});",
      skip: "it.skip('not run', () => {});",
      clean: "it('runs', () => { expect(1).toBe(1); });",
    };
    const results: Record<string, { strict: number | null; lax: number | null; out: string }> = {};
    const written: string[] = [];
    try {
      for (const [kind, extra] of Object.entries(canaries)) {
        const rel = `tests/__no-skip-canary-${kind}.test.ts`;
        written.push(resolve(REPO_ROOT, rel));
        writeFileSync(
          resolve(REPO_ROOT, rel),
          [
            "import { expect, it } from 'bun:test';",
            "it('a real test', () => { expect(1).toBe(1); });",
            extra,
            '',
          ].join('\n'),
        );
        const run = (args: string[]) =>
          spawnSync('node', [resolve(REPO_ROOT, 'scripts/bun-test.mjs'), ...args, rel], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 300_000,
          });
        const strict = run(['--no-skip']);
        const lax = run([]);
        results[kind] = {
          strict: strict.status,
          lax: lax.status,
          out: `${strict.stdout}${strict.stderr}`,
        };
      }
    } finally {
      for (const f of written) rmSync(f, { force: true });
    }
    for (const kind of ['todo', 'if', 'skip']) {
      expect(
        results[kind].strict,
        `--no-skip let a file with it.${kind} pass:\n${results[kind].out}`,
      ).toBe(1);
      expect(results[kind].out).toContain('--no-skip:');
      // Without the flag bun itself exits 0 — so the flag is what reds it.
      expect(results[kind].lax, `without --no-skip, it.${kind} is expected to pass`).toBe(0);
    }
    expect(
      results.clean.strict,
      `--no-skip failed a file with nothing skipped:\n${results.clean.out}`,
    ).toBe(0);
  }, 300_000);
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
