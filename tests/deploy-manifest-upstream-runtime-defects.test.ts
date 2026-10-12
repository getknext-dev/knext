import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FAMILY_QUARANTINE_CAP } from './compat-quarantine-bounds';
import {
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

const valid: UpstreamRuntimeDefect = {
  test: 'test/e2e/app-dir/x/x.test.ts',
  lane: 'bun/turbopack',
  nextjsRef: 'v16.4.0',
  cases: ['a case'],
  mechanism: 'a mechanism',
  evidence: 'run 38181750458 (bun x turbopack): FINAL 3/3',
  upstream: { issue: 'oven-sh/bun#45007', fix: 'oven-sh/bun#45010' },
  knextRefusal: 'https://github.com/getknext-dev/knext/pull/2226',
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
    expect(ledgerProblems(ledger)).toEqual([]);
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
    expect(entryProblems(valid)).toEqual([]);
  });

  it('REQUIRES a non-empty removal condition', () => {
    expect(entryProblems({ ...valid, removeWhen: '' }).join()).toContain('removeWhen');
    expect(entryProblems({ ...valid, removeWhen: '   ' }).join()).toContain('removeWhen');
    const { removeWhen: _drop, ...none } = valid;
    expect(entryProblems(none).join()).toContain('removeWhen');
  });

  it('REQUIRES a lane scoped to one runtime/builder cell', () => {
    for (const lane of ['', 'bun', 'all', 'node', 'bun/vinext']) {
      expect(entryProblems({ ...valid, lane }).join(), `lane ${JSON.stringify(lane)}`).toContain(
        'lane must be',
      );
    }
    const { lane: _drop, ...none } = valid;
    expect(entryProblems(none).join()).toContain('lane must be');
  });

  it('REQUIRES the upstream issue AND fix, outside getknext-dev', () => {
    expect(
      entryProblems({ ...valid, upstream: { issue: '', fix: valid.upstream.fix } }).join(),
    ).toContain('upstream.issue');
    expect(
      entryProblems({ ...valid, upstream: { issue: valid.upstream.issue, fix: 'no' } }).join(),
    ).toContain('upstream.fix');
    expect(
      entryProblems({
        ...valid,
        upstream: { issue: 'getknext-dev/knext#2225', fix: valid.upstream.fix },
      }).join(),
    ).toContain('upstream.issue');
  });

  it('REQUIRES the knext build-time refusal', () => {
    expect(entryProblems({ ...valid, knextRefusal: '' }).join()).toContain('knextRefusal');
  });

  it('REQUIRES run-cited evidence', () => {
    expect(entryProblems({ ...valid, evidence: 'it failed once' }).join()).toContain('evidence');
  });

  it('ENFORCES its own cap and rejects a duplicate (test, lane)', () => {
    const many = Array.from({ length: UPSTREAM_RUNTIME_DEFECT_CAP + 1 }, (_v, i) => ({
      ...valid,
      test: `test/e2e/app-dir/x${i}/x${i}.test.ts`,
    }));
    expect(ledgerProblems(many).join()).toContain('over its own cap');
    expect(ledgerProblems([valid, valid]).join()).toContain('duplicate entry');
  });

  it('FAILS CLOSED on an unreadable or ledger-less manifest', () => {
    expect(() => parseUpstreamRuntimeDefects('{not json')).toThrow('not readable JSON');
    expect(() => parseUpstreamRuntimeDefects('{}')).toThrow(UPSTREAM_RUNTIME_DEFECT_KEY);
    expect(() => parseUpstreamRuntimeDefects(`{"${UPSTREAM_RUNTIME_DEFECT_KEY}": {}}`)).toThrow(
      UPSTREAM_RUNTIME_DEFECT_KEY,
    );
  });
});
