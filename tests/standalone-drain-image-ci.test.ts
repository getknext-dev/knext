import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
