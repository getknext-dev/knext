#!/usr/bin/env node
/**
 * Assertions for the CDN cache-tier kind e2e (ADR-0068 D13, CDN-3a): knext's
 * edge headers, observed through a Vary-ignoring, Cloudflare-shaped cache
 * emulator (packages/kn-next/src/__tests__/fixtures/cdn-emulator) that fronts
 * several apps at once.
 *
 * Shared by .github/workflows/cdn-headers-kind-e2e.yml and a local run against
 * any emulator that can reach the apps:
 *
 *   node scripts/cdn-e2e-assert.mjs [--only id,id] [--skip id,id]
 *   node scripts/cdn-e2e-assert.mjs --probe <app> <METHOD> <path> [name:value ...]
 *
 * Every check runs (one failure does not hide the next), prints `ok [id] …` or
 * `FAIL [id] …`, and the run exits non-zero if any check failed. The FAIL lines
 * are stable strings: the workflow's expected-red steps assert on them, so a
 * mutation is proved to go red at the intended check and not for an unrelated
 * reason. A check whose precondition does not hold (the response shape it
 * exists to exercise never appeared) fails with `precondition:` in its message,
 * never silently passes.
 *
 * "Edge-cached" is observed, not inferred: the emulator stamps a response it
 * stored with `x-emu-stored`, and answers a later request for the same key with
 * `x-emu-cache: HIT`.
 *
 * Environment:
 *   CDN_EMU_URL          the emulator's cache port        (http://127.0.0.1:18080)
 *   CDN_EMU_ADMIN_URL    the emulator's admin port        (http://127.0.0.1:18081)
 *   CDN_NS               the apps' namespace              (cdn-e2e)
 *   CDN_APP_A            spec.cdn, provider emulator      (cdn-a)
 *   CDN_APP_B            spec.cdn + includePaths          (cdn-b)
 *   CDN_APP_OFF          no spec.cdn, this commit's image (cdn-off)
 *   CDN_APP_BASE         no spec.cdn, pre-CDN baseline    (cdn-base)
 *   CDN_PUBLIC_HOST_1/2  the apps' networking.publicHosts (a.example.test / b.example.test)
 *   CDN_RUN_ID           makes every cache key unique to this run (default: now)
 *   CDN_OFF_URL / CDN_BASE_URL  zero-diff compares these pod-direct URLs
 *                        (the user container, no ingress) instead of the emulator path
 *   CDN_PREFIX_A/_B      override the expected tag prefix (default: derived
 *                        exactly as the operator derives it, sha256("<ns>/<name>"))
 */

import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';

export function derivePrefix(ns, name) {
  return createHash('sha256').update(`${ns}/${name}`, 'utf8').digest('hex').slice(0, 12);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * One raw HTTP request. `path` goes on the wire byte for byte (no URL parser
 * normalises it), which the path-canonicalisation cases depend on.
 */
export function send(baseUrl, { method = 'GET', host, path, headers = {}, body }) {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: base.hostname,
        port: base.port,
        method,
        path,
        headers: { ...(host ? { host } : {}), ...headers },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: buf,
            text: buf.toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`timeout ${method} ${path}`)));
    req.end(body);
  });
}

const VOLATILE = new Set([
  'date',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'x-envoy-upstream-service-time',
]);

/**
 * The header block of a response as `name: value` lines, in wire order, with
 * the names lowercased. Only the headers that vary per request regardless of
 * the app (the clock, hop-by-hop framing, the proxy's own timing) are left out.
 */
export function headerLines(rawHeaders) {
  const lines = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (VOLATILE.has(name)) continue;
    lines.push(`${name}: ${rawHeaders[i + 1]}`);
  }
  return lines;
}

/** Differences between two responses: status, header lines (in order), body. */
export function diffResponses(a, b) {
  const out = [];
  if (a.status !== b.status) out.push(`status ${a.status} != ${b.status}`);
  const la = headerLines(a.rawHeaders);
  const lb = headerLines(b.rawHeaders);
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i])
      out.push(
        `header #${i}: ${JSON.stringify(la[i] ?? null)} != ${JSON.stringify(lb[i] ?? null)}`,
      );
  }
  if (sha256(a.body) !== sha256(b.body))
    out.push(`body sha256 ${sha256(a.body).slice(0, 12)} != ${sha256(b.body).slice(0, 12)}`);
  return out;
}

const EDGE_HEADERS = ['cloudflare-cdn-cache-control', 'cdn-cache-control', 'cache-tag'];
const isFlight = (r) => String(r.headers['content-type'] || '').startsWith('text/x-component');
export const isHtml = (r) => String(r.headers['content-type'] || '').startsWith('text/html');
export const stored = (r) => r.headers['x-emu-stored'] !== undefined;
export const hit = (r) => r.headers['x-emu-cache'] === 'HIT';
const edgeDirective = (r) => EDGE_HEADERS.filter((h) => r.headers[h] !== undefined);

export function config(env = process.env) {
  const ns = env.CDN_NS || 'cdn-e2e';
  const names = {
    a: env.CDN_APP_A || 'cdn-a',
    b: env.CDN_APP_B || 'cdn-b',
    off: env.CDN_APP_OFF || 'cdn-off',
    base: env.CDN_APP_BASE || 'cdn-base',
  };
  const host = (n) => `${n}.${ns}.svc.cluster.local`;
  return {
    emu: env.CDN_EMU_URL || 'http://127.0.0.1:18080',
    admin: env.CDN_EMU_ADMIN_URL || 'http://127.0.0.1:18081',
    ns,
    names,
    hosts: { a: host(names.a), b: host(names.b), off: host(names.off), base: host(names.base) },
    prefixes: {
      a: env.CDN_PREFIX_A || derivePrefix(ns, names.a),
      b: env.CDN_PREFIX_B || derivePrefix(ns, names.b),
    },
    publicHosts: [
      env.CDN_PUBLIC_HOST_1 || 'a.example.test',
      env.CDN_PUBLIC_HOST_2 || 'b.example.test',
    ],
    run: env.CDN_RUN_ID || String(Date.now()),
    // Pod-direct base URLs for zero-diff (bypassing Kourier and the queue-proxy).
    direct: { off: env.CDN_OFF_URL || null, base: env.CDN_BASE_URL || null },
  };
}

export class CheckFailure extends Error {}
export const must = (cond, message) => {
  if (!cond) throw new CheckFailure(message);
};

/**
 * "R1 (the shape under test) must not be edge-cached": R1 carries no edge
 * directive and was not stored, and a plain R2 for the same key is not a HIT
 * on R1's body.
 */
async function neverCached(c, _id, what, r1Req, plainReq) {
  const r1 = await send(c.emu, r1Req);
  const r2 = await send(c.emu, plainReq ?? { host: r1Req.host, path: r1Req.path });
  const leaked = stored(r1) || (hit(r2) && sha256(r2.body) === sha256(r1.body));
  must(
    !leaked,
    `${what} was edge-cached (r1 stored=${stored(r1)} directive=[${edgeDirective(r1)}], r2 x-emu-cache=${r2.headers['x-emu-cache']})`,
  );
  must(
    edgeDirective(r1).length === 0,
    `${what} carried an edge directive [${edgeDirective(r1)}] (the emulator did not store it only by luck)`,
  );
  return { r1, r2 };
}

/** The checks, in run order. Each returns a short note or throws CheckFailure. */
export function checks(c) {
  const k = (id) => `k=${id}-${c.run}`;
  return [
    {
      id: 'hit-tagged',
      async run() {
        const req = { host: c.hosts.a, path: `/tagged?${k('hit')}` };
        const r1 = await send(c.emu, req);
        must(
          r1.status === 200 && isHtml(r1),
          `precondition: /tagged answered ${r1.status} ${r1.headers['content-type']}`,
        );
        const r2 = await send(c.emu, req);
        must(
          stored(r1) && hit(r2),
          `the tagged page was not an edge HIT (r1 stored=${stored(r1)}, r2 x-emu-cache=${r2.headers['x-emu-cache']}, directive=[${edgeDirective(r1)}])`,
        );
        must(
          sha256(r1.body) === sha256(r2.body),
          'the tagged page HIT returned a different body than the response stored',
        );
        const tags = String(r1.headers['cache-tag'] || '')
          .split(',')
          .filter(Boolean);
        const own = `kn-${c.prefixes.a}`;
        must(
          tags.length >= 3,
          `the tagged page carries ${tags.length} cache tags, want the app, build and page tags: ${tags.join(',')}`,
        );
        must(
          tags.every((t) => t === own || t.startsWith(`${own}-`)),
          `a Cache-Tag on app A does not carry its operator-derived prefix ${own}: ${tags.join(',')}`,
        );
        must(tags.includes(own), `the app tag ${own} is missing: ${tags.join(',')}`);
        must(
          tags.some((t) => /^kn-[0-9a-f]{12}-b[0-9a-f]{12}$/.test(t)),
          `no build tag: ${tags.join(',')}`,
        );
        must(
          tags.some((t) => /^kn-[0-9a-f]{12}-t[0-9a-f]{16}$/.test(t)),
          `no Next tag: ${tags.join(',')}`,
        );
        return `HIT, ${tags.length} tags under ${own}, edge directive ${r1.headers['cloudflare-cdn-cache-control']}`;
      },
    },
    {
      // D4.3 hard rule: `RSC: 1` without `_rsc`, then a plain request for the
      // same URL, must get the HTML page. Next 16.4 itself answers such a request
      // with a 307 to the `_rsc` URL, so the hazard has two shapes here: a stored
      // flight payload, or a stored redirect, under the HTML key. Both fail.
      id: 'rsc-poisoning',
      async run() {
        const path = `/tagged?${k('rsc')}`;
        const r1 = await send(c.emu, { host: c.hosts.a, path, headers: { rsc: '1' } });
        const redirected =
          r1.status >= 300 && r1.status < 400 && String(r1.headers.location || '').includes('_rsc');
        must(
          isFlight(r1) || redirected,
          `precondition: an RSC request answered ${r1.status} ${r1.headers['content-type']}, neither a flight payload nor a redirect to _rsc`,
        );
        const r2 = await send(c.emu, { host: c.hosts.a, path });
        must(
          r2.status === 200 && isHtml(r2) && /^<!DOCTYPE html>/i.test(r2.text),
          `RSC poisoning: a plain request was not served the HTML page (status=${r2.status}, x-emu-cache=${r2.headers['x-emu-cache']}, content-type=${r2.headers['content-type']})`,
        );
        must(
          !stored(r1),
          `RSC poisoning: the response to RSC: 1 without _rsc was stored under the HTML key (directive=[${edgeDirective(r1)}])`,
        );
        return `RSC request answered ${r1.status} ${isFlight(r1) ? 'flight' : 'redirect'}, not stored; the plain request got HTML`;
      },
    },
    {
      // D4.3 symmetric rule: `_rsc` in the URL WITHOUT `RSC: 1` (a crafted
      // request) must not store HTML under the flight key that a real client
      // navigation then reads. The `_rsc` value is the one Next 16.4 accepts for
      // a request with no router-state headers (an empty `_rsc`).
      id: 'rsc-symmetric',
      async run() {
        const path = `/tagged?${k('sym')}&_rsc`;
        const r1 = await send(c.emu, { host: c.hosts.a, path });
        const r2 = await send(c.emu, { host: c.hosts.a, path, headers: { rsc: '1' } });
        must(
          !(hit(r2) && !isFlight(r2)) && !(stored(r1) && !isFlight(r1)),
          `an RSC navigation was served HTML stored under the _rsc key (r1 ${r1.status} ${r1.headers['content-type']} stored=${stored(r1)}, r2 x-emu-cache=${r2.headers['x-emu-cache']} ${r2.headers['content-type']})`,
        );
        must(
          isFlight(r2),
          `precondition: the RSC navigation answered ${r2.status} ${r2.headers['content-type']}`,
        );
        return `crafted _rsc request answered ${r1.headers['content-type']}, stored=${stored(r1)}; the navigation got flight`;
      },
    },
    {
      // D4.3: with `_rsc` present the flight payload MAY be edge-cached on a
      // row that keys on the query (the emulator row does).
      id: 'rsc-param',
      async run() {
        const path = `/tagged?${k('nav')}&_rsc`;
        const r1 = await send(c.emu, { host: c.hosts.a, path, headers: { rsc: '1' } });
        must(
          isFlight(r1),
          `precondition: an RSC navigation answered ${r1.status} ${r1.headers['content-type']}`,
        );
        const r2 = await send(c.emu, { host: c.hosts.a, path, headers: { rsc: '1' } });
        must(
          stored(r1) && hit(r2) && isFlight(r2),
          `a real RSC request with _rsc was not an edge HIT (r1 stored=${stored(r1)}, r2 x-emu-cache=${r2.headers['x-emu-cache']})`,
        );
        return 'flight under the _rsc key: HIT';
      },
    },
    {
      id: 'never-set-cookie',
      async run() {
        const req = { host: c.hosts.a, path: `/cookie?${k('cookie')}` };
        const { r1 } = await neverCached(
          c,
          'never-set-cookie',
          'a response carrying Set-Cookie',
          req,
        );
        must(
          r1.headers['set-cookie'] !== undefined && r1.status === 200,
          `precondition: /cookie answered ${r1.status} without Set-Cookie`,
        );
        return 'not stored';
      },
    },
    {
      id: 'never-private',
      async run() {
        const req = { host: c.hosts.a, path: `/cc/private?${k('private')}` };
        const { r1 } = await neverCached(
          c,
          'never-private',
          'a response carrying Cache-Control private',
          req,
        );
        must(
          r1.status === 200 && r1.text === 'PRIVATE-BODY',
          `precondition: /cc/private answered ${r1.status} ${r1.text.slice(0, 40)}`,
        );
        return `not stored (cache-control: ${r1.headers['cache-control']})`;
      },
    },
    {
      id: 'never-no-store',
      async run() {
        const req = { host: c.hosts.a, path: `/cc/no-store?${k('nostore')}` };
        const { r1 } = await neverCached(
          c,
          'never-no-store',
          'a response carrying Cache-Control no-store',
          req,
        );
        must(
          r1.status === 200 && r1.text === 'NO-STORE-BODY',
          `precondition: /cc/no-store answered ${r1.status} ${r1.text.slice(0, 40)}`,
        );
        return `not stored (cache-control: ${r1.headers['cache-control']})`;
      },
    },
    {
      id: 'never-authorization',
      async run() {
        const path = `/tagged?${k('auth')}`;
        const { r1 } = await neverCached(
          c,
          'never-authorization',
          'a response to a request with Authorization',
          {
            host: c.hosts.a,
            path,
            headers: { authorization: 'Bearer e2e-not-a-real-token' },
          },
        );
        must(
          r1.status === 200 && isHtml(r1),
          `precondition: /tagged with Authorization answered ${r1.status}`,
        );
        return 'not stored';
      },
    },
    {
      id: 'never-draft-cookie',
      async run() {
        const path = `/tagged?${k('draft')}`;
        const { r1 } = await neverCached(
          c,
          'never-draft-cookie',
          'a response to a request with the draft-mode cookie',
          {
            host: c.hosts.a,
            path,
            headers: { cookie: '__prerender_bypass=e2e-forged' },
          },
        );
        must(
          r1.status === 200 && isHtml(r1),
          `precondition: /tagged with the draft cookie answered ${r1.status}`,
        );
        return 'not stored';
      },
    },
    {
      id: 'never-non-get',
      async run() {
        const path = `/tagged?${k('post')}`;
        const { r1 } = await neverCached(c, 'never-non-get', 'a POST response', {
          method: 'POST',
          host: c.hosts.a,
          path,
          headers: { 'content-type': 'text/plain' },
          body: 'x',
        });
        return `not stored (POST answered ${r1.status})`;
      },
    },
    {
      id: 'never-3xx-vary',
      async run() {
        const [h1, h2] = c.publicHosts;
        const path = `/go?${k('go')}`;
        const r1 = await send(c.emu, {
          host: c.hosts.a,
          path,
          headers: { 'x-forwarded-host': h1 },
        });
        must(
          r1.status >= 300 && r1.status < 400,
          `precondition: /go answered ${r1.status}, not a redirect`,
        );
        const vary = String(r1.headers.vary || '').toLowerCase();
        must(
          /(^|,\s*)(host|x-forwarded-host)(\s*,|$)/.test(vary),
          `precondition: the redirect carries no Vary on Host/X-Forwarded-Host (vary=${vary})`,
        );
        must(
          String(r1.headers.location || '').includes(h1),
          `precondition: the redirect does not point at ${h1}: ${r1.headers.location}`,
        );
        const r2 = await send(c.emu, {
          host: c.hosts.a,
          path,
          headers: { 'x-forwarded-host': h2 },
        });
        must(
          !stored(r1) && !hit(r2),
          `a redirect varying on Host/X-Forwarded-Host was edge-cached (r1 stored=${stored(r1)}, r2 x-emu-cache=${r2.headers['x-emu-cache']} location=${r2.headers.location})`,
        );
        must(
          String(r2.headers.location || '').includes(h2),
          `the second host was sent the first host's redirect: ${r2.headers.location}`,
        );
        return `vary=${vary}; each host got its own Location`;
      },
    },
    {
      // A prerendered redirect is a page entry with tags and `s-maxage`: the
      // 3xx status (D4.1 condition 2) is the only thing keeping it off the edge.
      id: 'never-3xx-static',
      async run() {
        const req = { host: c.hosts.a, path: `/moved?${k('moved')}` };
        const { r1 } = await neverCached(c, 'never-3xx-static', 'a prerendered 3xx', req);
        must(
          r1.status >= 300 && r1.status < 400,
          `precondition: /moved answered ${r1.status}, not a redirect`,
        );
        return `not stored (${r1.status})`;
      },
    },
    {
      id: 'cookie-gated-static',
      async run() {
        const path = `/protected/static?${k('gate')}`;
        const r1 = await send(c.emu, { host: c.hosts.a, path, headers: { cookie: 'session=ok' } });
        must(
          r1.status === 200 && r1.text.includes('PROTECTED-BODY'),
          `precondition: the session request answered ${r1.status}`,
        );
        const r2 = await send(c.emu, { host: c.hosts.a, path });
        must(
          !r2.text.includes('PROTECTED-BODY'),
          `a cookieless request got the protected body from the edge (x-emu-cache=${r2.headers['x-emu-cache']}, r1 stored=${stored(r1)})`,
        );
        return `cookieless request answered ${r2.status} ${r2.headers['x-emu-cache']}`;
      },
    },
    {
      id: 'middleware-cookie-variants',
      async run() {
        const path = `/variant?${k('variant')}`;
        const r1 = await send(c.emu, { host: c.hosts.a, path, headers: { cookie: 'v=a' } });
        must(
          r1.text.includes('VARIANT-A-BODY'),
          `precondition: the v=a request did not get variant A (${r1.status})`,
        );
        const r2 = await send(c.emu, { host: c.hosts.a, path, headers: { cookie: 'v=b' } });
        must(
          !r2.text.includes('VARIANT-A-BODY'),
          `variant B was served variant A's body from the edge (x-emu-cache=${r2.headers['x-emu-cache']})`,
        );
        must(
          r2.text.includes('VARIANT-B-BODY'),
          `the v=b request did not get variant B (${r2.status})`,
        );
        return 'each cookie got its own variant';
      },
    },
    {
      id: 'encoded-path',
      async run() {
        const bad = [];
        for (const p of ['/%70rotected/static', '/protected/%73tatic']) {
          const path = `${p}?${k('enc')}`;
          const r1 = await send(c.emu, {
            host: c.hosts.a,
            path,
            headers: { cookie: 'session=ok' },
          });
          const r2 = await send(c.emu, { host: c.hosts.a, path });
          if (stored(r1) || r2.text.includes('PROTECTED-BODY'))
            bad.push(
              `${p} (r1 ${r1.status} stored=${stored(r1)}, r2 ${r2.headers['x-emu-cache']})`,
            );
        }
        const malformed = await send(c.emu, {
          host: c.hosts.a,
          path: `/tagged/%E0%A4%A?${k('malformed')}`,
        });
        if (stored(malformed)) bad.push('/tagged/%E0%A4%A was stored');
        must(
          bad.length === 0,
          `an encoded path leaked the protected body or was edge-cached: ${bad.join('; ')}`,
        );
        return 'no encoded form was edge-cached';
      },
    },
    {
      id: 'dot-segment',
      async run() {
        const bad = [];
        for (const p of [
          '/x/%2e%2e/protected/static',
          '/x/../protected/static',
          '/./protected/static',
          '/x/%2E%2E/tagged',
          '/./tagged',
        ]) {
          const path = `${p}?${k('dot')}`;
          const r1 = await send(c.emu, {
            host: c.hosts.a,
            path,
            headers: { cookie: 'session=ok' },
          });
          const r2 = await send(c.emu, { host: c.hosts.a, path });
          if (stored(r1) || r2.text.includes('PROTECTED-BODY'))
            bad.push(
              `${p} (r1 ${r1.status} stored=${stored(r1)}, r2 ${r2.headers['x-emu-cache']})`,
            );
        }
        must(
          bad.length === 0,
          `a dot-segment path leaked the protected body or was edge-cached: ${bad.join('; ')}`,
        );
        return 'no dot-segment form was edge-cached';
      },
    },
    {
      id: 'include-paths-opt-out',
      async run() {
        // App B lists /variant in includePaths. That REMOVES the protection, so
        // the wrong variant is expected here: proof the opt-out is real.
        const path = `/variant?${k('optout')}`;
        const r1 = await send(c.emu, { host: c.hosts.b, path, headers: { cookie: 'v=a' } });
        const r2 = await send(c.emu, { host: c.hosts.b, path, headers: { cookie: 'v=b' } });
        must(
          stored(r1) && hit(r2) && r2.text.includes('VARIANT-A-BODY'),
          `includePaths did not opt the middleware-matched path back in (r1 stored=${stored(r1)}, r2 x-emu-cache=${r2.headers['x-emu-cache']})`,
        );
        return 'with includePaths, variant B got variant A from the edge, as documented';
      },
    },
    {
      id: 'two-apps-prefix',
      async run() {
        must(c.prefixes.a !== c.prefixes.b, 'precondition: the two apps derive the same prefix');
        for (const [app, host] of [
          ['a', c.hosts.a],
          ['b', c.hosts.b],
        ]) {
          const req = { host, path: `/tagged?${k(`two-${app}`)}` };
          const r = await send(c.emu, req);
          must(stored(r), `precondition: app ${app.toUpperCase()}'s tagged page was not stored`);
        }
        const res = await send(c.admin, { path: '/__emu/entries' });
        const { entries } = JSON.parse(res.text);
        const problems = [];
        let seen = { a: 0, b: 0 };
        for (const e of entries) {
          const app = e.host === c.hosts.a ? 'a' : e.host === c.hosts.b ? 'b' : null;
          if (!app || e.tags.length === 0) continue;
          seen[app] += 1;
          const own = `kn-${c.prefixes[app]}`;
          const other = `kn-${c.prefixes[app === 'a' ? 'b' : 'a']}`;
          for (const t of e.tags) {
            if (!(t === own || t.startsWith(`${own}-`)))
              problems.push(`${e.key}: ${t} is not under ${own}`);
            if (t === other || t.startsWith(`${other}-`))
              problems.push(`${e.key}: ${t} is app ${app === 'a' ? 'B' : 'A'}'s`);
          }
        }
        must(
          seen.a > 0 && seen.b > 0,
          `precondition: the emulator holds tagged entries for both apps (a=${seen.a}, b=${seen.b})`,
        );
        must(
          problems.length === 0,
          `an app's stored entry carries a tag outside its own prefix: ${problems.slice(0, 5).join('; ')}`,
        );
        seen = `${seen.a} entries under kn-${c.prefixes.a}, ${seen.b} under kn-${c.prefixes.b}`;
        return seen;
      },
    },
    {
      id: 'zero-diff',
      async run() {
        const diffs = [];
        for (const probe of zeroDiffProbes(c)) {
          // Pod-direct when CDN_OFF_URL / CDN_BASE_URL are set (the workflow
          // port-forwards each pod's user container), else through the emulator.
          const via = (url) =>
            url
              ? { base: url, headers: probe.headers }
              : { base: c.emu, headers: { ...probe.headers, 'x-emu-bypass': '1' } };
          const o = via(c.direct.off);
          const b = via(c.direct.base);
          const off = await send(o.base, { ...probe, host: c.hosts.off, headers: o.headers });
          const base = await send(b.base, { ...probe, host: c.hosts.base, headers: b.headers });
          const d = diffResponses(off, base);
          if (d.length) diffs.push(`${probe.method || 'GET'} ${probe.path}: ${d.join(' | ')}`);
          for (const h of EDGE_HEADERS)
            if (off.headers[h] !== undefined)
              diffs.push(`${probe.path}: ${h} present without spec.cdn`);
        }
        must(
          diffs.length === 0,
          `headers without spec.cdn differ from the pre-CDN baseline: ${diffs.slice(0, 6).join(' ;; ')}`,
        );
        return `${zeroDiffProbes(c).length} probes byte-identical (status, header block in order, body)`;
      },
    },
  ];
}

/** Fixed request shapes compared between the no-CDN app and the baseline. */
export function zeroDiffProbes(c) {
  return [
    { path: '/variant-a' },
    { path: '/variant-a', headers: { rsc: '1' } },
    { path: '/variant-a', method: 'HEAD' },
    { path: '/login' },
    { path: '/cookie' },
    { path: '/cc/private' },
    { path: '/cc/no-store' },
    { path: '/protected/static' },
    { path: '/protected/static', headers: { cookie: 'session=ok' } },
    { path: '/variant', headers: { cookie: 'v=b' } },
    { path: '/go', headers: { 'x-forwarded-host': c.publicHosts[1] } },
    { path: '/api/health' },
    { path: '/no-such-page' },
    { path: '/variant-a', method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' },
  ];
}

async function main(argv) {
  const c = config();
  if (argv[0] === '--probe') {
    const [, app, method, path, ...hs] = argv;
    const headers = Object.fromEntries(
      hs.map((h) => [h.slice(0, h.indexOf(':')), h.slice(h.indexOf(':') + 1)]),
    );
    // CDN_PROBE_BODY sends a request body; every header is printed, framing included.
    const body = process.env.CDN_PROBE_BODY;
    const r = await send(c.emu, { host: c.hosts[app] ?? app, method, path, headers, body });
    console.log(r.status);
    for (let i = 0; i < r.rawHeaders.length; i += 2)
      console.log(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
    console.log(`\n${r.text.slice(0, 400)}`);
    return 0;
  }
  return runChecks(checks(c), argv);
}

/**
 * Run `all` (an array of `{ id, run }`) honouring `--only` / `--skip`: every
 * selected check runs, each prints `ok [id] …` or `FAIL [id] …`, and the result
 * is the exit code (1 if any failed, 2 for an unknown id).
 */
export async function runChecks(all, argv) {
  const pick = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1
      ? null
      : new Set(
          String(argv[at + 1] || '')
            .split(',')
            .filter(Boolean),
        );
  };
  const only = pick('--only');
  const skip = pick('--skip') ?? new Set();
  for (const id of [...(only ?? []), ...skip]) {
    if (!all.some((x) => x.id === id)) {
      console.error(`::error::unknown check id ${id}`);
      return 2;
    }
  }
  const failed = [];
  for (const check of all) {
    if ((only && !only.has(check.id)) || skip.has(check.id)) continue;
    try {
      const note = await check.run();
      console.log(`ok [${check.id}] ${note}`);
    } catch (err) {
      failed.push(check.id);
      const message = err instanceof CheckFailure ? err.message : `error: ${err?.stack}`;
      console.log(`FAIL [${check.id}] ${message}`);
      console.log(`::error::FAIL [${check.id}] ${message}`);
    }
  }
  console.log(failed.length ? `failed: ${failed.join(',')}` : 'all checks passed');
  return failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::${err?.stack}`);
      process.exit(2);
    },
  );
}
