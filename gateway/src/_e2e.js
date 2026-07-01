'use strict';
// Offline e2e: full wake-on-connect path against a fake Postgres compute.
//
//   client --(SSLRequest, declined)--> gateway
//   client --(StartupMessage)-------> gateway: compute is DOWN
//   gateway --(exec wake cmd)-------> fake compute starts (~150ms "cold start")
//   gateway replays startup, pipes;  fake compute answers a Query
//   client disconnects; after GW_IDLE_MS the gateway runs the sleep cmd
//   and the fake compute goes back to zero.
//
// No docker, no k8s: wake/sleep are exec-mode shell commands flipping a flag
// file that this script polls to start/stop the fake compute in-process.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const proto = require('./proto');
const { createGateway } = require('./index');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pggw-e2e-'));
const flag = path.join(dir, 'compute-on');
const COMPUTE_PORT = 55599;
const GW_PORT = 55598;

// --- fake compute: minimal PG server: AuthOk + ReadyForQuery, echoes one row.
let computeServer = null;
function startCompute() {
  return new Promise((resolve) => {
    computeServer = net.createServer((sock) => {
      let started = false;
      sock.on('data', (d) => {
        if (!started) {
          started = true; // consumed StartupMessage
          // AuthenticationOk (R,len8,0) + ReadyForQuery (Z,len5,'I')
          sock.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
          return;
        }
        if (d[0] === 0x51) { // Query
          const row = 'it-works';
          const rd = Buffer.concat([
            Buffer.from([0x44, 0, 0, 0, 0, 0, 1]), // DataRow, 1 col (len patched below)
            Buffer.from([0, 0, 0, row.length]), Buffer.from(row),
          ]);
          rd.writeInt32BE(rd.length - 1, 1);
          const cc = Buffer.concat([Buffer.from([0x43, 0, 0, 0, 0]), Buffer.from('SELECT 1\0')]);
          cc.writeInt32BE(cc.length - 1, 1);
          sock.write(Buffer.concat([rd, cc, Buffer.from([0x5a, 0, 0, 0, 5, 0x49])]));
        }
      });
      sock.on('error', () => {});
    });
    computeServer.listen(COMPUTE_PORT, '127.0.0.1', resolve);
  });
}
function stopCompute() {
  return new Promise((resolve) => computeServer ? computeServer.close(() => { computeServer = null; resolve(); }) : resolve());
}
// Poll the flag file: exec wake/sleep commands only touch/rm it.
let starting = false;
const poller = setInterval(async () => {
  const want = fs.existsSync(flag);
  if (want && !computeServer && !starting) {
    starting = true;
    await new Promise((r) => setTimeout(r, 150)); // simulated cold start
    if (fs.existsSync(flag)) await startCompute();
    starting = false;
  }
  if (!want && computeServer && !starting) await stopCompute();
}, 20);

// --- gateway in exec mode
const gw = createGateway({
  GW_COMPUTE_MODE: 'exec',
  GW_TARGET: `127.0.0.1:${COMPUTE_PORT}`,
  GW_WAKE_CMD: `touch ${flag}`,
  GW_SLEEP_CMD: `rm -f ${flag}`,
  GW_IDLE_MS: '400',
  GW_WAKE_TIMEOUT_MS: '5000',
  GW_CONNECT_TIMEOUT_MS: '200',
  GW_RETRY_MS: '50',
}, () => {});

function pgConnect() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(GW_PORT, '127.0.0.1');
    const recv = [];
    sock.on('data', (d) => { recv.push(d); sock.emit('_chunk'); });
    sock.on('error', reject);
    sock.on('connect', () => resolve({ sock, recv }));
  });
}
function waitFor(conn, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const all = Buffer.concat(conn.recv);
      if (pred(all)) return resolve(all);
      if (Date.now() - started > ms) return reject(new Error('timeout waiting for bytes'));
      setTimeout(check, 20);
    };
    check();
  });
}

async function main() {
  await new Promise((r) => gw.server.listen(GW_PORT, '127.0.0.1', r));
  assert.ok(!fs.existsSync(flag), 'compute starts OFF');

  // 1. SSL declined
  const c = await pgConnect();
  c.sock.write(proto.buildSslRequest());
  const ssl = await waitFor(c, (b) => b.length >= 1);
  assert.strictEqual(ssl.toString('utf8', 0, 1), 'N');
  console.log('ok 1 - SSLRequest declined with N');

  // 2. Startup while compute is down -> wake -> AuthenticationOk arrives
  const t0 = Date.now();
  c.sock.write(proto.buildStartup({ user: 'app', database: 'testdb' }));
  await waitFor(c, (b) => b.includes(0x52) && b.includes(0x5a)); // R ... Z
  const wakeMs = Date.now() - t0;
  assert.ok(fs.existsSync(flag), 'wake cmd ran');
  assert.strictEqual(gw.metrics.data.wakes_total, 1);
  console.log(`ok 2 - cold connect woke compute and completed handshake in ${wakeMs}ms`);

  // 3. Query flows through the pipe
  const q = Buffer.concat([Buffer.from([0x51, 0, 0, 0, 0]), Buffer.from('SELECT 1\0')]);
  q.writeInt32BE(q.length - 1, 1);
  const before = Buffer.concat(c.recv).length;
  c.sock.write(q);
  const all = await waitFor(c, (b) => b.length > before && b.includes(Buffer.from('it-works')));
  assert.ok(all.includes(Buffer.from('it-works')));
  console.log('ok 3 - query bytes piped both ways');

  // 4. Second concurrent connection: no second wake
  const c2 = await pgConnect();
  c2.sock.write(proto.buildStartup({ user: 'app', database: 'testdb' }));
  await waitFor(c2, (b) => b.includes(0x5a));
  assert.strictEqual(gw.metrics.data.wakes_total, 1, 'warm connect must not wake');
  assert.strictEqual(gw.metrics.data.active_connections, 2);
  console.log('ok 4 - warm connect reuses running compute (no wake)');

  // 5. Disconnect both -> idle window -> compute scaled to zero
  c.sock.destroy();
  c2.sock.destroy();
  await new Promise((r) => setTimeout(r, 1200)); // > GW_IDLE_MS + poller
  assert.ok(!fs.existsSync(flag), 'sleep cmd ran after idle');
  assert.ok(!computeServer, 'fake compute is down');
  assert.strictEqual(gw.metrics.data.sleeps_total, 1);
  console.log('ok 5 - idle -> scaled to zero');

  // 6. Reconnect wakes it again (the full 0->1->0->1 loop)
  const c3 = await pgConnect();
  c3.sock.write(proto.buildStartup({ user: 'app', database: 'testdb' }));
  await waitFor(c3, (b) => b.includes(0x5a));
  assert.strictEqual(gw.metrics.data.wakes_total, 2);
  console.log('ok 6 - reconnect after zero wakes again');
  c3.sock.destroy();

  console.log('\ngateway e2e: 6 tests passed');
  cleanup(0);
}

function cleanup(code) {
  clearInterval(poller);
  gw.server.close();
  stopCompute().then(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(code);
  });
}

main().catch((e) => { console.error('e2e FAILED:', e); cleanup(1); });
