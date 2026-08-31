import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD TEST for the four previously-unbacked capability rows (Sprint 1, T4).
 *
 * `docs/compat-matrix.md` carried four rows that were implemented but whose `compat-smoke`
 * evidence either SKIPPED on failure or did not exist at all:
 *
 *   next/image optimization · Server Actions · Streaming/Suspense · ISR with a real Redis
 *
 * A capability whose check skips is indistinguishable from a broken one, so this file asserts
 * the STRUCTURAL properties that made those rows unbacked can never come back:
 *
 *   1. the smoke runner has NO skip-on-fail mechanism at all (only the runtime-lane filter);
 *   2. all four checks exist and are hard;
 *   3. each asserts its OWN named evidence rather than "the app answered 200";
 *   4. CI actually supplies the real Redis check (k) refuses to run without.
 *
 * This is a regression fence. The behavioural proof is the mutation-proof recorded in the PR:
 * each check was individually reddened by breaking only its own capability.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SMOKE_PATH = resolve(REPO_ROOT, 'apps/file-manager/scripts/compat-smoke.mjs');
const CI_PATH = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const APP_DIR = resolve(REPO_ROOT, 'apps/file-manager');

const smokeSrc = readFileSync(SMOKE_PATH, 'utf8');
const ciSrc = readFileSync(CI_PATH, 'utf8');

/** Body of a single `await check('<id>. …', async () => { … })` declaration. */
function checkBody(id: string): string {
  const re = new RegExp(
    `check\\(\\s*['"]${id}\\.[\\s\\S]*?(?=await check\\(|// ─{2,}|printReport\\()`,
  );
  const m = smokeSrc.match(re);
  return m ? m[0] : '';
}

describe('compat-smoke — the four capability checks are red-on-fail (T4)', () => {
  it('the runner has no skip-on-fail mechanism at all', () => {
    // The old `skip(msg)` helper threw an error tagged `__skip`, which `check()` downgraded
    // to a SKIP result. Both halves must be gone — a check may only PASS or FAIL.
    expect(smokeSrc).not.toMatch(/__skip/);
    expect(smokeSrc).not.toMatch(/function skip\s*\(/);
  });

  it('the only SKIP the runner can emit is the declared runtime-lane filter', () => {
    const skipEmissions = smokeSrc.match(/status:\s*'SKIP'/g) ?? [];
    expect(skipEmissions).toHaveLength(1);
    // …and it lives in the lane filter, which runs BEFORE the check body executes.
    expect(smokeSrc).toMatch(/if \(!lanes\.includes\(LANE\)\)[\s\S]{0,200}status: 'SKIP'/);
  });

  it.each([
    ['g', 'next/image optimization'],
    ['i', 'Server Action'],
    ['j', 'Streaming'],
    ['k', 'ISR'],
  ])('check (%s) exists and its body cannot skip', (id, label) => {
    const body = checkBody(id);
    expect(body, `check (${id}) — ${label} — not found in compat-smoke.mjs`).not.toBe('');
    expect(body).not.toMatch(/\bskip\(/);
  });

  it('(g) asserts a negotiated transcode and a re-encode, not merely "some image bytes"', () => {
    const body = checkBody('g');
    // Format negotiation: a static-file passthrough would answer image/png.
    expect(body).toMatch(/accept:\s*'image\/webp/);
    expect(body).toMatch(/'image\/webp'/);
    // Re-encode: the optimized output must be smaller than the source asset.
    expect(body).toMatch(/res\.bytes\s*<\s*source\.bytes/);
  });

  it('(i) drives a real action round-trip, keyed on a per-run nonce', () => {
    const body = checkBody('i');
    expect(body).toMatch(/\$ACTION_ID_/);
    expect(body).toMatch(/method|post\(/);
    expect(body).toMatch(/nonce/);
  });

  it('(j) asserts chunk ARRIVAL ORDERING, which a buffered response cannot satisfy', () => {
    const body = checkBody('j');
    expect(body).toMatch(/requestChunks\(/);
    // ordering + a real time gap — asserting the final body would pass on a buffered response
    expect(body).toMatch(/lateIdx\s*>\s*shellIdx/);
    expect(body).toMatch(/gap\s*>=\s*300/);
  });

  it('(k) refuses to run without a real REDIS_URL and asserts CHANGED content', () => {
    const body = checkBody('k');
    expect(body).toMatch(/assert\.ok\(\s*REDIS_URL/);
    // cached (identical back-to-back) AND revalidated (changed afterwards)
    expect(body).toMatch(/assert\.strictEqual\(\s*immediate,\s*first/);
    expect(body).toMatch(/assert\.notStrictEqual\(\s*current,\s*first/);
    // named evidence that the cache really was the configured Redis
    expect(body).toMatch(/redisDbSize\(/);
  });

  it('the server is booted with the inherited REDIS_URL, not a hard-coded empty one', () => {
    expect(smokeSrc).not.toMatch(/REDIS_URL:\s*''/);
    expect(smokeSrc).toMatch(/const REDIS_URL = process\.env\.REDIS_URL/);
  });

  it('the fixture routes the checks depend on exist', () => {
    expect(existsSync(resolve(APP_DIR, 'src/app/knext-smoke/stream/page.tsx'))).toBe(true);
    expect(existsSync(resolve(APP_DIR, 'src/app/knext-smoke/isr/page.tsx'))).toBe(true);
    expect(existsSync(resolve(APP_DIR, 'public/knext-optimize-fixture.png'))).toBe(true);
  });
});

describe('ci.yml — the compat-smoke job supplies the real Redis (T4)', () => {
  /** The `compat-smoke:` job block, up to the next top-level job key. */
  const job = ciSrc.match(/^ {2}compat-smoke:[\s\S]*?(?=^ {2}[a-z][\w-]*:$)/m)?.[0] ?? '';

  it('the compat-smoke job was found', () => {
    expect(job).not.toBe('');
  });

  it('runs a Redis service container, pinned by digest', () => {
    expect(job).toMatch(/services:/);
    expect(job).toMatch(/image:\s*redis:[\w.-]+@sha256:[0-9a-f]{64}/);
  });

  it('passes a real REDIS_URL into the smoke run', () => {
    expect(job).toMatch(/REDIS_URL:\s*redis:\/\//);
  });
});
