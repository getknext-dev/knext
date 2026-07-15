import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * v5-P2 (#281/#282) — compat-ledger LANE-SCOPING + per-mechanism-family SOFT BOUND
 * (ADR-0007 §c/§d amendment).
 *
 * TWO new accounting properties on top of the existing deploy-manifest guard
 * (tests/deploy-manifest.test.ts is preserved verbatim; this file only ADDS):
 *
 *  1. LANE-SCOPING. Every $knextQuarantines entry is attributed to EXACTLY ONE
 *     lane — "node" or "bun" — mirroring the ALREADY-EXISTING Node/Bun matrix-row
 *     split in docs/compat-matrix.md (the Node 778/0 credential row vs the Bun
 *     runtime-axis row). This is NOT a new parity claim: it aligns the ledger's
 *     accounting to a split the scoreboard already draws. TOTAL CONSERVATION:
 *     sum(per-lane counts) === total ledger size — nothing may be truncated into
 *     invisibility by lane bucketing.
 *
 *  2. PER-MECHANISM-FAMILY SOFT BOUND. The #214 lesson (a growing blanket skip is
 *     not a policy) is codified as a bound PER mechanism-family. Exceeding the
 *     bound is a HARD FAIL with a documented escalation message — a warn-and-pass
 *     cap is a fake-green vector and is rejected. N is a reviewed constant.
 *
 * These are SCHEMA + ACCOUNTING only: zero live matrix numbers and zero manifest
 * test-case selections are touched.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'test/deploy-tests-manifest.knext.json');

interface KnextQuarantine {
  test: string;
  cases?: string[];
  mechanism: string;
  evidence: string;
  provenance: string;
  nextjsRef?: string;
  reaudited?: string;
  level?: 'case' | 'file';
  /** v5-P2: the matrix lane this quarantine is accounted against (default "node"). */
  lane?: 'node' | 'bun';
  /** v5-P2: the mechanism-family the entry belongs to (soft-bounded per family). */
  family?: string;
}

interface Manifest {
  version: number;
  suites: Record<string, { failed?: string[]; flakey?: string[] }>;
  rules: { include: string[]; exclude: string[] };
  $knextExclusions: { test: string; rationale: string; category: string }[];
  $knextQuarantines?: KnextQuarantine[];
}

const manifest: Manifest = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  : ({} as Manifest);

const quarantines: KnextQuarantine[] = manifest.$knextQuarantines ?? [];

/** The two lanes the compat-matrix already splits on (Node credential + Bun axis). */
const LANES = ['node', 'bun'] as const;

/**
 * The mechanism-family taxonomy is CLOSED. Every quarantine entry must name one of
 * these; anything else fails loudly (a new family requires a reviewed amendment).
 *  - runtime-prefetch : the §d navigation-timing / segment-cache race family.
 *  - bun-edge-fetch   : the documented Bun edge-sandbox outbound-fetch gap.
 */
const KNOWN_FAMILIES = new Set(['runtime-prefetch', 'bun-edge-fetch']);

/**
 * The per-mechanism-family SOFT BOUND. A reviewed constant: the runtime-prefetch
 * family (§d) is the largest today at 12 file-level entries, so 15 leaves modest
 * headroom while making an unbounded blanket-skip drift FAIL. Kept in sync with
 * the existing ≤15 file-level cap in tests/deploy-manifest.test.ts.
 */
const PER_FAMILY_SOFT_BOUND = 15;

/** The exact escalation message the guard must emit on a per-family overflow. */
function familyOverflowMessage(family: string, count: number): string {
  return (
    `mechanism-family "${family}" has ${count} quarantine entries, over the reviewed ` +
    `per-family soft bound of ${PER_FAMILY_SOFT_BOUND}. ESCALATE: a growing blanket skip ` +
    `is not a policy (ADR-0007 §d) — do not raise the bound to go green. Re-audit the ` +
    `family at the current NEXTJS_REF, drop entries that no longer wobble, and if the ` +
    `family genuinely still exceeds ${PER_FAMILY_SOFT_BOUND} bring a reviewed ADR-0007 ` +
    `amendment (the upstream root-cause fix should be shrinking it, not growing it).`
  );
}

/** Count entries per lane (default lane is "node"). */
function laneCounts(entries: KnextQuarantine[]): Record<(typeof LANES)[number], number> {
  const counts: Record<string, number> = { node: 0, bun: 0 };
  for (const q of entries) counts[q.lane ?? 'node']++;
  return counts as Record<(typeof LANES)[number], number>;
}

/** Count entries per mechanism-family. */
function familyCounts(entries: KnextQuarantine[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const q of entries) {
    const fam = q.family ?? '';
    counts[fam] = (counts[fam] ?? 0) + 1;
  }
  return counts;
}

/**
 * The guard proper: throws the escalation message when ANY mechanism-family
 * exceeds the soft bound. This is the FAIL-with-escalation behavior — proven
 * below to throw (not warn) on an over-cap family.
 */
function assertPerFamilySoftBound(entries: KnextQuarantine[]): void {
  const counts = familyCounts(entries);
  for (const [family, count] of Object.entries(counts)) {
    if (count > PER_FAMILY_SOFT_BOUND) {
      throw new Error(familyOverflowMessage(family, count));
    }
  }
}

describe('v5-P2 lane-scoping — every entry lands in exactly one lane (#281)', () => {
  it('there are quarantine entries to account (sanity)', () => {
    expect(quarantines.length).toBeGreaterThan(0);
  });

  it('every entry declares a lane in the closed {node,bun} set (default node)', () => {
    for (const q of quarantines) {
      const lane = q.lane ?? 'node';
      expect(
        (LANES as readonly string[]).includes(lane),
        `${q.test}: lane "${String(q.lane)}" is not one of ${LANES.join(', ')}`,
      ).toBe(true);
    }
  });

  it('TOTAL CONSERVATION: sum(per-lane counts) === total ledger size', () => {
    const counts = laneCounts(quarantines);
    const summed = LANES.reduce((acc, lane) => acc + counts[lane], 0);
    expect(
      summed,
      `per-lane sum ${summed} != ledger size ${quarantines.length} — an entry was ` +
        'truncated into invisibility by lane bucketing',
    ).toBe(quarantines.length);
  });

  it('lane attribution is correct: bun-lane entries are the documented bun-only observations', () => {
    // The compat-matrix Bun row documents exactly these two files as bun-lane-only
    // observations (Node lane is green on both — they are part of the Node 778/0
    // credential). The ledger's lane field must mirror that split, not cross-tax
    // the Node scoreboard.
    const bunLaneFiles = new Set(quarantines.filter((q) => q.lane === 'bun').map((q) => q.test));
    expect(bunLaneFiles).toEqual(
      new Set([
        'test/e2e/app-dir/server-actions-redirect-middleware-rewrite/server-actions-redirect-middleware-rewrite.test.ts',
        'test/e2e/edge-async-local-storage/index.test.ts',
      ]),
    );
  });

  it('the runtime-prefetch §d family stays on the NODE lane (it is the Node credential)', () => {
    // The file-level §d family entries are the Node 778/0 credential's quarantines;
    // they must NOT be booked against the Bun lane.
    for (const q of quarantines) {
      if (q.level === 'file' && q.family === 'runtime-prefetch') {
        expect(q.lane ?? 'node', `${q.test}: runtime-prefetch family entry must be node-lane`).toBe(
          'node',
        );
      }
    }
  });

  it('records the lane split as MIRRORING the pre-existing matrix rows (not a new claim)', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf8');
    expect(
      /mirror/i.test(raw) && /lane/i.test(raw),
      'the manifest must state the lane field mirrors the existing Node/Bun matrix-row split',
    ).toBe(true);
  });
});

describe('v5-P2 mechanism-family soft bound — HARD FAIL on overflow (#282)', () => {
  it('every entry declares a family in the closed taxonomy', () => {
    for (const q of quarantines) {
      expect(
        q.family !== undefined && KNOWN_FAMILIES.has(q.family),
        `${q.test}: family "${String(q.family)}" is not in the closed taxonomy ` +
          `{${[...KNOWN_FAMILIES].join(', ')}}`,
      ).toBe(true);
    }
  });

  it('the live ledger is UNDER the per-family soft bound (guard passes on current data)', () => {
    expect(() => assertPerFamilySoftBound(quarantines)).not.toThrow();
  });

  it('the soft bound is a HARD FAIL, not a warn-and-pass — an over-cap family THROWS the escalation message', () => {
    // Synthesize a family that exceeds the bound and prove the guard THROWS (exits
    // non-zero) rather than warning. A warn-and-pass cap is a fake-green vector.
    const over: KnextQuarantine[] = Array.from({ length: PER_FAMILY_SOFT_BOUND + 1 }, (_, i) => ({
      test: `test/e2e/synthetic/over-cap-${i}.test.ts`,
      mechanism: 'synthetic',
      evidence: 'synthetic',
      provenance: 'synthetic',
      family: 'runtime-prefetch',
      lane: 'node' as const,
    }));
    expect(() => assertPerFamilySoftBound(over)).toThrow(/per-family soft bound/);
    // And the thrown message MUST carry the escalation instruction (not raise the bound).
    expect(() => assertPerFamilySoftBound(over)).toThrow(/ESCALATE/);
    expect(() => assertPerFamilySoftBound(over)).toThrow(/growing blanket skip is not a policy/);
  });

  it('the escalation message names the offending family and its count', () => {
    const msg = familyOverflowMessage('runtime-prefetch', 99);
    expect(msg).toContain('runtime-prefetch');
    expect(msg).toContain('99');
    expect(msg).toContain(String(PER_FAMILY_SOFT_BOUND));
  });

  it('every mechanism-family is individually at-or-under the bound (per-family, not global)', () => {
    const counts = familyCounts(quarantines);
    for (const [family, count] of Object.entries(counts)) {
      expect(
        count,
        `family "${family}" (${count}) exceeds the per-family soft bound ${PER_FAMILY_SOFT_BOUND}`,
      ).toBeLessThanOrEqual(PER_FAMILY_SOFT_BOUND);
    }
  });

  it('records the per-family soft bound + hard-fail-with-escalation policy in the manifest text', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf8');
    expect(
      /soft bound/i.test(raw) && /family/i.test(raw),
      'the manifest must document the per-mechanism-family soft bound',
    ).toBe(true);
    expect(
      /escalat/i.test(raw),
      'the manifest must state the bound is a hard fail WITH escalation (not warn-and-pass)',
    ).toBe(true);
  });
});

describe('v5-P2 preserves every family entry mapping (lane+family are additive metadata)', () => {
  it('each family:"runtime-prefetch" entry is a level:"file" §d quarantine (no reclassification)', () => {
    for (const q of quarantines) {
      if (q.family === 'runtime-prefetch') {
        expect(q.level, `${q.test}: runtime-prefetch entries are file-level §d quarantines`).toBe(
          'file',
        );
      }
    }
  });

  it('each family:"bun-edge-fetch" entry is a per-case bun-lane quarantine (§c.1 mechanics)', () => {
    for (const q of quarantines) {
      if (q.family === 'bun-edge-fetch') {
        expect(q.lane, `${q.test}: bun-edge-fetch entries are bun-lane`).toBe('bun');
        expect(q.level ?? 'case', `${q.test}: bun-edge-fetch entries stay per-case`).not.toBe(
          'file',
        );
      }
    }
  });
});
