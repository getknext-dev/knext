#!/usr/bin/env node
// Per-phase scale-from-zero instrument — ONE cold cycle per invocation.
//
//   node harness.mjs <ksvc-name>          (run inside the `phase-bench` pod)
//
// Prints one JSON object on stdout. Every `t_*` value is milliseconds since the
// request was sent (t = 0), on THIS pod's wall clock, sampled with
// performance.timeOrigin + performance.now() (sub-millisecond). Watch-event
// times are ARRIVAL times at this pod, so they trail the apiserver write by the
// watch-delivery latency (typically a few ms in-cluster). Node-side timestamps
// (CRI-O log-line stamps, kubelet/scheduler event times, status timestamps) are
// re-based onto this clock using the offset measured against the `clock-<node>`
// pod on the app's node (see clockOffset); the offset and its RTT bound are
// reported per cycle.
//
// Read-only against the cluster (RBAC: harness-rbac.yaml) except with HEAL=1,
// which execs one DNS lookup in the new app container (experiment E1). The
// traffic it generates besides the measured request: TCP connect attempts to
// the new pod's :3000 and :8012 (no payload), Knative-style readiness probes
// (`K-Network-Probe: queue`) to :8012 — the same probe the activator sends —
// and, via the agent on the pod's node (node-agents.yaml), one same-node TCP
// poll and one direct GET of the health path.

import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const NS = process.env.NS ?? 'bench-cells';
const ARM = process.argv[2];
const HEALTH = process.env.HEALTH_PATH ?? '/api/health';
if (!ARM) throw new Error('usage: harness.mjs <ksvc>');
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN = fs.readFileSync(`${SA}/token`, 'utf8');
const CA = fs.readFileSync(`${SA}/ca.crt`);
const API = {
  host: process.env.KUBERNETES_SERVICE_HOST,
  port: Number(process.env.KUBERNETES_SERVICE_PORT),
};
// node-agents.yaml: one agent per worker node (clock + same-node TCP poll).
const AGENT_PODS = { '10.0.1.118': 'agent-118', '10.0.1.169': 'agent-169' };
const agentIps = {};
async function agentIp(nodeName) {
  const pod = AGENT_PODS[nodeName];
  if (!pod) return null;
  agentIps[pod] ??= (await apiGet(`/api/v1/namespaces/${NS}/pods/${pod}`)).status.podIP;
  return agentIps[pod];
}

// Ask the agent on the NEW pod's node to poll ip:port (same-node reachability).
async function agentPoll(nodeName, query) {
  const aip = await agentIp(nodeName);
  if (!aip) return null;
  return new Promise((resolve) => {
    http
      .get({ host: aip, port: 8080, path: `${query}&ms=15000`, agent: false }, (res) => {
        let b = '';
        res.on('data', (c) => {
          b += c;
        });
        res.on('end', () => resolve(JSON.parse(b)));
      })
      .on('error', () => resolve(null));
  });
}

const now = () => performance.timeOrigin + performance.now();
// One JSON line on stdout is the harness's whole output contract (drive.py reads the last line).
const emit = (line) => process.stdout.write(`${line}\n`);

function apiGet(path, raw = false) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { ...API, path, ca: CA, headers: { Authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let b = '';
        res.on('data', (c) => {
          b += c;
        });
        res.on('end', () => {
          if (res.statusCode !== 200)
            return reject(new Error(`${path}: ${res.statusCode} ${b.slice(0, 200)}`));
          resolve(raw ? b : JSON.parse(b));
        });
      },
    );
    req.on('error', reject);
  });
}

// Watch from `rv`; calls onEvent(type, object, arrivalMs). Resolves once the
// stream's response headers arrive (watch established).
function watch(path, rv, onEvent) {
  let req;
  const ready = new Promise((resolve, reject) => {
    const sep = path.includes('?') ? '&' : '?';
    req = https.get(
      {
        ...API,
        path: `${path}${sep}watch=1&allowWatchBookmarks=false&resourceVersion=${rv}`,
        ca: CA,
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        resolve();
        let buf = '';
        res.on('data', (c) => {
          const t = now();
          buf += c;
          for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line.trim()) {
              const ev = JSON.parse(line);
              onEvent(ev.type, ev.object, t);
            }
          }
        });
      },
    );
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
  return { ready, close: () => req.destroy() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HEAL=1 (Part 2, experiment E1): the moment the watch shows user-container
// running, exec a one-shot DNS lookup INSIDE it. Its UDP packet to the cluster
// DNS ClusterIP is off-subnet, so the pod first ARPs for its gateway (the node's
// cni0 address); the node's kernel refreshes its neighbour entry for the pod IP
// from that ARP request. The exec goes through the apiserver as a WebSocket
// (v4.channel.k8s.io) — no kubectl in the pod. Resolves with the time the
// upgrade completed (the command is running) and when the stream closed.
const HEAL = process.env.HEAL === '1';
function execHeal(podName, bin) {
  const code =
    "require('node:dns').lookup('kubernetes.default.svc.cluster.local.',()=>process.exit(0))";
  const qs = [
    'container=user-container',
    'stdout=true',
    'stderr=true',
    `command=${bin}`,
    'command=-e',
    `command=${encodeURIComponent(code)}`,
  ].join('&');
  return new Promise((resolve) => {
    const sent = now();
    const req = https.request({
      ...API,
      path: `/api/v1/namespaces/${NS}/pods/${podName}/exec?${qs}`,
      ca: CA,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(String(Math.random()).slice(2, 18)).toString('base64'),
        'Sec-WebSocket-Protocol': 'v4.channel.k8s.io',
      },
    });
    req.on('upgrade', (_res, socket) => {
      const upgraded = now();
      socket.on('close', () => resolve({ sent, upgraded, closed: now() }));
      socket.on('error', () => {});
      socket.resume();
    });
    req.on('response', (res) => {
      let b = '';
      res.on('data', (c) => {
        b += c;
      });
      res.on('end', () => resolve({ sent, error: `${res.statusCode} ${b.slice(0, 200)}` }));
    });
    req.on('error', (e) => resolve({ sent, error: String(e) }));
    req.end();
  });
}

// NTP-style offset of the remote node's clock vs ours: offset = remote - mid.
async function clockOffset(nodeName) {
  const ip = await agentIp(nodeName);
  if (!ip) return null;
  let best = null;
  for (let i = 0; i < 7; i++) {
    const t0 = now();
    const remote = await new Promise((resolve, reject) => {
      http
        .get({ host: ip, port: 8080, path: '/', agent: false }, (res) => {
          let b = '';
          res.on('data', (c) => {
            b += c;
          });
          res.on('end', () => resolve(Number(b)));
        })
        .on('error', reject);
    });
    const t1 = now();
    const rtt = t1 - t0;
    if (!best || rtt < best.rtt_ms) best = { offset_ms: remote - (t0 + t1) / 2, rtt_ms: rtt };
  }
  best.offset_ms = Math.round(best.offset_ms * 100) / 100;
  best.rtt_ms = Math.round(best.rtt_ms * 100) / 100;
  return best;
}

function tcpPoll(ip, port, stop, everyMs = 10) {
  return new Promise((resolve) => {
    let attempts = 0;
    const tryOnce = () => {
      if (stop.done) return resolve(null);
      attempts++;
      const s = net.connect({ host: ip, port });
      // destroy(err) emits 'error', which schedules the retry; a bare
      // destroy() would emit only 'close' and stall the poll.
      const t = setTimeout(() => s.destroy(new Error('connect timeout')), 200);
      s.once('connect', () => {
        const at = now();
        clearTimeout(t);
        s.destroy();
        resolve({ at, attempts });
      });
      s.once('error', () => {
        clearTimeout(t);
        setTimeout(tryOnce, everyMs);
      });
      s.once('close', () => {});
    };
    tryOnce();
  });
}

// The activator's probe: GET :8012/ with K-Network-Probe: queue, 300 ms timeout.
function qpProbePoll(ip, stop, everyMs = 50) {
  return new Promise((resolve) => {
    let attempts = 0;
    const tryOnce = () => {
      if (stop.done) return resolve(null);
      attempts++;
      const req = http.get(
        {
          host: ip,
          port: 8012,
          path: '/',
          agent: false,
          timeout: 300,
          headers: { 'K-Network-Probe': 'queue' },
        },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve({ at: now(), attempts });
          setTimeout(tryOnce, everyMs);
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => setTimeout(tryOnce, everyMs));
    };
    tryOnce();
  });
}

const tsMs = (s) => (s ? Date.parse(s) : null);

async function main() {
  const sel = encodeURIComponent(`serving.knative.dev/service=${ARM}`);
  const podList = await apiGet(`/api/v1/namespaces/${NS}/pods?labelSelector=${sel}`);
  if (podList.items.length)
    throw new Error(`${ARM} has ${podList.items.length} pod(s); not at zero`);
  const depList = await apiGet(`/apis/apps/v1/namespaces/${NS}/deployments?labelSelector=${sel}`);
  const epsList = await apiGet(
    `/apis/discovery.k8s.io/v1/namespaces/${NS}/endpointslices?labelSelector=${sel}`,
  );

  const T = {}; // absolute ms, this clock
  const mark = (k, t) => {
    if (T[k] === undefined) T[k] = t;
  };
  let pod = null;
  const containers = {};
  const stop = { done: false };
  let probes = null;
  let healP = null;

  const wPods = watch(
    `/api/v1/namespaces/${NS}/pods?labelSelector=${sel}`,
    podList.metadata.resourceVersion,
    (type, o, t) => {
      if (type === 'ADDED') mark('pod_added', t);
      if (pod && o.metadata.name !== pod.metadata.name) return; // only the first pod
      pod = o;
      if (o.spec.nodeName) mark('pod_bound', t);
      for (const c of o.status.conditions ?? []) if (c.status === 'True') mark(`cond_${c.type}`, t);
      if (o.status.podIP) {
        mark('pod_ip', t);
        if (!probes) {
          const ip = o.status.podIP;
          probes = Promise.all([
            tcpPoll(ip, 3000, stop),
            tcpPoll(ip, 8012, stop),
            qpProbePoll(ip, stop),
            agentPoll(o.spec.nodeName, `/tcp?ip=${ip}&port=3000`),
            agentPoll(o.spec.nodeName, `/http?ip=${ip}&port=3000&path=${HEALTH}`),
          ]);
        }
      }
      for (const cs of o.status.containerStatuses ?? []) {
        containers[cs.name] ??= {};
        if (cs.state?.running) mark(`${cs.name}_running`, t);
        if (HEAL && !healP && cs.name === 'user-container' && cs.state?.running) {
          healP = execHeal(o.metadata.name, process.env.HEAL_BIN ?? 'node');
        }
        if (cs.ready) mark(`${cs.name}_ready`, t);
      }
    },
  );
  const wDep = watch(
    `/apis/apps/v1/namespaces/${NS}/deployments?labelSelector=${sel}`,
    depList.metadata.resourceVersion,
    (_type, o, t) => {
      if ((o.spec.replicas ?? 0) > 0) mark('deploy_scaled', t);
    },
  );
  const wEps = watch(
    `/apis/discovery.k8s.io/v1/namespaces/${NS}/endpointslices?labelSelector=${sel}`,
    epsList.metadata.resourceVersion,
    (_type, o, t) => {
      if (!o.metadata.name.includes('-private')) {
        // Public slice: activator IP in proxy mode; a pod IP once the SKS flips
        // to serve mode (activator leaves the path).
        const ips = (o.endpoints ?? []).flatMap((e) => e.addresses);
        if (pod?.status?.podIP && ips.includes(pod.status.podIP)) mark('public_eps_pod', t);
        return;
      }
      for (const e of o.endpoints ?? []) {
        mark('eps_present', t);
        if (e.conditions?.ready) mark('eps_ready', t);
      }
    },
  );
  await Promise.all([wPods.ready, wDep.ready, wEps.ready]);
  await sleep(200);

  // Client DNS is timed separately so t=0 is "request on the wire".
  const host = `${ARM}.${NS}.svc.cluster.local`;
  const d0 = now();
  const { address } = await dns.lookup(host);
  const client_dns_ms = now() - d0;

  const res = await new Promise((resolve, reject) => {
    const r = { code: 0, size: 0 };
    mark('t0', now());
    const req = http.get(
      { host: address, port: 80, path: '/', headers: { Host: host }, agent: false },
      (resp) => {
        mark('resp_headers', now());
        r.code = resp.statusCode;
        let body = '';
        resp.on('data', (c) => {
          mark('first_byte', now());
          body += c;
        });
        resp.on('end', () => {
          mark('resp_end', now());
          r.size = body.length;
          r.marker = /items:(<!-- -->)?50/.test(body);
          resolve(r);
        });
      },
    );
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });

  await sleep(1500); // let trailing status updates arrive
  stop.done = true;
  const pr = probes ? await probes : [null, null, null, null, null];
  if (pr[0]) T.app_tcp_3000 = pr[0].at;
  if (pr[1]) T.qp_tcp_8012 = pr[1].at;
  if (pr[2]) T.qp_probe_ok = pr[2].at;
  // Same-node poll runs on the agent's clock; re-based below once the offset is known.
  const localAbs = pr[3]?.at ?? null;
  const healed = healP ? await healP : null;
  if (healed?.upgraded) T.heal_exec_running = healed.upgraded;
  if (healed?.closed) T.heal_exec_done = healed.closed;
  const localHttpAbs = pr[4]?.at ?? null;
  wPods.close();
  wDep.close();
  wEps.close();

  const name = pod.metadata.name;
  const fresh = await apiGet(`/api/v1/namespaces/${NS}/pods/${name}`);
  const node = fresh.spec.nodeName;
  const off = await clockOffset(node);
  const o = off ? off.offset_ms : 0;
  const t0 = T.t0;
  const rel = (abs) => (abs == null ? null : Math.round((abs - t0) * 10) / 10);
  const relNode = (abs) => (abs == null ? null : Math.round((abs - o - t0) * 10) / 10); // node clock -> ours

  const cs = Object.fromEntries((fresh.status.containerStatuses ?? []).map((c) => [c.name, c]));
  const status = {
    created: relNode(tsMs(fresh.metadata.creationTimestamp)),
    startedAt_user: relNode(tsMs(cs['user-container']?.state?.running?.startedAt)),
    startedAt_qp: relNode(tsMs(cs['queue-proxy']?.state?.running?.startedAt)),
    conditions: Object.fromEntries(
      (fresh.status.conditions ?? []).map((c) => [c.type, relNode(tsMs(c.lastTransitionTime))]),
    ),
  };

  // Events: core/v1 list, keeping the most precise stamp available.
  const evs = await apiGet(
    `/api/v1/namespaces/${NS}/events?fieldSelector=${encodeURIComponent(`involvedObject.name=${name}`)}`,
  );
  const events = evs.items
    .map((e) => ({
      reason: e.reason,
      src: e.reportingComponent || e.source?.component,
      t: relNode(tsMs(e.eventTime) ?? tsMs(e.firstTimestamp)),
      precise: Boolean(e.eventTime),
      msg: e.message.slice(0, 160),
    }))
    .sort((a, b) => a.t - b.t);

  // CRI-O-stamped log lines (RFC3339Nano, node clock).
  const logs = {};
  for (const c of ['user-container', 'queue-proxy']) {
    try {
      const raw = await apiGet(
        `/api/v1/namespaces/${NS}/pods/${name}/log?container=${c}&timestamps=true&limitBytes=20000`,
        true,
      );
      logs[c] = raw
        .split('\n')
        .filter(Boolean)
        .slice(0, 25)
        .map((l) => {
          const sp = l.indexOf(' ');
          const iso = l.slice(0, sp);
          const ns = iso.match(/\.(\d+)Z$/);
          const base = Date.parse(iso.replace(/\.\d+Z$/, 'Z'));
          const ms = base + (ns ? Number(`0.${ns[1]}`) * 1000 : 0);
          return { t: relNode(ms), line: l.slice(sp + 1, sp + 401) };
        });
    } catch (e) {
      logs[c] = [{ error: String(e).slice(0, 200) }];
    }
  }

  const watchRel = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, rel(v)]));
  watchRel.same_node_tcp_3000 = relNode(localAbs);
  watchRel.same_node_health_ok = relNode(localHttpAbs);
  emit(
    JSON.stringify({
      arm: ARM,
      wall_start: new Date(t0).toISOString(),
      pod: name,
      pod_ip_addr: fresh.status.podIP,
      node,
      clock: off,
      client_dns_ms: Math.round(client_dns_ms * 10) / 10,
      code: res.code,
      marker: res.marker,
      size: res.size,
      heal: healed && (healed.error ? { error: healed.error } : 'ok'),
      probe_attempts: {
        tcp3000: pr[0]?.attempts,
        tcp8012: pr[1]?.attempts,
        qp: pr[2]?.attempts,
        same_node_tcp3000: pr[3]?.attempts,
        same_node_health: pr[4]?.attempts,
      },
      watch: watchRel,
      status,
      events,
      logs,
    }),
  );
}

setTimeout(() => {
  emit(JSON.stringify({ arm: ARM, error: 'harness watchdog: 90 s' }));
  process.exit(2);
}, 90000).unref();

main().catch((e) => {
  emit(JSON.stringify({ arm: ARM, error: String(e?.stack ?? e).slice(0, 500) }));
  process.exit(1);
});
