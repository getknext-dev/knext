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
 * docs/benchmarks/ and ADR-0036's withdrawn runs for why each one is here):
 *
 *   - ONE application on both arms, asserted by image DIGEST, not by inspection.
 *   - The arms are INTERLEAVED (ABBA within a pair). A sequential A-then-B design
 *     is invalid: a cluster-level slow mode switching on mid-run already produced
 *     one withdrawn 4.5x result.
 *   - Every replicate asserts its own PRECONDITION (image present / absent on
 *     every node) and fails loudly rather than measuring the wrong thing.
 *   - Both arms are held to the same time-at-zero floor before the request, and
 *     the actual gap is recorded per replicate.
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
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CTX = process.env.KUBE_CONTEXT ?? '';
const NS = process.env.NAMESPACE ?? 'knext-prewarm';
const APP = process.env.APP ?? 'pw';
const IMAGE = process.env.PW_IMAGE; // digest-pinned app image, same on both arms
const ENDPOINT = process.env.PW_ENDPOINT ?? '/api/health';
const OUT = process.env.PW_OUT ?? join(HERE, 'results', 'results.jsonl');
const PAIRS = Number(process.env.PW_PAIRS ?? 5);
const SETTLE_FLOOR_MS = Number(process.env.PW_SETTLE_FLOOR_MS ?? 150000);
const DISK_ABORT_PCT = Number(process.env.PW_DISK_ABORT_PCT ?? 85);
const ORDER = ['on', 'off', 'off', 'on']; // ABBA within pair

if (!IMAGE || !IMAGE.includes('@sha256:')) {
  console.error('PW_IMAGE must be a digest-pinned app image (registry/repo@sha256:…)');
  process.exit(1);
}

const kc = (...args) =>
  execFileSync('kubectl', CTX ? [...args, '--context', CTX] : args, { encoding: 'utf8' });
const kcj = (...args) => JSON.parse(kc(...args, '-o', 'json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (...m) => console.log(`[${now()}]`, ...m);

const nodesh = (node, cmd) =>
  execFileSync(join(HERE, 'nodesh.sh'), [node, cmd], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, KUBE_CONTEXT: CTX, NAMESPACE: NS },
  });

const NODES = kc('get', 'nodes', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}')
  .trim()
  .split('\n')
  .filter(Boolean);

// --- node image cache -------------------------------------------------------
const REPO = IMAGE.split('@')[0];
const nodeDisk = {};

// NOTE: `crictl images -q <repo>` returns NOTHING for a digest-only (untagged)
// image even when it IS present. Trusting it silently invalidated a whole run
// (the "no prewarm" arm never actually evicted anything, so every replicate
// reported "already present on machine"). `crictl inspecti <ref>` is the
// authoritative presence check; the id table is only for logging.
function imageOnNode(node) {
  const out = nodesh(
    node,
    `crictl inspecti -q ${IMAGE} >/dev/null 2>&1 && echo PRESENT || echo ABSENT; ` +
      `crictl images --digests 2>/dev/null | grep ${REPO} | awk '{print "ID="$4}'; ` +
      `df --output=pcent / | tail -1`,
  );
  const pct = out.match(/(\d+)%/);
  if (pct) nodeDisk[node] = Number(pct[1]);
  const ids = [...out.matchAll(/ID=([0-9a-f]{8,})/g)].map((m) => m[1]);
  if (out.includes('PRESENT')) return ids.length ? ids : ['present'];
  if (out.includes('ABSENT')) return [];
  throw new Error(`could not determine image presence on ${node}: ${out}`);
}

async function removeImageFromNode(node) {
  // Only ever touches the harness's OWN repository, never a pre-existing image.
  // cri-o refuses to remove an image still referenced by an (even exited)
  // container, so retry while the previous replicate's containers are reaped —
  // that reaping routinely takes two minutes here.
  let last = '';
  for (let attempt = 0; attempt < 16; attempt++) {
    last = nodesh(
      node,
      `crictl rmi ${IMAGE} 2>&1 | tail -1; ` +
        `ids=$(crictl images --digests 2>/dev/null | grep ${REPO} | awk '{print $4}'); ` +
        `for i in $ids; do crictl rmi $i 2>&1 | tail -1; done; ` +
        `crictl inspecti -q ${IMAGE} >/dev/null 2>&1 && echo "STILL-PRESENT" || echo "removed"`,
    );
    if (imageOnNode(node).length === 0) return last;
    await sleep(10000);
  }
  return last;
}

// --- CR-driven state (ADR-0001: the CR is the only thing the harness writes) --
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
  } catch {}
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
    // THE criterion: with the image already staged by the prewarm DaemonSet the
    // kubelet must not emit `Pulling` at all.
    pulling: events.some((e) => e.reason === 'Pulling'),
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
      throw new Error(
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

  // 4. symmetric settle: the arms otherwise differ in how long the app has been at
  // zero before the request (the off arm spends minutes waiting for cri-o to
  // release the image). Hold both to the same floor and record the real gap.
  const waitMore = SETTLE_FLOOR_MS - (Date.now() - scaledAt);
  if (waitMore > 0) await sleep(waitMore);
  const settleMs = Date.now() - scaledAt;
  log(`  settled ${Math.round(settleMs / 1000)}s at zero`);

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

  // 6. what the kubelet actually did
  await sleep(3000);
  const facts = podFacts(sinceIso);
  log(
    `  pod=${facts?.pod} node=${facts?.node} Pulling=${facts?.pulling} pulled=${JSON.stringify(facts?.pulledMsgs)}`,
  );

  const row = {
    ts: now(),
    pair,
    idx,
    // 'on'  = imagePrewarm=true, image already staged on every node
    // 'off' = imagePrewarm=false, image evicted from every node → kubelet must pull
    mode,
    image: IMAGE,
    endpoint: ENDPOINT,
    url,
    cold_ttfb_ms: cold.ttfb_ms,
    cold_status: cold.status,
    cold_err: err,
    warm_ttfb_ms: warm?.ttfb_ms ?? null,
    node_cache_before: cacheBefore,
    node_disk_pct: { ...nodeDisk },
    settle_ms: settleMs,
    revision: REVISION,
    ...facts,
  };
  appendFileSync(OUT, `${JSON.stringify(row)}\n`);
  return row;
}

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
  const first = Number(process.env.PW_PAIR_START ?? 1);
  let n = (first - 1) * ORDER.length;
  for (let pair = first; pair <= first + PAIRS - 1; pair++) {
    for (const mode of ORDER) {
      n++;
      try {
        await replicate({ pair, idx: n, mode });
      } catch (e) {
        // A failed replicate is RECORDED, never silently retried into the dataset.
        log(`  REPLICATE FAILED: ${e}`);
        appendFileSync(
          OUT,
          `${JSON.stringify({ ts: now(), pair, idx: n, mode, failed: String(e) })}\n`,
        );
      }
    }
  }
  log('done');
};
main();
