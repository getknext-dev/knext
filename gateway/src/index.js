'use strict';
// Wake-on-connect Postgres gateway.
// Accept -> (decline SSL/GSS) -> parse StartupMessage -> resolve compute from
// the database name -> wake it if asleep -> replay startup bytes -> pipe.
// After the handshake the gateway is a dumb byte pipe: auth and queries flow
// through untouched. When the last connection for a compute closes and stays
// closed for GW_IDLE_MS, the compute is scaled back to zero (modes that can).

const net = require('net');
const proto = require('./proto');
const { makeDriver, connectWithWake } = require('./wake');
const { makeMetrics, startMetricsServer } = require('./metrics');

function createGateway(env = process.env, log = console.error) {
  const driver = makeDriver(env);
  const metrics = makeMetrics();
  const opts = {
    connectTimeoutMs: Number(env.GW_CONNECT_TIMEOUT_MS || 1000),
    wakeTimeoutMs: Number(env.GW_WAKE_TIMEOUT_MS || 60000),
    retryMs: Number(env.GW_RETRY_MS || 250),
  };
  const idleMs = Number(env.GW_IDLE_MS || 300000);

  // Idle tracking: per compute key, active conn count + a sleep timer.
  const active = new Map(); // key -> {count, timer, target}
  function connStarted(target) {
    const e = active.get(target.key) || { count: 0, timer: null, target };
    e.count++;
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    active.set(target.key, e);
  }
  function connEnded(target) {
    const e = active.get(target.key);
    if (!e) return;
    e.count--;
    if (e.count <= 0 && driver.canSleep && idleMs > 0) {
      e.timer = setTimeout(() => {
        if (e.count > 0) return; // raced with a new connection
        driver.sleep(target).then(() => {
          metrics.sleep();
          log(`[gw] ${target.key}: idle ${idleMs}ms -> scaled to zero`);
        }).catch((err) => log(`[gw] ${target.key}: sleep failed: ${err.message}`));
      }, idleMs);
      e.timer.unref?.();
    }
  }

  const server = net.createServer((client) => {
    client.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let done = false;

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let framed;
      try {
        framed = proto.readInitialPacket(buf);
      } catch (e) { fail('08P01', e.message); return; }
      if (!framed) return; // wait for more bytes
      let msg;
      try {
        msg = proto.parseInitialPacket(framed.packet);
      } catch (e) { fail('08P01', e.message); return; }

      if (msg.type === 'ssl' || msg.type === 'gssenc') {
        buf = Buffer.from(framed.rest); // keep whatever followed
        client.write('N'); // no TLS gateway-side (terminate TLS in front if needed)
        return;            // client now sends the real StartupMessage
      }
      if (msg.type === 'cancel') { client.destroy(); cleanup(); return; }

      // StartupMessage: stop parsing, go proxy.
      client.off('data', onData);
      done = true;
      const systemId = msg.params.database || 'postgres';
      const target = driver.resolve(systemId);
      proxy(client, framed.packet, Buffer.from(framed.rest), target, msg.params);
    };

    const fail = (code, message) => {
      log(`[gw] startup error: ${message}`);
      try { client.write(proto.buildErrorResponse(code, message)); } catch {}
      client.destroy();
      cleanup();
    };
    const cleanup = () => { client.off('data', onData); done = true; };

    client.on('data', onData);
    client.on('error', () => {});
    client.setTimeout(30000, () => { if (!done) { client.destroy(); cleanup(); } });
  });

  async function proxy(client, startupPacket, pendingRest, target, params) {
    connStarted(target);
    metrics.connOpen(target.key);
    let backend;
    try {
      const r = await connectWithWake(driver, target, opts,
        () => log(`[gw] ${target.key}: compute asleep, waking (db=${params.database} user=${params.user})`));
      backend = r.socket;
      if (r.woke) {
        metrics.wake(target.key, r.wakeMs);
        log(`[gw] ${target.key}: awake in ${r.wakeMs}ms`);
      }
    } catch (e) {
      metrics.wakeFailure();
      metrics.connClose(target.key);
      connEnded(target);
      log(`[gw] ${target.key}: ${e.message}`);
      try { client.write(proto.buildErrorResponse('57P03', `compute unavailable: ${e.message}`)); } catch {}
      client.destroy();
      return;
    }

    backend.setNoDelay(true);
    backend.write(startupPacket);
    if (pendingRest.length) backend.write(pendingRest);
    client.pipe(backend);
    backend.pipe(client);

    let closed = false;
    const onClose = () => {
      if (closed) return;
      closed = true;
      metrics.connClose(target.key);
      connEnded(target);
      client.destroy();
      backend.destroy();
    };
    client.on('close', onClose);
    backend.on('close', onClose);
    client.on('error', onClose);
    backend.on('error', onClose);
  }

  return { server, metrics, driver, _active: active };
}

if (require.main === module) {
  const env = process.env;
  const port = Number(env.GW_PORT || 55432);
  const metricsPort = Number(env.GW_METRICS_PORT || 9090);
  const gw = createGateway();
  gw.server.listen(port, '0.0.0.0', () =>
    console.error(`[gw] listening on :${port} mode=${gw.driver.mode} idle_ms=${env.GW_IDLE_MS || 300000}`));
  startMetricsServer(gw.metrics, metricsPort);
  console.error(`[gw] metrics on :${metricsPort}/metrics`);
  process.on('SIGTERM', () => { gw.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}

module.exports = { createGateway };
