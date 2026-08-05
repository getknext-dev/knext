import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0042 A9 — the alpine-image e2e has no skip path; this asserts it has
 * somewhere to run.
 *
 * `examples/bun-exec/test/alpine-image-e2e.test.ts` fails (rather than skips)
 * when docker or bun is missing, which is the right shape. But it is
 * deliberately EXCLUDED from the example's default `bun run test` — it compiles
 * a ~100 MB binary and builds a container — so the only thing that ever runs it
 * is the `bun-exec-alpine-image` job. Delete that job and the suite becomes
 * unreachable: nothing turns red, and the `apk add libstdc++ libgcc` line it
 * protects could be dropped again with the same silence that let ADR-0036 ship
 * an image row describing a container that exits 127.
 *
 * These assertions therefore guard the WIRING, not the behaviour. Read as TEXT
 * for the same reason `tests/bun-exec-hardcap-ci.test.ts` does: the root package
 * has no direct `yaml` dependency.
 */

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const JOB_KEY = 'bun-exec-alpine-image:';

/** The job's own lines, bounded by the next top-level job key. */
function jobBlock(): string {
  const raw = readFileSync(CI_YML, 'utf8');

  // Non-vacuity: an unreadable or restructured workflow must not let every
  // assertion below pass by absence.
  expect(raw.length, 'ci.yml is empty or unreadable').toBeGreaterThan(1000);
  expect(raw, 'ci.yml no longer looks like a workflow').toMatch(/^jobs:/m);

  const start = raw.indexOf(`  ${JOB_KEY}`);
  expect(start, `no ${JOB_KEY} job in ci.yml`).toBeGreaterThan(-1);

  const rest = raw.slice(start + JOB_KEY.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('bun-exec alpine-image gate is wired into CI (ADR-0042 A1/A9)', () => {
  it('runs the image suite, not the fast one', () => {
    // `bun run test` would NOT run it — the config excludes it. Only the
    // dedicated script does.
    expect(jobBlock(), 'the job never runs `test:image`, so the alpine e2e is unreachable').toMatch(
      /test:image/,
    );
  });

  it('installs bun, which the suite needs to compile the binary', () => {
    expect(jobBlock(), 'the job never installs bun').toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/);
  });

  it('runs in examples/bun-exec, where the Dockerfile and build.sh live', () => {
    expect(jobBlock(), 'the job does not run in examples/bun-exec').toMatch(
      /working-directory:\s*examples\/bun-exec/,
    );
  });

  it('does not disarm itself with continue-on-error', () => {
    expect(
      jobBlock(),
      'the alpine-image job is continue-on-error, so it cannot fail the workflow',
    ).not.toMatch(/continue-on-error:\s*true/);
  });
});

describe('the reference image keeps the C++ runtime libraries (ADR-0042 A9)', () => {
  const dockerfile = readFileSync(resolve(REPO_ROOT, 'examples/bun-exec/Dockerfile'), 'utf8');

  it('installs libstdc++ and libgcc', () => {
    // Cheap, static echo of what the e2e proves dynamically — this one fails in
    // seconds on a PR, before anyone waits for a container to exit 127.
    expect(dockerfile, 'the musl binary will fail to load without libstdc++').toMatch(
      /^RUN apk add .*libstdc\+\+/m,
    );
    expect(dockerfile, 'the musl binary will fail to load without libgcc').toMatch(
      /^RUN apk add .*libgcc/m,
    );
  });

  it('does not ship .output/server — the routes are embedded in the binary', () => {
    expect(dockerfile).not.toMatch(/COPY\s+\.output\/server/);
  });
});
