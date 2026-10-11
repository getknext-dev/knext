#!/usr/bin/env node
// The assertions half of the deep-health alert e2e. Reads Prometheus through the
// API server's service proxy (no port-forward process to leak).
//
// Every wait is a poll with a deadline and a named reason; a timeout FAILS with
// what was last seen. Nothing here passes by default: a missing target, a missing series and
// a never-firing alert are three different failures with three different
// messages, because "the alert did not fire" alone does not say which link in
// the chain (scrape -> series -> rule) broke.
//
// Usage: node assert-alert.mjs <kube-context> [timeoutSeconds]

import { spawnSync } from 'node:child_process';

const [ctx, timeoutArg] = process.argv.slice(2);
if (!ctx) {
  console.error('usage: assert-alert.mjs <kube-context> [timeoutSeconds]');
  process.exit(2);
}
const TIMEOUT_MS = Number(timeoutArg ?? 600) * 1000;
const PROM = '/api/v1/namespaces/monitoring/services/prometheus-operated:web/proxy';

function raw(path) {
  const r = spawnSync('kubectl', ['--context', ctx, 'get', '--raw', path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`kubectl get --raw ${path}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

const query = (q) => {
  const body = raw(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`);
  if (body.status !== 'success') throw new Error(`query failed: ${JSON.stringify(body)}`);
  return body.data.result;
};

const alerts = () => raw(`${PROM}/api/v1/alerts`).data.alerts;

async function waitFor(name, probe) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = '(never evaluated)';
  while (Date.now() < deadline) {
    try {
      const got = probe();
      if (got.ok) {
        console.log(`PASS  ${name}  ${got.detail ?? ''}`);
        return;
      }
      last = got.detail ?? 'not yet';
    } catch (e) {
      last = String(e.message ?? e).slice(0, 300);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.error(`FAIL  ${name}\n      last seen: ${last}`);
  process.exit(1);
}

// 1. The SHIPPED PodMonitor found the pod and scraped :9464. `job` and `app` are
//    set by that manifest's relabelings, so seeing them proves the manifest, not
//    just a scrape.
await waitFor(
  'shipped PodMonitor scrapes the app (up{job="knext-nextapp",app="e2e-app"} == 1)',
  () => {
    const r = query('up{job="knext-nextapp",app="e2e-app"} == 1');
    return { ok: r.length === 1, detail: `${r.length} target(s) up` };
  },
);

// 2. The gauge arrived on the scraped port and says `down` for the dead database.
await waitFor('deep-health gauge is on the scraped port and reads down', () => {
  const r = query(
    'knext_deep_health_state{job="knext-nextapp",dependency="overall",state="down"} == 1',
  );
  return { ok: r.length >= 1, detail: `${r.length} series` };
});

// 3. The bridge is an ALLOWLIST: nothing else from the app's registry rides along.
{
  const r = query('{job="knext-nextapp",__name__=~"knext_(http|coldstart|db_wake)_.*"}');
  if (r.length !== 0) {
    console.error(`FAIL  allowlist: ${r.length} non-allowlisted app series reached :9464`);
    console.error(JSON.stringify(r.slice(0, 3)));
    process.exit(1);
  }
  console.log('PASS  only the allowlisted app family reaches the scraped port');
}

// 4. THE POINT: the shipped rule, unmodified, fires.
await waitFor('KnextDeepHealthDown is FIRING', () => {
  const a = alerts().find((x) => x.labels.alertname === 'KnextDeepHealthDown');
  return { ok: a?.state === 'firing', detail: a ? `state=${a.state}` : 'alert not yet pending' };
});

// 5. And it fired for the right reason: a refused BYO database is `down`, not
//    `waking`, so the sibling rule must stay quiet.
{
  const sibling = alerts().find((x) => x.labels.alertname === 'KnextDeepHealthStuckWaking');
  if (sibling && sibling.state === 'firing') {
    console.error(
      'FAIL  KnextDeepHealthStuckWaking is firing for a refused bring-your-own database',
    );
    process.exit(1);
  }
  console.log(
    'PASS  KnextDeepHealthStuckWaking stays quiet (refused BYO database is down, not waking)',
  );
}
console.log('deep-health alert e2e: OK');
