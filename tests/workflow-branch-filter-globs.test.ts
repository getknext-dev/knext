import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * GUARD TESTS for GitHub Actions branch/tag trigger globs (#671).
 *
 * GitHub filter patterns define `*` as "zero or more characters, but **not**
 * the `/` character". So `branches: ['*']` matches `main` and misses **every**
 * slashed branch name — `chore/…`, `fix/…`, `feat/…`.
 *
 * For `pull_request`, `branches` filters the **base** branch. This repo's
 * normal working mode is stacked PRs, whose base is the previous unmerged
 * (slashed) branch. `.github/workflows/ci.yml` carried `branches: ['*']`, so
 * every stacked PR ran **zero** `ci.yml` jobs — no lint, no typecheck, no
 * operator tests, neither `bun-exec` gate. Measured on PR #583 (base
 * `chore/gitignore-agent-artifacts`): five checks, none from `ci.yml`, while
 * `install-smoke.yml` — which uses `['**']` — did run.
 *
 * The invariant locked in here, in two halves:
 *
 *   1. **Scanned, not enumerated.** No workflow, on any event, may use a
 *      filter element whose path segment is a bare `*`. Such a segment cannot
 *      match a `/`, so it silently under-matches this repo's slashed branch
 *      names. `**` is the intended spelling, and omitting the filter entirely
 *      is always fine. A new workflow copying the broken idiom reds without
 *      anyone remembering to add it to a list.
 *   2. **Targeted.** `ci.yml`'s `pull_request` trigger specifically must reach
 *      every base branch — either no `branches` key at all, or a filter that
 *      provably matches everything (`**`). Half 1 alone would stay green if
 *      someone narrowed it to `branches: [main]`, which reintroduces the exact
 *      defect by a different spelling.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');

const FILTER_KEYS = ['branches', 'branches-ignore', 'tags', 'tags-ignore'] as const;

type Filters = { workflow: string; event: string; key: string; patterns: string[] };

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

/**
 * Reads the `on:` block of a workflow. YAML 1.1 (which the `yaml` package
 * follows by default for plain scalars in this position) parses the unquoted
 * key `on` as the boolean `true`, so accept both spellings rather than relying
 * on which one the parser happened to produce.
 */
function triggerBlock(file: string): Record<string, unknown> | undefined {
  const doc = parse(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')) as Record<string, unknown>;
  const on = doc?.on ?? doc?.true;
  return on && typeof on === 'object' ? (on as Record<string, unknown>) : undefined;
}

/** Every branch/tag filter list across every workflow, in document order. */
function allFilters(): Filters[] {
  const found: Filters[] = [];
  for (const file of workflowFiles()) {
    const on = triggerBlock(file);
    if (!on) continue;
    for (const [event, cfg] of Object.entries(on)) {
      if (!cfg || typeof cfg !== 'object') continue;
      for (const key of FILTER_KEYS) {
        const patterns = (cfg as Record<string, unknown>)[key];
        if (!patterns) continue;
        found.push({
          workflow: file,
          event,
          key,
          patterns: (Array.isArray(patterns) ? patterns : [patterns]).map(String),
        });
      }
    }
  }
  return found;
}

/**
 * A pattern is slash-blind when any of its `/`-separated segments is exactly
 * `*`: that segment cannot match a `/`, so the pattern silently fails to match
 * any ref with a further slash at that position. `**` is fine; a literal name
 * is fine; `release*` is fine (it is a prefix match, not a whole-segment
 * wildcard); `*` and `release/*` are not.
 */
function slashBlindSegments(pattern: string): boolean {
  return pattern.split('/').some((segment) => segment === '*');
}

describe('GitHub Actions branch/tag trigger globs (#671)', () => {
  it('finds workflows to scan (the scan is not vacuously green)', () => {
    expect(workflowFiles().length).toBeGreaterThan(5);
  });

  it('no workflow filter uses a bare `*` segment — `*` does not match `/`', () => {
    const offenders = allFilters()
      .flatMap(({ workflow, event, key, patterns }) =>
        patterns
          .filter(slashBlindSegments)
          .map((p) => `${workflow}: on.${event}.${key} contains ${JSON.stringify(p)}`),
      )
      .sort();

    expect(
      offenders,
      'A `*` path segment in a GitHub filter cannot match `/`, so it skips every ' +
        'slashed branch (chore/…, fix/…). Use `**`, or omit the filter entirely.',
    ).toEqual([]);
  });

  it('ci.yml runs on pull requests against EVERY base branch, including slashed ones', () => {
    const on = triggerBlock('ci.yml');
    expect(on, 'ci.yml must declare triggers').toBeDefined();

    const pullRequest = on?.pull_request as Record<string, unknown> | null | undefined;
    expect(on).toHaveProperty('pull_request');

    const branches = pullRequest?.branches;
    if (branches === undefined) return; // no filter at all = every base branch

    const patterns = (Array.isArray(branches) ? branches : [branches]).map(String);
    // `**` matches every ref including slashed ones, so a list containing it
    // is equivalent to declaring no filter. Anything else narrows the gate.
    expect(
      patterns,
      "ci.yml's pull_request `branches` filter must be `['**']` (or absent). Any " +
        'narrower list means stacked PRs — whose base is a slashed branch — run ' +
        'no ci.yml job at all (#671).',
    ).toContain('**');
  });
});
