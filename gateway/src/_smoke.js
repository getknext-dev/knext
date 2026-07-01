'use strict';
// Offline smoke tests: protocol parsing, framing edge cases, driver
// resolution, error responses. No network, no docker. `node _smoke.js`.

const assert = require('assert');
const proto = require('./proto');
const { makeDriver, parseHostPort } = require('./wake');

let n = 0;
function t(name, fn) { fn(); n++; console.log(`ok ${n} - ${name}`); }

t('SSLRequest is classified and 8 bytes long', () => {
  const b = proto.buildSslRequest();
  assert.strictEqual(b.length, 8);
  const f = proto.readInitialPacket(b);
  assert.strictEqual(proto.parseInitialPacket(f.packet).type, 'ssl');
});

t('StartupMessage roundtrips params', () => {
  const b = proto.buildStartup({ user: 'app', database: 'orders', application_name: 'knext' });
  const f = proto.readInitialPacket(b);
  const m = proto.parseInitialPacket(f.packet);
  assert.strictEqual(m.type, 'startup');
  assert.deepStrictEqual(m.params, { user: 'app', database: 'orders', application_name: 'knext' });
});

t('partial packet returns null until complete', () => {
  const b = proto.buildStartup({ user: 'u', database: 'd' });
  assert.strictEqual(proto.readInitialPacket(b.subarray(0, 3)), null);
  assert.strictEqual(proto.readInitialPacket(b.subarray(0, b.length - 1)), null);
  assert.ok(proto.readInitialPacket(b));
});

t('trailing bytes after packet are preserved in rest', () => {
  const b = proto.buildStartup({ user: 'u', database: 'd' });
  const tail = Buffer.from('XX');
  const f = proto.readInitialPacket(Buffer.concat([b, tail]));
  assert.strictEqual(f.rest.toString(), 'XX');
});

t('bogus length is rejected', () => {
  const evil = Buffer.alloc(8);
  evil.writeInt32BE(999999, 0);
  assert.throws(() => proto.readInitialPacket(evil), /bogus/);
});

t('unsupported protocol version is rejected', () => {
  const b = Buffer.alloc(9);
  b.writeInt32BE(9, 0);
  b.writeInt32BE(131072, 4); // protocol 2.0
  assert.throws(() => proto.parseInitialPacket(b), /unsupported protocol 2\.0/);
});

t('CancelRequest is classified', () => {
  const b = Buffer.alloc(16);
  b.writeInt32BE(16, 0);
  b.writeInt32BE(proto.CANCEL_REQUEST_CODE, 4);
  assert.strictEqual(proto.parseInitialPacket(b).type, 'cancel');
});

t('ErrorResponse is well-formed', () => {
  const e = proto.buildErrorResponse('57P03', 'compute unavailable');
  assert.strictEqual(e.toString('utf8', 0, 1), 'E');
  assert.strictEqual(e.readInt32BE(1), e.length - 1);
  assert.ok(e.includes('57P03'));
  assert.ok(e.includes('compute unavailable'));
});

t('parseHostPort handles host, host:port', () => {
  assert.deepStrictEqual(parseHostPort('db', 5432), { host: 'db', port: 5432 });
  assert.deepStrictEqual(parseHostPort('db:6432', 5432), { host: 'db', port: 6432 });
});

t('static driver resolves fixed target, cannot sleep', () => {
  const d = makeDriver({ GW_COMPUTE_MODE: 'static', GW_TARGET: 'pg.local:5433' });
  assert.deepStrictEqual(d.resolve('anything'), { host: 'pg.local', port: 5433, key: 'static' });
  assert.strictEqual(d.canSleep, false);
});

t('exec driver canSleep only with GW_SLEEP_CMD', () => {
  const d1 = makeDriver({ GW_COMPUTE_MODE: 'exec', GW_TARGET: 'x:1', GW_WAKE_CMD: 'true' });
  assert.strictEqual(d1.canSleep, false);
  const d2 = makeDriver({ GW_COMPUTE_MODE: 'exec', GW_TARGET: 'x:1', GW_WAKE_CMD: 'true', GW_SLEEP_CMD: 'true' });
  assert.strictEqual(d2.canSleep, true);
});

t('kubectl driver defaults target to service DNS', () => {
  const d = makeDriver({ GW_COMPUTE_MODE: 'kubectl', GW_K8S_NAMESPACE: 'db', GW_K8S_DEPLOYMENT: 'compute' });
  assert.deepStrictEqual(d.resolve('ignored'), { host: 'compute.db.svc', port: 55432, key: 'db/compute' });
  assert.strictEqual(d.canSleep, true);
});

t('template driver maps database name to per-system target', () => {
  const d = makeDriver({ GW_COMPUTE_MODE: 'template', GW_TARGET_TEMPLATE: 'compute-{system}.db.svc:5432' });
  assert.deepStrictEqual(d.resolve('orders'), { host: 'compute-orders.db.svc', port: 5432, key: 'orders' });
});

t('unknown mode throws', () => {
  assert.throws(() => makeDriver({ GW_COMPUTE_MODE: 'nope' }), /unknown GW_COMPUTE_MODE/);
});

console.log(`\ngateway smoke: ${n} tests passed`);
