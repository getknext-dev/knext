/**
 * The vinext STRUCTURAL-GAP ledger (founder decision, 2026-10-09).
 *
 * About 49 official Next.js deploy-test files fail on the vinext lane for ONE
 * reason: vinext does not implement the Next.js 16.3 client-router architecture.
 * They cannot be fixed by a knext patch, so the per-file ledger
 * (`test/compat-vinext-ledger.json`, cap 15, 30-day expiry — founder constraints
 * from the original ledger design) is the wrong tool for them, and loosening it
 * is not an option. This is a SEPARATE ledger with its own, equally explicit
 * bounds, living beside it:
 *
 *   - ONE shared gap record (reason + upstream links + dates), not 49 hand-written
 *     per-file justifications;
 *   - `reviewBy` at most 92 days after `recorded` (quarterly); past it the run reds;
 *   - a hard cap of 49 files — FROZEN at the number first quarantined, only ever
 *     lowered; adding a file needs a new ADR-0007 amendment;
 *   - every file must be a real corpus member (matches the manifest's include
 *     globs, not excluded, not already quarantined by the manifest);
 *   - matching is at CASE granularity — a NEW failing case in a ledgered file stays
 *     a real failure — and an entry is STALE (reds the run) once its file passes;
 *   - it applies ONLY to the vinext lane, never to the four stable credential
 *     cells (validator lane check + runtime refusal on a non-vinext summary +
 *     workflow wiring + the stable cells' fingerprint harness).
 *
 * The per-file ledger's own bounds are asserted UNCHANGED at the bottom: a bound
 * quietly widened to make room here would defeat the point of having two ledgers.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyLedger,
  LEDGER_FILE_CAP,
  MAX_EXPIRY_DAYS,
  publishedNumber,
  staleEntries,
} from '../scripts/compat-vinext-ledger.mjs';
import {
  manifestIncludes,
  overlapWithPerFile,
  STRUCTURAL_CANONICAL_FILES,
  STRUCTURAL_CLASS,
  STRUCTURAL_FILE_CAP,
  STRUCTURAL_MAX_REVIEW_DAYS,
  STRUCTURAL_REASON,
  staleStructural,
  structuralApplyRefusal,
  structuralEntries,
  validateStructuralGaps,
} from '../scripts/compat-vinext-structural-gaps.mjs';
import { CREDENTIAL_CELLS } from '../scripts/compat-window-audit.mjs';
import { collectHarness } from '../scripts/compat-window-fingerprint.mjs';

// biome-ignore lint/suspicious/noExplicitAny: fixtures are plain JSON
type Any = any;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');
const STRUCTURAL_PATH = 'test/compat-vinext-structural-gaps.json';
const STRUCTURAL_SCRIPT = 'scripts/compat-vinext-structural-gaps.mjs';
const WORKFLOW = '.github/workflows/compat-vinext.yml';
const LEDGER_SCRIPT = resolve(repoRoot, 'scripts/compat-vinext-ledger.mjs');
const manifest = JSON.parse(read('test/deploy-tests-manifest.knext.json'));

const TODAY = '2026-10-09';
/**
 * The number of files first quarantined (2026-10-09). The cap is frozen at this
 * and can only be LOWERED. Do NOT raise this literal to make room: adding a file
 * or raising the cap needs a new ADR-0007 amendment first (the amendment text is
 * asserted below).
 */
const ORIGINAL_QUARANTINED_COUNT = 49;
const A = 'test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts';
const B = 'test/e2e/app-dir/app-prefetch/prefetching.test.ts';
const C = 'test/e2e/app-dir/use-offline/use-offline.test.ts';

function gap(over: Record<string, unknown> = {}): Any {
  return {
    id: 'client-router-architecture',
    reason: STRUCTURAL_REASON,
    upstream: [
      'https://github.com/cloudflare/vinext/issues/1614',
      'https://github.com/cloudflare/vinext/pull/3768',
      'https://github.com/getknext-dev/knext/issues/1148',
    ],
    recorded: '2026-10-09',
    reviewBy: '2027-01-08',
    ...over,
  };
}
function file(test: string, cases: string[] = ['a', 'b']): Any {
  return { test, cases };
}
function sg(files: Any[] = [file(A), file(B)], over: Record<string, unknown> = {}): Any {
  return { lane: 'bun-vinext', gap: gap(), files, ...over };
}
const errs = (l: Any, today = TODAY) => validateStructuralGaps(l, { today, manifest });

describe('validateStructuralGaps: the approved bounds', () => {
  it('accepts a well-formed ledger', () => {
    expect(errs(sg())).toEqual([]);
  });

  it('constants are the approved bounds: a cap that can only go down from 49, and 92 days', () => {
    expect(STRUCTURAL_FILE_CAP).toBeLessThanOrEqual(ORIGINAL_QUARANTINED_COUNT);
    expect(STRUCTURAL_FILE_CAP).toBeGreaterThan(0);
    expect(STRUCTURAL_MAX_REVIEW_DAYS).toBe(92);
  });

  it('CAP: exactly the cap is fine, one more file reds', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        file(
          STRUCTURAL_CANONICAL_FILES[i] ??
            `test/e2e/app-dir/segment-cache/gen-${i}/gen-${i}.test.ts`,
        ),
      );
    expect(errs(sg(many(STRUCTURAL_FILE_CAP)))).toEqual([]);
    expect(errs(sg(many(STRUCTURAL_FILE_CAP + 1))).join()).toMatch(
      new RegExp(`${STRUCTURAL_FILE_CAP + 1} files.*cap is ${STRUCTURAL_FILE_CAP}`),
    );
  });

  it('REVIEW-BY: the day itself is fine, the day after reds', () => {
    expect(errs(sg(), '2027-01-08')).toEqual([]);
    expect(errs(sg(), '2027-01-09').join()).toMatch(/reviewBy 2027-01-08 has passed/);
  });

  it('REVIEW-BY: more than 92 days after `recorded` reds, exactly 92 is fine', () => {
    expect(errs(sg(undefined, { gap: gap({ reviewBy: '2027-01-09' }) }))).toEqual([]); // +92
    expect(errs(sg(undefined, { gap: gap({ reviewBy: '2027-01-10' }) })).join()).toMatch(
      /93 days.*maximum is 92/,
    );
  });

  it('REVIEW-BY: undated, malformed, before `recorded`, or recorded in the future all red', () => {
    expect(errs(sg(undefined, { gap: gap({ reviewBy: undefined }) })).join()).toMatch(/reviewBy/);
    expect(errs(sg(undefined, { gap: gap({ recorded: undefined }) })).join()).toMatch(/recorded/);
    expect(errs(sg(undefined, { gap: gap({ reviewBy: '08/01/2027' }) })).join()).toMatch(
      /reviewBy.*YYYY-MM-DD/,
    );
    expect(errs(sg(undefined, { gap: gap({ reviewBy: '2026-10-01' }) })).join()).toMatch(
      /before it was recorded/,
    );
    expect(errs(sg(undefined, { gap: gap({ recorded: '2026-10-20' }) })).join()).toMatch(
      /recorded in the future/,
    );
  });

  it('UNKNOWN FILE: a path that is not a manifest corpus member reds', () => {
    expect(errs(sg([file('test/e2e/does-not-exist/x.not-a-test.ts')])).join()).toMatch(
      /not a corpus member/,
    );
    expect(errs(sg([file('not/under/test.test.ts')])).join()).toMatch(/not a corpus member/);
  });

  it('UNKNOWN FILE: a path the manifest EXCLUDES reds (a test that never runs cannot be a known gap)', () => {
    const excluded = manifest.rules.exclude.find((e: string) => !e.includes('*'));
    expect(errs(sg([file(excluded)])).join()).toMatch(/excluded by the manifest/);
    expect(errs(sg([file('test/e2e/middleware-general/anything.test.ts')])).join()).toMatch(
      /excluded by the manifest/,
    );
  });

  it('a file the manifest already quarantines is not double-hidden', () => {
    const q = manifest.$knextQuarantines[0].test;
    expect(errs(sg([file(q)])).join()).toMatch(/already quarantined by the manifest/);
  });

  it('a duplicate file, or a file with no case snapshot, reds', () => {
    expect(errs(sg([file(A), file(A)])).join()).toMatch(/duplicate/);
    expect(errs(sg([file(A, [])])).join()).toMatch(/cases/);
    expect(errs(sg([file(A, ['x', 'x'])])).join()).toMatch(/duplicate case/);
  });

  it('LANE: only the vinext lane may carry it', () => {
    expect(errs(sg(undefined, { lane: 'bun' })).join()).toMatch(/lane/);
    expect(errs(sg(undefined, { lane: 'node' })).join()).toMatch(/lane/);
    expect(errs(sg(undefined, { lane: undefined })).join()).toMatch(/lane/);
  });

  it('ONE shared gap record: per-file override keys (own reason / dates / upstream) are rejected', () => {
    for (const key of ['reason', 'reviewBy', 'upstream', 'expires', 'class']) {
      expect(errs(sg([{ ...file(A), [key]: 'x' }])).join(), key).toMatch(/unexpected key/);
    }
    // ... but a free-text `note` is allowed.
    expect(errs(sg([{ ...file(A), note: 'patched on the 1.3 line' }]))).toEqual([]);
  });

  it('the shared record states the reason and links vinext AND knext upstream', () => {
    expect(errs(sg(undefined, { gap: gap({ reason: '' }) })).join()).toMatch(/reason/);
    expect(errs(sg(undefined, { gap: gap({ reason: 'it is flaky' }) })).join()).toMatch(/reason/);
    expect(errs(sg(undefined, { gap: gap({ upstream: [] }) })).join()).toMatch(/upstream/);
    expect(
      errs(
        sg(undefined, {
          gap: gap({ upstream: ['https://github.com/getknext-dev/knext/issues/1'] }),
        }),
      ).join(),
    ).toMatch(/cloudflare\/vinext/);
    expect(
      errs(
        sg(undefined, {
          gap: gap({ upstream: ['https://github.com/cloudflare/vinext/issues/1614'] }),
        }),
      ).join(),
    ).toMatch(/getknext-dev\/knext/);
    expect(errs(sg(undefined, { gap: gap({ upstream: ['not a url'] }) })).join()).toMatch(
      /upstream/,
    );
  });

  it('a missing or non-object ledger reds instead of passing', () => {
    expect(validateStructuralGaps(null, { today: TODAY, manifest }).length).toBeGreaterThan(0);
    expect(errs({ lane: 'bun-vinext', gap: gap() }).join()).toMatch(/files/);
    expect(errs({ lane: 'bun-vinext', files: [file(A)] }).join()).toMatch(/gap/);
  });
});

describe('manifestIncludes: the corpus-membership glob', () => {
  const m = { rules: { include: ['test/e2e/**/*.test.{t,j}s{,x}'], exclude: ['test/e2e/x/**/*'] } };
  it('matches the manifest include shapes', () => {
    expect(manifestIncludes(m, 'test/e2e/a.test.ts')).toBe(true);
    expect(manifestIncludes(m, 'test/e2e/a/b/c.test.tsx')).toBe(true);
    expect(manifestIncludes(m, 'test/e2e/a/b/c.test.js')).toBe(true);
    expect(manifestIncludes(m, 'test/e2e/a/b/c.test.mjs')).toBe(false);
    expect(manifestIncludes(m, 'test/unit/a.test.ts')).toBe(false);
    expect(manifestIncludes(m, 'test/e2e/a.test.ts.bak')).toBe(false);
  });
});

describe('structural entries reuse the per-file reclassification, at case granularity', () => {
  const ledger = sg([file(A, ['a', 'b']), file(B, ['p'])]);
  const entries = structuralEntries(ledger);
  const summary = (over: Record<string, unknown> = {}): Any => ({
    passed: 40,
    failed: 3,
    notRun: 0,
    excluded: 38,
    expectedTotal: 43,
    truncated: false,
    shard: '1/16',
    runtime: 'bun',
    builder: 'vinext',
    failures: [
      { file: A, kind: 'assertion', cases: ['a', 'b'] },
      { file: B, kind: 'assertion', cases: ['p'] },
      { file: 'test/e2e/unrelated/x.test.ts', kind: 'assertion', cases: ['c'] },
    ],
    ...over,
  });

  it('maps each file to a synthetic `structural` entry carrying the shared upstream', () => {
    expect(entries.map((e: Any) => e.test)).toEqual([A, B]);
    expect(entries[0].class).toBe(STRUCTURAL_CLASS);
    expect(entries[0].upstream).toBe('https://github.com/cloudflare/vinext/issues/1614');
  });

  it('quarantines the snapshot cases and decreases `failed` by those files only', () => {
    const out = applyLedger(summary(), entries);
    expect(out.failed).toBe(1);
    expect(out.failures.map((f: Any) => f.file)).toEqual(['test/e2e/unrelated/x.test.ts']);
    expect(out.quarantined.map((q: Any) => [q.file, q.class])).toEqual([
      [A, 'structural'],
      [B, 'structural'],
    ]);
    // passed / notRun / expectedTotal / excluded are never touched.
    expect(out.passed).toBe(40);
    expect(out.expectedTotal).toBe(43);
  });

  it('a NEW failing case in a ledgered file stays a real failure (regressions are never absorbed)', () => {
    const s = summary();
    s.failures[0].cases = ['a', 'b', 'brand-new'];
    const out = applyLedger(s, entries);
    expect(out.failed).toBe(2);
    expect(out.failures.find((f: Any) => f.file === A).cases).toEqual(['brand-new']);
  });

  it('a file-level failure with no case detail (a build/deploy failure) stays a real failure', () => {
    const s = summary();
    s.failures[0] = { file: A, kind: 'deploy', cases: [] };
    const out = applyLedger(s, entries);
    expect(out.failures.map((f: Any) => f.file)).toContain(A);
  });

  it('composes with the per-file ledger: both entry sets reclassify in one pass', () => {
    const perFile = {
      test: 'test/e2e/unrelated/x.test.ts',
      class: 'unsupported',
      upstream: 'https://github.com/cloudflare/vinext/issues/1359',
      cases: ['c'],
    };
    const out = applyLedger(summary(), [perFile, ...entries]);
    expect(out.failed).toBe(0);
    expect(out.quarantined.map((q: Any) => q.class).sort()).toEqual([
      'structural',
      'structural',
      'unsupported',
    ]);
  });

  it('the published number counts structural files as quarantined, over the unchanged total', () => {
    const out = applyLedger(summary(), entries);
    const n = publishedNumber([out]);
    expect(n).toEqual({ passed: 40, failed: 1, quarantined: 2, notRun: 0, total: 43 });
  });

  it('the per-file stale rule is NOT applied to structural entries (that is file-level, below)', () => {
    // all snapshot cases passing -> the per-file rule would flag it; the structural
    // rule has its own, file-level, definition.
    const clean = applyLedger(summary({ failed: 0, failures: [] }), entries);
    expect(staleEntries([clean], []).length).toBe(0);
  });
});

describe('staleStructural: a file that starts PASSING reds, a partial fix only warns', () => {
  const ledger = sg([file(A, ['a', 'b']), file(B, ['p'])]);
  const run = (failures: Any[], over: Record<string, unknown> = {}): Any[] => [
    applyLedger(
      {
        passed: 40,
        failed: failures.length,
        notRun: 0,
        excluded: 38,
        expectedTotal: 43,
        shard: '1/16',
        runtime: 'bun',
        builder: 'vinext',
        failures,
        ...over,
      },
      structuralEntries(ledger),
    ),
  ];

  it('all snapshot cases failing as recorded: nothing stale', () => {
    const r = staleStructural(
      run([
        { file: A, kind: 'assertion', cases: ['a', 'b'] },
        { file: B, kind: 'assertion', cases: ['p'] },
      ]),
      ledger,
    );
    expect(r.stale).toEqual([]);
    expect(r.shrink).toEqual([]);
  });

  it('a ledgered file that PASSED (no failure of any kind) is stale', () => {
    const r = staleStructural(run([{ file: A, kind: 'assertion', cases: ['a', 'b'] }]), ledger);
    expect(r.stale.map((s: Any) => s.test)).toEqual([B]);
  });

  it('a PARTIAL fix (some snapshot cases pass, one still fails) is a shrink warning, not stale', () => {
    const r = staleStructural(
      run([
        { file: A, kind: 'assertion', cases: ['a'] },
        { file: B, kind: 'assertion', cases: ['p'] },
      ]),
      ledger,
    );
    expect(r.stale).toEqual([]);
    expect(r.shrink).toEqual([{ test: A, cases: ['b'] }]);
  });

  it('a file that still fails for a NEW reason is not stale (the real failure reds the run on its own)', () => {
    const r = staleStructural(
      run([
        { file: A, kind: 'assertion', cases: ['brand-new'] },
        { file: B, kind: 'assertion', cases: ['p'] },
      ]),
      ledger,
    );
    expect(r.stale).toEqual([]);
  });

  it('a file that did not run, or failed with no case detail, is not called stale (no result is not a pass)', () => {
    const notRun = staleStructural(
      run([{ file: B, kind: 'assertion', cases: ['p'] }], { notRunFiles: [A], notRun: 1 }),
      ledger,
    );
    expect(notRun.stale).toEqual([]);
    const noDetail = staleStructural(
      run([
        { file: A, kind: 'deploy', cases: [] },
        { file: B, kind: 'assertion', cases: ['p'] },
      ]),
      ledger,
    );
    expect(noDetail.stale).toEqual([]);
  });

  it('a shard whose reclassification was skipped proves nothing passed', () => {
    const skipped = [
      {
        ...run([])[0],
        ledgerSkipped: 'failed=3 but the summary lists no per-file failures',
      },
    ];
    expect(staleStructural(skipped, ledger).stale).toEqual([]);
  });
});

describe('structuralApplyRefusal: never applied to a stable credential cell', () => {
  it('accepts a vinext summary', () => {
    expect(structuralApplyRefusal({ builder: 'vinext', runtime: 'bun' })).toBeNull();
  });
  it('refuses the four stable cells: turbopack (no builder field) and webpack, on node and bun', () => {
    for (const s of [
      { runtime: 'node' },
      { runtime: 'bun' },
      { runtime: 'node', builder: 'webpack' },
      { runtime: 'bun', builder: 'webpack' },
      { runtime: 'bun', builder: 'turbopack' },
      {},
    ]) {
      expect(structuralApplyRefusal(s), JSON.stringify(s)).toMatch(/stable|vinext/);
    }
  });
});

describe('overlapWithPerFile: one mechanism per CASE', () => {
  const mine = sg([file(A, ['a', 'b']), file(B, ['p'])]);
  const perFile = (test: string, cases: string[]) => ({ test, cases });

  it('a file may sit in both ledgers when their case sets are disjoint', () => {
    expect(overlapWithPerFile(mine, [perFile(A, ['z'])])).toEqual([]);
  });
  it('a shared case is reported with the file', () => {
    expect(overlapWithPerFile(mine, [perFile(A, ['b', 'z']), perFile(C, ['a'])])).toEqual([
      { test: A, cases: ['b'] },
    ]);
  });
});

describe('CLI: apply / report with --structural', () => {
  const dirs: string[] = [];
  function fixture(structural: Any, perFile: Any = { lane: 'bun-vinext', entries: [] }): string {
    const root = mkdtempSync(join(tmpdir(), 'knext-structural-'));
    dirs.push(root);
    mkdirSync(join(root, 'test'));
    copyFileSync(
      join(repoRoot, 'test/deploy-tests-manifest.knext.json'),
      join(root, 'test/deploy-tests-manifest.knext.json'),
    );
    writeFileSync(join(root, 'test/ledger.json'), JSON.stringify(perFile));
    writeFileSync(join(root, 'test/structural.json'), JSON.stringify(structural));
    return root;
  }
  const cleanup = () => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  };
  const run = (root: string, argv: string[]) =>
    spawnSync('node', [LEDGER_SCRIPT, ...argv], { cwd: root, encoding: 'utf8' });
  const shardSummary = (over: Record<string, unknown> = {}): Any => ({
    passed: 40,
    failed: 2,
    notRun: 0,
    excluded: 38,
    expectedTotal: 42,
    truncated: false,
    shard: '1/16',
    runtime: 'bun',
    builder: 'vinext',
    failures: [
      { file: A, kind: 'assertion', cases: ['a', 'b'] },
      { file: B, kind: 'assertion', cases: ['p'] },
    ],
    ...over,
  });
  const live = () => {
    // a reviewBy comfortably in the future relative to the REAL clock
    const d = new Date();
    const iso = (x: Date) => x.toISOString().slice(0, 10);
    const later = new Date(d.getTime() + 30 * 86_400_000);
    return sg([file(A, ['a', 'b']), file(B, ['p'])], {
      gap: gap({ recorded: iso(d), reviewBy: iso(later) }),
    });
  };

  it('apply and report REFUSE (exit 1) a ledger whose file is outside the original 49', () => {
    const swapped = live();
    swapped.files[1] = file('test/e2e/app-dir/catch-error/catch-error.test.ts', ['p']);
    const root = fixture(swapped);
    try {
      writeFileSync(join(root, 's.json'), JSON.stringify(shardSummary()));
      mkdirSync(join(root, 'sums'));
      writeFileSync(join(root, 'sums/s.json'), JSON.stringify(shardSummary()));
      const common = ['--ledger', 'test/ledger.json', '--structural', 'test/structural.json'];
      const a = run(root, ['apply', ...common, '--summary', 's.json']);
      expect(a.status).toBe(1);
      expect(a.stderr).toMatch(/ADR-0007 amendment/);
      const r = run(root, ['report', ...common, '--summaries', 'sums']);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/ADR-0007 amendment/);
    } finally {
      cleanup();
    }
  });

  it('apply reclassifies the structural files and exits 0', () => {
    const root = fixture(live());
    try {
      writeFileSync(join(root, 's.json'), JSON.stringify(shardSummary()));
      const r = run(root, [
        'apply',
        '--ledger',
        'test/ledger.json',
        '--structural',
        'test/structural.json',
        '--summary',
        's.json',
      ]);
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(readFileSync(join(root, 's.json'), 'utf8'));
      expect(out.failed).toBe(0);
      expect(out.quarantined.map((q: Any) => q.class)).toEqual(['structural', 'structural']);
    } finally {
      cleanup();
    }
  });

  it('apply REFUSES (exit 1) a summary from a stable cell, and leaves it untouched', () => {
    const root = fixture(live());
    try {
      const before = JSON.stringify(shardSummary({ builder: undefined, runtime: 'node' }));
      writeFileSync(join(root, 's.json'), before);
      const r = run(root, [
        'apply',
        '--ledger',
        'test/ledger.json',
        '--structural',
        'test/structural.json',
        '--summary',
        's.json',
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/stable|vinext/);
      expect(readFileSync(join(root, 's.json'), 'utf8')).toBe(before);
    } finally {
      cleanup();
    }
  });

  it('apply exits 1 once reviewBy has passed (the run reds)', () => {
    const root = fixture(
      sg([file(A, ['a', 'b'])], { gap: gap({ recorded: '2020-01-01', reviewBy: '2020-03-01' }) }),
    );
    try {
      writeFileSync(join(root, 's.json'), JSON.stringify(shardSummary()));
      const r = run(root, [
        'apply',
        '--ledger',
        'test/ledger.json',
        '--structural',
        'test/structural.json',
        '--summary',
        's.json',
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/reviewBy/);
    } finally {
      cleanup();
    }
  });

  it('apply exits 1 on an unknown file or an over-cap ledger', () => {
    const root = fixture({ ...live(), files: [file('test/e2e/nope/not-a-test.ts')] });
    try {
      writeFileSync(join(root, 's.json'), JSON.stringify(shardSummary()));
      const r = run(root, [
        'apply',
        '--ledger',
        'test/ledger.json',
        '--structural',
        'test/structural.json',
        '--summary',
        's.json',
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/corpus member/);
    } finally {
      cleanup();
    }
  });

  it('a file in BOTH ledgers with disjoint cases is reclassified by each, keeping both classes', () => {
    const perFile: Any = {
      lane: 'bun-vinext',
      entries: [
        {
          test: A,
          class: 'unsupported',
          feature: 'x',
          upstream: 'https://github.com/cloudflare/vinext/issues/1359',
          cases: ['z'],
          evidence: { fail: [] },
          added: new Date().toISOString().slice(0, 10),
          expires: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
        },
      ],
    };
    // the per-file ledger's own evidence rules are not under test here, so use a
    // structural-only ledger plus a per-file entry the validator accepts.
    perFile.entries[0].evidence = {
      fail: [
        { run: '1', cases: ['z'] },
        { run: '2', cases: ['z'] },
      ],
    };
    const root = fixture(live(), perFile);
    try {
      writeFileSync(
        join(root, 's.json'),
        JSON.stringify(
          shardSummary({
            failed: 2,
            failures: [
              { file: A, kind: 'assertion', cases: ['a', 'b', 'z'] },
              { file: B, kind: 'assertion', cases: ['p'] },
            ],
          }),
        ),
      );
      const r = run(root, [
        'apply',
        '--ledger',
        'test/ledger.json',
        '--structural',
        'test/structural.json',
        '--summary',
        's.json',
      ]);
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(readFileSync(join(root, 's.json'), 'utf8'));
      expect(out.failed).toBe(0);
      expect(out.quarantined.map((q: Any) => [q.file, q.class, q.cases])).toEqual([
        [A, 'unsupported', ['z']],
        [A, 'structural', ['a', 'b']],
        [B, 'structural', ['p']],
      ]);
    } finally {
      cleanup();
    }
  });

  it('apply exits 1 when the two ledgers claim the SAME case', () => {
    const perFile = {
      lane: 'bun-vinext',
      entries: [
        {
          test: A,
          class: 'unsupported',
          feature: 'x',
          upstream: 'https://github.com/cloudflare/vinext/issues/1359',
          cases: ['a'],
          evidence: {
            fail: [
              { run: '1', cases: ['a'] },
              { run: '2', cases: ['a'] },
            ],
          },
          added: new Date().toISOString().slice(0, 10),
          expires: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
        },
      ],
    };
    const root = fixture(live(), perFile);
    try {
      writeFileSync(join(root, 's.json'), JSON.stringify(shardSummary()));
      const r = run(root, [
        'apply',
        '--ledger',
        'test/ledger.json',
        '--structural',
        'test/structural.json',
        '--summary',
        's.json',
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/both ledgers/);
    } finally {
      cleanup();
    }
  });

  function reportDir(root: string, summaries: Any[]): string {
    const dir = join(root, 'summaries');
    mkdirSync(dir);
    for (const [i, s] of summaries.entries())
      writeFileSync(join(dir, `compat-suite-summary-${i + 1}-16.json`), JSON.stringify(s));
    return dir;
  }
  const applied = (over: Record<string, unknown> = {}) =>
    applyLedger(shardSummary(over), structuralEntries(live()));

  it('report publishes the quarantined count and exits 0 while every file still fails as recorded', () => {
    const root = fixture(live());
    try {
      reportDir(root, [applied()]);
      const r = run(root, [
        'report',
        '--ledger',
        'test/ledger.json',
        '--structural',
        'test/structural.json',
        '--summaries',
        'summaries',
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/2 quarantined/);
    } finally {
      cleanup();
    }
  });

  it('report exits 1 and names the file when a ledgered file starts PASSING', () => {
    const root = fixture(live());
    try {
      reportDir(root, [
        applied({ failures: [{ file: A, kind: 'assertion', cases: ['a', 'b'] }], failed: 1 }),
      ]);
      const r = run(root, [
        'report',
        '--ledger',
        'test/ledger.json',
        '--structural',
        'test/structural.json',
        '--summaries',
        'summaries',
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/stale structural-gap entry/);
      expect(r.stderr).toContain(B);
    } finally {
      cleanup();
    }
  });

  it('report refuses summaries from a stable cell (exit 1)', () => {
    const root = fixture(live());
    try {
      reportDir(root, [applied({ builder: undefined })]);
      const r = run(root, [
        'report',
        '--ledger',
        'test/ledger.json',
        '--structural',
        'test/structural.json',
        '--summaries',
        'summaries',
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/stable|vinext/);
    } finally {
      cleanup();
    }
  });

  it('without --structural, behaviour is exactly the per-file ledger (back-compat)', () => {
    const root = fixture(live());
    try {
      writeFileSync(join(root, 's.json'), JSON.stringify(shardSummary({ builder: undefined })));
      const r = run(root, ['apply', '--ledger', 'test/ledger.json', '--summary', 's.json']);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(root, 's.json'), 'utf8')).failed).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe('the real structural-gap ledger', () => {
  const real = JSON.parse(read(STRUCTURAL_PATH));

  it('is valid today: under the cap, inside its review window, every file a real corpus member', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(validateStructuralGaps(real, { today, manifest })).toEqual([]);
    expect(real.files.length).toBeGreaterThan(0);
    expect(real.files.length).toBeLessThanOrEqual(STRUCTURAL_FILE_CAP);
    expect(real.gap.reason).toBe(STRUCTURAL_REASON);
  });

  it('FILE SET PINNED: the canonical list is the original 49 and the committed ledger is a subset of it', () => {
    expect(STRUCTURAL_CANONICAL_FILES.length).toBe(ORIGINAL_QUARANTINED_COUNT);
    expect(new Set(STRUCTURAL_CANONICAL_FILES).size).toBe(ORIGINAL_QUARANTINED_COUNT);
    const canonical = new Set<string>(STRUCTURAL_CANONICAL_FILES);
    const outside = real.files.map((f: Any) => f.test).filter((t: string) => !canonical.has(t));
    expect(
      outside,
      'ledger holds a file outside the original 49 (needs an ADR-0007 amendment)',
    ).toEqual([]);
  });

  it('FILE SET PINNED: swapping a ledgered file for a different corpus file reds, naming the amendment', () => {
    const swapped = sg([file(A), file('test/e2e/app-dir/catch-error/catch-error.test.ts')]);
    const e = errs(swapped).join('\n');
    expect(e).toMatch(/catch-error.*not one of the original 49.*ADR-0007 amendment/s);
    expect(errs(sg([file(A)]))).toEqual([]); // dropping a file stays legal
  });

  it('FROZEN CAP: files <= cap <= the original 49 — a file can be removed, never added', () => {
    expect(real.files.length).toBeLessThanOrEqual(STRUCTURAL_FILE_CAP);
    expect(STRUCTURAL_FILE_CAP).toBeLessThanOrEqual(ORIGINAL_QUARANTINED_COUNT);
    expect(real.files.length).toBeLessThanOrEqual(ORIGINAL_QUARANTINED_COUNT);
  });

  it('the ADR-0007 amendment records the decision, the frozen cap, and the vinext-only scope', () => {
    const adr = read('docs/adr/0007-compat-suite.md');
    const at = adr.indexOf('## Amendment (2026-10-09)');
    expect(at, 'ADR-0007 has no 2026-10-09 amendment section').toBeGreaterThan(-1);
    const section = adr.slice(at);
    expect(section).toMatch(/founder/i);
    expect(section).toContain('2026-10-09');
    expect(section).toContain(`${ORIGINAL_QUARANTINED_COUNT} files`);
    expect(section).toMatch(
      /only (ever )?(goes|be lowered|lowered)|can only (go|be) (down|lowered)/i,
    );
    expect(section).toMatch(/new ADR[- ]0007 amendment|new amendment/i);
    expect(section).toMatch(/vinext lane/i);
    expect(section).toMatch(/15 files/);
  });

  it('records the founder decision date and links vinext and knext upstream', () => {
    expect(real.gap.recorded).toBe('2026-10-09');
    expect(real.gap.upstream).toContain('https://github.com/cloudflare/vinext/pull/3768');
    expect(real.gap.upstream).toContain('https://github.com/getknext-dev/knext/issues/1148');
  });

  it('leaves out every file the cluster-E derivation excluded as ambiguous or already passing', () => {
    const tests = new Set(real.files.map((f: Any) => f.test));
    for (const t of [
      // tagged C6+E (two clusters)
      'test/e2e/next-image-legacy/image-from-node-modules/image-from-node-modules.test.ts',
      'test/e2e/next-image-new/app-dir-image-from-node-modules/app-dir-image-from-node-modules.test.ts',
      'test/e2e/next-image-new/image-from-node-modules/image-from-node-modules.test.ts',
      // tagged E in the triage but PASSING on rc.7
      'test/e2e/css-features/css-and-styled-jsx.test.ts',
    ])
      expect(tests.has(t), t).toBe(false);
  });

  it('shares no CASE with the per-file ledger (a case is quarantined by one mechanism only)', () => {
    const perFile = JSON.parse(read('test/compat-vinext-ledger.json'));
    expect(overlapWithPerFile(real, perFile.entries)).toEqual([]);
  });
});

describe('the structural ledger applies ONLY to the vinext lane', () => {
  it('only compat-vinext.yml references it — no other workflow, so no stable cell can apply it', () => {
    const dir = resolve(repoRoot, '.github/workflows');
    const referencing = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .filter((f) => {
        const text = readFileSync(join(dir, f), 'utf8');
        return text.includes('compat-vinext-structural-gaps');
      });
    expect(referencing).toEqual(['compat-vinext.yml']);
  });

  it('none of the four stable credential cells freezes it (their windows cannot move)', () => {
    const stable = (CREDENTIAL_CELLS as Any[]).filter((c) => c.builder !== 'vinext');
    expect(stable.length).toBe(4);
    for (const c of stable) {
      expect(c.extraFiles, c.lane).not.toContain(STRUCTURAL_PATH);
      expect(c.extraFiles, c.lane).not.toContain(STRUCTURAL_SCRIPT);
      const harness = (collectHarness(repoRoot, c.lane) as Any[]).map((e) => e.path);
      expect(harness, c.lane).not.toContain(STRUCTURAL_PATH);
      expect(harness, c.lane).not.toContain(STRUCTURAL_SCRIPT);
    }
  });

  it('the vinext cell freezes the script TRANSITIVELY (compat-vinext-ledger.mjs imports it)', () => {
    const harness = (collectHarness(repoRoot, 'bun-vinext') as Any[]).map((e) => e.path);
    expect(harness).toContain(STRUCTURAL_SCRIPT);
  });

  it('the shared fingerprint harness roots never match it (it cannot move a stable cell’s window)', async () => {
    const { HARNESS_ROOTS } = await import('../scripts/compat-window-fingerprint.mjs');
    for (const rel of [STRUCTURAL_PATH, STRUCTURAL_SCRIPT]) {
      const [dir, ...rest] = rel.split('/');
      const name = rest.join('/');
      for (const root of HARNESS_ROOTS as Any[]) {
        if (root.kind === 'dir' && root.path === dir) {
          expect(root.match.test(name), `${rel} would enter the shared fingerprint`).toBe(false);
        }
      }
    }
  });
});

describe('workflow wiring', () => {
  // biome-ignore lint/suspicious/noExplicitAny: the workflow schema is not modelled here
  const wf = (Bun as any).YAML.parse(read(WORKFLOW)) as Any;
  const steps = (job: string): Any[] => wf.jobs[job].steps;

  it('the per-shard apply step passes the structural ledger beside the per-file one', () => {
    const apply = steps('deploy-tests').find((s) => /quarantine ledger/i.test(s.name ?? ''));
    expect(apply.run).toContain('scripts/compat-vinext-ledger.mjs apply');
    expect(apply.run).toContain('--ledger test/compat-vinext-ledger.json');
    expect(apply.run).toContain('--structural test/compat-vinext-structural-gaps.json');
  });

  it('the run-level reconcile step passes it too, and is still not continue-on-error', () => {
    const rec = steps('shard-ledger').find((s) => /quarantine ledger/i.test(s.name ?? ''));
    expect(rec.run).toContain('scripts/compat-vinext-ledger.mjs report');
    expect(rec.run).toContain('--structural knext/test/compat-vinext-structural-gaps.json');
    expect(rec['continue-on-error']).toBeUndefined();
  });
});

describe('the per-file ledger’s founder bounds are UNCHANGED', () => {
  it('cap 15 files, 30-day expiry', () => {
    expect(LEDGER_FILE_CAP).toBe(15);
    expect(MAX_EXPIRY_DAYS).toBe(30);
  });

  it('the structural cap is separate: the per-file cap did not absorb it', () => {
    expect(STRUCTURAL_FILE_CAP).not.toBe(LEDGER_FILE_CAP);
    expect(LEDGER_FILE_CAP).toBe(15); // not raised to make room
    const perFile = JSON.parse(read('test/compat-vinext-ledger.json'));
    expect(perFile.entries.length).toBeLessThanOrEqual(LEDGER_FILE_CAP);
  });
});
