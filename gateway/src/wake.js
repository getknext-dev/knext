'use strict';
// Compute wake/sleep drivers. The gateway stays mode-agnostic: every mode
// exposes resolve(systemId) -> {host, port, key}, wake(target), sleep(target).
//
// Modes (GW_COMPUTE_MODE):
//   static   - fixed GW_TARGET host:port; wake/sleep are no-ops (compute always on)
//   exec     - GW_WAKE_CMD / GW_SLEEP_CMD shell commands (docker compose, scripts)
//   template - GW_TARGET_TEMPLATE with {system}; wake/sleep via kubectl scale
//   kubectl  - single deployment GW_K8S_DEPLOYMENT in GW_K8S_NAMESPACE, scaled 0<->1
//
// kubectl-family modes talk to the API server directly when running in-cluster
// (service account token), else shell out to `kubectl`.

const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const net = require('net');

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

function parseHostPort(s, defPort) {
  const i = s.lastIndexOf(':');
  if (i === -1) return { host: s, port: defPort };
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
}

function sh(cmd) {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', cmd], { timeout: 60000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd}: ${stderr || err.message}`)) : resolve(stdout));
  });
}

function inCluster() {
  return fs.existsSync(`${SA_DIR}/token`);
}

// Scale a deployment via the in-cluster API (merge-patch on the scale subresource).
function apiScale(namespace, deployment, replicas) {
  return new Promise((resolve, reject) => {
    const token = fs.readFileSync(`${SA_DIR}/token`, 'utf8');
    const body = JSON.stringify({ spec: { replicas } });
    const req = https.request({
      host: process.env.KUBERNETES_SERVICE_HOST,
      port: process.env.KUBERNETES_SERVICE_PORT || 443,
      path: `/apis/apps/v1/namespaces/${namespace}/deployments/${deployment}/scale`,
      method: 'PATCH',
      ca: fs.readFileSync(`${SA_DIR}/ca.crt`),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/merge-patch+json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => res.statusCode < 300 ? resolve()
        : reject(new Error(`scale ${deployment}=${replicas}: HTTP ${res.statusCode} ${data.slice(0, 200)}`)));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function kubeScale(namespace, deployment, replicas) {
  if (inCluster()) return apiScale(namespace, deployment, replicas);
  return sh(`kubectl -n ${namespace} scale deployment/${deployment} --replicas=${replicas}`);
}

function makeDriver(env = process.env) {
  const mode = env.GW_COMPUTE_MODE || 'static';
  const defPort = Number(env.GW_TARGET_PORT || 55432);
  const ns = env.GW_K8S_NAMESPACE || 'scale-zero-pg';

  if (mode === 'static') {
    const t = parseHostPort(env.GW_TARGET || '127.0.0.1:55432', defPort);
    return {
      mode,
      resolve: () => ({ ...t, key: 'static' }),
      wake: async () => {},
      sleep: async () => {},
      canSleep: false,
    };
  }

  if (mode === 'exec') {
    const t = parseHostPort(env.GW_TARGET || '127.0.0.1:55432', defPort);
    return {
      mode,
      resolve: () => ({ ...t, key: 'exec' }),
      wake: async () => { if (env.GW_WAKE_CMD) await sh(env.GW_WAKE_CMD); },
      sleep: async () => { if (env.GW_SLEEP_CMD) await sh(env.GW_SLEEP_CMD); },
      canSleep: Boolean(env.GW_SLEEP_CMD),
    };
  }

  if (mode === 'kubectl') {
    const deployment = env.GW_K8S_DEPLOYMENT || 'compute';
    const t = parseHostPort(env.GW_TARGET || `${deployment}.${ns}.svc:55432`, defPort);
    return {
      mode,
      resolve: () => ({ ...t, key: `${ns}/${deployment}` }),
      wake: () => kubeScale(ns, deployment, 1),
      sleep: () => kubeScale(ns, deployment, 0),
      canSleep: true,
    };
  }

  if (mode === 'template') {
    // Multi-system mode (parked SCS path): database name -> {system} in the
    // template. Kept because it costs nothing and the e2e exercises it.
    const tpl = env.GW_TARGET_TEMPLATE || `compute-{system}.${ns}.svc:55432`;
    const depTpl = env.GW_K8S_DEPLOYMENT_TEMPLATE || 'compute-{system}';
    return {
      mode,
      resolve: (systemId) => {
        const t = parseHostPort(tpl.replaceAll('{system}', systemId), defPort);
        return { ...t, key: systemId };
      },
      wake: (target) => kubeScale(ns, depTpl.replaceAll('{system}', target.key), 1),
      sleep: (target) => kubeScale(ns, depTpl.replaceAll('{system}', target.key), 0),
      canSleep: true,
    };
  }

  throw new Error(`unknown GW_COMPUTE_MODE=${mode}`);
}

// Try to open a TCP connection; resolve socket or reject.
function tryConnect(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: target.host, port: target.port });
    const t = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(t); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// Connect, waking the compute if needed. Wake is issued once, then we poll.
async function connectWithWake(driver, target, opts, onWake) {
  const connectTimeout = opts.connectTimeoutMs ?? 1000;
  const deadline = Date.now() + (opts.wakeTimeoutMs ?? 30000);
  const retryMs = opts.retryMs ?? 250;
  try {
    return { socket: await tryConnect(target, connectTimeout), woke: false };
  } catch { /* asleep or starting - fall through to wake path */ }
  const wakeStart = Date.now();
  if (onWake) onWake();
  await driver.wake(target);
  for (;;) {
    try {
      const socket = await tryConnect(target, connectTimeout);
      return { socket, woke: true, wakeMs: Date.now() - wakeStart };
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`wake timed out for ${target.key}: ${e.message}`);
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}

module.exports = { makeDriver, connectWithWake, tryConnect, parseHostPort, kubeScale };
