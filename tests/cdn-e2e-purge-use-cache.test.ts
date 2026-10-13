import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * #2302: a page whose ONLY tag comes from a `'use cache'` function is edge-cached
 * WITH that tag, so `revalidateTag` purges it (ADR-0068 D5.1, which relies on
 * Next copying a `'use cache'` function's tags into the page entry's
 * `x-next-cache-tags`). The proof runs on kind
 * (.github/workflows/cdn-purge-kind-e2e.yml, check `purge-use-cache`); these
 * tests keep its pieces honest where a PR can see them:
 *
 * - the fixture's page really takes its tag from `'use cache'` alone (no fetch,
 *   no `unstable_cache`), or the kind check would pass by another route;
 * - the check itself, against a fake emulator: a tagged page passes, and an
 *   untagged one, a missing purge and a stale refill each fail at the check's
 *   own message, while a page that never reached the edge is a precondition;
 * - the red leg's mutation (`--set use-cache-tags`) removes exactly the Next
 *   behaviour under test, its anchor occurs exactly once in the pinned Next, and
 *   it never writes through a hardlink into a shared install cache;
 * - the workflow wires the green leg and the red leg.
 */
const ROOT = resolve(import.meta.dir, '..');
const PURGE_ASSERT = join(ROOT, 'scripts/cdn-e2e-purge-assert.mjs');
const MUTATE = join(ROOT, 'scripts/cdn-e2e-mutate-preload.mjs');
const WORKFLOW = join(ROOT, '.github/workflows/cdn-purge-kind-e2e.yml');
const FIXTURE = join(ROOT, 'packages/kn-next/src/__tests__/fixtures/cdn-use-cache-kind-app');
const RED_SPEC = 'scripts/cdn-e2e-red/purge-use-cache-untagged.txt';
const TAGS_MODULE = join(ROOT, 'packages/kn-next/src/adapters/cdn-purge/tags.js');
/** Next's two copies of the 'use cache' wrapper (CJS and ESM), relative to the package. */
const WRAPPERS = [
  'dist/server/use-cache/use-cache-wrapper.js',
  'dist/esm/server/use-cache/use-cache-wrapper.js',
];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("the 'use cache' fixture (cdn-use-cache-kind-app)", () => {
  it("is a Cache Components app whose /uc-tagged page takes its only tag from 'use cache'", async () => {
    const { UC_TAG, UC_PATH } = await import(PURGE_ASSERT);
    const config = readFileSync(join(FIXTURE, 'next.config.mjs'), 'utf8');
    expect(config).toContain('cacheComponents: true');
    expect(config).toContain('cacheHandler:');
    expect(config).toContain('adapterPath:');
    const page = readFileSync(join(FIXTURE, `app${UC_PATH}/page.tsx`), 'utf8');
    expect(page).toContain('"use cache";');
    expect(page).toContain(`cacheTag("${UC_TAG}");`);
    // No other route to a page tag: neither unstable_cache nor a fetch.
    for (const f of filesUnder(join(FIXTURE, 'app'))) {
      // Code only: the page's comment names what it does NOT use.
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect({ f: relative(FIXTURE, f), unstable: src.includes('unstable_cache') }).toEqual({
        f: relative(FIXTURE, f),
        unstable: false,
      });
      expect({ f: relative(FIXTURE, f), fetch: /\bfetch\s*\(/.test(src) }).toEqual({
        f: relative(FIXTURE, f),
        fetch: false,
      });
    }
  });

  it('its revalidate route is Bearer-authenticated, fail-closed, and allows exactly the page tag', async () => {
    const { UC_TAG } = await import(PURGE_ASSERT);
    const route = readFileSync(join(FIXTURE, 'app/api/revalidate/route.ts'), 'utf8');
    expect(route).toContain(`const TAGS = new Set(["${UC_TAG}"]);`);
    expect(route).toContain('if (!expected || !header?.startsWith("Bearer ")) return false;');
    expect(route).toContain('timingSafeEqual');
  });

  it('pins the same Next as the CDN fixture the lane already builds', () => {
    const pin = (dir: string) =>
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.next;
    const cdnApp = join(ROOT, 'packages/kn-next/src/__tests__/fixtures/cdn-kind-app');
    expect(pin(FIXTURE)).toBe(pin(cdnApp));
  });
});

/**
 * `purge-use-cache` against a fake emulator (cache port and admin port on one
 * server). It stores a page with the Cache-Tag the mode gives it, serves it as
 * a HIT until a purge carrying one of its tags evicts it, and records purges
 * the way the real emulator does.
 */
describe('purge-use-cache: the check sees a page the purge cannot reach', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-uc-check-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  type Mode =
    | 'tagged'
    | 'untagged'
    | 'no-purge'
    | 'expired'
    | 'stale'
    | 'not-stored'
    | 'no-app-tag'
    | 'deny';

  async function runAgainst(mode: Mode) {
    const tagsMod = await import(TAGS_MODULE);
    const { derivePrefix } = await import(join(ROOT, 'scripts/cdn-e2e-assert.mjs'));
    const { UC_TAG } = await import(PURGE_ASSERT);
    const p = derivePrefix('cdn-e2e', 'cdn-uc');
    const ucTag = tagsMod.nextTag(p, UC_TAG);
    const headerTags = [
      tagsMod.appTag(p),
      `kn-${p}-b0123456789ab`,
      tagsMod.nextTag(p, '_N_T_/uc-tagged'),
      ...(mode === 'untagged' ? [] : [ucTag]),
    ];
    const purges: Array<{ at: number; status: number; tags: string[]; evicted: number }> = [];
    const store = new Map<string, { tags: string[]; stamp: string }>();
    let renders = 0;
    const html = (stamp: string) => `<!DOCTYPE html><main><p id="stamp">${stamp}</p></main>`;
    const server = createServer((req, res) => {
      const url = String(req.url);
      if (url === '/__emu/purges') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ purges }));
      }
      if (url.startsWith('/api/revalidate')) {
        if (mode === 'deny') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"error":"Unauthorized"}');
        }
        const tag = new URL(url, 'http://x').searchParams.get('tag') ?? '';
        // The entry leaves the edge (say its TTL ran out) with no purge sent.
        if (mode === 'expired') store.clear();
        else if (mode !== 'no-purge') {
          const t = tagsMod.nextTag(p, tag);
          let evicted = 0;
          for (const [key, e] of store) {
            if (e.tags.includes(t)) {
              store.delete(key);
              evicted++;
            }
          }
          purges.push({ at: Date.now(), status: 200, tags: [t], evicted });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      }
      if (url.startsWith('/uc-tagged')) {
        const entry = store.get(url);
        if (entry) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-tag': entry.tags.join(','),
            'x-emu-cache': 'HIT',
          });
          return res.end(html(entry.stamp));
        }
        renders++;
        const stamp = mode === 'stale' ? 'stamp-1' : `stamp-${renders}`;
        const tags = mode === 'no-app-tag' ? [] : headerTags;
        if (mode !== 'not-stored') store.set(url, { tags, stamp });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          ...(tags.length > 0 ? { 'cache-tag': tags.join(',') } : {}),
          'x-emu-cache': 'MISS',
          ...(mode === 'not-stored' ? {} : { 'x-emu-stored': '3600' }),
        });
        return res.end(html(stamp));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as { port: number }).port;
      const { purgeChecks, purgeConfig } = await import(PURGE_ASSERT);
      const c = purgeConfig({
        CDN_EMU_URL: `http://127.0.0.1:${port}`,
        CDN_EMU_ADMIN_URL: `http://127.0.0.1:${port}`,
        CDN_REVALIDATE_TOKEN: 'unit-token',
        CDN_PURGE_WAIT_MS: '600',
        CDN_STATE_FILE: join(dir, `state-${port}.json`),
      });
      const check = purgeChecks(c).find((x: { id: string }) => x.id === 'purge-use-cache');
      expect(check).toBeDefined();
      try {
        return { ok: true, note: String(await check.run()), ucTag };
      } catch (err) {
        return { ok: false, note: String((err as Error).message), ucTag };
      }
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  }

  it("a page whose Cache-Tag carries the 'use cache' tag hash is purged and re-rendered: pass", async () => {
    const r = await runAgainst('tagged');
    expect(r.ok).toBe(true);
    expect(r.note).toContain(r.ucTag);
    expect(r.note).toContain('MISS with a fresh render');
  });

  it("the 'use cache' tag missing from the edge entry (the #2302 defect) is the failure", async () => {
    const r = await runAgainst('untagged');
    expect(r.ok).toBe(false);
    expect(r.note.startsWith('precondition')).toBe(false);
    expect(r.note).toContain("the 'use cache' tag did not make the page purgeable at the edge");
    expect(r.note).toContain(`the edge HIT's Cache-Tag lacks ${r.ucTag}`);
    expect(r.note).toContain('the edge still served the page after revalidateTag');
  });

  it('a tagged page that no purge reaches is the failure too', async () => {
    const r = await runAgainst('no-purge');
    expect(r.ok).toBe(false);
    expect(r.note.startsWith('precondition')).toBe(false);
    expect(r.note).toContain('the edge still served the page after revalidateTag');
    expect(r.note).not.toContain('Cache-Tag lacks');
  });

  it('a MISS that no purge caused (the entry merely left the edge) is the failure', async () => {
    const r = await runAgainst('expired');
    expect(r.ok).toBe(false);
    expect(r.note).toBe(`no purge carrying the 'use cache' tag ${r.ucTag} reached the emulator`);
  });

  it('a MISS after the purge that serves the old stamp is the failure', async () => {
    const r = await runAgainst('stale');
    expect(r.ok).toBe(false);
    expect(r.note.startsWith("the MISS after the 'use cache' purge served stale content")).toBe(
      true,
    );
  });

  it('a page the edge never stored, or stored untagged, or a refused revalidate is a precondition, never the defect', async () => {
    for (const mode of ['not-stored', 'no-app-tag', 'deny'] as const) {
      const r = await runAgainst(mode);
      expect({ mode, ok: r.ok }).toEqual({ mode, ok: false });
      expect({ mode, pre: r.note.startsWith('precondition:') }).toEqual({ mode, pre: true });
    }
  });
});

/**
 * The red leg rebuilds the fixture against a Next whose 'use cache' wrapper no
 * longer copies a function's tags into the enclosing page entry
 * (`propagateCacheLifeAndTagsToRevalidateStore`), cache life still propagated,
 * so the page is still an ISR page with its `_N_T_` tags. That is precisely the
 * case ADR-0068 D5.1 assumes away.
 */
describe("use-cache-tags mutation (Next's tag propagation, scripts/cdn-e2e-mutate-preload.mjs)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-uc-mutate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // The workspace's Next, which must be the version the fixture pins.
  const nextPkg = createRequire(join(ROOT, 'packages/kn-next/package.json')).resolve(
    'next/package.json',
  );
  const nextDir = resolve(nextPkg, '..');

  it('the workspace resolves the Next version the fixture pins, so the anchor test reads the real target', () => {
    const pinned = JSON.parse(readFileSync(join(FIXTURE, 'package.json'), 'utf8')).dependencies
      .next;
    expect(JSON.parse(readFileSync(nextPkg, 'utf8')).version).toBe(pinned);
  });

  it('the anchor occurs exactly once in both copies of the wrapper, inside the propagation function', async () => {
    const { USE_CACHE_TAGS_MUTATIONS } = await import(MUTATE);
    expect(USE_CACHE_TAGS_MUTATIONS.length).toBe(1);
    const [, anchor, replacement] = USE_CACHE_TAGS_MUTATIONS[0];
    for (const rel of WRAPPERS) {
      const src = readFileSync(join(nextDir, rel), 'utf8');
      expect({ rel, count: src.split(anchor).length - 1 }).toEqual({ rel, count: 1 });
      const fn = src.indexOf('function propagateCacheLifeAndTagsToRevalidateStore(');
      const next = src.indexOf('\nfunction ', fn + 1);
      expect({
        rel,
        inside: fn >= 0 && src.indexOf(anchor) > fn && src.indexOf(anchor) < next,
      }).toEqual({ rel, inside: true });
      // Only the tags: the cache-life propagation in the same function stays.
      expect(replacement.includes('push')).toBe(false);
    }
  });

  it('the CLI mutates a real copy of each wrapper once, keeps it parseable, and refuses a second time', () => {
    for (const rel of WRAPPERS) {
      // The same tree shape, so the ESM copy is checked as a module.
      const copy = join(dir, 'next', rel);
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, readFileSync(join(nextDir, rel)));
      const once = spawnSync(process.execPath, [MUTATE, '--set', 'use-cache-tags', copy], {
        encoding: 'utf8',
      });
      expect({ rel, status: once.status, err: once.stderr }).toEqual({ rel, status: 0, err: '' });
      const out = readFileSync(copy, 'utf8');
      expect(out.includes('outerTags.push(tag);')).toBe(false);
      expect(out.startsWith('/* KNEXT_E2E_MUTATED:')).toBe(true);
      const twice = spawnSync(process.execPath, [MUTATE, '--set', 'use-cache-tags', copy], {
        encoding: 'utf8',
      });
      expect(twice.status).toBe(1);
      expect(twice.stderr).toContain('already mutated');
    }
  });

  it('never writes through a hardlink: a sibling link (a shared install cache) keeps the original bytes', () => {
    const sub = join(dir, 'hardlink');
    mkdirSync(sub, { recursive: true });
    const cache = join(sub, 'cache-copy.js');
    const installed = join(sub, 'installed.js');
    const original = readFileSync(join(nextDir, WRAPPERS[0]), 'utf8');
    writeFileSync(cache, original);
    linkSync(cache, installed);
    expect(statSync(installed).ino).toBe(statSync(cache).ino);
    const r = spawnSync(process.execPath, [MUTATE, '--set', 'use-cache-tags', installed], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(readFileSync(installed, 'utf8')).not.toBe(original);
    expect(readFileSync(cache, 'utf8')).toBe(original);
  });
});

describe('the purge kind lane wires the use-cache check (cdn-purge-kind-e2e.yml)', () => {
  const wf = readFileSync(WORKFLOW, 'utf8');

  it('is path-filtered on the new fixture', () => {
    expect(wf).toContain("- 'packages/kn-next/src/__tests__/fixtures/cdn-use-cache-kind-app/**'");
  });

  it('stages the fixture with copied (never hardlinked) dependencies and pins its Next', () => {
    expect(wf).toContain('cp -R packages/kn-next/src/__tests__/fixtures/cdn-use-cache-kind-app');
    expect(wf).toContain('bun install --backend=copyfile');
  });

  it("mutates both copies of Next's wrapper for cdn-uc-mut only, and restores them", () => {
    for (const rel of WRAPPERS) {
      expect(wf).toContain(`"$UC_APP_DIR/node_modules/next/${rel}"`);
    }
    expect(wf).toContain('cdn-e2e-mutate-preload.mjs" --set use-cache-tags "$w"');
    const mutateAt = wf.indexOf('--set use-cache-tags');
    const green = wf.indexOf('"$WRITE_CONFIG" cdn-uc purge');
    const red = wf.indexOf('"$WRITE_CONFIG" cdn-uc-mut purge');
    expect(green).toBeGreaterThan(0);
    expect(green).toBeLessThan(mutateAt);
    expect(red).toBeGreaterThan(mutateAt);
    expect(wf.indexOf('cp "$RUNNER_TEMP/wrapper.orig.$i.js" "$w"')).toBeGreaterThan(red);
  });

  it("removes both 'use cache' apps after their check, before the churn and rollout steps need the node's room", () => {
    const red = wf.indexOf('CDN_APP_UC=cdn-uc-mut bash scripts/cdn-e2e-expect-red.sh');
    const removed = wf.indexOf(
      'kubectl -n "$APP_NS" delete nextapp cdn-uc cdn-uc-mut --wait=true --timeout=180s',
    );
    const churn = wf.indexOf('- name: Assert no revision churn on unrelated apps');
    expect(red).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(red);
    expect(churn).toBeGreaterThan(removed);
  });

  it('runs the green check on cdn-uc and the red leg on cdn-uc-mut through the helper', () => {
    expect(wf).toContain('node scripts/cdn-e2e-purge-assert.mjs --only purge-use-cache\n');
    expect(wf).toContain(
      `CDN_APP_UC=cdn-uc-mut bash scripts/cdn-e2e-expect-red.sh use-cache-untagged ${RED_SPEC} -- \\`,
    );
  });
});
