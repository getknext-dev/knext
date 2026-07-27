// cold-attribution-attribute.mjs — the attribution arithmetic, extracted so it can be tested
// against synthetic samples rather than only against whatever the cluster happened to produce.
// Consumed by cold-attribution-report.mjs; guarded by tests/cold-attribution-attribute.test.ts.
//
// The single job here is to REFUSE to name a cause the measurement does not support. Four ways an
// earlier version could still have emitted a false attribution, each closed below:
//
//  1. argmax survived the floor. The >=50% floor was applied to the SUM of all five interval
//     excesses, but the cause named was the single largest. Five intervals contributing ~20% each
//     summed to 100%, cleared the floor, and the tool named a bucket explaining 20%. The NAMED
//     interval must now clear the floor on its own; otherwise a ranked list is returned and the
//     sample is UNATTRIBUTABLE.
//  2. The intervals overlapped. `pulling->pulled` is contained inside `scheduled->started`, so
//     summing both double-counted the pull and a 30%-pull sample scored ~60%. Only the contiguous
//     create->scheduled->started->ready chain is summed; the pull is a diagnostic column.
//  3. `ready->response` is an upper bound, not an interval. Its end marker is the k6 DRIVER pod's
//     container termination, which includes the summary write and pod teardown — not the response.
//     It is the largest interval by construction and therefore the most likely spurious argmax, so
//     it is a diagnostic and is never summed and never named.
//  4. Clipping per-interval excess at zero (`Math.max(0, v - ceil)`) biased the sum upward only,
//     so quantization noise across five 1-s-resolution intervals could manufacture an explanation.
//     Excess is now signed.

export const ATTRIBUTION_FLOOR = 0.5;

// Kubernetes condition `lastTransitionTime` has one-second resolution, so an excess at or below 1 s
// is inside the measurement's own noise and must not be named as a cause.
export const QUANTIZATION_S = 1.0;

// Contiguous and non-overlapping: create -> scheduled -> (both containers) started -> ready.
export const DECOMPOSITION_KEYS = ['schedDelay', 'startDelay', 'boot'];

// Measured and reported, but never summed and never named — see 2 and 3 above.
export const DIAGNOSTIC_KEYS = ['pullDelta', 'postReady'];

export const INTERVAL_LABELS = {
  schedDelay: 'create→scheduled (scheduling)',
  pullDelta: 'pulling→pulled (image pull)',
  startDelay: 'scheduled→started (container start)',
  boot: 'started→ready (becoming servable)',
  postReady: 'ready→response (routing / activator)',
};

export const DIAGNOSTIC_REASONS = {
  pullDelta: 'contained inside scheduled→started — counting it as well would double-count the pull',
  postReady:
    'upper bound only — the end marker is the k6 driver pod container termination (summary write + teardown), not the response',
};

const ALL_KEYS = [...DECOMPOSITION_KEYS, ...DIAGNOSTIC_KEYS];

/**
 * @typedef {{schedDelay?: number|null, pullDelta?: number|null, startDelay?: number|null,
 *            boot?: number|null, postReady?: number|null}} Intervals
 * @typedef {{dur: number, intervals?: Intervals}} SampleRow
 * @typedef {{fastCeil: Record<string, number|null>, fastDurCeil: number|null}} Baseline
 * @typedef {{k: string, label: string, value: number|null, excess: number|null,
 *            share: number|null, reason?: string}} IntervalScore
 * @typedef {{cause: string|null, note: string, totalExcess: number|null, explained: number|null,
 *            share: number|null, ranked: IntervalScore[], diagnostics: IntervalScore[],
 *            unmeasured: string[]}} Attribution
 */

/**
 * Baseline = the WORST fast sample, per interval and in total. Excess is measured beyond anything
 * the fast mode ever did, so normal variation is never mistaken for a cause. No medians involved.
 *
 * @param {SampleRow[]} fastRows
 * @returns {Baseline}
 */
export function fastBaseline(fastRows) {
  const fastCeil = {};
  for (const k of ALL_KEYS) {
    const vals = fastRows.map((r) => r.intervals?.[k]).filter((v) => v != null);
    fastCeil[k] = vals.length ? Math.max(...vals) : null;
  }
  const durs = fastRows.map((r) => r.dur).filter((v) => v != null);
  return { fastCeil, fastDurCeil: durs.length ? Math.max(...durs) : null };
}

/**
 * Attribute one SLOW sample's excess over the fast mode, or refuse to.
 * Returns { cause, note, totalExcess, explained, share, ranked, diagnostics, unmeasured }.
 * `cause` is null when there is nothing to attribute, 'UNATTRIBUTABLE' when the measurement does
 * not support naming one, and an interval label otherwise.
 *
 * @param {SampleRow} row
 * @param {Baseline} baseline
 * @returns {Attribution}
 */
export function attributeSlowSample(row, baseline) {
  const { fastDurCeil, fastCeil = {} } = baseline ?? {};
  const empty = {
    totalExcess: null,
    explained: null,
    share: null,
    ranked: [],
    diagnostics: [],
    unmeasured: [],
  };
  if (fastDurCeil == null) {
    return {
      cause: 'UNATTRIBUTABLE',
      note: 'no fast samples in this arm to form a baseline',
      ...empty,
    };
  }

  const totalExcess = row.dur - fastDurCeil;

  const score = (k) => {
    const v = row.intervals?.[k] ?? null;
    const ceil = fastCeil[k] ?? null;
    // An interval with no fast baseline cannot be scored; unmeasured, not zero.
    // Excess is SIGNED — an interval faster than the worst fast sample offsets the others.
    const excess = v != null && ceil != null ? v - ceil : null;
    return {
      k,
      label: INTERVAL_LABELS[k],
      value: v,
      excess,
      share: excess != null && totalExcess > 0 ? excess / totalExcess : null,
    };
  };

  const scored = DECOMPOSITION_KEYS.map(score);
  const diagnostics = DIAGNOSTIC_KEYS.map((k) => ({ ...score(k), reason: DIAGNOSTIC_REASONS[k] }));
  const unmeasured = [...scored, ...diagnostics].filter((e) => e.excess == null).map((e) => e.k);
  const ranked = [...scored].sort((a, b) => (b.excess ?? -Infinity) - (a.excess ?? -Infinity));
  const explained = scored.reduce((a, e) => a + (e.excess ?? 0), 0);
  const share = totalExcess > 0 ? explained / totalExcess : 0;
  const base = { totalExcess, explained, share, ranked, diagnostics, unmeasured };

  if (totalExcess <= 0) return { cause: null, note: 'not in excess of the fast mode', ...base };

  const top = ranked[0];
  const topShare = top?.share ?? 0;
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const of = `of ${totalExcess.toFixed(2)}s excess`;

  // The largest DIAGNOSTIC, named in the note when it dwarfs everything scoreable — a reader must
  // be told where the unexplained time appears to sit even though it cannot be attributed there.
  const topDiag = [...diagnostics].sort(
    (a, b) => (b.excess ?? -Infinity) - (a.excess ?? -Infinity),
  )[0];
  const diagHint =
    topDiag?.excess != null && topDiag.excess > (top?.excess ?? 0)
      ? ` The largest residual sits in ${topDiag.label}, which is not scoreable: ${topDiag.reason}.`
      : '';

  if (share < ATTRIBUTION_FLOOR) {
    return {
      cause: 'UNATTRIBUTABLE',
      note: `the non-overlapping intervals explain only ${pct(share)} ${of}.${diagHint}`,
      ...base,
    };
  }
  if (topShare < ATTRIBUTION_FLOOR) {
    return {
      cause: 'UNATTRIBUTABLE',
      note:
        `the intervals explain ${pct(share)} ${of} between them, but no single interval reaches` +
        ` the ${pct(ATTRIBUTION_FLOOR)} floor (largest: ${top?.label} at ${pct(topShare)}) —` +
        ` a spread excess names no cause.${diagHint}`,
      ...base,
    };
  }
  if ((top?.excess ?? 0) <= QUANTIZATION_S) {
    return {
      cause: 'UNATTRIBUTABLE',
      note:
        `${top?.label} is the largest interval but its ${top?.excess?.toFixed(2)}s excess is inside` +
        ` the ${QUANTIZATION_S.toFixed(0)}s quantization of Kubernetes condition timestamps.`,
      ...base,
    };
  }
  return {
    cause: top.label,
    note: `${pct(topShare)} ${of} in this one interval (${pct(share)} explained overall)`,
    ...base,
  };
}
