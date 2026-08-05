#!/usr/bin/env node
/**
 * image-prewarm (ADR-0037) live-cluster measurement: does `spec.scaling.imagePrewarm`
 * actually remove the image pull from a cold scale-from-zero, and by how much?
 *
 * This is NOT assertable on kind — kind side-loads images into every node's
 * containerd, so "no `Pulling` event" is trivially true there whether or not the
 * prewarmer works. It needs a real cluster pulling from a real registry.
 *
 * Design constraints (this repo's admissibility bar for benchmark evidence — see
 * docs/benchmarks/ and ADR-0036's withdrawn runs for why each one is here). Each
 * is CODE, in `lib.mjs`, unit-tested by `tests/image-prewarm-harness.test.ts` —
 * an earlier revision of this header claimed the first of them while nothing in
 * the file implemented it, which is the defect class the workflow rules name:
 *
 *   - ONE application on both arms, asserted by image DIGEST against the running
 *     Revision, BEFORE any mutation (`assertSingleApplication`), and again per
 *     replicate against the pod that actually served the cold request.
 *   - The arms are INTERLEAVED (ABBA within a pair). A sequential A-then-B design
 *     is invalid: a cluster-level slow mode switching on mid-run already produced
 *     one withdrawn 4.5x result.
 *   - Every replicate asserts its own PRECONDITION (image present / absent on
 *     every node) and fails loudly rather than measuring the wrong thing. An
 *     ABSENT observation — no pod, a failed events query — FAILS the replicate:
 *     recorded as failed, stepped over, and never recorded as the favourable
 *     value. It is not fatal, because a transient events query says nothing
 *     about the next replicate and aborting discards hours on a shared cluster.
 *   - A condition that would damage the cluster or invalidate what follows (node
 *     disk at the kubelet's image-GC threshold, a lost restore, the measured pod
 *     running a DIFFERENT image) is a `FatalError` and aborts the RUN. The caller
 *     catches ordinary failures, so an abort that is not distinguishable from one
 *     is not an abort.
 *   - Both arms are held to the same QUIET floor before the request, measured
 *     from the end of the precondition work — not from scale-to-zero. The `off`
 *     arm spends 60-85 s in privileged node Jobs evicting the image and the `on`
 *     arm 12-15 s, so a floor measured from scale-to-zero gives the two arms
 *     different amounts of quiet (measured: run 2, 2026-08-04).
 *   - Whatever the run changes on the CR it puts back, verified by read-back.
 *   - Raw per-replicate rows are written as JSONL; analyze.mjs reports the
 *     distribution stratified by arm, never a pooled median.
 *
 * Everything the harness writes to the cluster goes through the NextApp CR
 * (ADR-0001) — `kubectl patch nextapp … spec.scaling.imagePrewarm` — except the
 * node-local image eviction in nodesh.sh, which has no API equivalent.
 *
 * Usage:
 *   KUBE_CONTEXT=… NAMESPACE=knext-prewarm APP=pw \
 *   PW_IMAGE=registry/repo@sha256:… node measure.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPodFacts,
  assertSafeImageRef,
  assertSafeNodeName,
  assertSingleApplication,
  FatalError,
  imageRepo,
  nodeEvictCmd,
  nodeProbeCmd,
  parseNodeProbe,
  runReplicates,
  withRestore,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CTX = process.env.KUBE_CONTEXT ?? '';
const NS = process.env.NAMESPACE ?? 'knext-prewarm';
const APP = process.env.APP ?? 'pw';
const ENDPOINT = process.env.PW_ENDPOINT ?? '/api/health';
const OUT = process.env.PW_OUT ?? join(HERE, 'results', 'results.jsonl');
const PAIRS = Number(process.env.PW_PAIRS ?? 5);
const SETTLE_FLOOR_MS = Number(process.env.PW_SETTLE_FLOOR_MS ?? 150000);
const DISK_ABORT_PCT = Number(process.env.PW_DISK_ABORT_PCT ?? 85);
const ORDER = ['on', 'off', 'off', 'on']; // ABBA within pair

// `results/` is gitignored and therefore absent in a fresh clone — the first
// writeFileSync below used to throw ENOENT on line 1 of the documented
// "Reproducing this" command. The sibling scale-to-zero harness mkdir -p's for
// the same reason (run.sh:360).
mkdirSync(dirname(OUT), { recursive: true });

// digest-pinned app image, same on both arms. Validated, not merely sniffed for
// "@sha256:": it is interpolated into a ROOT nsenter shell on every node.
const IMAGE = assertSafeImageRef(process.env.PW_IMAGE);
const REPO = imageRepo(IMAGE);

const kc = (...args) =>
  execFileSync('kubectl', CTX ? [...args, '--context', CTX] : args, { encoding: 'utf8' });
const kcj = (...args) => JSON.parse(kc(...args, '-o', 'json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (...m) => console.log(`[${now()}]`, ...m);

const nodesh = (node, cmd) =>
  execFileSync(join(HERE, 'nodesh.sh'), [assertSafeNodeName(node), cmd], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, KUBE_CONTEXT: CTX, NAMESPACE: NS },
  });

const NODES = kc('get', 'nodes', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(assertSafeNodeName);

// --- node image cache -------------------------------------------------------
const nodeDisk = {};

// NOTE: `crictl images -q <repo>` returns NOTHING for a digest-only (untagged)
// image even when it IS present. Trusting it silently invalidated a whole run
// (the "no prewarm" arm never actually evicted anything, so every replicate
// reported "already present on machine"). `crictl inspecti <ref>` is the
// authoritative presence check; the id table is only for logging and eviction,
// and it is selected by EXACT repository (see repoIdSelector).
function imageOnNode(node) {
  const probe = parseNodeProbe(nodesh(node, nodeProbeCmd(IMAGE)));
  if (probe.diskPct != null) nodeDisk[node] = probe.diskPct;
  if (!probe.present) return [];
  return probe.ids.length ? probe.ids : ['present'];
}

async function removeImageFromNode(node) {
  // Only ever touches the harness's OWN repository — matched EXACTLY on the
  // repository column, never `grep <repo>`, which also matched `<repo>-app` and
  // `<repo>x` and would then have `crictl rmi`'d them by image id.
  // cri-o refuses to remove an image still referenced by an (even exited)
  // container, so retry while the previous replicate's containers are reaped —
  // that reaping routinely takes two minutes here.
  let last = '';
  for (let attempt = 0; attempt < 16; attempt++) {
    last = nodesh(node, nodeEvictCmd(IMAGE));
    if (imageOnNode(node).length === 0) return last;
    await sleep(10000);
  }
  return last;
}

// --- CR-driven state (ADR-0001: the CR is the only thing the harness writes) --
const readPrewarm = () =>
  kc('get', 'nextapp', APP, '-n', NS, '-o', 'jsonpath={.spec.scaling.imagePrewarm}').trim() ===
  'true';

const patchPrewarm = (on) =>
  kc(
    'patch',
    'nextapp',
    APP,
    '-n',
    NS,
    '--type=merge',
    '-p',
    JSON.stringify({ spec: { scaling: { imagePrewarm: on } } }),
  );

async function waitFor(what, fn, timeoutMs = 420000, everyMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try {
      v = fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(everyMs);
  }
}

function dsReady() {
  try {
    const s = kcj('get', 'daemonset', `${APP}-imgcache`, '-n', NS).status ?? {};
    return s.desiredNumberScheduled > 0 && s.numberReady === s.desiredNumberScheduled ? s : false;
  } catch {
    return false;
  }
}
function dsGone() {
  try {
    kc('get', 'daemonset', `${APP}-imgcache`, '-n', NS);
    return false;
  } catch {
    return true;
  }
}

// The ACTIVE revision only: a stale non-Ready revision (e.g. one created before
// the app's pull secret existed) keeps a bound-but-unstartable pod around, and
// that pod must not be mistaken for the app still being warm.
const REVISION =
  process.env.PW_REVISION ??
  kc('get', 'ksvc', APP, '-n', NS, '-o', 'jsonpath={.status.latestReadyRevisionName}').trim();
const URL_BASE = kc('get', 'ksvc', APP, '-n', NS, '-o', 'jsonpath={.status.url}').trim();

// The header's first design constraint, as an assertion: the Revision that will
// serve BOTH arms must run exactly the digest under test. Read and checked
// BEFORE any patch, so a mismatch aborts without having mutated anything.
const REVISION_IMAGE = (() => {
  try {
    return kc(
      'get',
      'revision',
      REVISION,
      '-n',
      NS,
      '-o',
      'jsonpath={.spec.containers[0].image}',
    ).trim();
  } catch {
    return '';
  }
})();
assertSingleApplication({ pwImage: IMAGE, revisionImage: REVISION_IMAGE, revision: REVISION });

const appPods = () =>
  kcj('get', 'pods', '-n', NS, '-l', `serving.knative.dev/revision=${REVISION}`).items.filter(
    (i) => i.status?.phase !== 'Succeeded' && !i.metadata.deletionTimestamp,
  );

const waitScaledToZero = () =>
  waitFor('app scaled to zero', () => appPods().length === 0, 480000, 5000);

// --- measurement ------------------------------------------------------------
async function timedGet(url, timeoutMs = 300000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    const ttfb = performance.now() - t0;
    const body = await res.text();
    return {
      ttfb_ms: +ttfb.toFixed(1),
      total_ms: +(performance.now() - t0).toFixed(1),
      status: res.status,
      bytes: body.length,
    };
  } finally {
    clearTimeout(t);
  }
}

function podFacts(sinceIso) {
  const pod = appPods()
    .filter((p) => new Date(p.metadata.creationTimestamp) >= new Date(sinceIso))
    .sort(
      (a, b) => new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp),
    )[0];
  if (!pod) return null;
  let events = [];
  // A FAILED events query is recorded as such and fails the replicate. It used
  // to be swallowed, leaving `events = []` and therefore `pulling: false` — the
  // value the headline claim wants, from an observation that never happened.
  let eventsError = null;
  try {
    events = kcj(
      'get',
      'events',
      '-n',
      NS,
      '--field-selector',
      `involvedObject.name=${pod.metadata.name}`,
    ).items.map((e) => ({
      reason: e.reason,
      msg: (e.message ?? '').slice(0, 220),
      t: e.firstTimestamp ?? e.eventTime,
    }));
  } catch (e) {
    eventsError = String(e);
  }
  return {
    pod: pod.metadata.name,
    node: pod.spec.nodeName,
    created: pod.metadata.creationTimestamp,
    conditions: Object.fromEntries(
      (pod.status?.conditions ?? []).map((c) => [c.type, c.lastTransitionTime]),
    ),
    containers: (pod.status?.containerStatuses ?? []).map((c) => ({
      name: c.name,
      image: c.image,
      imageID: c.imageID,
      restarts: c.restartCount,
      startedAt: c.state?.running?.startedAt ?? null,
    })),
    events,
    eventsError,
    // THE criterion: with the image already staged by the prewarm DaemonSet the
    // kubelet must not emit `Pulling` at all.
    pulling: eventsError ? null : events.some((e) => e.reason === 'Pulling'),
    pulledMsgs: events.filter((e) => e.reason === 'Pulled').map((e) => e.msg),
  };
}

async function replicate({ pair, idx, mode }) {
  log(`--- pair ${pair} replicate ${idx} mode=${mode} ---`);

  // 1. select the arm — through the CR, never by touching the DaemonSet
  patchPrewarm(mode === 'on');
  if (mode === 'on') {
    const s = await waitFor('imgcache DaemonSet ready', dsReady);
    log(`  DaemonSet ready: ${s.numberReady}/${s.desiredNumberScheduled}`);
  } else {
    await waitFor('imgcache DaemonSet gone', dsGone);
    log('  DaemonSet gone');
  }

  // 2. a genuinely cold app: no pods at all for the active revision
  await waitScaledToZero();
  const scaledAt = Date.now();
  log('  app scaled to zero');

  // 3. force the node image cache into the state this arm claims, then ASSERT it
  const cacheBefore = {};
  if (mode === 'off') {
    for (const n of NODES) {
      const out = await removeImageFromNode(n);
      log(`  rmi on ${n}: ${out.trim().split('\n').pop()}`);
    }
  }
  for (const n of NODES) cacheBefore[n] = imageOnNode(n);
  log(`  image ids per node: ${JSON.stringify(cacheBefore)}`);
  for (const [n, pct] of Object.entries(nodeDisk)) {
    if (pct >= DISK_ABORT_PCT) {
      // FATAL, not a failed replicate: the caller catches ordinary errors and
      // steps to the next replicate, which would pull another few hundred MB
      // onto a node already at the kubelet's image-GC high-water mark — at
      // which point the kubelet evicts images this harness does not own.
      throw new FatalError(
        `ABORT: ${n} root disk at ${pct}% — too close to the kubelet image-GC high threshold ` +
          `to keep pulling (GC would start evicting images this harness does not own)`,
      );
    }
  }
  const expectCached = mode === 'on';
  for (const n of NODES) {
    const present = cacheBefore[n].length > 0;
    if (present !== expectCached) {
      throw new Error(
        `precondition failed on ${n}: image present=${present}, expected=${expectCached}`,
      );
    }
  }

  // 4. symmetric QUIET floor. The clock starts HERE — after the precondition
  // work — not at scale-to-zero: the `off` arm spends 60-85 s in privileged
  // node Jobs evicting the image while the `on` arm spends 12-15 s probing, so
  // a floor measured from scale-to-zero leaves the two arms with materially
  // different amounts of quiet before the request (60-90 s vs 135-138 s in run
  // 2). Both the quiet time and the node work are recorded per replicate.
  const quietFrom = Date.now();
  const preconditionMs = quietFrom - scaledAt;
  const waitMore = SETTLE_FLOOR_MS - (Date.now() - quietFrom);
  if (waitMore > 0) await sleep(waitMore);
  const settleMs = Date.now() - quietFrom;
  log(
    `  precondition work ${Math.round(preconditionMs / 1000)}s, then quiet ${Math.round(settleMs / 1000)}s`,
  );

  // 5. the cold request, then an immediately-following warm one as this
  // replicate's own baseline (it cancels client↔cluster RTT)
  const sinceIso = new Date(Date.now() - 5000).toISOString();
  const url = `${URL_BASE}${ENDPOINT}`;
  let cold;
  let err = null;
  try {
    cold = await timedGet(url);
  } catch (e) {
    err = String(e);
    cold = { ttfb_ms: null, status: null };
  }
  log(`  cold ttfb=${cold.ttfb_ms}ms status=${cold.status}${err ? ` err=${err}` : ''}`);

  let warm = null;
  try {
    warm = await timedGet(url, 60000);
  } catch (e) {
    warm = { ttfb_ms: null, err: String(e) };
  }
  log(`  warm ttfb=${warm.ttfb_ms}ms`);

  // 6. what the kubelet actually did — asserted complete, and asserted to be
  // the SAME application by digest, before it is written as a data point
  await sleep(3000);
  const facts = assertPodFacts(podFacts(sinceIso), { expectImage: IMAGE });
  log(
    `  pod=${facts.pod} node=${facts.node} Pulling=${facts.pulling} pulled=${JSON.stringify(facts.pulledMsgs)}`,
  );

  const row = {
    ts: now(),
    pair,
    idx,
    // 'on'  = imagePrewarm=true, image already staged on every node
    // 'off' = imagePrewarm=false, image evicted from every node → kubelet must pull
    mode,
    image: IMAGE,
    repo: REPO,
    endpoint: ENDPOINT,
    url,
    cold_ttfb_ms: cold.ttfb_ms,
    cold_status: cold.status,
    cold_err: err,
    warm_ttfb_ms: warm?.ttfb_ms ?? null,
    node_cache_before: cacheBefore,
    node_disk_pct: { ...nodeDisk },
    // precondition_ms = privileged node work (eviction + probes); settle_ms =
    // the QUIET time between that work and the request. Published per arm by
    // analyze.mjs, because an asymmetry here is an alternative explanation for
    // the tail.
    precondition_ms: preconditionMs,
    settle_ms: settleMs,
    at_zero_ms: Date.now() - scaledAt,
    revision: REVISION,
    ...facts,
  };
  appendFileSync(OUT, `${JSON.stringify(row)}\n`);
  return row;
}

const record = (row) => appendFileSync(OUT, `${JSON.stringify(row)}\n`);

const main = async () => {
  writeFileSync(
    OUT.replace(/\.jsonl$/, '.meta.json'),
    `${JSON.stringify(
      {
        started: now(),
        image: IMAGE,
        endpoint: ENDPOINT,
        url: URL_BASE,
        revision: REVISION,
        revisionImage: REVISION_IMAGE,
        pairs: PAIRS,
        order: ORDER,
        nodes: NODES,
      },
      null,
      2,
    )}\n`,
  );
  log(`image under test: ${IMAGE}`);
  log(`url: ${URL_BASE}${ENDPOINT}  revision: ${REVISION}  nodes: ${NODES.join(',')}`);

  // Whatever imagePrewarm was set to before this run, it is set back to that —
  // and the restore is READ BACK, not assumed. `ORDER` ends with `on`, so
  // without this every run left a prewarm DaemonSet and a warm image resident
  // on every node, and the next benchmark on this cluster inherits it silently.
  // This covers Ctrl-C too (SIGINT/SIGTERM restore, then exit 130/143): a run is
  // ~100 minutes, so interrupting one is a likely exit path, not an exotic one.
  await withRestore({
    read: readPrewarm,
    write: patchPrewarm,
    log: (m) => log(m),
    body: () =>
      runReplicates({
        first: Number(process.env.PW_PAIR_START ?? 1),
        pairs: PAIRS,
        order: ORDER,
        run: replicate,
        record,
        log,
        now,
      }),
  });
  log('done');
};

main().catch((e) => {
  log(`RUN ABORTED: ${e}`);
  process.exitCode = 1;
});
