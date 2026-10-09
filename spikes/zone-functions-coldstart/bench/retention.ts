// Retention coupling check (shape R): a function with a scale-to-zero pod
// retention period LONGER than its zone's stays warm after the zone has gone
// back to zero, so the next cold zone meets a warm function — shape D without
// any explicit pre-warm. This only holds once the function has been called:
// a never-called function is still cold (shapes B and C).
//
// Usage: bun retention.ts <out.jsonl> [n=7]   (env Z2_KUBECONFIG, FN_GO_IMAGE)
import { appendFileSync } from 'node:fs';
import { fnService } from './deploy';
import { applyJson, curl, kubectl, NS, podCount, sleep, svcUrl } from './k';

const out = process.argv[2];
const n = Number(process.argv[3] ?? 7);
const image = process.env.FN_GO_IMAGE;
if (!out || !image) throw new Error('usage: FN_GO_IMAGE=... bun retention.ts <out.jsonl> [n]');

const FN = 'fn-go-h1-ret';
const ZONE = 'zone-node';
applyJson(
  fnService(FN, image, 'http1', {
    'autoscaling.knative.dev/scale-to-zero-pod-retention-period': '3m',
  }),
);
kubectl(['wait', '-n', NS, `ksvc/${FN}`, '--for=condition=Ready', '--timeout=180s']);

async function waitZero(svc: string) {
  while (podCount(svc) > 0) await sleep(2000);
}

// First call through the zone: this is what "binds" the function warm.
curl(svcUrl(ZONE, `/api/chain?fn=${FN}`));
for (let i = 0; i < n; i++) {
  await waitZero(ZONE);
  const pre = { zone: podCount(ZONE), fn: podCount(FN) };
  const r = curl(svcUrl(ZONE, `/api/chain?fn=${FN}`));
  const body = JSON.parse(r.body);
  const rec = {
    ts: new Date().toISOString(),
    shape: 'R',
    gw: 'node',
    zone: ZONE,
    fn: FN,
    lang: 'go',
    transport: 'http1',
    e2eMs: Math.round(r.ms * 10) / 10,
    code: r.code,
    pre,
    valid: pre.zone === 0 && pre.fn > 0,
    body,
  };
  appendFileSync(out, `${JSON.stringify(rec)}\n`);
  console.log(
    `R ${i} e2e=${rec.e2eMs} call=${Math.round(body.callMs)} fnUptime=${body.fnUptimeMs} valid=${rec.valid}`,
  );
}
