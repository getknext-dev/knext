import { register } from '../../api/_metrics/registry';

/**
 * Reads the app's OWN Core Web Vitals from the in-process prom-client registry
 * (obs-pages plan P1.1, ADR-0038).
 *
 * The `kn_next_web_vitals_*` histograms are populated by the RUM ingest route
 * (`POST /api/rum`) from browser beacons. This module aggregates them, in
 * process, into a current p75-per-vital summary for the server-rendered
 * /observability/web-vitals page. It reads ONLY already-exported registry data
 * — no Prometheus, no external backend, no new dependency. The browser never
 * touches raw metrics; only the rendered aggregate is sent to the client.
 */

export const CORE_WEB_VITALS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export type CoreWebVital = (typeof CORE_WEB_VITALS)[number];

/** prom-client histogram series name for each vital. */
const SERIES_NAME: Record<CoreWebVital, string> = {
  LCP: 'kn_next_web_vitals_lcp',
  INP: 'kn_next_web_vitals_inp',
  CLS: 'kn_next_web_vitals_cls',
  FCP: 'kn_next_web_vitals_fcp',
  TTFB: 'kn_next_web_vitals_ttfb',
};

/** Display unit — LCP/INP/FCP/TTFB are milliseconds; CLS is unitless. */
const UNIT: Record<CoreWebVital, string> = {
  LCP: 'ms',
  INP: 'ms',
  CLS: '',
  FCP: 'ms',
  TTFB: 'ms',
};

export interface VitalSummaryRow {
  metric: CoreWebVital;
  /** Human label of what this vital measures. */
  label: string;
  /** 75th percentile across all route/rating label sets, or null if no samples. */
  p75: number | null;
  /** Total observed samples. */
  count: number;
  /** Display unit ("ms" or ""). */
  unit: string;
}

const LABEL: Record<CoreWebVital, string> = {
  LCP: 'Largest Contentful Paint',
  INP: 'Interaction to Next Paint',
  CLS: 'Cumulative Layout Shift',
  FCP: 'First Contentful Paint',
  TTFB: 'Time to First Byte',
};

interface Bucket {
  le: number;
  cumulative: number;
}

/**
 * Prometheus-style linear-interpolation quantile over a classic histogram.
 * `buckets` are cumulative counts by upper-bound (`le`), sorted ascending with a
 * final +Inf bucket. Returns null when there are no samples.
 */
export function histogramQuantile(
  quantile: number,
  buckets: Bucket[],
  count: number,
): number | null {
  if (count <= 0 || buckets.length === 0) {
    return null;
  }
  const rank = quantile * count;
  let prevLe = 0;
  let prevCum = 0;
  for (const b of buckets) {
    if (b.cumulative >= rank) {
      if (!Number.isFinite(b.le)) {
        // Falls in the +Inf bucket — best finite estimate is the last bound.
        return prevLe;
      }
      const bucketCount = b.cumulative - prevCum;
      if (bucketCount <= 0) {
        return b.le;
      }
      return prevLe + (b.le - prevLe) * ((rank - prevCum) / bucketCount);
    }
    prevLe = b.le;
    prevCum = b.cumulative;
  }
  return prevLe;
}

/**
 * Aggregates a single histogram's `get()` values (summed across every
 * route/rating label set) into cumulative buckets + a total count.
 */
function aggregate(
  values: Array<{ metricName?: string; labels: Record<string, unknown>; value: number }>,
): {
  buckets: Bucket[];
  count: number;
} {
  const byLe = new Map<number, number>();
  let count = 0;
  for (const v of values) {
    const name = v.metricName ?? '';
    if (name.endsWith('_bucket')) {
      const leRaw = v.labels.le;
      const le =
        leRaw === '+Inf' || leRaw === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : Number(leRaw);
      byLe.set(le, (byLe.get(le) ?? 0) + v.value);
    } else if (name.endsWith('_count')) {
      count += v.value;
    }
  }
  const buckets = [...byLe.entries()]
    .map(([le, cumulative]) => ({ le, cumulative }))
    .sort((a, b) => a.le - b.le);
  return { buckets, count };
}

/**
 * Current p75 + sample count for every Core Web Vital, in a stable order.
 * Missing/empty series report `count: 0` and `p75: null` (never throws).
 */
export async function computeVitalsSummary(): Promise<VitalSummaryRow[]> {
  const rows: VitalSummaryRow[] = [];
  for (const metric of CORE_WEB_VITALS) {
    const series = register.getSingleMetric(SERIES_NAME[metric]);
    let p75: number | null = null;
    let count = 0;
    if (series) {
      const data = await series.get();
      const { buckets, count: total } = aggregate(
        data.values as Array<{
          metricName?: string;
          labels: Record<string, unknown>;
          value: number;
        }>,
      );
      count = total;
      p75 = histogramQuantile(0.75, buckets, total);
    }
    rows.push({ metric, label: LABEL[metric], p75, count, unit: UNIT[metric] });
  }
  return rows;
}
