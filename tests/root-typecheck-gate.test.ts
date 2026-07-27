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
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

/** Every tracked `.ts` file directly under the root `tests/` tree. */
function rootTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(join(REPO_ROOT, 'tests'));
  return out;
}

interface ShownConfig {
  compilerOptions?: Record<string, unknown>;
  files?: string[];
}

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
  it('every root tests/**/*.ts file is in the tsc program', () => {
    const inProgram = new Set((showConfig().files ?? []).map((f) => resolve(REPO_ROOT, f)));
    const missing = rootTestFiles()
      .filter((f) => !inProgram.has(f))
      .map((f) => relative(REPO_ROOT, f));
    expect(
      missing,
      'these root test files are type-checked by nothing — the include does not reach them',
    ).toEqual([]);
  });

  it('the program is non-trivially populated (a silently-empty include is the failure mode)', () => {
    const files = showConfig().files ?? [];
    expect(files.length).toBeGreaterThanOrEqual(25);
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
    // Extract the top-level job blocks (2-space-indented keys under `jobs:`).
    const jobsSection = ciYml.slice(ciYml.indexOf('\njobs:'));
    const blocks = jobsSection.split(/\n {2}(?=[a-z0-9-]+:\n)/);
    const typecheckBlock = blocks.find((b) => /run:\s*pnpm run typecheck\b/.test(b));
    expect(typecheckBlock, 'the root typecheck must live in its own top-level job').toBeDefined();
    expect(
      /^ {2}lint-and-test:/m.test(typecheckBlock ?? ''),
      'the root typecheck must NOT be a step inside the lint-and-test job',
    ).toBe(false);
    expect(
      /\n\s*needs:/.test(typecheckBlock ?? ''),
      'the typecheck job must not `needs:` another job — it runs alongside Lint & Test so a type error fails as early as a lint error',
    ).toBe(false);
  });
});
