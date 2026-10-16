#!/usr/bin/env node
// The FFI kind e2e's HTTP driver (ADR-0069 D20): calls the fixture zone's
// Rust-backed Server Actions the way Next's client does — a POST to the page
// with the `Next-Action` header, the action id read from the build's
// `server-reference-manifest.json` (by export name), and the arguments as the
// JSON body — then parses the RSC response for the action's return value.
//
//   node ffi-action-e2e.mjs --url <base> --manifest <server-reference-manifest.json>
//                           [--host <Host header>] [--page /rust-ffi]
//                           [--metrics <the pod's metrics URL>]
//
// Asserts, each a hard failure (exit 1):
//   - GET <page> renders the Rust greeting computed at request time;
//   - greetAction('kind') returns { ok: true, value: 'Hello, kind, from Rust!' };
//   - checkedGreetAction('') returns { ok: false, error: 'RustError',
//     message: 'name must not be empty' };
//   - explodeAction(msg) returns { ok: false, error: 'RustPanicError', message: msg }
//     — the panic was caught inside Rust and the process kept serving;
//   - greetAction again answers correctly after the panic;
//   - with --metrics: pauseAction(SLOW_MS) twice, past the 50 ms default
//     threshold, adds exactly 2 to knext_ffi_slow_calls_total{fn="pause"} on
//     the metrics port, a fast greetAction adds 0, and knext_ffi_load_seconds
//     is served for the library. (That the slow call is logged once is the
//     workflow's assertion: it reads the pod's log.)
// Prints one `KNEXT_FFI_ACTIONS {json}` line. Pod restarts are the workflow's
// assertion (it reads them from the cluster around this run).

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    manifest: { type: 'string' },
    host: { type: 'string' },
    page: { type: 'string', default: '/rust-ffi' },
    metrics: { type: 'string' },
  },
  strict: true,
});
if (!args.url || !args.manifest) {
  console.error(
    'usage: ffi-action-e2e.mjs --url <base> --manifest <path> [--host <h>] [--page <p>] [--metrics <url>]',
  );
  process.exit(2);
}

const failures = [];
const record = {};

function fail(msg) {
  console.error(`ffi-action-e2e: FAIL: ${msg}`);
  failures.push(msg);
}

/** Action id by export name, from the manifest of the build that is deployed. */
function actionIds(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const ids = {};
  for (const [id, entry] of Object.entries(manifest.node ?? {})) {
    if (!String(entry.filename ?? '').endsWith('app/rust-ffi/actions.ts')) continue;
    if (typeof entry.exportedName === 'string') ids[entry.exportedName] = id;
  }
  for (const name of ['greetAction', 'checkedGreetAction', 'explodeAction', 'pauseAction']) {
    if (!ids[name]) {
      console.error(`ffi-action-e2e: FAIL: no ${name} in ${path} (found: ${JSON.stringify(ids)})`);
      process.exit(1);
    }
  }
  return ids;
}

const headers = (extra = {}) => ({
  ...(args.host ? { host: args.host, origin: `http://${args.host}` } : {}),
  ...extra,
});

/** The action's return value: the RSC row holding an object with an `ok` key. */
function actionResult(body) {
  for (const line of body.split('\n')) {
    const m = /^[0-9a-f]+:(.*)$/.exec(line);
    if (!m || !m[1].startsWith('{')) continue;
    try {
      const v = JSON.parse(m[1]);
      if (v && typeof v === 'object' && 'ok' in v) return v;
    } catch {
      // not a JSON row
    }
  }
  return undefined;
}

/**
 * node:http rather than fetch: fetch drops a `Host` header, and the cluster's
 * ingress routes on it.
 */
function request(method, headerMap, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(args.page, args.url),
      { method, headers: headerMap },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('request timeout')));
    req.end(body);
  });
}

async function callAction(id, argsList) {
  const res = await request(
    'POST',
    headers({
      'next-action': id,
      accept: 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
    }),
    JSON.stringify(argsList),
  );
  return { ...res, result: actionResult(res.body) };
}

function expectResult(label, got, want) {
  record[label] = { status: got.status, result: got.result };
  if (got.status !== 200) {
    fail(`${label}: HTTP ${got.status}, want 200\n${got.body.slice(0, 2000)}`);
    return;
  }
  if (got.result === undefined) {
    fail(`${label}: no action result in the response\n${got.body.slice(0, 2000)}`);
    return;
  }
  for (const [k, v] of Object.entries(want)) {
    if (got.result[k] !== v) {
      fail(
        `${label}: ${k} = ${JSON.stringify(got.result[k])}, want ${JSON.stringify(v)} (result ${JSON.stringify(got.result)})`,
      );
    }
  }
}

const ids = actionIds(args.manifest);
record.ids = ids;

// The page renders a Rust call made at request time (a dynamic route).
const page = await request('GET', headers());
const html = page.body;
record.page = page.status;
if (page.status !== 200) fail(`GET ${args.page}: HTTP ${page.status}`);
else if (
  !html.includes('data-knext-ffi-render="ok"') ||
  !html.includes('Hello, page, from Rust!')
) {
  const m = /data-knext-ffi-render="[^"]*">([^<]*)</.exec(html);
  fail(`GET ${args.page}: the request-time Rust call did not render (${m ? m[1] : 'no marker'})`);
}

expectResult('greet', await callAction(ids.greetAction, ['kind']), {
  ok: true,
  value: 'Hello, kind, from Rust!',
});
expectResult('RustError', await callAction(ids.checkedGreetAction, ['']), {
  ok: false,
  error: 'RustError',
  fn: 'checked_greet',
  message: 'name must not be empty',
});
const panicMessage = `panic from the e2e ${Date.now()}`;
expectResult('RustPanicError', await callAction(ids.explodeAction, [panicMessage]), {
  ok: false,
  error: 'RustPanicError',
  fn: 'explode',
  message: panicMessage,
});
expectResult('greet after the panic', await callAction(ids.greetAction, ['again']), {
  ok: true,
  value: 'Hello, again, from Rust!',
});

// A Rust call that blocks past the threshold is counted on the metrics port.
// The library is already loaded (the calls above), so every function is listed.
const SLOW_MS = 120;

/** Slow-call counts by function, and the load gauge's samples, from an exposition. */
function parseFfiMetrics(text) {
  const slow = {};
  for (const m of text.matchAll(/^knext_ffi_slow_calls_total\{fn="([^"]+)"\} (\d+)$/gm)) {
    slow[m[1]] = Number(m[2]);
  }
  const load = [...text.matchAll(/^knext_ffi_load_seconds\{lib="([^"]+)"\} (\S+)$/gm)].map((m) => ({
    lib: m[1],
    seconds: Number(m[2]),
  }));
  return { slow, load };
}

function scrapeMetrics(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          ...parseFfiMetrics(Buffer.concat(chunks).toString('utf8')),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('metrics timeout')));
  });
}

if (args.metrics) {
  const before = await scrapeMetrics(args.metrics);
  expectResult('pause', await callAction(ids.pauseAction, [SLOW_MS]), {
    ok: true,
    value: String(SLOW_MS),
  });
  expectResult('pause again', await callAction(ids.pauseAction, [SLOW_MS]), {
    ok: true,
    value: String(SLOW_MS),
  });
  expectResult('greet (fast)', await callAction(ids.greetAction, ['fast']), {
    ok: true,
    value: 'Hello, fast, from Rust!',
  });
  const after = await scrapeMetrics(args.metrics);
  record.metrics = { before, after };
  if (before.status !== 200 || after.status !== 200) {
    fail(`metrics: HTTP ${before.status} / ${after.status}, want 200`);
  } else if (before.slow.pause === undefined || after.slow.pause === undefined) {
    fail('metrics: no knext_ffi_slow_calls_total{fn="pause"} series on the metrics port');
  } else {
    const added = after.slow.pause - before.slow.pause;
    if (added !== 2) fail(`metrics: the two slow pause() calls added ${added}, want 2`);
    if (after.slow.greet !== before.slow.greet) {
      fail(
        `metrics: the fast greet() call changed its slow count (${before.slow.greet} -> ${after.slow.greet})`,
      );
    }
    if (after.load.length !== 1 || !(after.load[0].seconds > 0)) {
      fail(
        `metrics: want one knext_ffi_load_seconds sample > 0, got ${JSON.stringify(after.load)}`,
      );
    }
  }
}

console.log(`KNEXT_FFI_ACTIONS ${JSON.stringify(record)}`);
if (failures.length > 0) {
  console.error(`ffi-action-e2e: ${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log('ffi-action-e2e: PASS');
