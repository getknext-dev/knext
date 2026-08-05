import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditBlockingGate } from './helpers/blocking-gate';

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
 * These assertions therefore guard the WIRING, not the behaviour. The CONTENT
 * half reads the job as TEXT (a SHA-pinned `uses:`, a script name); the "is this
 * job actually blocking?" half is PARSED — see `tests/helpers/blocking-gate.ts`
 * and #661, which measured the disarms a text anchor misses.
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

  it('runs unconditionally on a PR and its failure fails the run (#661)', () => {
    // PARSED, not text-matched — see tests/helpers/blocking-gate.ts. The text
    // form (a four-space-anchored `^ {4}if:` plus `continue-on-error:\s*true`)
    // let three single-edit disarms through with every other assertion here
    // green: a quoted `"if":` key, `continue-on-error: ${{ true }}`, and
    // `needs:` on a job that can skip. Enumerating three more patterns is the
    // same defect one level up, so this asks the semantic question of the
    // parsed workflow and FAILS CLOSED on any unrecognised job-level key.
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'bun-exec-alpine-image',
      gateCommand: /\btest:image\b/,
    });
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(audit.gateStepsSeen, 'the audit never found the step that runs `test:image`').toBe(1);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
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

/**
 * Renaming the suite is now part of the contract (the `*.docker-e2e.test.ts`
 * convention is what routes it to the right runner), and a rename leaves DEAD
 * POINTERS behind: when the suite took its current `.docker-e2e` name, ci.yml,
 * the README, the Dockerfile and this file were updated while `vite.config.ts`
 * and — worse — `vitest.image.config.ts`, the file that DEFINES the pattern,
 * kept naming the old file, which no longer exists.
 *
 * (This comment deliberately does not spell the old name out: under the scan
 * below, a historical mention IS a dead pointer, and it would fail here — as it
 * did on the first run of this guard.)
 *
 * Prose that names a non-existent file is not cosmetic here: these comments are
 * the only explanation of why the split exists, so a reader chasing the named
 * file finds nothing and concludes the guard is gone.
 *
 * SCANNED, not enumerated — the whole example tree PLUS the two files outside it
 * that name the suite (ci.yml and this file's sibling guard), so a stale pointer
 * in a file nobody listed still fails.
 */
describe('no stale test-file pointer survives a rename (both halves)', () => {
  const EXAMPLE = resolve(REPO_ROOT, 'examples/bun-exec');

  /**
   * Every tracked `*.test.ts` basename in the repo. A bare filename in prose
   * (`compile-cache-health-bun.test.ts`) carries no directory, so existence is
   * the only question that can honestly be asked of it — and asking it against
   * one guessed directory would fail on every correct reference to another.
   */
  function trackedTestBasenames(): Set<string> {
    const out = execFileSync('git', ['ls-files', '-z', '*.test.ts'], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((p) => p.split('/').pop() as string);
    // Non-vacuity: a collapsed file list would make every bare reference "valid".
    expect(
      out.length,
      'git ls-files found no test files — the index is not readable',
    ).toBeGreaterThan(50);
    return new Set(out);
  }

  /** Every text file in the example, minus build output and deps, + the outside namers. */
  function scannedFiles(): string[] {
    const out: string[] = [
      resolve(REPO_ROOT, '.github/workflows/ci.yml'),
      resolve(REPO_ROOT, 'tests/bun-exec-hardcap-ci.test.ts'),
      __filename,
    ];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.output', '.nitro', 'dist', '.next'].includes(entry.name)) continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs|js|md|sh|json)$|^Dockerfile/.test(entry.name)) out.push(full);
      }
    };
    walk(EXAMPLE);
    return out;
  }

  it('every `*.test.ts` a comment or doc names actually exists', () => {
    // Must start at a real token boundary, so neither glob fragments
    // (`**/*.docker-e2e.test.ts` — a PATTERN, not a path) nor a suffix of a
    // longer filename is mistaken for a file reference.
    const REF = /(?<![A-Za-z0-9._/*-])[A-Za-z0-9][A-Za-z0-9._/-]*\.test\.ts/g;
    const refs = new Map<string, string>(); // reference -> first file naming it

    for (const file of scannedFiles()) {
      for (const ref of readFileSync(file, 'utf8').match(REF) ?? []) {
        if (!refs.has(ref)) refs.set(ref, file);
      }
    }

    // BOTH HALVES. Without this, a scan that matched nothing — a broken regex, a
    // walk that skipped the tree — would pass by finding no stale pointer.
    expect(refs.size, 'the scan found no test-file references at all').toBeGreaterThan(3);
    expect(
      [...refs.keys()].some((r) => r.endsWith('alpine-image.docker-e2e.test.ts')),
      'the scan never saw the alpine e2e, so it is not reading the files it claims to',
    ).toBe(true);

    const basenames = trackedTestBasenames();
    for (const [ref, file] of refs) {
      // A reference WITH a path must resolve — relative to the example or to the
      // repo root. A BARE filename can only be checked for existence somewhere,
      // which is what the basename index is for.
      const ok = ref.includes('/')
        ? [resolve(EXAMPLE, ref), resolve(REPO_ROOT, ref)].some((c) => existsSync(c))
        : basenames.has(ref) || existsSync(resolve(EXAMPLE, 'test', ref));
      expect(ok, `${file} names ${ref}, which does not exist (stale pointer after a rename)`).toBe(
        true,
      );
    }
  });
});

/**
 * The alpine e2e reaps its own leaked artifacts on the next run, and the IMAGE
 * half of that sweep needs `--all` to do anything at all: `docker image prune`
 * without it removes only DANGLING images, and every image the suite leaks is
 * TAGGED (`knext-bunexec-alpine-e2e:<arch>-<runid>`), hence never dangling.
 * Measured on docker 29.4.0 with the suite's own label and `until=0s`, so age
 * could not be the excuse: without the flag, "Total reclaimed space: 0B" and
 * the image survives; with it, the image is deleted.
 *
 * That flag is therefore load-bearing and looks like tidiness, which is the
 * exact profile of a line a future edit drops in passing — and dropping it
 * fails SILENTLY: the sweep still runs, still exits 0, and reaps nothing while
 * ~150 MB leaks per aborted run. Nothing else in the tree would go red.
 *
 * BOTH HALVES, because a one-sided assertion is the defect class this suite has
 * spent five review rounds on: the sanctioned invocation must carry the flag,
 * AND no other `image prune` may exist in the example tree without it. The
 * second half is a SCAN rather than an enumeration, so a second sweep added
 * later cannot be the one nobody listed.
 *
 * Scoped to `examples/bun-exec` deliberately — unlike the stale-pointer scan
 * above it must NOT read this file, whose own regexes and prose contain the
 * very patterns it searches for.
 */
describe('the alpine e2e image sweep can actually reap (both halves)', () => {
  const EXAMPLE_DIR = resolve(REPO_ROOT, 'examples/bun-exec');
  const E2E = resolve(EXAMPLE_DIR, 'test/alpine-image.docker-e2e.test.ts');

  /** `run('docker', ['image', 'prune', …])` — the argv-array form the suite uses. */
  const ARGV_PRUNE = /\[\s*'image',\s*'prune'[^\]]*\]/g;
  /** `docker image prune …` — the shell form, in case a script or doc grows one. */
  const SHELL_PRUNE = /docker\s+image\s+prune[^\n;&|]*/g;

  function exampleTextFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.output', '.nitro', 'dist', '.next'].includes(entry.name)) continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs|js|md|sh|json|ya?ml)$|^Dockerfile/.test(entry.name)) out.push(full);
      }
    };
    walk(EXAMPLE_DIR);
    return out;
  }

  it('the sanctioned sweep passes --all, or it reaps nothing', () => {
    const src = readFileSync(E2E, 'utf8');
    const invocations = src.match(ARGV_PRUNE) ?? [];
    // Non-vacuity: a renamed helper or a reworked call shape must fail here
    // rather than let "no invocation found" read as "the flag is present".
    expect(
      invocations.length,
      'no `image prune` invocation in the alpine e2e — the image half of the leak sweep is gone',
    ).toBe(1);
    expect(
      invocations[0],
      'the image sweep dropped --all, so it reaps only DANGLING images and the suite leaks TAGGED ones',
    ).toContain("'--all'");
    // The filters are what bound the blast radius once `--all` is in play —
    // label scopes it to this suite, `until` spares a concurrent run.
    expect(invocations[0], 'the sweep is no longer scoped by label').toContain('label=');
    expect(invocations[0], 'the sweep is no longer bounded by age').toContain('until=');
  });

  it('NO `image prune` anywhere in the example omits --all', () => {
    let seen = 0;
    for (const file of exampleTextFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const call of [...(src.match(ARGV_PRUNE) ?? []), ...(src.match(SHELL_PRUNE) ?? [])]) {
        seen++;
        expect(
          /'--all'|\s--all\b|\s-a\b/.test(call),
          `${file} prunes images without --all, which removes only dangling images: ${call.trim()}`,
        ).toBe(true);
      }
    }
    // Non-vacuity: a broken regex or a walk that skipped the tree would
    // otherwise pass by finding nothing to check. Deliberately a floor, not an
    // exact count — a second, CORRECT sweep added later must not redden this,
    // or editing the guard becomes the routine way to get green.
    expect(
      seen,
      'the scan found no image-prune call at all — it is not reading the tree',
    ).toBeGreaterThan(0);
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
