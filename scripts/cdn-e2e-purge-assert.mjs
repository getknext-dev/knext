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
 *                     app tag arrived, and no old-build HTML is served
 *   revisions-before  snapshot every Knative Service's latest revision
 *   revisions-after   after spec.cdn was set on CDN_CHURN_CHANGED: no OTHER app
 *                     (CDN_CHURN_UNRELATED) got a new revision
 *
 * Environment, in addition to scripts/cdn-e2e-assert.mjs's:
 *   CDN_REVALIDATE_TOKEN  Bearer for the fixture's /api/revalidate (from the
 *                         app's Secret; never printed)
 *   CDN_STATE_FILE        state shared by the before/after halves
 *   CDN_PURGE_WAIT_MS     how long to wait for a purge to reach the emulator (20000)
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
        writeState(c, { rollout: { paths, mark: marks[0], buildTag, t0: Date.now() } });
        return `stored ${paths.length} old-build pages (build tag ${buildTag}, mark ${marks[0]})`;
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
          `precondition: the running build is ${current ?? "unreadable (/build-mark)"}, the stored pages are ${s.mark} (no rollout happened?)`,
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
      // The #2261 criterion read literally: after the first-ready purge, no
      // OLD-BUILD HTML is served at all. KNOWN DEFECT #2299: ISR HTML is shared
      // across builds (ADR-0066), so the new build serves the previous build's
      // body as a HIT and the edge stores it under the new build's tag. The
      // workflow runs this as expected-red until #2299 is fixed.
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
          `precondition: the running build is ${current ?? "unreadable (/build-mark)"}, the stored pages are ${s.mark} (no rollout happened?)`,
        );
        const old = [];
        for (const path of [s.paths[0], `/tagged?${k('ro-fresh')}`]) {
          const r = await send(c.emu, { host: c.hosts.a, path });
          const mark = buildMarkOf(r);
          if (mark !== current)
            old.push(
              `${path} (build ${mark}, x-nextjs-cache=${r.headers['x-nextjs-cache']}, edge-stored=${stored(r) || hit(r)})`,
            );
        }
        must(
          old.length === 0,
          `old-build HTML was served after the first-ready purge: ${old.join('; ')}`,
        );
        return `every page served build ${current}`;
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
