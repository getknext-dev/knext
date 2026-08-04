import { headers } from 'next/headers';
import { denyObservabilityAccess } from '../_ui/access-denied';
import { NO_DATA } from '../_ui/format';
import { isObservabilityAuthorized, observabilityToken } from '../auth';
import { computeVitalsSummary, type VitalSummaryRow } from './vitals';

/**
 * /observability/web-vitals — in-app Web Vitals page (obs-pages plan P1.1,
 * ADR-0038).
 *
 * Server-rendered "Speed Insights" analogue that surfaces the current p75 for
 * each Core Web Vital from the app's OWN in-process RUM registry (ingested via
 * POST /api/rum). No Prometheus, no external dependency, no client JS beyond the
 * existing WebVitalsReporter.
 *
 * Security (`.claude/rules/security.md` + plan §4):
 *  - Auth-gated, FAIL-CLOSED: unset `OBSERVABILITY_TOKEN` ⇒ deny-all. The check
 *    runs server-side every request; no metric data reaches an unauth'd browser.
 *  - Never cached (`force-dynamic`) — stale metrics mislead and the auth check
 *    must run on every request. This mirrors the auth/mutation no-cache rule.
 *  - Raw metrics never reach the browser; only the rendered aggregate does.
 */
export const dynamic = 'force-dynamic';

function formatValue(row: VitalSummaryRow): string {
  if (row.p75 === null) {
    // Shared marker (`_ui/format.ts`): a bare dash reads like a measured zero,
    // so all three observability pages say "no data yet" instead (#516).
    return NO_DATA;
  }
  const value = row.unit === 'ms' ? row.p75.toFixed(0) : row.p75.toFixed(3);
  return row.unit ? `${value} ${row.unit}` : value;
}

export default async function WebVitalsPage() {
  const requestHeaders = await headers();
  const authorized = isObservabilityAuthorized(
    requestHeaders.get('authorization'),
    observabilityToken(),
  );
  if (!authorized) {
    denyObservabilityAccess(); // real HTTP 401, never returns (#525)
  }

  const rows = await computeVitalsSummary();

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Web Vitals</h1>
      <p>
        Real-user Core Web Vitals for this app (p75), collected in-process from{' '}
        <code>/api/rum</code> beacons.
      </p>
      <table style={{ borderCollapse: 'collapse', marginTop: '1rem' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '0.5rem 1rem' }}>Metric</th>
            <th style={{ textAlign: 'left', padding: '0.5rem 1rem' }}>Measures</th>
            <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>p75</th>
            <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>Samples</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.metric}>
              <td style={{ padding: '0.5rem 1rem', fontWeight: 600 }}>{row.metric}</td>
              <td style={{ padding: '0.5rem 1rem' }}>{row.label}</td>
              <td style={{ padding: '0.5rem 1rem', textAlign: 'right' }}>{formatValue(row)}</td>
              <td style={{ padding: '0.5rem 1rem', textAlign: 'right' }}>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
