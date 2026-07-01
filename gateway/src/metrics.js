'use strict';
// Minimal metrics: JSON on /metrics.json, Prometheus text on /metrics,
// liveness on /healthz. Stdlib http only.

const http = require('http');

function makeMetrics() {
  const m = {
    connections_total: 0,
    active_connections: 0,
    wakes_total: 0,
    wake_failures_total: 0,
    sleeps_total: 0,
    wake_latency_ms_last: 0,
    wake_latency_ms: [], // last 100 samples
    per_system: {},      // key -> {connections, active, wakes, last_wake_ms}
  };

  const sys = (key) => (m.per_system[key] ??= { connections: 0, active: 0, wakes: 0, last_wake_ms: 0 });

  return {
    data: m,
    connOpen(key) { m.connections_total++; m.active_connections++; const s = sys(key); s.connections++; s.active++; },
    connClose(key) { m.active_connections--; sys(key).active--; },
    wake(key, ms) {
      m.wakes_total++; m.wake_latency_ms_last = ms;
      m.wake_latency_ms.push(ms);
      if (m.wake_latency_ms.length > 100) m.wake_latency_ms.shift();
      const s = sys(key); s.wakes++; s.last_wake_ms = ms;
    },
    wakeFailure() { m.wake_failures_total++; },
    sleep() { m.sleeps_total++; },
  };
}

function promText(m) {
  const lines = [
    `pggw_connections_total ${m.connections_total}`,
    `pggw_active_connections ${m.active_connections}`,
    `pggw_wakes_total ${m.wakes_total}`,
    `pggw_wake_failures_total ${m.wake_failures_total}`,
    `pggw_sleeps_total ${m.sleeps_total}`,
    `pggw_wake_latency_ms_last ${m.wake_latency_ms_last}`,
  ];
  for (const [k, s] of Object.entries(m.per_system)) {
    lines.push(`pggw_system_active_connections{system="${k}"} ${s.active}`);
    lines.push(`pggw_system_wakes_total{system="${k}"} ${s.wakes}`);
    lines.push(`pggw_system_last_wake_ms{system="${k}"} ${s.last_wake_ms}`);
  }
  return lines.join('\n') + '\n';
}

function startMetricsServer(metrics, port, host = '0.0.0.0') {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); res.end('ok\n'); return; }
    if (req.url === '/metrics.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(metrics.data, null, 2));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(promText(metrics.data));
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(port, host);
  return server;
}

module.exports = { makeMetrics, startMetricsServer, promText };
