// cold-attribution-report.mjs — turn cold-attribution-collector.sh output into a per-sample
// attribution table: every cold-start sample labelled fast/slow WITH a named cause.
//
// Usage: node cold-attribution-report.mjs <collector.jsonl> [k6-result.txt]
//
// Schema and admissibility rules follow .claude/verdicts/sprint1-sysdesign.md §1.
//
// A sample missing any required lifecycle field is reported INADMISSIBLE and excluded from every
// aggregate — never silently averaged in. A run of 10 where 3 are inadmissible is a better result
// than a run of 10 that quietly includes them.

import { readFileSync } from 'node:fs';

const [, , jsonlPath, k6Path] = process.argv;
if (!jsonlPath) {
  console.error('usage: node cold-attribution-report.mjs <collector.jsonl> [k6-result.txt]');
  process.exit(2);
}

const ms = (t) => (t ? Date.parse(t) : null);
const secs = (a, b) => (a != null && b != null ? (b - a) / 1000 : null);
const fmt = (s) => (s == null ? '—' : `${s.toFixed(2)}s`);

const rows = readFileSync(jsonlPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const start = rows.find((r) => r.kind === 'collector-start');

// ---- k6 driver pods delimit each sample window -------------------------------------------
const k6 = new Map();
for (const r of rows.filter((r) => r.kind === 'k6pod')) {
  const m = /cold-(\d+)/.exec(r.name);
  if (!m) continue;
  const i = Number(m[1]);
  const prev = k6.get(i) ?? { sample: i, firstSeen: r.t };
  k6.set(i, {
    ...prev,
    ...r,
    sample: i,
    firstSeen: prev.firstSeen,
    node: r.node ?? prev.node ?? null,
    startedAt: prev.startedAt ?? r.startedAt ?? null,
    finishedAt: r.finishedAt ?? prev.finishedAt ?? null,
  });
}

// ---- app pods: merge observations; prefer the first True for each condition ----------------
const pods = new Map();
for (const r of rows.filter((r) => r.kind === 'pod')) {
  const prev = pods.get(r.name) ?? { firstSeen: r.t, conds: {} };
  const merged = { ...prev.conds };
  for (const c of r.conditions ?? []) {
    if (c.status === 'True' && merged[c.type]?.status !== 'True') merged[c.type] = c;
    else if (!merged[c.type]) merged[c.type] = c;
  }
  const cStart = (n) =>
    r.containers?.find((c) => c.name === n)?.startedAt ?? prev[`${n}StartedAt`] ?? null;
  pods.set(r.name, {
    ...prev,
    ...r,
    conds: merged,
    firstSeen: prev.firstSeen,
    // BOTH containers — queue-proxy readiness is what actually gates traffic.
    'user-containerStartedAt': cStart('user-container'),
    'queue-proxyStartedAt': cStart('queue-proxy'),
  });
}

// ---- events -------------------------------------------------------------------------------
const eventsByPod = new Map();
for (const r of rows.filter((r) => r.kind === 'event')) {
  const list = eventsByPod.get(r.pod) ?? [];
  if (!list.some((e) => e.reason === r.reason && e.message === r.message && e.first === r.first)) {
    list.push(r);
  }
  eventsByPod.set(r.pod, list);
}

// ---- node residency timeline: reading taken BEFORE each request is the meaningful one -------
const nodeObs = rows.filter((r) => r.kind === 'node');
const nodeNames = [...new Set(nodeObs.map((r) => r.name))];
const residencyBefore = (node, tRef) => {
  const obs = nodeObs
    .filter((r) => r.name === node && ms(r.t) <= tRef)
    .sort((a, b) => ms(b.t) - ms(a.t))[0];
  return obs ? obs.targetImageResident : null;
};

// ---- ksvc identity: proves nothing re-applied the ksvc mid-arm ------------------------------
const ksvcObs = rows.filter((r) => r.kind === 'ksvc');
const generations = [...new Set(ksvcObs.map((r) => r.generation))];
const latestReadySeen = [...new Set(ksvcObs.map((r) => r.latestReady))];

// ---- KPA timeline ---------------------------------------------------------------------------
const kpaObs = rows.filter((r) => r.kind === 'kpa');

// ---- k6 metrics: total AND the split ---------------------------------------------------------
const toSeconds = (raw) => {
  const m = /^([0-9.]+)(µs|ms|s|m)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'µs' ? n / 1e6 : m[2] === 'ms' ? n / 1000 : m[2] === 'm' ? n * 60 : n;
};
const metric = (block, name) => {
  const re = new RegExp(`${name}[.\\s]*:\\s*avg=\\S+\\s+med=(\\S+?)\\s`);
  const m = re.exec(block);
  return m ? toSeconds(m[1]) : null;
};
// PRIMARY source: the full k6 summary captured from each driver pod's log by the collector.
// The harness's results file cannot supply the splits — run.sh:1021 greps them out.
const k6BySample = new Map();
for (const r of rows.filter((r) => r.kind === 'k6log')) {
  const m = /cold-(\d+)/.exec(r.pod);
  if (!m) continue;
  k6BySample.set(Number(m[1]), {
    duration: metric(r.log, 'http_req_duration'),
    connecting: metric(r.log, 'http_req_connecting'),
    tls: metric(r.log, 'http_req_tls_handshaking'),
    waiting: metric(r.log, 'http_req_waiting'),
    blocked: metric(r.log, 'http_req_blocked'),
    source: 'k6log',
  });
}

// FALLBACK: the harness results file. Totals only — any sample that lands here has no splits,
// and that is reported rather than left to look like a zero.
let k6Samples = [];
if (k6Path) {
  const text = readFileSync(k6Path, 'utf8');
  const blocks = text
    .split(/http_req_duration/)
    .slice(1)
    .map((b) => `http_req_duration${b}`);
  k6Samples = blocks.map((b) => ({
    duration: metric(b, 'http_req_duration'),
    connecting: metric(b, 'http_req_connecting'),
    tls: metric(b, 'http_req_tls_handshaking'),
    waiting: metric(b, 'http_req_waiting'),
    source: 'resultsFile',
  }));
}
const k6For = (i) => k6BySample.get(i) ?? k6Samples[i - 1] ?? {};

// ---- correlate ------------------------------------------------------------------------------
const SLOW_THRESHOLD = 6.0; // Run 24's gap: fast <6 s, slow >=6 s

const results = [];
for (const i of [...k6.keys()].sort((a, b) => a - b)) {
  const drv = k6.get(i);
  const winStart = ms(drv.startedAt) ?? ms(drv.firstSeen);
  const winEnd = ms(drv.finishedAt) ?? null;

  // The serving pod for a cold sample is created BY this request (scale-from-zero) and must exist
  // before the response. Bound the search to the sample's own window.
  //
  // This bound is load-bearing, not cosmetic. An earlier version allowed winEnd + 5 s and swept in
  // the revisions the harness's own restore step creates seconds after the final sample — which
  // made the arm-integrity check report CONTAMINATED on a clean arm. A false contamination flag is
  // worse than none, because it discredits a good run.
  const searchEnd = winEnd ?? (winStart != null ? winStart + 60000 : null);
  let best = null;
  for (const p of pods.values()) {
    const created = ms(p.created);
    if (created == null) continue;
    if (searchEnd != null && created > searchEnd) continue;
    if (winStart != null && created < winStart - 5000) continue;
    if (!best || created > ms(best.created)) best = p;
  }

  const k6m = k6For(i);
  const dur = k6m.duration ?? null;
  const mode = dur == null ? 'unknown' : dur >= SLOW_THRESHOLD ? 'SLOW' : 'fast';

  const missing = [];
  if (!best) missing.push('serving pod not captured');
  if (dur == null) missing.push('k6 duration');

  if (best) {
    if (!best.node) missing.push('nodeName');
    if (!best.conds?.PodScheduled?.at) missing.push('PodScheduled');
    if (!best.conds?.Ready?.at && !best.conds?.ContainersReady?.at) missing.push('Ready');
    if (!best['user-containerStartedAt']) missing.push('user-container startedAt');
    if (!best['queue-proxyStartedAt']) missing.push('queue-proxy startedAt');
  }

  if (missing.length) {
    results.push({
      sample: i,
      dur,
      mode,
      admissible: false,
      reason: missing.join(', '),
      pod: best?.name,
      node: best?.node,
    });
    continue;
  }

  // The readiness PREDICATE as rewritten onto the running pod (Knative moves the user probe onto
  // queue-proxy). tcpSocket passes when the socket binds; httpGet additionally requires the app to
  // serve a request. Recording it makes the predicate an explicit column rather than something
  // inferred from which service was measured.
  const probeStanzas = (best.probes ?? []).filter((p) => p.readinessProbe);
  const predicate = probeStanzas.some((p) => p.readinessProbe?.httpGet)
    ? 'httpGet'
    : probeStanzas.some((p) => p.readinessProbe?.tcpSocket)
      ? 'tcpSocket'
      : '?';
  const predicatePath =
    probeStanzas.map((p) => p.readinessProbe?.httpGet?.path).find(Boolean) ?? null;

  const ev = eventsByPod.get(best.name) ?? [];
  const pulling = ev.find((e) => e.reason === 'Pulling');
  const pulled = ev.find((e) => e.reason === 'Pulled');
  const unhealthy = ev.filter((e) => e.reason === 'Unhealthy');
  const alreadyPresent = /already present on machine/i.test(pulled?.message ?? '');
  const pullReported = /in ([0-9.]+(?:m|µ)?s)/.exec(pulled?.message ?? '')?.[1] ?? null;

  const tCreated = ms(best.created);
  const tScheduled = ms(best.conds?.PodScheduled?.at);
  const tUser = ms(best['user-containerStartedAt']);
  const tQueue = ms(best['queue-proxyStartedAt']);
  const tReady = ms(best.conds?.Ready?.at) ?? ms(best.conds?.ContainersReady?.at);
  const tLastStart = Math.max(tUser ?? 0, tQueue ?? 0) || null;

  const schedDelay = secs(tCreated, tScheduled);
  const pullDelta = pulling && pulled ? secs(ms(pulling.first), ms(pulled.first)) : null;
  const startDelay = secs(tScheduled, tLastStart); // scheduled -> both containers running
  const boot = secs(tLastStart, tReady); // last container start -> readiness satisfied
  const postReady = winEnd != null ? secs(tReady, winEnd) : null;
  const residentBefore = residencyBefore(best.node, winStart ?? tCreated);

  // NOTE: no cause is assigned here. Picking argmax over these intervals would classify 100% of
  // samples by construction — the classifier would always find *a* largest bucket and the run
  // would look fully explained whether or not it was. Attribution happens in a second pass
  // (below), against the fast-mode distribution, and is allowed to return UNATTRIBUTABLE.
  const intervals = { schedDelay, pullDelta, startDelay, boot, postReady };

  results.push({
    sample: i,
    dur,
    split: k6m,
    mode,
    admissible: true,
    pod: best.name,
    podCreated: best.created,
    revision: best.revision,
    revisionUid: best.revisionUid,
    node: best.node,
    k6Node: drv.node,
    sameNode: drv.node != null && best.node != null ? drv.node === best.node : null,
    predicate,
    predicatePath,
    imageResidentEvent: alreadyPresent,
    imageResidentBefore: residentBefore,
    pullReported,
    unhealthyCount: unhealthy.reduce((a, e) => a + (e.count ?? 1), 0),
    schedDelay,
    pullDelta,
    startDelay,
    boot,
    postReady,
    intervals,
  });
}

// ---- attribution pass: allowed to say "I cannot tell you why" --------------------------------
// A slow sample is attributed only if measured intervals actually account for its excess over the
// fast mode. Otherwise the ~8 s is somewhere the instrument does not see, and the honest output is
// UNATTRIBUTABLE. A run with zero unattributable samples and no falsification experiment is
// suspicious, not good.
const ATTRIBUTION_FLOOR = 0.5; // measured intervals must explain >=50% of the excess to name a cause

const INTERVAL_LABELS = {
  schedDelay: 'create→scheduled (scheduling)',
  pullDelta: 'pulling→pulled (image pull)',
  startDelay: 'scheduled→started (container start)',
  boot: 'started→ready (becoming servable)',
  postReady: 'ready→response (routing / activator)',
};

{
  const admRows = results.filter((r) => r.admissible);
  const fast = admRows.filter((r) => r.mode === 'fast');
  // Baseline = the WORST fast sample per interval. Excess is measured beyond anything the fast
  // mode ever did, so normal variation is never mistaken for a cause. No medians involved.
  const fastCeil = {};
  for (const k of Object.keys(INTERVAL_LABELS)) {
    const vals = fast.map((r) => r.intervals?.[k]).filter((v) => v != null);
    fastCeil[k] = vals.length ? Math.max(...vals) : null;
  }
  const fastDurCeil = fast.length
    ? Math.max(...fast.map((r) => r.dur).filter((v) => v != null))
    : null;

  for (const r of admRows) {
    if (r.mode !== 'SLOW') {
      r.attribution = { cause: null, note: 'fast sample — nothing to attribute' };
      continue;
    }
    if (fastDurCeil == null) {
      r.attribution = {
        cause: 'UNATTRIBUTABLE',
        note: 'no fast samples in this arm to form a baseline',
      };
      continue;
    }
    const totalExcess = r.dur - fastDurCeil;
    const excesses = Object.entries(INTERVAL_LABELS)
      .map(([k, label]) => {
        const v = r.intervals?.[k];
        const ceil = fastCeil[k];
        // An interval with no fast baseline cannot be scored; treat as unmeasured, not as zero.
        const excess = v != null && ceil != null ? Math.max(0, v - ceil) : null;
        return { k, label, value: v, excess };
      })
      .sort((a, b) => (b.excess ?? -1) - (a.excess ?? -1));
    const explained = excesses.reduce((a, e) => a + (e.excess ?? 0), 0);
    const share = totalExcess > 0 ? explained / totalExcess : 0;
    const unmeasured = excesses.filter((e) => e.excess == null).map((e) => e.k);

    if (totalExcess <= 0) {
      r.attribution = { cause: null, note: 'not in excess of the fast mode' };
    } else if (share < ATTRIBUTION_FLOOR) {
      r.attribution = {
        cause: 'UNATTRIBUTABLE',
        note: `measured intervals explain only ${(share * 100).toFixed(0)}% of ${totalExcess.toFixed(2)}s excess`,
        totalExcess,
        explained,
        unmeasured,
        excesses,
      };
    } else {
      r.attribution = {
        cause: excesses[0].label,
        note: `${(share * 100).toFixed(0)}% of ${totalExcess.toFixed(2)}s excess explained`,
        totalExcess,
        explained,
        unmeasured,
        excesses,
      };
    }
  }
}

// ---- output ----------------------------------------------------------------------------------
console.log(`\ncollector rows: ${rows.length} | app pods: ${pods.size} | k6 samples: ${k6.size}`);
console.log(`target digest: ${start?.targetDigest ?? '(unknown)'}`);
console.log(`nodes: ${nodeNames.join(', ') || '(none)'}`);

const adm = results.filter((r) => r.admissible);
const inadm = results.filter((r) => !r.admissible);

// Arm contamination check — revision identity must be constant across the arm.
const revs = [...new Set(adm.map((r) => r.revision))];
const revUids = [...new Set(adm.map((r) => r.revisionUid))];
console.log(
  `\nARM INTEGRITY: revisions=${revs.join(',') || '?'} revisionUIDs=${revUids.length} ksvcGenerations=${generations.join(',')} latestReady=${latestReadySeen.join(',')}`,
);
// What actually invalidates an arm is the SERVING revision changing between samples. The ksvc
// generation legitimately changes twice per run — apply_autoscaling bumps it before sample 1 and
// the restore bumps it after sample N — so treating any generation change as contamination
// reports every correct run as broken, which trains readers to ignore the check.
if (revs.length > 1 || revUids.length > 1) {
  console.log(
    '  *** CONTAMINATED: the serving revision changed mid-arm — samples are not comparable ***',
  );
} else {
  console.log(`  OK — one serving revision (${revs[0] ?? '?'}) across all admissible samples.`);
  if (generations.length > 1) {
    console.log(
      `     ksvc generation moved ${generations.join('→')} during the run. Expected: the harness` +
        ` applies its benchmark autoscaling config before sample 1 and restores after sample N.` +
        ` Neither touches the container, and both sit outside the sampled window.`,
    );
  }
}

console.log(
  '\nsample dur     mode  pred      node                  img  sched   pull    start   boot    postRdy  conn    wait    dominant cause',
);
for (const r of results) {
  if (!r.admissible) {
    console.log(
      `  ${String(r.sample).padEnd(4)} ${fmt(r.dur).padEnd(7)} ${r.mode.padEnd(5)} INADMISSIBLE — ${r.reason}`,
    );
    continue;
  }
  const img = r.imageResidentEvent
    ? 'HIT'
    : r.imageResidentBefore === false
      ? 'MISS'
      : r.imageResidentBefore
        ? 'hit?'
        : '?';
  console.log(
    `  ${String(r.sample).padEnd(4)} ${fmt(r.dur).padEnd(7)} ${r.mode.padEnd(5)} ${r.predicate.padEnd(9)} ` +
      `${(r.node ?? '?').slice(-20).padEnd(21)} ${img.padEnd(4)} ` +
      `${fmt(r.schedDelay).padEnd(7)} ${fmt(r.pullDelta).padEnd(7)} ${fmt(r.startDelay).padEnd(7)} ` +
      `${fmt(r.boot).padEnd(7)} ${fmt(r.postReady).padEnd(8)} ` +
      `${fmt(r.split?.connecting).padEnd(7)} ${fmt(r.split?.waiting).padEnd(7)} ` +
      `${r.attribution?.cause ?? '—'}`,
  );
}

console.log(
  `\nadmissible: ${adm.length}/${results.length}` +
    (inadm.length ? `  — INADMISSIBLE: ${inadm.map((r) => r.sample).join(', ')}` : ''),
);

const withSplits = adm.filter((r) => r.split?.waiting != null || r.split?.connecting != null);
console.log(
  `k6 split metrics available for ${withSplits.length}/${adm.length} admissible samples ` +
    `(source: k6 pod logs; the harness results file drops the splits at run.sh:1021). ` +
    `Samples without splits show "—" — that is missing data, not zero.`,
);

const group = (label, keyFn) => {
  const by = {};
  for (const r of adm) {
    const k = String(keyFn(r));
    by[k] ??= { fast: 0, slow: 0, durs: [] };
    by[k][r.mode === 'SLOW' ? 'slow' : 'fast']++;
    if (r.dur != null) by[k].durs.push(r.dur);
  }
  console.log(`\n${label}:`);
  // Distribution, not a median. A central tendency over a bimodal sample describes a value that
  // never occurs; the roadmap forbids publishing one. Print every sample and the range.
  for (const [k, v] of Object.entries(by)) {
    const s = [...v.durs].sort((a, b) => a - b);
    const range = s.length ? `${s[0].toFixed(2)}–${s[s.length - 1].toFixed(2)}s` : '—';
    console.log(
      `  ${k.slice(-40).padEnd(42)} n=${s.length} fast=${v.fast} slow=${v.slow} range=${range}`,
    );
    if (s.length)
      console.log(`  ${''.padEnd(42)} samples: ${s.map((x) => x.toFixed(2)).join(', ')}`);
  }
};

group('mode by app-pod node', (r) => r.node);
group('mode by image residency (event)', (r) => (r.imageResidentEvent ? 'RESIDENT' : 'PULLED'));
group(
  'mode by readiness predicate',
  (r) => `${r.predicate}${r.predicatePath ? ` ${r.predicatePath}` : ''}`,
);
group('mode by k6/app same-node', (r) =>
  r.sameNode == null ? 'unknown' : r.sameNode ? 'same-node' : 'cross-node',
);

// ---- attribution outcome, including the bucket that is allowed to stay non-empty -------------
console.log('\n=== ATTRIBUTION OUTCOME ===');
const slowRows = adm.filter((r) => r.mode === 'SLOW');
const fastRows = adm.filter((r) => r.mode === 'fast');
console.log(`  fast samples: ${fastRows.length}   SLOW samples: ${slowRows.length}`);

if (!slowRows.length) {
  console.log('  No SLOW samples in this arm — there is no slow mode here to attribute.');
} else {
  const tally = {};
  for (const r of slowRows) {
    const c = r.attribution?.cause ?? 'UNATTRIBUTABLE';
    tally[c] = (tally[c] ?? 0) + 1;
  }
  for (const [c, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padEnd(40)} ${n}/${slowRows.length}`);
  }
  const unatt = slowRows.filter((r) => r.attribution?.cause === 'UNATTRIBUTABLE');
  console.log(
    `\n  UNATTRIBUTABLE: ${unatt.length}/${slowRows.length}. This bucket is expected to be` +
      ` non-empty.\n  A run that classifies every sample may be describing its classifier rather than` +
      ` the cluster;\n  "slow, and the instrument cannot say why" is a publishable result.`,
  );

  console.log(
    '\n  per-slow-sample excess breakdown (baseline = the WORST fast sample, no medians):',
  );
  for (const r of slowRows) {
    console.log(
      `\n   sample ${r.sample}  dur=${fmt(r.dur)}  node=${r.node ?? '?'}  predicate=${r.predicate}` +
        `\n     ${r.attribution?.cause ?? 'UNATTRIBUTABLE'} — ${r.attribution?.note ?? ''}`,
    );
    for (const e of r.attribution?.excesses ?? []) {
      const mark = e.excess == null ? 'unmeasured' : `${fmt(e.excess)} beyond worst fast`;
      console.log(`       ${e.label.padEnd(38)} value=${fmt(e.value).padEnd(8)} ${mark}`);
    }
  }
}

// ---- scope disclosure: a distribution from one node/day/revision may be an artifact of it ------
console.log('\n=== SCOPE OF THIS RESULT ===');
const revsSeen = [...new Set(adm.map((r) => r.revision))].filter(Boolean);
const nodesUsed = [...new Set(adm.map((r) => r.node))].filter(Boolean);
const days = [...new Set(adm.map((r) => (r.podCreated ?? '').slice(0, 10)).filter(Boolean))];
console.log(`  revisions: ${revsSeen.join(', ') || '?'}`);
console.log(
  `  nodes actually used: ${nodesUsed.join(', ') || '?'} (cluster has ${nodeNames.length})`,
);
console.log(`  sitting(s): ${days.join(', ') || 'single run'}`);
console.log(
  '  A distribution from one node, one day and one revision can be literally honest and still\n' +
    '  describe an artifact of that node. Stratification by node is printed above; if the slow mode\n' +
    '  concentrates on one node, say THAT rather than making a platform-wide claim.',
);

console.log('\nKPA observations:', kpaObs.length);
const kpaTransitions = [];
let lastKey = null;
for (const k of kpaObs) {
  const active = k.conditions?.find((c) => c.type === 'Active');
  const key = `${k.revision}|${active?.status}|${active?.reason}|${k.actualReplicas}|${k.desiredReplicas}`;
  if (key !== lastKey) {
    kpaTransitions.push(
      `  ${k.t} rev=${k.revision} Active=${active?.status}(${active?.reason ?? '-'}) actual=${k.actualReplicas} desired=${k.desiredReplicas}`,
    );
    lastKey = key;
  }
}
for (const l of kpaTransitions.slice(0, 60)) console.log(l);
