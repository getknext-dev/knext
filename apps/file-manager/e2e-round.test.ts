// @vitest-environment node
//
// #1197 / T1 — guards for the named file-manager e2e round.
//
// The round is a NAME + entry point over checks that already gate every PR, plus
// the CI aggregator that asserts they all went green. These are the guards that
// keep the name honest:
//
//   1. SYNC — the leg registry and the ci.yml aggregator's `needs:` list are ONE
//      source of truth. Drift in either direction reds. Scanned, not enumerated.
//   2. FAIL-CLOSED — the aggregator's decision core sees an upstream RED as a
//      failure, never a skip/neutral. Proven with a failing-result fixture.
//   3. PATH-SCOPE — a runtime-path diff MUST trigger the round; a docs-only diff
//      reports N/A. The scope cannot swallow everything.
//   4. INVALIDATION — leg 4's 401-without-token security assertion is provable
//      without a live server (the auth-removed case reds).

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide } from './scripts/e2e-round-aggregate.mjs';
import { AGGREGATOR_NEEDS, LEGS, LOCAL_LEGS } from './scripts/e2e-round-legs.mjs';
import { appAffectingFiles, isAppAffecting } from './scripts/e2e-round-paths.mjs';
import { assertInvalidation } from './scripts/invalidation-probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CI_YML = path.resolve(HERE, '../../.github/workflows/ci.yml');

/**
 * Extract the `file-manager-e2e-round` job block from ci.yml, and its `needs:`
 * list — by SCANNING the YAML text (not a hand-copied enumeration). The job block
 * is everything from its key at 2-space indent up to the next 2-space-indent key.
 */
function readAggregatorJob(): string {
  const yml = readFileSync(CI_YML, 'utf8');
  const m = yml.match(/^ {2}file-manager-e2e-round:\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m);
  if (!m) throw new Error('ci.yml: file-manager-e2e-round job not found');
  return m[0];
}

function parseNeeds(jobBlock: string): string[] {
  // `needs: [a, b, c]` — inline array form.
  const m = jobBlock.match(/\n {4}needs:\s*\[([^\]]*)\]/);
  if (!m) throw new Error('ci.yml: file-manager-e2e-round has no inline `needs: [...]`');
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

describe('#1197 sync — leg registry ⇔ ci.yml aggregator needs', () => {
  it('the aggregator needs list is exactly the registry-derived CI jobs', () => {
    const job = readAggregatorJob();
    const declared = parseNeeds(job);
    // Both directions: a leg with a ciJob missing from needs, or a need with no
    // backing leg, is drift and reds here.
    expect(declared).toEqual([...AGGREGATOR_NEEDS]);
  });

  it('every registry ciJob is non-empty and unique', () => {
    const jobs = LEGS.map((l) => l.ciJob).filter((j): j is string => j !== null);
    expect(new Set(jobs).size).toBe(jobs.length);
    expect(jobs.every((j) => j.length > 0)).toBe(true);
  });

  it('the local orchestrator runs at least the compat-smoke and invalidation legs', () => {
    const ids = LOCAL_LEGS.map((l) => l.id);
    expect(ids).toContain('compat-smoke');
    expect(ids).toContain('invalidation-probe');
  });
});

describe('#1197 aggregator is fail-closed (if: always + explicit needs.*.result)', () => {
  it('the ci.yml job uses `if: always()` and reads needs.*.result — not bare needs', () => {
    const job = readAggregatorJob();
    expect(job).toMatch(/\n {4}if:\s*always\(\)/);
    // At least one upstream result is threaded in explicitly.
    expect(job).toMatch(/needs\.[a-z0-9-]+\.result/);
  });

  it('has a merge_group no-op branch so the queue does not freeze', () => {
    const yml = readFileSync(CI_YML, 'utf8');
    expect(yml).toMatch(/^ {2}merge_group:/m);
  });

  it('decide() FAILS (non-zero) when an upstream need did not succeed', () => {
    const results = Object.fromEntries(AGGREGATOR_NEEDS.map((j) => [j, 'success']));
    results[AGGREGATOR_NEEDS[0]] = 'failure';
    const out = decide({ results, changedFiles: ['apps/file-manager/src/app/page.tsx'] });
    expect(out.status).toBe('fail');
    expect(out.code).toBe(1);
  });

  it('decide() treats a SKIPPED/missing upstream as red, not neutral', () => {
    const results = Object.fromEntries(AGGREGATOR_NEEDS.map((j) => [j, 'success']));
    results[AGGREGATOR_NEEDS[1]] = 'skipped';
    const out = decide({ results, changedFiles: ['packages/kn-next/src/adapters/x.ts'] });
    expect(out.code).toBe(1);
    // and a totally-absent result is also red
    const missing = { ...results };
    delete missing[AGGREGATOR_NEEDS[1]];
    expect(decide({ results: missing, changedFiles: ['apps/file-manager/x.ts'] }).code).toBe(1);
  });

  it('a scoped-out (N/A) diff STILL fails closed if an upstream leg is red', () => {
    // Latent false-green: a docs-only diff must not green over a red leg. The
    // N/A short-circuit must not return before the results are checked.
    const results = Object.fromEntries(AGGREGATOR_NEEDS.map((j) => [j, 'failure']));
    const out = decide({ results, changedFiles: ['docs/x.md', 'README.md'] });
    expect(out.code).toBe(1);
    expect(out.status).toBe('fail');
  });

  it('a scoped-out (N/A) diff with all legs green is N/A green', () => {
    const results = Object.fromEntries(AGGREGATOR_NEEDS.map((j) => [j, 'success']));
    const out = decide({ results, changedFiles: ['docs/x.md', 'README.md'] });
    expect(out.code).toBe(0);
    expect(out.status).toBe('n/a');
  });

  it('decide() PASSES only when every gated need is success', () => {
    const results = Object.fromEntries(AGGREGATOR_NEEDS.map((j) => [j, 'success']));
    const out = decide({ results, changedFiles: ['apps/file-manager/src/app/page.tsx'] });
    expect(out.status).toBe('pass');
    expect(out.code).toBe(0);
  });
});

describe('#1197 path scope cannot swallow everything', () => {
  it('a runtime/adapter path IS app-affecting (round must run, not N/A)', () => {
    expect(isAppAffecting('packages/kn-next/src/adapters/node-server.ts')).toBe(true);
    expect(isAppAffecting('apps/file-manager/src/app/page.tsx')).toBe(true);
    expect(isAppAffecting('packages/kn-next-operator/internal/controller/x.go')).toBe(true);
    expect(isAppAffecting('apps/file-manager/Dockerfile')).toBe(true);
    expect(isAppAffecting('packages/kn-next/src/config.ts')).toBe(true);
  });

  it('the SHIP TARGET + bundled libs + loader ARE app-affecting (not N/A)', () => {
    // The bun single-executable ship target and the project build glue — the
    // `startsWith('.../cli/build')` predicate misses vinext-build.ts, so the
    // aggregator falsely reported N/A for a change to the ship target.
    expect(isAppAffecting('packages/kn-next/src/cli/vinext-build.ts')).toBe(true);
    expect(isAppAffecting('packages/kn-next/src/cli/project-build.ts')).toBe(true);
    expect(isAppAffecting('packages/kn-next/src/cli/build.ts')).toBe(true);
    // libs bundled INTO the app (leg 1: "lib → db → core → file-manager").
    expect(isAppAffecting('packages/lib/src/cache-handler.ts')).toBe(true);
    expect(isAppAffecting('packages/db/src/pool.ts')).toBe(true);
    // the runtime loader.
    expect(isAppAffecting('packages/kn-next/src/loader.ts')).toBe(true);
  });

  it('a docs/CI/script-only path is NOT app-affecting (N/A)', () => {
    expect(isAppAffecting('docs/adr/0054-x.md')).toBe(false);
    expect(isAppAffecting('README.md')).toBe(false);
    expect(isAppAffecting('.claude/rules/workflow.md')).toBe(false);
    expect(appAffectingFiles(['docs/x.md', 'README.md'])).toEqual([]);
  });

  it('decide() reports N/A green on a docs-only diff, and asserts on a runtime diff', () => {
    const allGreen = Object.fromEntries(AGGREGATOR_NEEDS.map((j) => [j, 'success']));
    const docsOnly = decide({ results: allGreen, changedFiles: ['docs/x.md', 'README.md'] });
    expect(docsOnly.status).toBe('n/a');
    expect(docsOnly.code).toBe(0);

    // Same all-green results, but a runtime diff → it actually asserts (pass here,
    // but NOT N/A — the scope did not swallow it).
    const runtime = decide({
      results: allGreen,
      changedFiles: ['packages/kn-next/src/adapters/node-server.ts'],
    });
    expect(runtime.status).toBe('pass');
    // and if a need had been red on that same diff, it would fail:
    const oneRed = { ...allGreen, [AGGREGATOR_NEEDS[0]]: 'failure' };
    expect(
      decide({ results: oneRed, changedFiles: ['packages/kn-next/src/adapters/node-server.ts'] })
        .code,
    ).toBe(1);
  });
});

describe('#1197 invalidation-probe — 401 without token is enforced', () => {
  const fp = (ts: string[]) => ({ timestamps: ts });

  it('passes when unauth=401, auth=200 and the cache busted', () => {
    const v = assertInvalidation({
      unauthStatus: 401,
      authStatus: 200,
      before: fp(['2026-01-01T00:00:00.000Z']),
      after: fp(['2026-01-01T00:00:01.000Z']),
    });
    expect(v.ok).toBe(true);
  });

  it('REDS when the unauthenticated POST is not rejected (auth check removed)', () => {
    const v = assertInvalidation({
      unauthStatus: 200,
      authStatus: 200,
      before: fp([]),
      after: fp([]),
    });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toMatch(/401/);
  });

  it('REDS when the authenticated POST does not succeed', () => {
    const v = assertInvalidation({
      unauthStatus: 401,
      authStatus: 500,
      before: fp([]),
      after: fp([]),
    });
    expect(v.ok).toBe(false);
  });
});
