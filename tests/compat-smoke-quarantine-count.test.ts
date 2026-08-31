import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// The plain-ESM helper the smoke runner itself imports (tsconfig.typecheck's `allowJs`
// infers its types from the JSDoc) — the guard exercises the SAME code, not a copy.
import {
  formatLaneSummary,
  loadQuarantineLedger,
  smokeQuarantineCount,
} from '../apps/file-manager/scripts/compat-smoke-quarantines.mjs';

/**
 * GUARD: the compat-smoke per-lane summary's quarantine count is DERIVED from the real
 * ledger, never hardcoded (#512, third acceptance criterion).
 *
 * `printReport()` used to print a literal `quarantined=0`. That line is the smoke lane's
 * public accounting, so a literal zero is a claim the runner cannot back: the moment the
 * smoke lane gains a quarantine, the summary under-reports it silently and the "quarantine
 * never hides a regression" guarantee stops being observable on this lane.
 *
 * The count is therefore computed over `$knextQuarantines` in the deploy-tests manifest —
 * the single quarantine ledger this repo has — with two loud failure modes rather than a
 * quiet zero:
 *   1. an unreadable / non-array ledger THROWS (an unreachable source is a failure, never
 *      a pass — the same rule the action-pin nightly follows);
 *   2. an entry that is attributable to NEITHER the official suite NOR a known smoke check
 *      THROWS, so an unparseable entry fails instead of being skipped. Scanning, not an
 *      enumerated allowlist.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SMOKE_PATH = resolve(REPO_ROOT, 'apps/file-manager/scripts/compat-smoke.mjs');
const smokeSrc = readFileSync(SMOKE_PATH, 'utf8');

/** The smoke runner's own check names, as the runner would pass them. */
const CHECK_NAMES = ['a. app router SSR', 'g. next/image optimization'];

describe('#512 — the smoke runner derives its quarantine count from the real ledger', () => {
  it('counts a smoke-lane ledger entry against the lane it declares', () => {
    const ledger = [
      { test: 'g. next/image optimization', lane: 'node' },
      { test: 'a. app router SSR', lane: 'bun' },
    ];
    expect(smokeQuarantineCount({ ledger, lane: 'node', checkNames: CHECK_NAMES })).toBe(1);
    expect(smokeQuarantineCount({ ledger, lane: 'bun', checkNames: CHECK_NAMES })).toBe(1);
  });

  it('defaults a smoke entry with no lane to the node lane (the ledger default)', () => {
    const ledger = [{ test: 'a. app router SSR' }];
    expect(smokeQuarantineCount({ ledger, lane: 'node', checkNames: CHECK_NAMES })).toBe(1);
    expect(smokeQuarantineCount({ ledger, lane: 'bun', checkNames: CHECK_NAMES })).toBe(0);
  });

  it('does NOT attribute official-suite entries to the smoke lane', () => {
    const ledger = [
      { test: 'test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts', lane: 'node' },
    ];
    expect(smokeQuarantineCount({ ledger, lane: 'node', checkNames: CHECK_NAMES })).toBe(0);
  });

  it('THROWS on an entry attributable to neither suite — never a quiet zero', () => {
    const ledger = [{ test: 'z. a check that does not exist', lane: 'node' }];
    expect(() => smokeQuarantineCount({ ledger, lane: 'node', checkNames: CHECK_NAMES })).toThrow(
      /unattributable|unknown/i,
    );

    expect(() =>
      smokeQuarantineCount({
        ledger: [{ test: 'who knows' }],
        lane: 'node',
        checkNames: CHECK_NAMES,
      }),
    ).toThrow(/unattributable|unknown/i);
  });

  it('THROWS on a missing / malformed ledger rather than reporting zero', () => {
    expect(() =>
      smokeQuarantineCount({ ledger: undefined, lane: 'node', checkNames: CHECK_NAMES }),
    ).toThrow(/ledger/i);
    expect(() => loadQuarantineLedger(resolve(REPO_ROOT, 'no-such-dir'))).toThrow(/ledger|ENOENT/i);
  });

  it('reads the REAL ledger and attributes none of its live entries to the smoke lane', () => {
    const ledger = loadQuarantineLedger(REPO_ROOT);
    expect(Array.isArray(ledger)).toBe(true);
    expect(ledger.length).toBeGreaterThan(0);
    for (const lane of ['node', 'bun']) {
      expect(smokeQuarantineCount({ ledger, lane, checkNames: CHECK_NAMES })).toBe(0);
    }
  });
});

describe('#512 — the PRINTED summary line tracks the ledger (behavioural, not text)', () => {
  /**
   * The first round of this guard asserted only SOURCE TEXT (`quarantined=${…}` present,
   * no `quarantined=<digit>`). A reviewer defeated it by changing the interpolation to
   * `${0}` — every test stayed green. Text cannot tell a derived value from a fake one, so
   * the summary line is now BUILT by `formatLaneSummary()` and asserted as a RETURNED
   * STRING over ledgers of different sizes: a constant cannot satisfy 0, 1 and 2 at once.
   */
  const line = (ledger: unknown, lane = 'node') =>
    formatLaneSummary({ lane, passing: 7, failing: 0, ledger, checkNames: CHECK_NAMES });

  it('prints the count the ledger actually implies — 0, 1 and 2 all differ', () => {
    expect(line([])).toMatch(/quarantined=0\b/);
    expect(line([{ test: 'a. app router SSR', lane: 'node' }])).toMatch(/quarantined=1\b/);
    expect(
      line([
        { test: 'a. app router SSR', lane: 'node' },
        { test: 'g. next/image optimization', lane: 'node' },
      ]),
    ).toMatch(/quarantined=2\b/);
  });

  it('is lane-scoped: the other lane’s entries do not inflate this lane’s line', () => {
    const ledger = [
      { test: 'a. app router SSR', lane: 'node' },
      { test: 'g. next/image optimization', lane: 'bun' },
    ];
    expect(line(ledger, 'node')).toMatch(/LANE=node {2}passing=7 {2}quarantined=1 {2}failing=0/);
    expect(line(ledger, 'bun')).toMatch(/LANE=bun {2}passing=7 {2}quarantined=1 {2}failing=0/);
  });

  it('propagates the loud failures instead of printing a line it cannot back', () => {
    expect(() => line(undefined)).toThrow(/ledger/i);
    expect(() => line([{ test: 'not a check and not test/…' }])).toThrow(/unattributable/i);
  });

  it('prints the REAL ledger as quarantined=0 today (structurally, see the module header)', () => {
    expect(line(loadQuarantineLedger(REPO_ROOT))).toMatch(/quarantined=0\b/);
  });

  it('the runner delegates the whole line — it may not format `quarantined=` itself', () => {
    // Structural backstop for the behavioural assertions above: if the runner ever
    // rebuilt the line locally, the tests above would be checking code nobody calls.
    expect(smokeSrc).not.toMatch(/quarantined=/);
    expect(smokeSrc).toMatch(/compat-smoke-quarantines\.mjs/);
    expect(smokeSrc).toMatch(/formatLaneSummary\(/);
    expect(smokeSrc).toMatch(/loadQuarantineLedger\(/);
  });
});
