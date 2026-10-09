// Diagnose the zone-side stall seen in back-to-back T1 cycles: a cold zone whose
// PREVIOUS pod went to zero only seconds earlier (and is still Terminating)
// takes ~15 s instead of ~2 s, and the time is spent BEFORE the request reaches
// the zone's handler. For each trial: wake the zone, let it reach zero live pods,
// then wake it again either immediately ("recent") or after the old pod is
// fully gone ("settled"). Records pod IPs to test the IP-reuse hypothesis.
//
// Usage: bun stall.ts <zone> <out.jsonl> [trials=4]
import { appendFileSync } from 'node:fs';
import { curl, kubectl, NS, podCount, sleep, svcUrl } from './k';

const [zone, out, tArg] = process.argv.slice(2);
const trials = Number(tArg ?? 4);

function pods(): { name: string; ip: string; terminating: boolean }[] {
  const j = JSON.parse(
    kubectl(['get', 'pods', '-n', NS, '-l', `serving.knative.dev/service=${zone}`, '-o', 'json']),
  );
  return j.items.map(
    (p: {
      metadata: { name: string; deletionTimestamp?: string };
      status: { podIP?: string };
    }) => ({
      name: p.metadata.name,
      ip: p.status.podIP ?? '',
      terminating: Boolean(p.metadata.deletionTimestamp),
    }),
  );
}
async function waitLiveZero() {
  while (podCount(zone) > 0) await sleep(1000);
}
async function waitAllGone() {
  while (pods().length > 0) await sleep(2000);
}

for (let i = 0; i < trials; i++) {
  for (const mode of ['recent', 'settled'] as const) {
    curl(svcUrl(zone, '/api/health'));
    await waitLiveZero();
    if (mode === 'settled') await waitAllGone();
    const before = pods();
    const r = curl(svcUrl(zone, '/api/health'));
    const after = pods();
    const body = JSON.parse(r.body);
    const rec = {
      trial: i,
      mode,
      zone,
      e2eMs: Math.round(r.ms),
      zoneUptimeAtReqMs: Math.round(body.uptimeMs),
      before,
      after,
    };
    appendFileSync(out, `${JSON.stringify(rec)}\n`);
    const newIp = after.find((p) => !p.terminating)?.ip;
    console.log(
      `${mode} e2e=${rec.e2eMs} uptimeAtReq=${rec.zoneUptimeAtReqMs} newIP=${newIp} oldIPs=${before.map((p) => p.ip).join(',') || '-'} reused=${before.some((p) => p.ip === newIp)}`,
    );
  }
}
