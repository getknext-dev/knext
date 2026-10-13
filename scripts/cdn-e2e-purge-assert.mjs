#!/usr/bin/env node
/**
 * Purge assertions for the CDN cache-tier kind e2e (ADR-0068 D6/D7, CDN-3b):
 * `revalidateTag` in the app must evict the page at the edge, through the knext
 * `emulator` purge provider, and only that app's page. Same emulator, same
 * conventions and same runner as scripts/cdn-e2e-assert.mjs (every check runs,
 * `ok [id]` / `FAIL [id]` lines, exit 1 if any failed).
 *
 *   node scripts/cdn-e2e-purge-assert.mjs [--only id,id] [--skip id,id]
 *
 * The rollout and revision checks span a redeploy the WORKFLOW performs, so
 * they come in halves that share a state file (CDN_STATE_FILE):
 *   rollout-before    store old-build pages at the edge, record their build
 *   rollout-after     after the new build is Ready: the first-ready purge of the
 *                     app tag arrived, and no pre-rollout entry is served
 *   rollout-no-old-html  ...and no previous-build HTML is stored at or served
 *                     from the edge, whatever the origin answers
 *   rollout-origin-new-html  ...and, once the previous build stopped serving
 *                     and a revalidation settled, the ORIGIN serves the new
 *                     build's HTML (a revalidate = 3600 and a revalidate: false
 *                     page the old build rendered before the rollout)
 *   revisions-before  snapshot every Knative Service's latest revision
 *   revisions-after   after spec.cdn was set on CDN_CHURN_CHANGED: no OTHER app
 *                     (CDN_CHURN_UNRELATED) got a new revision
 *
 * Environment, in addition to scripts/cdn-e2e-assert.mjs's:
 *   CDN_REVALIDATE_TOKEN  Bearer for the fixture's /api/revalidate (from the
 *                         app's Secret; never printed)
 *   CDN_STATE_FILE        state shared by the before/after halves
 *   CDN_PURGE_WAIT_MS     how long to wait for a purge to reach the emulator (20000)
 *   CDN_ORIGIN_SETTLE_MS  how long rollout-origin-new-html waits for the origin
 *                         to serve the new build's HTML (180000: the previous
 *                         build counts as live for up to 90 s after its last
 *                         cache access, plus a re-render)
 *   CDN_CHURN_CHANGED     the app whose CR gets spec.cdn          (cdn-late)
 *   CDN_CHURN_UNRELATED   the apps that must not roll, comma-separated
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config, hit, isHtml, must, runChecks, send, stored } from './cdn-e2e-assert.mjs';

/** The Next tag the fixture's /tagged page carries through unstable_cache. */
export const PAGE_TAG = 'cdn-e2e-page';

const hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
/** `kn-<p>-t<16 hex>` — ADR-0068 D5.2, computed independently of the runtime. */
export const nextTagOf = (prefix, tag) => `kn-${prefix}-t${hex(tag).slice(0, 16)}`;
export const appTagOf = (prefix) => `kn-${prefix}`;

const stampOf = (r) => (/<p id="stamp">([^<]*)<\/p>/.exec(r.text) || [])[1];
const buildMarkOf = (r) => (/<p id="build">([^<]*)<\/p>/.exec(r.text) || [])[1];
const buildTagOf = (r) =>
  String(r.headers['cache-tag'] || '')
    .split(',')
    .find((t) => /^kn-[0-9a-f]{12}-b[0-9a-f]{12}$/.test(t));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The headers that make a response edge-cacheable or purgeable (ADR-0068 D4.2/D5). */
const EDGE_ONLY = ['cloudflare-cdn-cache-control', 'cdn-cache-control', 'cache-tag'];
/** Straight to the origin: the emulator forwards it with no lookup and no store. */
const BYPASS = { 'x-emu-bypass': '1' };
/**
 * The fixture's ISR pages that print their build: `revalidate = 3600` and
 * `revalidate: false`. Both are in the prerender manifest, which is the case
 * where Next would apply the new build's window to the old build's entry.
 */
export const ORIGIN_PAGES = ['/tagged', '/static-mark'];

export function purgeConfig(env = process.env) {
  const c = config(env);
  const np = env.CDN_APP_NP || 'cdn-np';
  return {
    ...c,
    names: { ...c.names, np },
    hosts: { ...c.hosts, np: `${np}.${c.ns}.svc.cluster.local` },
    token: env.CDN_REVALIDATE_TOKEN || '',
    stateFile: env.CDN_STATE_FILE || '/tmp/cdn-e2e-purge-state.json',
    waitMs: Number(env.CDN_PURGE_WAIT_MS || 20000),
    originSettleMs: Number(env.CDN_ORIGIN_SETTLE_MS || 180000),
    churnChanged: env.CDN_CHURN_CHANGED || 'cdn-late',
    churnUnrelated: String(env.CDN_CHURN_UNRELATED || '')
      .split(',')
      .filter(Boolean),
  };
}

async function purgeLog(c) {
  return JSON.parse((await send(c.admin, { path: '/__emu/purges' })).text).purges;
}

/** Wait until a purge at/after `since` carried `tag` and was accepted (200). */
async function waitForPurge(c, tag, since) {
  const until = Date.now() + c.waitMs;
  for (;;) {
    const found = (await purgeLog(c)).find(
      (p) => p.at >= since && p.status === 200 && p.tags.includes(tag),
    );
    if (found || Date.now() > until) return found ?? null;
    await sleep(500);
  }
}

async function revalidate(c, host) {
  const r = await send(c.emu, {
    method: 'POST',
    host,
    path: `/api/revalidate?tag=${PAGE_TAG}`,
    headers: { authorization: `Bearer ${c.token}` },
  });
  must(
    r.status === 200,
    `precondition: /api/revalidate answered ${r.status} (is CDN_REVALIDATE_TOKEN the app's token?)`,
  );
}

/** Store a page at the edge and prove it is a HIT; returns the stored response. */
async function storeHit(c, host, path) {
  const r1 = await send(c.emu, { host, path });
  must(
    r1.status === 200 && isHtml(r1) && stored(r1),
    `precondition: ${host}${path} was not stored at the edge (stored=${stored(r1)}, status=${r1.status})`,
  );
  const r2 = await send(c.emu, { host, path });
  must(hit(r2), `precondition: ${host}${path} was not an edge HIT before the purge`);
  return r1;
}

function readState(c) {
  try {
    return JSON.parse(readFileSync(c.stateFile, 'utf8'));
  } catch {
    return {};
  }
}
function writeState(c, patch) {
  writeFileSync(c.stateFile, `${JSON.stringify({ ...readState(c), ...patch }, null, 2)}\n`);
}

function latestRevisions(ns) {
  const out = execFileSync('kubectl', ['-n', ns, 'get', 'ksvc', '-o', 'json'], {
    encoding: 'utf8',
  });
  return Object.fromEntries(
    JSON.parse(out).items.map((k) => [
      k.metadata.name,
      { revision: k.status?.latestCreatedRevisionName ?? null, generation: k.metadata.generation },
    ]),
  );
}

export function purgeChecks(c) {
  const k = (id) => `k=${id}-${c.run}`;
  const pA = c.prefixes.a;
  return [
    {
      // HIT, then revalidateTag in the app, then a MISS with fresh content.
      id: 'purge-revalidate',
      async run() {
        const path = `/tagged?${k('rv')}`;
        const before = await storeHit(c, c.hosts.a, path);
        const tag = nextTagOf(pA, PAGE_TAG);
        const t0 = Date.now();
        await revalidate(c, c.hosts.a);
        const purge = await waitForPurge(c, tag, t0);
        const after = await send(c.emu, { host: c.hosts.a, path });
        must(
          !hit(after),
          `the edge still served the page after revalidateTag (x-emu-cache=${after.headers['x-emu-cache']}, purge carrying ${tag} seen: ${purge ? 'yes' : 'no'})`,
        );
        must(purge !== null, `no purge carrying the page's tag ${tag} reached the emulator`);
        must(
          stampOf(after) !== undefined && stampOf(after) !== stampOf(before),
          `the MISS after the purge served stale content (stamp ${stampOf(after)} == ${stampOf(before)})`,
        );
        return `HIT -> revalidateTag -> purge of ${tag} (evicted ${purge.evicted}) -> MISS with a fresh render`;
      },
    },
    {
      // Two apps, one zone-wide emulator: A's purge must leave B's entry.
      id: 'purge-isolation',
      async run() {
        const pathB = `/tagged?${k('iso-b')}`;
        const pathA = `/tagged?${k('iso-a')}`;
        await storeHit(c, c.hosts.b, pathB);
        await storeHit(c, c.hosts.a, pathA);
        const t0 = Date.now();
        await revalidate(c, c.hosts.a);
        const purge = await waitForPurge(c, nextTagOf(pA, PAGE_TAG), t0);
        must(purge !== null, `precondition: app A's purge did not reach the emulator`);
        const b = await send(c.emu, { host: c.hosts.b, path: pathB });
        must(
          hit(b),
          `purging app A's tag evicted app B's entry (x-emu-cache=${b.headers['x-emu-cache']})`,
        );
        const a = await send(c.emu, { host: c.hosts.a, path: pathA });
        must(
          !hit(a),
          `app A's own entry survived its purge (x-emu-cache=${a.headers['x-emu-cache']})`,
        );
        return `A purged (${purge.tags.length} tag(s)), B's entry still a HIT`;
      },
    },
    {
      // ADR-0068 D13: a 429 once, then recovery on the purger's retry.
      id: 'purge-429-recovery',
      async run() {
        const path = `/tagged?${k('429')}`;
        await storeHit(c, c.hosts.a, path);
        const status = Number(process.env.CDN_FAIL_STATUS || 429);
        const armed = await send(c.admin, {
          method: 'POST',
          path: `/__emu/fail-next?status=${status}&retryAfter=1`,
        });
        must(
          armed.status === 200,
          `precondition: could not arm the emulator's fail-next (${armed.status})`,
        );
        const t0 = Date.now();
        await revalidate(c, c.hosts.a);
        const purge = await waitForPurge(c, nextTagOf(pA, PAGE_TAG), t0);
        const refused = (await purgeLog(c)).some((p) => p.at >= t0 && p.status === status);
        must(refused, `precondition: the emulator did not refuse a purge with ${status}`);
        const after = await send(c.emu, { host: c.hosts.a, path });
        must(
          purge !== null && !hit(after),
          `the edge still served the page after a refused purge (${status}; recovered: ${purge ? 'yes' : 'no'})`,
        );
        return `${status} once, then the retry purged`;
      },
    },
    {
      id: 'rollout-before',
      async run() {
        const paths = [`/tagged?${k('ro1')}`, `/variant-a?${k('ro2')}`];
        const marks = [];
        let buildTag;
        for (const path of paths) {
          const r = await storeHit(c, c.hosts.a, path);
          marks.push(buildMarkOf(r) ?? null);
          buildTag ??= buildTagOf(r);
        }
        must(buildTag !== undefined, 'precondition: the stored page carries no build tag');
        // The origin half: the old build renders these into the shared Redis
        // (asked twice, so the second answer proves the entry is stored).
        for (const path of ORIGIN_PAGES) {
          for (let attempt = 0; attempt < 2; attempt++) {
            const r = await send(c.emu, { host: c.hosts.a, path, headers: BYPASS });
            must(
              r.status === 200 && isHtml(r) && buildMarkOf(r) === marks[0],
              `precondition: ${path} at the origin answered ${r.status} with build ${buildMarkOf(r) ?? 'none'}, not the old build ${marks[0]}`,
            );
          }
        }
        writeState(c, {
          rollout: { paths, originPaths: ORIGIN_PAGES, mark: marks[0], buildTag, t0: Date.now() },
        });
        return `stored ${paths.length} old-build pages (build tag ${buildTag}, mark ${marks[0]}); ${ORIGIN_PAGES.join(', ')} rendered at the origin`;
      },
    },
    {
      // The ADR-0068 D7 rule, at the edge: after the rollout to a new build,
      // that build's first-ready purge of the app tag reached the emulator, and
      // no entry the edge stored BEFORE the rollout is served from it again.
      id: 'rollout-after',
      async run() {
        const s = readState(c).rollout;
        must(s?.paths, `precondition: no rollout-before state in ${c.stateFile}`);
        const current = buildMarkOf(
          await send(c.emu, {
            host: c.hosts.a,
            path: '/build-mark',
            headers: { 'x-emu-bypass': '1' },
          }),
        );
        must(
          current && current !== s.mark,
          `precondition: the running build is ${current ?? 'unreadable (/build-mark)'}, the stored pages are ${s.mark} (no rollout happened?)`,
        );
        const purge = await waitForPurge(c, appTagOf(pA), s.t0);
        const left = JSON.parse(
          (await send(c.admin, { path: '/__emu/entries' })).text,
        ).entries.filter((e) => e.host === c.hosts.a && e.tags.includes(s.buildTag));
        const fromEdge = [];
        for (const path of s.paths) {
          const r = await send(c.emu, { host: c.hosts.a, path });
          // A HIT on an entry stored BEFORE the rollout (old build tag); a refill
          // since the purge carries the new build tag and is rollout-no-old-html's case.
          if (hit(r) && buildTagOf(r) === s.buildTag) fromEdge.push(path);
        }
        must(
          left.length === 0 && fromEdge.length === 0,
          `pre-rollout HTML was still served from the edge after the rollout (first-ready purge of ${appTagOf(pA)} seen: ${purge ? 'yes' : 'no'}; old-build entries left: ${left.length}; edge HITs on pre-rollout keys: ${fromEdge.join(', ') || 'none'})`,
        );
        must(
          purge !== null,
          `no first-ready purge of the app tag ${appTagOf(pA)} reached the emulator after the rollout`,
        );
        return `build ${s.mark} -> ${current}: first-ready purge of ${appTagOf(pA)} arrived, no pre-rollout entry left at the edge`;
      },
    },
    {
      // The #2261 / ADR-0068 D13 criterion, as amended (Amendment 2): after the
      // first-ready purge, no previous-build HTML is STORED at the edge or
      // served FROM it. An old-build body may still come from the ORIGIN: ISR
      // HTML is shared across builds (ADR-0066), so the new build serves the
      // previous build's page once, as stale, while it re-renders it (and keeps
      // its window while the previous build still counts as live). The edge
      // must refuse it (reason foreign_build_body); rollout-origin-new-html
      // gates the origin. Each page is asked twice, so an entry the first
      // request stored would come back as a HIT.
      id: 'rollout-no-old-html',
      async run() {
        const s = readState(c).rollout;
        must(s?.paths, `precondition: no rollout-before state in ${c.stateFile}`);
        const current = buildMarkOf(
          await send(c.emu, {
            host: c.hosts.a,
            path: '/build-mark',
            headers: { 'x-emu-bypass': '1' },
          }),
        );
        must(
          current && current !== s.mark,
          `precondition: the running build is ${current ?? 'unreadable (/build-mark)'}, the stored pages are ${s.mark} (no rollout happened?)`,
        );
        // Not vacuous: a page the new build renders itself IS edge-cached, so a
        // pass below means "refused", not "the edge stores nothing at all".
        const control = `/variant-b?${k('ro-ctl')}`;
        await send(c.emu, { host: c.hosts.a, path: control });
        const ctl = await send(c.emu, { host: c.hosts.a, path: control });
        must(
          ctl.status === 200 && hit(ctl),
          `precondition: ${control}, rendered by the new build, was not an edge HIT (x-emu-cache=${ctl.headers['x-emu-cache']}, status ${ctl.status}): the edge caches nothing, so this check would prove nothing`,
        );
        const bad = [];
        let fromOrigin = 0;
        for (const path of [s.paths[0], `/tagged?${k('ro-fresh')}`]) {
          for (let attempt = 0; attempt < 2; attempt++) {
            const r = await send(c.emu, { host: c.hosts.a, path });
            const mark = buildMarkOf(r);
            // Only a real page can be old-build HTML: a 5xx, a 404, an error page
            // or the emulator's 502 carries no build mark and is a broken page,
            // which must never pass for (or fail as) old-build HTML.
            must(
              r.status === 200 && isHtml(r) && mark !== undefined,
              `precondition: ${path} answered ${r.status} ${r.headers['content-type']} with no build mark (the page is broken, not old)`,
            );
            if (mark === current) continue;
            fromOrigin++;
            const why = [];
            if (hit(r)) why.push('an edge HIT');
            if (stored(r)) why.push(`stored for ${r.headers['x-emu-stored']} s`);
            for (const h of EDGE_ONLY)
              if (r.headers[h] !== undefined) why.push(`${h}: ${r.headers[h]}`);
            if (why.length > 0)
              bad.push(
                `${path} (build ${mark}, build tag ${buildTagOf(r) ?? 'none'}: ${why.join(', ')})`,
              );
          }
        }
        must(
          bad.length === 0,
          `old-build HTML was stored at or served from the edge after the first-ready purge: ${bad.join('; ')}`,
        );
        return `build ${current}: ${fromOrigin} old-build response(s) from the origin, none edge-cacheable or stored; ${control} (new build) an edge HIT`;
      },
    },
    {
      // The origin half (ADR-0066, Amendment 3): a page the previous build
      // rendered into the shared Redis is served by the new build at most as
      // STALE while it re-renders, so once the previous build has stopped
      // serving and that revalidation settled, the origin answers with the new
      // build's HTML. Before the fix, Next applied the new build's manifest
      // window to the old entry and answered HIT with the old body for an hour
      // (revalidate = 3600), or forever (revalidate: false). Asked straight at
      // the origin (the emulator's bypass), so the edge plays no part. Settled
      // means two new-build answers in a row; the deadline covers the previous
      // build's liveness (90 s after its last cache access) plus a re-render.
      id: 'rollout-origin-new-html',
      async run() {
        const s = readState(c).rollout;
        must(
          Array.isArray(s?.originPaths) && s.originPaths.length > 0,
          `precondition: no rollout-before origin pages in ${c.stateFile}`,
        );
        const current = buildMarkOf(
          await send(c.emu, { host: c.hosts.a, path: '/build-mark', headers: BYPASS }),
        );
        must(
          current && current !== s.mark,
          `precondition: the running build is ${current ?? 'unreadable (/build-mark)'}, the origin pages are ${s.mark} (no rollout happened?)`,
        );
        const until = Date.now() + c.originSettleMs;
        const stuck = [];
        const settled = [];
        let sawOld = false;
        for (const path of s.originPaths) {
          const trail = [];
          let streak = 0;
          for (let n = 0; ; n++) {
            const r = await send(c.emu, {
              host: c.hosts.a,
              path: `${path}?${k(`origin-${n}`)}`,
              headers: BYPASS,
            });
            const mark = buildMarkOf(r);
            // A broken page carries no build mark: never a pass, never the defect.
            must(
              r.status === 200 && isHtml(r) && mark !== undefined,
              `precondition: ${path} at the origin answered ${r.status} ${r.headers['content-type']} with no build mark (the page is broken, not old)`,
            );
            trail.push(
              `${mark === current ? 'new' : mark === s.mark ? 'old' : mark}/${r.headers['x-nextjs-cache'] ?? '-'}`,
            );
            streak = mark === current ? streak + 1 : 0;
            // Past the deadline, a first new answer still gets its confirming
            // second request (bounded: the next answer ends the loop either way).
            if (streak >= 2 || (streak === 0 && Date.now() > until)) break;
            await sleep(streak > 0 ? 200 : 2000);
          }
          if (trail[0].startsWith('old/')) sawOld = true;
          // The first answer, the last few, and how many there were.
          const seen = `${path} [${trail.length} answers, first ${trail[0]}, last ${trail.slice(-3).join(' ')}]`;
          if (streak >= 2) settled.push(seen);
          else stuck.push(seen);
        }
        // Not vacuous: the shared cache really held the old build's pages after
        // the rollout. /static-mark is asked here first, so its first answer is
        // the old build's unless no old entry was shared at all.
        must(
          sawOld,
          `precondition: no origin page answered with the previous build's HTML even once after the rollout (${settled.concat(stuck).join('; ')}): nothing old was shared, so this check would prove nothing`,
        );
        must(
          stuck.length === 0,
          `the origin still served the previous build's HTML after the revalidation settle (${Math.round(c.originSettleMs / 1000)} s): ${stuck.join('; ')}`,
        );
        return `build ${s.mark} -> ${current}: the origin serves the new build's HTML: ${settled.join('; ')}`;
      },
    },
    {
      id: 'revisions-before',
      async run() {
        const revisions = latestRevisions(c.ns);
        writeState(c, { revisions });
        return Object.entries(revisions)
          .map(([name, r]) => `${name}=${r.revision}`)
          .join(' ');
      },
    },
    {
      id: 'revisions-after',
      async run() {
        const before = readState(c).revisions;
        must(before, `precondition: no revisions-before state in ${c.stateFile}`);
        const now = latestRevisions(c.ns);
        must(
          now[c.churnChanged] &&
            before[c.churnChanged] &&
            now[c.churnChanged].revision !== before[c.churnChanged].revision,
          `precondition: setting spec.cdn on ${c.churnChanged} did not roll its own revision (${before[c.churnChanged]?.revision} -> ${now[c.churnChanged]?.revision})`,
        );
        must(c.churnUnrelated.length > 0, 'precondition: CDN_CHURN_UNRELATED is empty');
        const churned = c.churnUnrelated.filter(
          (name) =>
            !before[name] ||
            !now[name] ||
            before[name].revision !== now[name].revision ||
            before[name].generation !== now[name].generation,
        );
        must(
          churned.length === 0,
          `setting spec.cdn on ${c.churnChanged} created a new revision on ${churned
            .map((n) => `${n} (${before[n]?.revision} -> ${now[n]?.revision})`)
            .join(', ')}`,
        );
        return `${c.churnChanged} rolled ${before[c.churnChanged].revision} -> ${now[c.churnChanged].revision}; ${c.churnUnrelated.join(', ')} unchanged`;
      },
    },
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChecks(purgeChecks(purgeConfig()), process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::${err?.stack}`);
      process.exit(2);
    },
  );
}
