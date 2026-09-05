/**
 * The T6b DEFERRAL has a clock (#936).
 *
 * T6b closed the half that could be closed cheaply: the two mutating seams on
 * `@getknext/core/adapters/cache-handler` now refuse unconditionally under
 * `NODE_ENV=production`, so the `KNEXT_TEST_SEAMS` flag cannot re-open them in a
 * production process. What it did NOT do is remove the surface — they are still
 * exported from a **published** subpath, so a consumer's dev or CI process is
 * still one where a transitive dependency can repoint the process-wide cache.
 *
 * Relocating them to a test-only entry is a **public-API change**, which is a
 * `workflow.md` escalation trigger, so it is tracked (#936) rather than smuggled
 * into a hardening PR. This file is what stops that tracking from being prose:
 * `security.md`'s own standard is that a documented expectation degrades and its
 * efficacy is unobservable until it has already failed, so the deferral gets the
 * same treatment #928 got — a justification, a date, and a clock that reds CI.
 *
 * WHY THIS LIVES IN `tests/` AND NOT BESIDE THE SEAM GATE. It reads
 * `scripts/lib/published-seam-policy.mjs`, an untyped `.mjs` outside the
 * `@getknext/core` package's tsconfig — importing it from
 * `packages/kn-next/src/__tests__/` fails the package typecheck (TS7016). Every
 * other dated-exemption guard in this repo is a repo-level `tests/` spec for the
 * same reason, so this follows them rather than inventing a declaration file.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  activeSeamRelocationExemptions,
  SEAM_RELOCATION_EXEMPTIONS,
} from '../scripts/lib/published-seam-policy.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const HANDLER_SRC = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/cache-handler.js');

/**
 * The GATED seams, read out of the module rather than listed here — the same
 * derivation `cache-handler-seam-gate.test.ts` uses, for the same reason: an
 * enumerated pair is how a third seam ships with no exception and no clock.
 */
function gatedSeamNames(): string[] {
  const src = readFileSync(HANDLER_SRC, 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/assertTestSeamEnabled\(\s*['"](__[A-Za-z0-9_]+)['"]\s*\)/g)) {
    found.add(m[1] as string);
  }
  return [...found].sort();
}

describe('the published-seam relocation deferral is dated (#936)', () => {
  it('discovers the gated seams instead of trusting a list', () => {
    const seams = gatedSeamNames();
    // Anti-vacuity: an empty scan makes the loop below iterate zero times and
    // report a pass, which is the failure mode this whole file guards against.
    expect(
      seams.length,
      'no gated seams found — the scan is broken, or the gate was removed wholesale',
    ).toBeGreaterThanOrEqual(2);
  });

  it('every seam still on the published subpath is a DATED exception', () => {
    const excused = activeSeamRelocationExemptions();
    for (const seam of gatedSeamNames()) {
      expect(
        excused,
        `${seam} is still exported from the published cache-handler subpath and its relocation ` +
          'exception has EXPIRED. Do the relocation (#936), or re-date the entry in ' +
          'scripts/lib/published-seam-policy.mjs with a reason. Do not weaken this test.',
      ).toContain(`@getknext/core/adapters/cache-handler#${seam}`);
    }
  });

  it('the relocation clock is real, not decorative', () => {
    // The other half. Without it an exemption reader that never expires anything
    // would satisfy the case above forever — the quietest way to neuter a
    // deferral, because it still reads as dated.
    const [entry] = SEAM_RELOCATION_EXEMPTIONS;
    const after = new Date(`${entry?.expires}T00:00:01Z`);
    expect(activeSeamRelocationExemptions(after).size).toBe(0);
  });
});
