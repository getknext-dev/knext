import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// The plain-ESM helper the smoke runner itself imports (tsconfig.typecheck's `allowJs`
// infers its types from the JSDoc) — the guard exercises the SAME code, not a copy.
import {
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
      { test: 'compat-smoke:g. next/image optimization', lane: 'node' },
      { test: 'compat-smoke:a. app router SSR', lane: 'bun' },
    ];
    expect(smokeQuarantineCount({ ledger, lane: 'node', checkNames: CHECK_NAMES })).toBe(1);
    expect(smokeQuarantineCount({ ledger, lane: 'bun', checkNames: CHECK_NAMES })).toBe(1);
  });

  it('defaults a smoke entry with no lane to the node lane (the ledger default)', () => {
    const ledger = [{ test: 'compat-smoke:a. app router SSR' }];
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
    const ledger = [{ test: 'compat-smoke:z. a check that does not exist', lane: 'node' }];
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

describe('#512 — the printed count is an interpolation, not a literal', () => {
  it('the summary line interpolates a variable for quarantined=', () => {
    expect(smokeSrc).toMatch(/quarantined=\$\{[^}]+\}/);
    expect(smokeSrc).not.toMatch(/quarantined=\d/);
  });

  it('the runner actually calls the shared derivation', () => {
    expect(smokeSrc).toMatch(/compat-smoke-quarantines\.mjs/);
    expect(smokeSrc).toMatch(/smokeQuarantineCount\(/);
    expect(smokeSrc).toMatch(/loadQuarantineLedger\(/);
  });
});
