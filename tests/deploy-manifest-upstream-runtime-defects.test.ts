import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FAMILY_QUARANTINE_CAP } from './compat-quarantine-bounds';
import {
  type LedgerContext,
  entryProblems,
  ledgerProblems,
  parseUpstreamRuntimeDefects,
  UPSTREAM_RUNTIME_DEFECT_CAP,
  UPSTREAM_RUNTIME_DEFECT_KEY,
  type UpstreamRuntimeDefect,
} from './compat-upstream-runtime-defects';

/**
 * ADR-0007 amendment (2026-10-12): the lane-scoped "upstream runtime defect"
 * ledger. It is NOT a quarantine: the file keeps running on its lane, the entry
 * records that the red is triaged, has a named upstream cause and fix, and has a
 * removal condition. It is not counted toward the §h family cap.
 *
 * Every guard below is mutation-proved by exit code in
 * scripts/mutation-prove-upstream-runtime-defects.mjs.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MAIN = resolve(REPO_ROOT, 'test/deploy-tests-manifest.knext.json');
const SMOKE = resolve(REPO_ROOT, 'test/deploy-tests-manifest.smoke.knext.json');

// An unreadable manifest THROWS here, at collection: the spec fails, it never
// reads as an empty ledger with nothing to enforce.
const mainText = readFileSync(MAIN, 'utf8');
const smokeText = readFileSync(SMOKE, 'utf8');
const ledger = parseUpstreamRuntimeDefects(mainText);
const manifest = JSON.parse(mainText) as {
  rules: { include: string[]; exclude: string[] };
  $knextQuarantines: { test: string; family?: string; level?: string }[];
  $knextExclusions: { test: string }[];
};

/** Does manifest pattern `p` drop file `f`? Exact, or a `dir/**` / `dir/**\/*` prefix. */
function covers(p: string, f: string): boolean {
  if (p === f) return true;
  const m = p.match(/^(.*?)\/\*\*(?:\/\*)?$/);
  return m !== null && f.startsWith(`${m[1]}/`);
}

/** The real repository, for the shipped entries. */
const repoCtx: LedgerContext = {
  exists: (p) => existsSync(resolve(REPO_ROOT, p)),
  read: (p) => {
    try {
      return readFileSync(resolve(REPO_ROOT, p), 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** A fake repository for the guard unit tests: one guard file with one symbol. */
const fakeCtx: LedgerContext = {
  exists: (p) => p === 'packages/x/guard.ts',
  read: (p) => (p === 'packages/x/guard.ts' ? 'export function assertGuard() {}' : undefined),
};

const valid: UpstreamRuntimeDefect = {
  test: 'test/e2e/app-dir/x/x.test.ts',
  lane: 'bun/turbopack',
  nextjsRef: 'v16.4.0',
  cases: ['a case'],
  mechanism: 'a mechanism',
  evidence: 'run 38181750458 (bun x turbopack): FINAL 3/3',
  upstream: { issue: 'oven-sh/bun#45007', fix: 'oven-sh/bun#45010' },
  knextRefusal:
    'packages/x/guard.ts#assertGuard — refuses the config (https://github.com/getknext-dev/knext/pull/2226)',
  removeWhen: 'a Bun release containing oven-sh/bun#45010',
  provenance: 'https://github.com/getknext-dev/knext/issues/2225',
};

describe('upstream-runtime-defect ledger — the shipped entries', () => {
  it('holds the two bun x turbopack fragment files, scoped to that one lane', () => {
    expect(ledger.map((e) => e.test).sort()).toEqual([
      'test/e2e/app-dir/treeshake-mw/mw.test.ts',
      'test/e2e/app-dir/turbopack-tree-shaking-chunkgroup/turbopack-tree-shaking-chunkgroup.test.ts',
    ]);
    for (const e of ledger) expect(e.lane).toBe('bun/turbopack');
  });

  it('every entry is admissible: lane, upstream issue + fix, removeWhen, refusal, evidence', () => {
    expect(ledgerProblems(ledger, repoCtx)).toEqual([]);
  });

  it('every removal condition names the upstream fix it waits for', () => {
    for (const e of ledger) expect(e.removeWhen).toContain(e.upstream.fix);
  });

  it('has its OWN cap (5), distinct from the §h family cap, and is within it', () => {
    expect(UPSTREAM_RUNTIME_DEFECT_CAP).toBe(5);
    expect(UPSTREAM_RUNTIME_DEFECT_CAP).not.toBe(FAMILY_QUARANTINE_CAP);
    expect(ledger.length).toBeLessThanOrEqual(UPSTREAM_RUNTIME_DEFECT_CAP);
  });

  it('is NOT a quarantine: no entry is in $knextQuarantines (so none counts toward §h)', () => {
    const q = new Set(manifest.$knextQuarantines.map((x) => x.test));
    for (const e of ledger) expect(q.has(e.test)).toBe(false);
  });

  it('keeps running: no entry is dropped by rules.exclude or $knextExclusions, and each is in the corpus', () => {
    for (const e of ledger) {
      for (const p of manifest.rules.exclude) {
        expect(covers(p, e.test), `${e.test} is dropped by rules.exclude ${p}`).toBe(false);
      }
      for (const x of manifest.$knextExclusions) {
        expect(covers(x.test, e.test), `${e.test} is dropped by $knextExclusions ${x.test}`).toBe(
          false,
        );
      }
      expect(/^test\/(e2e|production)\//.test(e.test)).toBe(true);
    }
  });

  it('the smoke manifest carries the identical ledger (derived, not drifted)', () => {
    expect(parseUpstreamRuntimeDefects(smokeText)).toEqual(ledger);
  });
});

describe('upstream-runtime-defect ledger — the guards themselves', () => {
  it('accepts a complete entry', () => {
    expect(entryProblems(valid, fakeCtx)).toEqual([]);
  });

  it('REQUIRES a non-empty removal condition', () => {
    expect(entryProblems({ ...valid, removeWhen: '' }, fakeCtx).join()).toContain(
      'non-empty removal condition',
    );
    expect(entryProblems({ ...valid, removeWhen: '   ' }, fakeCtx).join()).toContain(
      'non-empty removal condition',
    );
    const { removeWhen: _drop, ...none } = valid;
    expect(entryProblems(none, fakeCtx).join()).toContain('non-empty removal condition');
  });

  it('REQUIRES a lane scoped to one runtime/builder cell', () => {
    for (const lane of ['', 'bun', 'all', 'node', 'bun/vinext']) {
      expect(
        entryProblems({ ...valid, lane }, fakeCtx).join(),
        `lane ${JSON.stringify(lane)}`,
      ).toContain('lane must be');
    }
    const { lane: _drop, ...none } = valid;
    expect(entryProblems(none, fakeCtx).join()).toContain('lane must be');
  });

  it('REQUIRES the upstream issue AND fix, outside getknext-dev', () => {
    expect(
      entryProblems({ ...valid, upstream: { issue: '', fix: valid.upstream.fix } }, fakeCtx).join(),
    ).toContain('upstream.issue');
    expect(
      entryProblems(
        { ...valid, upstream: { issue: valid.upstream.issue, fix: 'no' } },
        fakeCtx,
      ).join(),
    ).toContain('upstream.fix');
    expect(
      entryProblems(
        {
          ...valid,
          upstream: { issue: 'getknext-dev/knext#2225', fix: valid.upstream.fix },
        },
        fakeCtx,
      ).join(),
    ).toContain('upstream.issue');
  });

  it('REQUIRES the knext build-time refusal', () => {
    expect(entryProblems({ ...valid, knextRefusal: '' }, fakeCtx).join()).toContain(
      'must cite the build-time refusal',
    );
  });

  it('REQUIRES run-cited evidence', () => {
    expect(entryProblems({ ...valid, evidence: 'it failed once' }, fakeCtx).join()).toContain(
      'evidence',
    );
  });

  it('REQUIRES knextRefusal to name a real guard: an existing repo path, with its symbol when given', () => {
    const p = (knextRefusal: string) => entryProblems({ ...valid, knextRefusal }, fakeCtx).join();
    expect(p('x')).toContain('real guard');
    expect(p('see the pull request')).toContain('real guard');
    expect(p('packages/x/missing.ts#assertGuard')).toContain('real guard');
    expect(p('packages/x/guard.ts#notThere')).toContain('real guard');
    expect(p('packages/x/guard.ts')).toBe('');
    expect(p('packages/x/guard.ts#assertGuard')).toBe('');
    expect(entryProblems(valid).join()).toContain('cannot be verified');
  });

  it("REQUIRES removeWhen to reference the entry's own upstream fix", () => {
    expect(entryProblems({ ...valid, removeWhen: 'TBD' }, fakeCtx).join()).toContain(
      'own upstream fix',
    );
    expect(
      entryProblems(
        { ...valid, removeWhen: 'a Bun release containing oven-sh/bun#99999' },
        fakeCtx,
      ).join(),
    ).toContain('own upstream fix');
  });

  it('REQUIRES the test to be one concrete file (no glob or wildcard)', () => {
    for (const test of [
      'test/e2e/**/*.test.ts',
      'test/e2e/app-dir/x/*.test.ts',
      'test/e2e/{a,b}.test.ts',
      'test/e2e/a?.test.ts',
      'test/../../etc/x.test.ts',
      'test/e2e/./x/x.test.ts',
    ]) {
      expect(entryProblems({ ...valid, test }, fakeCtx).join(), test).toContain('concrete');
    }
  });

  it('ENFORCES its own cap and rejects a duplicate (test, lane)', () => {
    const many = Array.from({ length: UPSTREAM_RUNTIME_DEFECT_CAP + 1 }, (_v, i) => ({
      ...valid,
      test: `test/e2e/app-dir/x${i}/x${i}.test.ts`,
    }));
    expect(ledgerProblems(many, fakeCtx).join()).toContain('over its own cap');
    expect(ledgerProblems([valid, valid], fakeCtx).join()).toContain('duplicate entry');
  });

  it('FAILS CLOSED on an unreadable or ledger-less manifest', () => {
    expect(() => parseUpstreamRuntimeDefects('{not json')).toThrow('not readable JSON');
    expect(() => parseUpstreamRuntimeDefects('{}')).toThrow(UPSTREAM_RUNTIME_DEFECT_KEY);
    expect(() => parseUpstreamRuntimeDefects(`{"${UPSTREAM_RUNTIME_DEFECT_KEY}": {}}`)).toThrow(
      UPSTREAM_RUNTIME_DEFECT_KEY,
    );
  });
});
