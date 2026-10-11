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
// 6. THE SCALE-TO-ZERO PROMISE: scraping must not keep the database awake.
//    The probe only runs while the app has used its database recently (45 s). The
//    probe's own query must not count as that use, or every scrape re-arms the
//    gate and the database never sleeps while the pod is up. Observable here as
//    the probe's own log line (one per probe): it must STOP once the app is idle,
//    while Prometheus keeps scraping.
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const probeLines = () => {
    const r = spawnSync(
      'kubectl',
      ['--context', ctx, '-n', 'deep-health-e2e', 'logs', 'deploy/e2e-app', '--tail=-1'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    if (r.status !== 0) throw new Error(`kubectl logs: ${r.stderr.trim()}`);
    return r.stdout.split('\n').filter((l) => l.includes('[Health Check] Postgres')).length;
  };

  // A previous run on a kept cluster may have left the fixture idle.
  spawnSync(
    'kubectl',
    [
      '--context',
      ctx,
      '-n',
      'deep-health-e2e',
      'exec',
      'deploy/e2e-app',
      '--',
      'rm',
      '-f',
      '/tmp/stop-traffic',
    ],
    { encoding: 'utf8' },
  );

  // Positive control: while the app is active the probe DOES run, so the log line
  // is a live signal and "no new lines" below means something.
  const active0 = probeLines();
  await waitFor('probes are logged while the app is active (control)', () => {
    const n = probeLines();
    return { ok: n > active0, detail: `${active0} -> ${n} probe lines` };
  });

  const stop = spawnSync(
    'kubectl',
    [
      '--context',
      ctx,
      '-n',
      'deep-health-e2e',
      'exec',
      'deploy/e2e-app',
      '--',
      'touch',
      '/tmp/stop-traffic',
    ],
    { encoding: 'utf8' },
  );
  if (stop.status !== 0) {
    console.error(`FAIL  could not idle the fixture: ${stop.stderr.trim()}`);
    process.exit(1);
  }
  // Let the 45 s activity budget lapse (+ one scrape + the probe TTL), then watch.
  await sleep(100_000);
  const idle1 = probeLines();
  const scrapes1 = Number(
    query('timestamp(up{job="knext-nextapp",app="e2e-app"})')[0]?.value[1] ?? 0,
  );
  await sleep(130_000); // four-plus 30 s scrape intervals with the app idle
  const idle2 = probeLines();
  const scrapes2 = Number(
    query('timestamp(up{job="knext-nextapp",app="e2e-app"})')[0]?.value[1] ?? 0,
  );

  if (scrapes2 <= scrapes1) {
    console.error(
      `FAIL  Prometheus stopped scraping (last scrape at ${scrapes1} -> ${scrapes2}); the idle check proves nothing`,
    );
    process.exit(1);
  }
  if (idle2 !== idle1) {
    console.error(
      `FAIL  the idle app was still probed on scrape: ${idle1} -> ${idle2} probe lines over ${Math.round((scrapes2 - scrapes1) / 30)} scrapes. ` +
        'The probe is keeping the scale-to-zero database awake.',
    );
    process.exit(1);
  }
  console.log(
    `PASS  idle app: ${Math.round((scrapes2 - scrapes1) / 30)} more scrapes, 0 more database probes (${idle1} -> ${idle2})`,
  );
}
console.log('deep-health alert e2e: OK');
