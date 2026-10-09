// Z2 cold-start chain bench. One request at a time, cluster as a queue of one.
//
// Shapes (zone → function):
//   A warm → warm      B warm → cold      C cold → cold
//   D cold → warm      E cold → cold with wake-ahead (zone pre-wakes its bound fn)
//
// Each "cycle" starts with every Knative pod in the namespace gone, then takes
// several samples on DISJOINT (zone, fn) pairs, so one wait-for-zero yields
// several cold samples without any sample seeing another's warm pod:
//   T1 cycle: C(node,fa) A B(node,fb) A  C(bun,fc) A B(bun,fd) A  D(node-d,fa) D(bun-d,fc)
//   T2 cycle: E on all four fns, gateways alternating.
// The fn assignment rotates per cycle so every (gateway, fn) gets every shape
// equally often. Cycle order is [T1, T1, T2] repeated, spreading drift.
//
// Before each sample the precondition is ASSERTED (pod counts) and recorded;
// a violated precondition marks the sample invalid instead of silently counting.
//
// Usage: bun run.ts <out.jsonl> [rounds=14] [c-node-settled]
import { appendFileSync } from 'node:fs';
import { FNS } from './deploy';
import { allKnPods, anyPodCount, curl, podCount, sleep, svcUrl } from './k';

type Fn = (typeof FNS)[number];
type Gw = 'node' | 'bun';
type Shape = 'A' | 'B' | 'C' | 'D' | 'E';

const out = process.argv[2];
const rounds = Number(process.argv[3] ?? 14);
if (!out) throw new Error('usage: bun run.ts <out.jsonl> [rounds]');

// A Connect GET on the NO_SIDE_EFFECTS Ping RPC: answers 200 on both the Go
// and the Rust function, so it can pre-warm either one.
const PING_GET = '/zonefn.v1.PingService/Ping?connect=v1&encoding=json&message=%7B%7D';

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function waitAllZero(timeoutMs = 300_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const live = allKnPods();
    if (live.length === 0) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) throw new Error(`pods never reached zero: ${live.join(',')}`);
    await sleep(2000);
  }
}

function warm(url: string, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = curl(url);
    if (r.code === 200) return r.ms;
  }
  throw new Error(`could not warm ${url}`);
}

function sample(cycle: number, shape: Shape, gw: Gw, zone: string, fn: Fn) {
  // Preconditions per shape.
  if (shape === 'B' || shape === 'A') warm(svcUrl(zone, '/api/health'));
  if (shape === 'D') warm(svcUrl(fn, PING_GET));
  const pre = { zone: podCount(zone), fn: podCount(fn) };
  const wantZoneWarm = shape === 'A' || shape === 'B';
  const wantFnWarm = shape === 'A' || shape === 'D';
  const valid = pre.zone > 0 === wantZoneWarm && pre.fn > 0 === wantFnWarm;

  const r = curl(svcUrl(zone, `/api/chain?fn=${fn}`));
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(r.body);
  } catch {
    body = { raw: r.body.slice(0, 500) };
  }
  const rec = {
    ts: new Date().toISOString(),
    cycle,
    shape,
    gw,
    zone,
    fn,
    lang: fn.includes('rust') ? 'rust' : 'go',
    transport: fn.endsWith('-h2') ? 'h2c' : 'http1',
    e2eMs: Math.round(r.ms * 10) / 10,
    code: r.code,
    pre,
    valid,
    body,
  };
  appendFileSync(out, `${JSON.stringify(rec)}\n`);
  log(
    `c${cycle} ${shape} ${gw} ${fn} e2e=${rec.e2eMs}ms code=${r.code} call=${Math.round(Number(body.callMs ?? NaN))}ms valid=${valid}`,
  );
}

async function t1(cycle: number, k: number) {
  const f = (i: number) => FNS[(k + i) % 4] as Fn;
  const [fa, fb, fc, fd] = [f(0), f(1), f(2), f(3)];
  sample(cycle, 'C', 'node', 'zone-node', fa);
  sample(cycle, 'A', 'node', 'zone-node', fa);
  sample(cycle, 'B', 'node', 'zone-node', fb);
  sample(cycle, 'A', 'node', 'zone-node', fb);
  sample(cycle, 'C', 'bun', 'zone-bun', fc);
  sample(cycle, 'A', 'bun', 'zone-bun', fc);
  sample(cycle, 'B', 'bun', 'zone-bun', fd);
  sample(cycle, 'A', 'bun', 'zone-bun', fd);
  sample(cycle, 'D', 'node', 'zone-node-d', fa);
  sample(cycle, 'D', 'bun', 'zone-bun-d', fc);
}

async function t2(cycle: number, j: number) {
  for (let i = 0; i < 4; i++) {
    const fn = FNS[i] as Fn;
    const gw: Gw = (i + j) % 2 === 0 ? 'node' : 'bun';
    sample(cycle, 'E', gw, `zone-${gw}-wa-${fn.replace('fn-', '')}`, fn);
  }
}

// Supplement (c-node-settled): shape C on zone-node only, each sample taken
// after the zone's previous pod has fully terminated. Added after the main run
// showed every back-to-back-T1 C sample on the Node zone hit the re-wake stall,
// which confounded the Node C cells with transport (see the report).
if (process.argv[4] === 'c-node-settled') {
  for (let r = 0; r < rounds; r++)
    for (const fn of FNS) {
      while (anyPodCount('zone-node') > 0 || anyPodCount(fn) > 0) await sleep(2000);
      sample(1000 + r, 'C', 'node', 'zone-node', fn as Fn);
    }
  log('done');
  process.exit(0);
}

let cycle = 0;
let k1 = 0;
let k2 = 0;
for (let r = 0; r < rounds; r++) {
  for (const kind of ['T1', 'T1', 'T2'] as const) {
    const waited = await waitAllZero();
    log(`cycle ${cycle} ${kind} (waited ${waited} ms for zero)`);
    if (kind === 'T1') await t1(cycle, k1++);
    else await t2(cycle, k2++);
    cycle++;
  }
}
log('done');
