// One "recent" stall trial with a trace: while the request is in flight, poll
// the new pod's Ready condition and container readiness every 500 ms, so the
// report can say WHERE the ~15–28 s goes (pod not Ready vs Ready-but-not-routed).
// Usage: bun stall-trace.ts <zone>
import { spawn } from 'node:child_process';
import { CONTEXT, DRIVER, kubectl, NS, podCount, sleep, svcUrl } from './k';

const zone = process.argv[2] ?? 'zone-node';
kubectl([
  'exec',
  '-n',
  NS,
  DRIVER,
  '--',
  'curl',
  '-s',
  '-o',
  '/dev/null',
  svcUrl(zone, '/api/health'),
]);
while (podCount(zone) > 0) await sleep(1000);
const t0 = Date.now();
const req = spawn(
  'kubectl',
  [
    '--context',
    CONTEXT,
    'exec',
    '-n',
    NS,
    DRIVER,
    '--',
    'curl',
    '-s',
    '-m',
    '90',
    '-w',
    ' %{time_total}',
    svcUrl(zone, '/api/health'),
  ],
  { env: { ...process.env, KUBECONFIG: process.env.Z2_KUBECONFIG } },
);
let done = false;
let body = '';
req.stdout.on('data', (d) => (body += d));
req.on('exit', () => (done = true));
let last = '';
while (!done) {
  const j = JSON.parse(
    kubectl(['get', 'pods', '-n', NS, '-l', `serving.knative.dev/service=${zone}`, '-o', 'json']),
  );
  const s = j.items
    .map(
      (p: {
        metadata: { name: string; deletionTimestamp?: string };
        status: {
          phase: string;
          conditions?: { type: string; status: string }[];
          containerStatuses?: { name: string; ready: boolean }[];
        };
      }) => {
        const ready = p.status.conditions?.find((c) => c.type === 'Ready')?.status;
        const cs = (p.status.containerStatuses ?? [])
          .map((c) => `${c.name}=${c.ready ? 'R' : '-'}`)
          .join(',');
        return `${p.metadata.name.slice(-5)}${p.metadata.deletionTimestamp ? '(term)' : ''}:${p.status.phase}/Ready=${ready}/${cs}`;
      },
    )
    .join('  ');
  if (s !== last) {
    console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
    last = s;
  }
  await sleep(500);
}
console.log(`response after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${body}`);
