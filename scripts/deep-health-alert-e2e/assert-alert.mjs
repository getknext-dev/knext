#!/usr/bin/env node
// The assertions half of the deep-health alert e2e. Reads Prometheus through the
// API server's service proxy (no port-forward process to leak).
//
// Four arms run CONCURRENTLY against the same Prometheus:
//   e2e-app            tracing ON,  dead database                   -> down
//   e2e-app-notracing  tracing OFF, dead database                   -> down
//   e2e-app-waking     tracing OFF, dead database, scale-to-zero    -> waking
//   e2e-app-up         tracing OFF, a real Postgres                 -> up
// Tracing OFF is the default install, where the gauge used to not exist at all.
// Each arm is a separate app (its own `app` label), so every query and every alert
// lookup below is scoped to it.
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
const NAMESPACE = 'deep-health-e2e';

// `tracing` is what the arm is DEPLOYED with; the assertions below prove the
// series really came from the path that install shape takes.
// `expect` is the reading the arm must show, and so which alert (if any) must fire.
const ARMS = [
  { app: 'e2e-app', tracing: true, expect: 'down' },
  { app: 'e2e-app-notracing', tracing: false, expect: 'down' },
  { app: 'e2e-app-waking', tracing: false, expect: 'waking' },
  { app: 'e2e-app-up', tracing: false, expect: 'up' },
];

// The label selectors that say "this arm reads what it should". `up` is the
// healthy reading: overall `ok` AND postgres `up`.
const READING = {
  down: [',dependency="overall",state="down"'],
  waking: [',dependency="overall",state="waking"', ',dependency="postgres",state="waking"'],
  up: [',dependency="overall",state="ok"', ',dependency="postgres",state="up"'],
};
// The alert that must fire for a reading, if any.
const ALERT_FOR = {
  down: 'KnextDeepHealthDown',
  waking: 'KnextDeepHealthStuckWaking',
  up: undefined,
};
const ALERTS = ['KnextDeepHealthDown', 'KnextDeepHealthStuckWaking'];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kubectl = (args) =>
  spawnSync('kubectl', ['--context', ctx, '-n', NAMESPACE, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

const fail = (arm, msg) => {
  console.error(`FAIL  [${arm.app}] ${msg}`);
  process.exit(1);
};

async function waitFor(arm, name, probe) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = '(never evaluated)';
  while (Date.now() < deadline) {
    try {
      const got = probe();
      if (got.ok) {
        console.log(`PASS  [${arm.app}] ${name}  ${got.detail ?? ''}`);
        return;
      }
      last = got.detail ?? 'not yet';
    } catch (e) {
      last = String(e.message ?? e).slice(0, 300);
    }
    await sleep(5000);
  }
  console.error(`FAIL  [${arm.app}] ${name}\n      last seen: ${last}`);
  process.exit(1);
}

/** The alert for this arm's app, or undefined. `alerts()` omits inactive ones. */
const alertFor = (arm, alertname) =>
  alerts().find((x) => x.labels.alertname === alertname && x.labels.app === arm.app);

const gaugeSeries = (arm, extra = '') =>
  query(`knext_deep_health_state{job="knext-nextapp",app="${arm.app}"${extra}}`);

/** True when every selector in the arm's expected reading has a series at 1. */
const readsExpected = (arm) => {
  const per = READING[arm.expect].map(
    (extra) => gaugeSeries(arm, extra).filter((s) => s.value[1] === '1').length,
  );
  return { ok: per.every((n) => n >= 1), detail: `${arm.expect}: ${per.join('/')} series at 1` };
};

/**
 * Read the app's own loopback registry from INSIDE the pod, on the port the pod
 * spec names. Run from the pod so the e2e needs no knowledge of the port.
 */
function loopbackBody(arm) {
  const r = kubectl([
    'exec',
    `deploy/${arm.app}`,
    '--',
    'bun',
    '-e',
    '(async () => { const r = await fetch(`http://127.0.0.1:${process.env.KN_CHILD_METRICS_PORT}/metrics`); process.stdout.write(await r.text()); })()',
  ]);
  if (r.status !== 0) throw new Error(`loopback read failed: ${r.stderr.trim()}`);
  return r.stdout;
}

async function runArm(arm) {
  // A previous run on a kept cluster may have left this fixture idle (the stop file
  // is how an arm is idled). Start every arm ACTIVE, or the first wait below would
  // time out on an app that is correctly serving no series.
  kubectl(['exec', `deploy/${arm.app}`, '--', 'rm', '-f', '/tmp/stop-traffic']);

  // 1. The SHIPPED PodMonitor found the pod and scraped :9464. `job` and `app` are
  //    set by that manifest's relabelings, so seeing them proves the manifest, not
  //    just a scrape.
  await waitFor(
    arm,
    `shipped PodMonitor scrapes the app (up{job="knext-nextapp",app="${arm.app}"} == 1)`,
    () => {
      const r = query(`up{job="knext-nextapp",app="${arm.app}"} == 1`);
      return { ok: r.length === 1, detail: `${r.length} target(s) up` };
    },
  );

  // 2. The gauge arrived on the scraped port and reads what this arm's dependency
  //    state is: down (refused bring-your-own host), waking (a refusal on a database
  //    declared scale-to-zero), or up (a real Postgres).
  await waitFor(arm, `deep-health gauge is on the scraped port and reads ${arm.expect}`, () =>
    readsExpected(arm),
  );

  // 2b. The series came from the path this install shape takes. With tracing ON
  //     the loopback port serves the whole prom-client registry; with it OFF the
  //     lite module serves the deep-health family and NOTHING else. Without this a
  //     tracing-off arm that quietly fell back to the full instrumentation would
  //     still go green.
  {
    const body = loopbackBody(arm);
    const families = [...body.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]);
    if (!families.includes('knext_deep_health_state')) {
      fail(arm, `loopback registry has no knext_deep_health_state family (saw: ${families})`);
    }
    const fullRegistry = families.includes('knext_http_requests_total');
    if (arm.tracing && !fullRegistry) {
      fail(arm, `tracing-on arm: loopback registry is not the full registry (saw: ${families})`);
    }
    if (!arm.tracing && (fullRegistry || families.length !== 1)) {
      fail(
        arm,
        `tracing-off arm: loopback port should serve ONLY the deep-health family (saw: ${families})`,
      );
    }
    console.log(
      `PASS  [${arm.app}] series is served by the ${arm.tracing ? 'full instrumentation' : 'lite module'} (loopback families: ${families.length})`,
    );
  }

  // 3. The bridge is an ALLOWLIST: nothing else from the app's registry rides along.
  {
    const r = query(
      `{job="knext-nextapp",app="${arm.app}",__name__=~"knext_(http|coldstart|db_wake)_.*"}`,
    );
    if (r.length !== 0) {
      console.error(JSON.stringify(r.slice(0, 3)));
      fail(arm, `allowlist: ${r.length} non-allowlisted app series reached :9464`);
    }
    console.log(`PASS  [${arm.app}] only the allowlisted app family reaches the scraped port`);
  }

  // 4. THE POINT: the shipped rule for this reading, unmodified, fires, and the
  //    other one stays quiet. A refused bring-your-own database is `down`, not
  //    `waking`; a scale-to-zero one is `waking`, not `down`; a healthy one pages
  //    nobody. The healthy arm is held past the rules' 2-minute hold so a quiet
  //    result means something.
  const firing = ALERT_FOR[arm.expect];
  if (firing) {
    await waitFor(arm, `${firing} is FIRING`, () => {
      const a = alertFor(arm, firing);
      return {
        ok: a?.state === 'firing',
        detail: a ? `state=${a.state}` : 'alert not yet pending',
      };
    });
  } else {
    await sleep(150_000);
  }
  for (const name of ALERTS.filter((n) => n !== firing)) {
    const a = alertFor(arm, name);
    if (a) fail(arm, `${name} is ${a.state} for a ${arm.expect} dependency`);
  }
  console.log(
    `PASS  [${arm.app}] ${ALERTS.filter((n) => n !== firing).join(' and ')} stay quiet for a ${arm.expect} dependency`,
  );

  // 6. THE SCALE-TO-ZERO PROMISE: scraping must not keep the database awake.
  //    The probe only runs while the app has used its database recently (45 s). The
  //    probe's own query must not count as that use, or every scrape re-arms the
  //    gate and the database never sleeps while the pod is up. Observable here as
  //    the probe's own log line (one per probe): it must STOP once the app is idle,
  //    while Prometheus keeps scraping.
  if (arm.expect === 'up') {
    // A healthy probe logs nothing, so the log line this check counts does not
    // exist for this arm; the other three arms cover the no-probe-at-idle property
    // with the same code path. Idle the app for the drop check below.
    const stop = kubectl(['exec', `deploy/${arm.app}`, '--', 'touch', '/tmp/stop-traffic']);
    if (stop.status !== 0) fail(arm, `could not idle the fixture: ${stop.stderr.trim()}`);
  } else {
    const probeLines = () => {
      const r = kubectl(['logs', `deploy/${arm.app}`, '--tail=-1']);
      if (r.status !== 0) throw new Error(`kubectl logs: ${r.stderr.trim()}`);
      return r.stdout.split('\n').filter((l) => l.includes('[Health Check] Postgres')).length;
    };

    // Positive control: while the app is active the probe DOES run, so the log line
    // is a live signal and "no new lines" below means something.
    const active0 = probeLines();
    await waitFor(arm, 'probes are logged while the app is active (control)', () => {
      const n = probeLines();
      return { ok: n > active0, detail: `${active0} -> ${n} probe lines` };
    });

    const stop = kubectl(['exec', `deploy/${arm.app}`, '--', 'touch', '/tmp/stop-traffic']);
    if (stop.status !== 0) fail(arm, `could not idle the fixture: ${stop.stderr.trim()}`);

    const lastScrape = () =>
      Number(query(`timestamp(up{job="knext-nextapp",app="${arm.app}"})`)[0]?.value[1] ?? 0);
    // Let the 45 s activity budget lapse (+ one scrape + the probe TTL), then watch.
    await sleep(100_000);
    const idle1 = probeLines();
    const scrapes1 = lastScrape();
    await sleep(130_000); // four-plus 30 s scrape intervals with the app idle
    const idle2 = probeLines();
    const scrapes2 = lastScrape();

    if (scrapes2 <= scrapes1) {
      fail(
        arm,
        `Prometheus stopped scraping (last scrape at ${scrapes1} -> ${scrapes2}); the idle check proves nothing`,
      );
    }
    if (idle2 !== idle1) {
      fail(
        arm,
        `the idle app was still probed on scrape: ${idle1} -> ${idle2} probe lines over ${Math.round((scrapes2 - scrapes1) / 30)} scrapes. ` +
          'The probe is keeping the scale-to-zero database awake.',
      );
    }
    console.log(
      `PASS  [${arm.app}] idle app: ${Math.round((scrapes2 - scrapes1) / 30)} more scrapes, 0 more database probes (${idle1} -> ${idle2})`,
    );
  }

  // 7. An idle app makes NO claim. The probe does not run (above) and nothing is
  //    served in its place, so the series is gone from the scraped port rather than
  //    frozen at its last reading.
  await waitFor(arm, 'series is DROPPED while the app is idle', () => {
    const r = gaugeSeries(arm);
    return { ok: r.length === 0, detail: `${r.length} series still present` };
  });

  // 8. ... which is what lets the alert resolve instead of firing forever for an
  //    app that is merely idle.
  if (firing) {
    await waitFor(arm, `${firing} RESOLVES once the app is idle`, () => {
      const a = alertFor(arm, firing);
      return { ok: !a, detail: a ? `still ${a.state}` : 'inactive' };
    });
  }
  for (const name of ALERTS) {
    const a = alertFor(arm, name);
    if (a) fail(arm, `${name} is ${a.state} on an idle app`);
  }
  console.log(
    `PASS  [${arm.app}] an idle app never makes KnextDeepHealthStuckWaking or KnextDeepHealthDown pending or firing`,
  );

  // 9. The drop is not a latch: when the app is used again the series is back and
  //    reads the dead database as down.
  {
    const r = kubectl(['exec', `deploy/${arm.app}`, '--', 'rm', '-f', '/tmp/stop-traffic']);
    if (r.status !== 0) fail(arm, `could not resume the fixture: ${r.stderr.trim()}`);
  }
  await waitFor(arm, `series returns when the app is used again, reading ${arm.expect}`, () =>
    readsExpected(arm),
  );
}

await Promise.all(ARMS.map(runArm));
console.log('deep-health alert e2e: OK');
