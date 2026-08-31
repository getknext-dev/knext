/**
 * The load-soak SLOs must keep their teeth, and both copies of them must agree.
 *
 * WHY THIS EXISTS. `packages/scale-zero-pg/deploy/88-loadsoak-k6.yaml` is the only
 * thing in this repo that measures behaviour UNDER LOAD, and it carries the latency
 * and error-budget SLOs as k6 `thresholds`. Nothing guarded them. Two failure modes
 * were open:
 *
 *   1. DRIFT. Every knob is defaulted TWICE — once in the k6 script
 *      (`__ENV.P95_MS || '1500'`) and once in the drill that renders it
 *      (`P95_MS="${P95_MS:-1500}"`). Two copies of a number with nothing comparing
 *      them is the same shape as the install-URL drift this repo already guards:
 *      change one, and a run silently measures against a different bar than the one
 *      documented.
 *   2. DEFANGING. A soak that goes red is fixed either by making the system faster
 *      or by moving the bar. `MAX_ERR_RATE=1.0` makes the error threshold
 *      unfailable while leaving a `thresholds` block that still LOOKS like a gate —
 *      decoration, in the sense `workflow.md` uses, applied to a performance gate.
 *
 * WHAT THIS DOES NOT DO. It does not run k6 and it does not need a cluster: the soak
 * itself is a drill, applied on demand. This asserts only that the SLOs exist, agree
 * across their two homes, and remain capable of failing.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = resolve(REPO_ROOT, 'packages/scale-zero-pg/deploy/88-loadsoak-k6.yaml');
const DRILL = resolve(REPO_ROOT, 'packages/scale-zero-pg/deploy/_verify-loadsoak.sh');

const manifest = readFileSync(MANIFEST, 'utf8');
const drill = readFileSync(DRILL, 'utf8');

/** `const NAME = ... __ENV.NAME || 'value'` in the k6 script. */
function manifestDefault(name: string): string | undefined {
  const m = manifest.match(new RegExp(`__ENV\\.${name}\\s*\\|\\|\\s*'([^']*)'`));
  return m?.[1];
}

/** `NAME="${NAME:-value}"` in the drill. */
function drillDefault(name: string): string | undefined {
  const m = drill.match(new RegExp(`^${name}="\\$\\{${name}:-([^}]*)\\}"`, 'm'));
  return m?.[1];
}

// Every knob that exists in BOTH files. Deliberately derived from the manifest rather
// than hand-listed, so a knob added later is covered without anyone remembering to.
//
// NOTE the DIGITS in the character class. It was `[A-Z_]+` first, which silently
// skipped `P95_MS` and `P99_MS` — the two latency SLOs this file exists to guard —
// because their names contain digits. The suite was fully green with the drift check
// covering everything EXCEPT the thing it was written for. Mutation-proving caught it:
// drifting the drill's p95 default left 13/13 passing.
const SHARED_KNOBS = [...manifest.matchAll(/__ENV\.([A-Z0-9_]+)\s*\|\|/g)]
  .map((m) => m[1])
  .filter((name) => drillDefault(name) !== undefined)
  // TARGET_URL is the ONE knob whose two defaults legitimately differ, and the
  // exemption is admissible only because the drill makes the k6 fallback
  // unreachable: it defaults TARGET_URL to empty and then hard-fails on empty
  // before rendering (`[ -n "$TARGET_URL" ] || fail ...`). The test below asserts
  // that guard, so if someone deletes it this exemption stops being justified and
  // the suite says so — rather than the exemption quietly covering a real drift.
  .filter((name) => name !== 'TARGET_URL');

describe('load-soak SLOs — the thresholds exist and can still fail', () => {
  it('the k6 script declares p95, p99 and error-rate thresholds', () => {
    expect(manifest).toMatch(/thresholds:\s*\{/);
    expect(manifest).toMatch(/p\(95\)<\$\{P95_MS\}/);
    expect(manifest).toMatch(/p\(99\)<\$\{P99_MS\}/);
    expect(manifest).toMatch(/rate<\$\{MAX_ERR_RATE\}/);
  });

  it('the thresholds are wired to the metrics they claim to bound', () => {
    // A threshold on a metric nothing records passes vacuously.
    expect(manifest).toMatch(/'http_req_duration'\s*:/);
    expect(manifest).toMatch(/'app_errors'\s*:/);
    expect(manifest).toMatch(/new Rate\('app_errors'\)/);
  });

  it('the error budget is capable of failing', () => {
    const raw = manifestDefault('MAX_ERR_RATE');
    expect(raw, 'MAX_ERR_RATE default not found in the k6 script').toBeTruthy();
    const budget = Number(raw);
    expect(Number.isFinite(budget)).toBe(true);
    // rate<1 can fail; rate<1.0 (or more) cannot, because a rate never exceeds 1.
    expect(
      budget,
      `MAX_ERR_RATE=${raw} makes the error threshold unfailable — a rate never exceeds 1`,
    ).toBeLessThan(1);
    expect(budget).toBeGreaterThan(0);
  });

  it('the latency bars are finite and ordered p95 <= p99', () => {
    const p95 = Number(manifestDefault('P95_MS'));
    const p99 = Number(manifestDefault('P99_MS'));
    expect(Number.isFinite(p95) && p95 > 0, `P95_MS=${p95}`).toBe(true);
    expect(Number.isFinite(p99) && p99 > 0, `P99_MS=${p99}`).toBe(true);
    expect(
      p95,
      'a p95 bar above the p99 bar makes the p99 threshold unreachable',
    ).toBeLessThanOrEqual(p99);
  });

  it('the soak is long enough to be a soak, and holds below the ramp ceiling', () => {
    const soakDur = manifestDefault('SOAK_DUR') ?? '';
    const minutes = Number(soakDur.replace(/m$/, ''));
    expect(soakDur, 'SOAK_DUR must be expressed in minutes').toMatch(/^\d+m$/);
    expect(
      minutes,
      'a "soak" shorter than 10 minutes measures the ramp, not steady state',
    ).toBeGreaterThanOrEqual(10);
    const ceil = Number(manifestDefault('RAMP_CEIL_VU'));
    const soak = Number(manifestDefault('SOAK_VU'));
    expect(soak).toBeLessThanOrEqual(ceil);
  });
});

describe('load-soak SLOs — the two copies of every default agree', () => {
  it('finds the shared knobs at all (not vacuous)', () => {
    // If the parsers stop matching, every drift assertion below passes trivially.
    expect(SHARED_KNOBS.length).toBeGreaterThanOrEqual(6);
    expect(SHARED_KNOBS).toContain('MAX_ERR_RATE');
  });

  it('TARGET_URL is exempt from drift ONLY because the drill refuses to run without it', () => {
    // The k6 script falls back to http://app.default.svc.cluster.local/ — a real URL
    // that would silently soak the WRONG target if an empty value ever reached it.
    // What makes that unreachable is this guard in the drill, so the guard is the thing
    // worth asserting.
    expect(drillDefault('TARGET_URL'), 'the drill should default TARGET_URL to empty').toBe('');
    expect(
      drill,
      'the drill must hard-fail on an empty TARGET_URL; without it the k6 fallback ' +
        'becomes reachable and a run soaks the wrong URL while reporting success',
    ).toMatch(/\[ -n "\$TARGET_URL" \] \|\| fail/);
  });

  it.each(SHARED_KNOBS)('%s has the same default in the k6 script and the drill', (name) => {
    const inManifest = manifestDefault(name);
    const inDrill = drillDefault(name);
    expect(
      inDrill,
      `${name}: drill default "${inDrill}" != k6 script default "${inManifest}" — ` +
        'two copies of an SLO that disagree mean a run measures against a different bar ' +
        'than the one documented',
    ).toBe(inManifest);
  });
});
