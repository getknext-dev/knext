/**
 * root-typecheck-gate.test.ts — the guard for #527 (Sprint 1, T0).
 *
 * Vitest transpiles TypeScript with esbuild, which strips types WITHOUT
 * checking them. A root test file can therefore be fully green under
 * `vitest run` while `tsc` would reject it — and that has shipped twice
 * (PR #500's four implicit-`any`s; PR #526's `.map()`-may-return-undefined
 * plus a non-assignable type predicate). The per-package configs cover
 * `packages/*` and `apps/*`; the root `tests/` tier — the workflow guards,
 * the compat-lane ledger, the release-action pins, the e2e-deploy contracts —
 * was type-checked by no repo script and no CI job.
 *
 * This test pins the three halves of the fix so none can rot independently:
 *   1. a root typecheck tsconfig exists, at the strictness the per-package
 *      configs already use, and is scoped to root-level TS only;
 *   2. `tsc --showConfig` proves the root test files are ACTUALLY in the
 *      program — an `include` that silently matches nothing is the exact
 *      failure mode this issue is about, and it would produce a permanently
 *      green gate that checks nothing;
 *   3. a root `typecheck` script exists and CI runs it ALONGSIDE `Lint &
 *      Test` (its own job, no `needs:` on that job) so a type error fails as
 *      early as a lint error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { auditBlockingGate } from './helpers/blocking-gate';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const TSCONFIG = 'tsconfig.typecheck.json';
const TSCONFIG_PATH = join(REPO_ROOT, TSCONFIG);

/** Strip `//` line comments so JSONC configs parse (the repo writes them). */
function readJsonc(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Every `.ts` file under `dir`, recursively. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * The tiers this gate CLAIMS to cover, enumerated from the FILESYSTEM and
 * declared HERE rather than read back from `tsconfig.typecheck.json`.
 *
 * A guard that derives its expectation from its subject cannot notice the
 * subject shrinking: with the expectation read from `include`, dropping
 * `turbo/**\/*.ts` (or the three root `vitest.*.ts` entries) left every
 * assertion green — 34 files became 30, still over any count floor, and three
 * of the four declared scopes were unenforced.
 */
const COVERED_TIERS: Array<{ label: string; files: () => string[] }> = [
  { label: 'tests/**/*.ts', files: () => tsFilesUnder(join(REPO_ROOT, 'tests')) },
  { label: 'turbo/**/*.ts', files: () => tsFilesUnder(join(REPO_ROOT, 'turbo')) },
  {
    // vitest.workspace.ts is the one documented exclusion. NOTE: it is excluded
    // from TYPECHECK SCOPE, not because it is dead — the older note here claimed
    // it was dead code and safe to delete, which was measured and is false. On
    // vitest 4.0.18 it is still loaded and is what puts `apps/**` under happy-dom;
    // deleting it turns apps/file-manager/bun-portability.test.ts red. See the
    // corrected explanation in tsconfig.typecheck.json.
    label: 'root vitest.*.ts',
    files: () =>
      readdirSync(REPO_ROOT)
        .filter((f) => /^vitest\..+\.ts$/.test(f) && f !== 'vitest.workspace.ts')
        .map((f) => join(REPO_ROOT, f)),
  },
];

interface ShownConfig {
  compilerOptions?: Record<string, unknown>;
  files?: string[];
}

/**
 * Translate a tsconfig `include` glob into an anchored RegExp over
 * repo-relative POSIX paths. Only the two forms this config uses are
 * supported: `**\/` (zero or more directories) and `*` (within one segment).
 */
function globToRegExp(glob: string): RegExp {
  const DIRSTAR = '\u0000';
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, DIRSTAR)
    .replace(/\*/g, '[^/]*')
    // split/join rather than String.replaceAll: this file is itself checked by
    // the gate, whose `lib` is not guaranteed to carry ES2021.
    .split(DIRSTAR)
    .join('(?:[^/]+/)*');
  return new RegExp(`^${body}$`);
}

interface CiJob {
  key: string;
  body: string;
}

/**
 * The top-level jobs of ci.yml, each with its KEY CAPTURED.
 *
 * The key matters as much as the body: an earlier version of this file split
 * on the two-space indent and thereby consumed it, so every block started at
 * column 0 and `/^ {2}lint-and-test:/m.test(block)` could never be true —
 * a tautology that stayed green when the typecheck job was deleted and its
 * step inlined into `lint-and-test`. Keeping the key lets the assertions name
 * the job they mean instead of pattern-matching for its absence.
 */
function ciJobs(yml: string): CiJob[] {
  const jobsIdx = yml.indexOf('\njobs:');
  const jobs: CiJob[] = [];
  let current: CiJob | undefined;
  for (const line of yml
    .slice(jobsIdx + 1)
    .split('\n')
    .slice(1)) {
    // A column-0 non-comment key ends the `jobs:` mapping.
    if (/^[^\s#]/.test(line)) break;
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) {
      current = { key: key[1], body: `${line}\n` };
      jobs.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return jobs;
}

/** The command the gate step runs, matched against a PARSED `run:` value. */
const TYPECHECK_COMMAND = /(?:^|\s)pnpm run typecheck\b/;
/** The same step, matched against the raw YAML text of a job block. */
const TYPECHECK_RUN = /run:\s*pnpm run typecheck\b/;
/** The job that must own it. */
const TYPECHECK_JOB = 'typecheck-root';

let cachedShowConfig: ShownConfig | undefined;

/** `tsc --showConfig -p <cfg>` — the resolved program, not the raw file. */
function showConfig(): ShownConfig {
  if (cachedShowConfig) return cachedShowConfig;
  const stdout = execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--showConfig',
      '-p',
      TSCONFIG_PATH,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  cachedShowConfig = JSON.parse(stdout) as ShownConfig;
  return cachedShowConfig;
}

describe('root typecheck config (#527)', () => {
  it(`a root ${TSCONFIG} exists`, () => {
    expect(
      existsSync(TSCONFIG_PATH),
      `the root tests/ tier needs its own tsconfig — without one, nothing type-checks it`,
    ).toBe(true);
  });

  it('is strict, matching the strictest level the per-package configs already use', () => {
    const opts = showConfig().compilerOptions ?? {};
    // packages/{lib,db,kn-next}/tsconfig.json all set `strict: true`; the root
    // tier matches rather than inventing a new (weaker OR aspirational) baseline.
    expect(opts.strict).toBe(true);
    expect(opts.noEmit).toBe(true);
  });

  it('does NOT pull in package/app sources already checked by their own configs', () => {
    const files = (showConfig().files ?? []).map((f) => relative(REPO_ROOT, resolve(REPO_ROOT, f)));
    const overreach = files.filter(
      (f) => f.startsWith('packages/') || f.startsWith('apps/') || f.startsWith('examples/'),
    );
    expect(
      overreach,
      'an over-broad include produces duplicate/conflicting diagnostics against the per-package gates',
    ).toEqual([]);
  });
});

describe('the covered set is real, not an include that matches nothing (#527)', () => {
  it.each(COVERED_TIERS)('every $label file is in the tsc program', ({ label, files }) => {
    const onDisk = files();
    expect(
      onDisk.length,
      `no ${label} files on disk — this tier assertion would be vacuous`,
    ).toBeGreaterThan(0);
    const inProgram = new Set((showConfig().files ?? []).map((f) => resolve(REPO_ROOT, f)));
    const missing = onDisk.filter((f) => !inProgram.has(f)).map((f) => relative(REPO_ROOT, f));
    expect(
      missing,
      `these ${label} files are type-checked by nothing — the include does not reach them`,
    ).toEqual([]);
  });

  it('the program is non-trivially populated (a silently-empty include is the failure mode)', () => {
    const files = showConfig().files ?? [];
    expect(files.length).toBeGreaterThanOrEqual(25);
  });

  it('EVERY include entry contributes at least one file — not just tests/**', () => {
    // A file-count floor only covers the biggest entry: dropping `turbo/**/*.ts`
    // or the three `vitest.*.ts` entries still leaves 30 files, comfortably over
    // any floor, so three quarters of the declared scope was unguarded. Assert
    // per-entry instead: an include the program never reaches is dead scope.
    const include = (readJsonc(TSCONFIG_PATH).include ?? []) as string[];
    expect(include.length).toBeGreaterThanOrEqual(4);
    const files = (showConfig().files ?? []).map((f) =>
      relative(REPO_ROOT, resolve(REPO_ROOT, f)).split(sep).join('/'),
    );
    const barren = include.filter((entry) => !files.some((f) => globToRegExp(entry).test(f)));
    expect(
      barren,
      'these tsconfig `include` entries match nothing in the program — the scope they claim is not actually checked',
    ).toEqual([]);
  });
});

describe('root typecheck script + CI wiring (#527)', () => {
  const pkg = readJsonc(join(REPO_ROOT, 'package.json')) as {
    scripts?: Record<string, string>;
  };
  const ciYml = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('the root package.json has a `typecheck` script pointed at the root config', () => {
    const script = pkg.scripts?.typecheck;
    expect(script, 'root `pnpm typecheck` must exist').toBeTypeOf('string');
    expect(script).toContain(TSCONFIG);
  });

  it('ci.yml runs the root typecheck', () => {
    expect(/run:\s*pnpm run typecheck\b/.test(ciYml)).toBe(true);
  });

  it('it runs ALONGSIDE Lint & Test — its own job, not gated behind it', () => {
    // Assert on the job KEY, not on the absence of a pattern inside a block:
    // if the step is inlined into `lint-and-test`, the owning key changes and
    // this fails by naming the wrong job. (The previous form of this assertion
    // matched `/^ {2}lint-and-test:/m` against a block whose indent had already
    // been consumed by the split — it could never fire.)
    const owners = ciJobs(ciYml)
      .filter((job) => TYPECHECK_RUN.test(job.body))
      .map((job) => job.key);
    expect(
      owners,
      `the root typecheck must run in exactly one top-level job, \`${TYPECHECK_JOB}\` — not as a step inside lint-and-test (or any other job)`,
    ).toEqual([TYPECHECK_JOB]);

    const job = ciJobs(ciYml).find((j) => j.key === TYPECHECK_JOB);
    expect(
      /^ {4}needs:/m.test(job?.body ?? ''),
      'the typecheck job must not `needs:` another job — it runs alongside Lint & Test so a type error fails as early as a lint error',
    ).toBe(false);
  });

  it('runs unconditionally on a PR and its failure fails the run (#661)', () => {
    // "A CI job that runs but is not required to pass" is the second way this
    // gate becomes decoration. Branch protection is configured OUTSIDE the repo
    // (main currently has NO required checks at all, which is a repo-wide gap,
    // not a T0-specific one). What IS enforceable from in here is that the job
    // stays fail-closed.
    //
    // PARSED, not text-matched (#672). The predecessor of this assertion read
    // the job's LINES for `/continue-on-error/` and `/\n\s{4}if:/`, and #672
    // measured it GREEN under a quoted `"if": false` key (an exactly equivalent
    // YAML mapping key the four-space anchor does not match) and under a
    // job-level `strategy:` whose matrix can expand to zero jobs. The audit asks
    // the semantic question of the parsed workflow and FAILS CLOSED on any
    // job-level key it does not recognise, so the next form nobody enumerated
    // reddens instead of passing.
    const audit = auditBlockingGate({
      workflowPath: join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
      jobId: TYPECHECK_JOB,
      gateCommand: TYPECHECK_COMMAND,
    });
    // Non-vacuity: an audit that parsed nothing must not pass by finding no
    // problem to report, and the job must really be the one running `tsc`.
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(
      audit.gateStepsSeen,
      `the \`${TYPECHECK_JOB}\` job must be the one that runs the root typecheck`,
    ).toBe(1);
    // Also the machine-checked half of "it runs ALONGSIDE Lint & Test": an empty
    // closure beyond itself is exactly "no `needs:`", asserted by the walk
    // rather than by a regex over the block.
    expect(audit.needsClosure, 'the `needs` closure the audit walked').toEqual([TYPECHECK_JOB]);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });
});

/**
 * The gate above proves the root tests are IN the tsc program. This one proves
 * the program can be BUILT on a machine that is not this one.
 *
 * A bare specifier that resolves only because pnpm hoisted it for some other
 * workspace package is a PHANTOM dependency: `tsc` and `vitest` both find it in
 * a local checkout and both fail in CI, where the hoist is not guaranteed. That
 * is not hypothetical — `import { parse } from 'yaml'` landed in
 * `tests/operator-image-pin-resolution.test.ts` while the root manifest had no
 * `yaml`. It reddened BOTH `Typecheck (root tests/)` (TS2307) and `Lint & Test`
 * ("Failed to resolve import"), and because a module-level import fails the
 * whole file, it took that entire suite offline — including the guards that were
 * the point of the PR.
 *
 * Scanned in both dimensions: every `.ts` under `tests/` is read from disk (a
 * new file cannot dodge this by not being on a list) and every bare specifier in
 * it is resolved against the root manifest.
 */
describe('the root test tree imports only DECLARED root dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  const builtin = new Set(builtinModules);

  /** `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
  const packageName = (specifier: string): string => {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
  };

  /**
   * Every module specifier in `source`, from static and dynamic imports alike.
   *
   * TypeScript's own pre-processor, not a regex. These files write FIXTURE
   * sources into template literals (`import x from 'next'` inside a string that
   * is written to a temp dir), and a regex cannot tell that from a real import —
   * it reported six false positives on the first run. `preProcessFile` runs the
   * real scanner, for which a template literal is one token.
   */
  const specifiersIn = (source: string): string[] =>
    ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);

  const files = tsFilesUnder(join(REPO_ROOT, 'tests'));

  it('the scan itself finds files and specifiers — an empty scan proves nothing', () => {
    // Both halves. Without this a broken walk (or a broken regex) would report
    // "no undeclared imports" forever, which is the permanently-green gate this
    // file's own header warns about.
    expect(files.length).toBeGreaterThan(20);
    const all = files.flatMap((f) => specifiersIn(readFileSync(f, 'utf8')));
    expect(all).toContain('vitest');
    expect(all.some((s) => s.startsWith('node:'))).toBe(true);
    expect(all.some((s) => s.startsWith('.'))).toBe(true);
  });

  it.each(files.map((f) => [relative(REPO_ROOT, f), f]))('%s', (label, file) => {
    const undeclaredHere = specifiersIn(readFileSync(file, 'utf8'))
      .filter((s): s is string => typeof s === 'string')
      .filter((s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:'))
      .map(packageName)
      .filter((name) => !builtin.has(name) && !declared.has(name));
    expect(
      [...new Set(undeclaredHere)],
      `${label} imports package(s) that the ROOT package.json does not declare. ` +
        'They resolve here only because pnpm hoisted them for another workspace ' +
        'package; CI has no such hoist and both tsc and vite will fail.',
    ).toEqual([]);
  });
});
