import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import {
  activeStaleProverExemptions,
  auditProverAnchors,
  findProverFiles,
  KNOWN_STALE_PROVER_EXEMPTIONS,
  scanProverFile,
} from '../scripts/lib/prover-anchor-scan.mjs';

/**
 * GUARD (#1223).
 *
 * `scripts/mutation-prove-compat-window-audit.mjs` mutation #4 anchored on
 * text `scripts/compat-window-audit.mjs` no longer carried, so the prover
 * ABORTED instead of proving the guard — and nothing caught it until a human
 * ran the script by hand. Every prover in this fleet has the same failure
 * mode: a hardcoded text anchor is a snapshot of source that WILL move under
 * an unrelated edit, and `mutate()`'s own "occurs exactly once" check only
 * fires when someone actually RUNS the prover, which no CI job does.
 *
 * This is the fleet-wide generalisation of the one-off precedent
 * `tests/publish-markers-proof-runnable.test.ts` set: load every prover's
 * anchor list STATICALLY (`scripts/lib/prover-anchor-scan.mjs`) and assert it
 * still resolves against the CURRENT tree, without running a single prover or
 * spawning a single spec.
 *
 * Coverage is HONEST, not total — read the module doc on
 * `scripts/lib/prover-anchor-scan.mjs` for exactly what it can and cannot
 * statically resolve, and why an anchor computed at run time is correctly
 * left unchecked rather than guessed at.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * RATCHET FLOORS, not a "some coverage exists" smoke check (review feedback on
 * #1250). Measured on this tree: 66 resolved (anchor, file) pairs across 13
 * provers. A `toBeGreaterThan(10)`-style floor would stay green if the
 * scanner regressed and lost most of the fleet — e.g. if the wrapper-function
 * resolution tier (`findAnchorParamFunctions`/`scanWrapperCallSites`, the
 * shape `mutation-prove-compat-window-audit.mjs` itself uses) silently broke,
 * dropping straight to whatever the direct-literal tier alone still catches
 * (measured: 30 pairs across 7 provers with that tier disabled — still
 * comfortably above a low "some coverage" bar, and exactly what these floors
 * exist to catch instead).
 * `scripts/mutation-prove-prover-anchor-scanner-tier.mjs` mutation-proves
 * exactly that: disable the wrapper-function tier, watch these floors go
 * red, restore, watch them go green again.
 *
 * RAISE these when the fleet's resolvable coverage grows (a new prover in the
 * wrapper-function or table-driven shape, or a resolution tier gaining
 * ground). NEVER LOWER them — a lowered floor is exactly the silent
 * regression this ratchet exists to make loud.
 */
const MIN_RESOLVED_PAIRS = 66;
const MIN_RESOLVED_PROVERS = 13;

describe("every mutation prover's STATICALLY-resolvable anchors still match the current tree", () => {
  it('discovers a non-vacuous set of provers (the scan is not silently matching nothing)', () => {
    const files = findProverFiles(REPO_ROOT);
    // Enumerated once, in a comment, so a collapse to near-zero is loud: at
    // the time this guard was written there were 40.
    expect(files.length, 'the mutation-prove-*.mjs glob matched almost nothing').toBeGreaterThan(
      20,
    );
    expect(files).toContain('scripts/mutation-prove-compat-window-audit.mjs');
  });

  it('resolves at least the ratcheted floor of (anchor, file) pairs and provers fleet-wide', () => {
    const files = findProverFiles(REPO_ROOT);
    let resolvedPairs = 0;
    let resolvedProvers = 0;
    for (const f of files) {
      const n = scanProverFile(REPO_ROOT, f).pairs.length;
      resolvedPairs += n;
      if (n > 0) resolvedProvers += 1;
    }
    expect(
      resolvedPairs,
      `resolved pairs dropped below the ${MIN_RESOLVED_PAIRS}-pair ratchet floor — a resolution ` +
        'tier likely regressed (see the floor comment above this describe block)',
    ).toBeGreaterThanOrEqual(MIN_RESOLVED_PAIRS);
    expect(
      resolvedProvers,
      `resolved-prover count dropped below the ${MIN_RESOLVED_PROVERS}-prover ratchet floor — a ` +
        'resolution tier likely regressed (see the floor comment above this describe block)',
    ).toBeGreaterThanOrEqual(MIN_RESOLVED_PROVERS);
  });

  it('#1223: compat-window-audit.mjs resolves ALL FIVE of its anchors, all clean', () => {
    // The concrete regression tripwire for the bug this file exists to catch:
    // mutation #4's anchor is now `l?.lane === lane || (isUnresolved(l) &&
    // l?.lane == null)`, matching the current `selectLaneNights` shape.
    const scanned = scanProverFile(REPO_ROOT, 'scripts/mutation-prove-compat-window-audit.mjs');
    expect(scanned.subjectFiles).toEqual(['scripts/compat-window-audit.mjs']);
    expect(scanned.pairs.length).toBe(5);
    expect(auditProverAnchors(REPO_ROOT, scanned)).toEqual([]);
  });

  it('every non-exempt prover with resolvable anchors is clean', () => {
    const exempt = activeStaleProverExemptions();
    const files = findProverFiles(REPO_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      if (exempt.has(file)) continue;
      const scanned = scanProverFile(REPO_ROOT, file);
      offenders.push(...auditProverAnchors(REPO_ROOT, scanned));
    }
    expect(offenders, offenders.join('\n  ')).toEqual([]);
  });

  it('every KNOWN-stale exemption still names a real, currently-discovered prover', () => {
    // Hygiene: an exemption for a prover that got renamed or deleted is dead
    // text pretending to excuse something. `dated-exemptions.mjs` already
    // enforces the shape (unique subject, required `expires`); this enforces
    // the SUBJECT still exists in the fleet the scan discovers.
    const files = new Set(findProverFiles(REPO_ROOT));
    for (const entry of KNOWN_STALE_PROVER_EXEMPTIONS) {
      expect(files.has(entry.prover), `exempted prover not found: ${entry.prover}`).toBe(true);
    }
  });

  it('every ACTIVE exemption still has a real finding (it is not excusing nothing)', () => {
    // The inverse hygiene check: an exemption that no longer corresponds to
    // any actual finding should be REMOVED, not left decorating a clean
    // prover — it would silently mask a NEW, unrelated regression in that
    // same file later.
    const exempt = activeStaleProverExemptions();
    for (const file of exempt) {
      const scanned = scanProverFile(REPO_ROOT, file);
      const findings = auditProverAnchors(REPO_ROOT, scanned);
      expect(
        findings.length,
        `${file} is exempted but has no findings — remove the exemption`,
      ).toBeGreaterThan(0);
    }
  });
});
