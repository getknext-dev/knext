// Transport robustness probe (Q11): N concurrent chain calls through one warm
// zone to one warm function, so the zone's client multiplexes them on its
// HTTP/2 session (h2c) or spreads them over its HTTP/1.1 pool. Counts non-200s
// and Connect errors. Not a latency benchmark.
//
// Usage: bun burst.ts <zone> <fn> [requests=200] [parallel=20]
import { DRIVER, kubectl, NS, svcUrl } from './k';

const [zone, fn, nArg, pArg] = process.argv.slice(2);
const n = Number(nArg ?? 200);
const p = Number(pArg ?? 20);
const url = svcUrl(zone, `/api/chain?fn=${fn}`);
// warm both first
kubectl(['exec', '-n', NS, DRIVER, '--', 'curl', '-s', '-o', '/dev/null', '-m', '90', url]);
const urls = Array.from({ length: n }, () => url);
const out = kubectl([
  'exec',
  '-n',
  NS,
  DRIVER,
  '--',
  'curl',
  '-s',
  '-m',
  '60',
  '--parallel',
  '--parallel-max',
  String(p),
  '-w',
  '\n__Z2__ %{http_code} %{time_total}\n',
  ...urls,
]);
const codes = new Map<string, number>();
const times: number[] = [];
for (const line of out.split('\n')) {
  if (!line.startsWith('__Z2__ ')) continue;
  const [, code, t] = line.split(' ');
  codes.set(code, (codes.get(code) ?? 0) + 1);
  times.push(Number(t) * 1000);
}
const errors = out
  .split('\n')
  .filter((l) => l.includes('"ok":false'))
  .slice(0, 3);
times.sort((a, b) => a - b);
const pct = (q: number) => Math.round(times[Math.floor((times.length - 1) * q)]);
console.log(
  JSON.stringify({
    zone,
    fn,
    n,
    parallel: p,
    codes: Object.fromEntries(codes),
    p50: pct(0.5),
    p95: pct(0.95),
    max: pct(1),
    sampleErrors: errors,
  }),
);
