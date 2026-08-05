import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0042 A9 — the alpine-image e2e has no skip path; this asserts it has
 * somewhere to run.
 *
 * `examples/bun-exec/test/alpine-image.docker-e2e.test.ts` fails (rather than skips)
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

/**
 * BOTH HALVES. The block above proves the job calls `test:image`. On its own that
 * is half a scan: nothing said `test:image` still reaches the suite. Editing the
 * script in `examples/bun-exec/package.json`, or excluding the suite from the
 * image config, disarms the only thing that runs the alpine e2e while every
 * assertion above, the Dockerfile assertions and the fast suite all stay green.
 * (Deleting or renaming the test file IS already covered — vitest exits 1 when a
 * config's include matches nothing. The script and config CONTENT was not.)
 *
 * The chain asserted here, end to end:
 *   ci.yml job -> `bun run test:image` -> vitest.image.config.ts
 *   -> include `*.docker-e2e.test.ts` -> a file matching it exists
 * plus the root-run exclude that keeps that same pattern out of `Lint & Test`.
 */
describe('the `test:image` chain actually reaches the suite (both halves)', () => {
  const EXAMPLE = resolve(REPO_ROOT, 'examples/bun-exec');
  const PATTERN = 'docker-e2e';

  it('the `test:image` script runs the image vitest config', () => {
    const pkg = JSON.parse(readFileSync(resolve(EXAMPLE, 'package.json'), 'utf8'));
    const script: string = pkg.scripts?.['test:image'] ?? '';
    expect(script, 'examples/bun-exec has no `test:image` script for the CI job to run').toMatch(
      /vitest run/,
    );
    expect(script, '`test:image` does not point at vitest.image.config.ts').toMatch(
      /--config\s+vitest\.image\.config\.ts/,
    );
    expect(existsSync(resolve(EXAMPLE, 'vitest.image.config.ts'))).toBe(true);
  });

  it('the image config INCLUDES the container-e2e pattern and does not exclude it', () => {
    const cfg = readFileSync(resolve(EXAMPLE, 'vitest.image.config.ts'), 'utf8');
    const include = cfg.match(/include:\s*\[([^\]]*)\]/)?.[1] ?? '';
    expect(include, `the image config's include does not match *.${PATTERN}.test.ts`).toContain(
      PATTERN,
    );
    // An exclude of the very pattern it includes would leave `test:image`
    // running zero container tests while exiting 0 on some other file.
    const exclude = cfg.match(/exclude:\s*\[([^\]]*)\]/)?.[1] ?? '';
    expect(exclude, 'the image config excludes the pattern it includes').not.toContain(PATTERN);
  });

  it('at least one container e2e file matches that pattern', () => {
    // Non-vacuity for the whole chain: an include that matches nothing is a
    // green job that ran no test.
    const files = readdirSync(resolve(EXAMPLE, 'test')).filter((f) =>
      f.endsWith(`.${PATTERN}.test.ts`),
    );
    expect(files.length, `no *.${PATTERN}.test.ts in examples/bun-exec/test`).toBeGreaterThan(0);
  });

  it('the ROOT vitest run excludes the pattern, so `Lint & Test` cannot collect it', () => {
    // The example-local exclude only applies when vitest's cwd is that example.
    // The root run (`pnpm exec vitest run --coverage`, job `Lint & Test`)
    // collects `examples/**`, and this suite has NO skip path — so without this
    // entry it runs `./build.sh` on a runner with no bun and reddens the main
    // gate for an unrelated reason. Verified before the fix: `vitest list
    // --filesOnly` listed examples/bun-exec/test/alpine-image.docker-e2e.test.ts.
    const rootCfg = readFileSync(resolve(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    const exclude = rootCfg.match(/exclude:\s*\[([^\]]*)\]/)?.[1] ?? '';
    expect(exclude, 'the ROOT vitest config does not exclude the container e2e pattern').toContain(
      PATTERN,
    );
  });

  it('the example fast suite also excludes it, so `bun run test` stays fast', () => {
    const cfg = readFileSync(resolve(EXAMPLE, 'vitest.config.ts'), 'utf8');
    const exclude = cfg.match(/exclude:\s*\[([^\]]*)\]/)?.[1] ?? '';
    expect(exclude).toContain(PATTERN);
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

  it('pins its base image by digest', () => {
    // scripts/check-base-images-pinned.sh (CI: base-image-pin-guard) is the
    // enforcing gate and SCANS every Dockerfile*, so this file is covered there
    // too. Asserted here as well because this Dockerfile is what the README
    // calls the reference ship image, next to a "cosign-signed, digest-pinned"
    // claim — a floating tag here is a security.md violation, not a style nit.
    const froms = dockerfile.match(/^FROM\s+\S+/gm) ?? [];
    expect(froms.length, 'no FROM line in the reference Dockerfile').toBeGreaterThan(0);
    for (const from of froms) {
      expect(from, `floating base image: ${from}`).toContain('@sha256:');
    }
  });
});
