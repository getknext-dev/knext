/**
 * A2-2 (#38): bytecode cache REUSE across cold starts — deterministic PR-CI gate.
 *
 * A real scale-to-zero cold-start timing e2e cannot run in standard PR CI (no
 * persistent kind/Knative, RWO-PVC scheduling, timing within noise). This test
 * proves the *mechanism* the scale-to-zero invariant depends on: a second process
 * pointed at the SAME `NODE_COMPILE_CACHE` dir REUSES the bytecode written by the
 * first — it does not recompile.
 *
 * Proof strategy (V8 only writes compile-cache files on a NEW compilation):
 *   1. COLD run: launch the standalone server (stubbed listen, exits after load)
 *      with NODE_COMPILE_CACHE -> a fixed temp dir. Snapshot the set of cache
 *      files (relative path + size + mtimeMs) after warm-up.
 *   2. WARM run: launch a SECOND process against the SAME dir. Assert:
 *      (a) NO new compile-cache files were written AND existing files were not
 *          rewritten (mtime unchanged) => zero writes => cache hit => REUSE.
 *      (b) the app's /api/metrics route reports
 *          `kn_next_bytecode_cache_warm_start{app="..."} 1` on the warm process.
 *
 * SKIP CONDITION (CI-safe): no `.next/standalone/.../server.js` build present.
 * Runs locally / on the build-having job after `next build --webpack`; skips
 * cleanly on PR CI without a build. Lives in the existing vitest job — no CI wiring.
 */
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const APP_DIR = dirname(__filename);
const STANDALONE_SERVER = resolve(APP_DIR, '.next/standalone/apps/file-manager/server.js');
const STANDALONE_CWD = resolve(APP_DIR, '.next/standalone/apps/file-manager');
const CACHE_DIR = join(tmpdir(), 'knext-bytecode-reuse-test');
const APP_NAME = 'file-manager-reuse-test';

const serverExists = existsSync(STANDALONE_SERVER);
const skipReason = serverExists
  ? null
  : 'standalone server.js not found — run `next build --webpack` first';

/** Snapshot of every regular file under a V8 compile-cache dir. */
type CacheSnapshot = Map<string, { size: number; mtimeMs: number }>;

function snapshotCacheDir(dir: string): CacheSnapshot {
  const snap: CacheSnapshot = new Map();
  function walk(d: string) {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isFile()) {
        const st = statSync(full);
        snap.set(relative(dir, full), { size: st.size, mtimeMs: st.mtimeMs });
      } else if (entry.isDirectory() && entry.name !== 'lost+found') {
        walk(full);
      }
    }
  }
  walk(dir);
  return snap;
}

/**
 * Run the standalone server once with NODE_COMPILE_CACHE pointed at CACHE_DIR,
 * scrape the app's own `/api/metrics` route over HTTP on port 3000, then shut
 * the server down. V8 flushes the compile cache on a clean exit.
 *
 * Returns the raw Prometheus exposition text from the route so the caller can
 * assert the real `kn_next_bytecode_cache_warm_start{app}` gauge emitted by
 * `src/app/api/metrics/route.ts` — NOT a re-implementation of it.
 */
function runServerAndScrapeMetrics(): string {
  const out = join(CACHE_DIR, '__metrics_capture.txt');
  const probeFile = join(CACHE_DIR, '__probe.cjs');
  rmSync(out, { force: true });
  // Child script (written to a .cjs file, NOT `node -e`, to avoid shell-quoting
  // and Node 24's eval-as-TypeScript pitfalls): boot server.js, poll
  // GET /api/metrics until 200, write the body to `out`, then exit(0).
  const probe = `
    const http = require('http');
    const fs = require('fs');
    const OUT = ${JSON.stringify(out)};
    const SERVER = ${JSON.stringify(STANDALONE_SERVER)};
    const PORT = 3000;
    let done = false;
    function scrape(attempt) {
      if (done) return;
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/metrics' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            done = true;
            try { fs.writeFileSync(OUT, body); } catch (e) {}
            process.exit(0);
          } else if (attempt < 60) { setTimeout(() => scrape(attempt + 1), 250); }
          else { process.exit(1); }
        });
      });
      req.on('error', () => { if (attempt < 60) setTimeout(() => scrape(attempt + 1), 250); else process.exit(1); });
    }
    process.env.HOSTNAME = '127.0.0.1';
    process.env.PORT = String(PORT);
    setTimeout(() => scrape(0), 250);
    setTimeout(() => process.exit(1), 28000); // hard cap
    try { require(SERVER); } catch (e) { process.exit(1); }
  `;
  writeFileSync(probeFile, probe);
  try {
    execSync(`node ${JSON.stringify(probeFile)}`, {
      env: {
        ...process.env,
        NODE_COMPILE_CACHE: CACHE_DIR,
        NODE_ENV: 'production',
        KN_APP_NAME: APP_NAME,
      },
      timeout: 30000,
      cwd: STANDALONE_CWD,
    });
  } catch {
    // exit(0)/exit(1) from the probe, or boot error — we still read whatever
    // metrics body was captured (empty string if the scrape never landed).
  }
  return existsSync(out) ? readFileSync(out, 'utf8') : '';
}

describe('bytecode cache reuse across cold starts (A2-2 / #38)', () => {
  beforeAll(() => {
    if (serverExists) {
      rmSync(CACHE_DIR, { recursive: true, force: true });
      mkdirSync(CACHE_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    if (serverExists) rmSync(CACHE_DIR, { recursive: true, force: true });
  });

  it('standalone server.js exists after next build', () => {
    if (!serverExists) {
      console.log(`SKIP: ${skipReason}`);
      return;
    }
    expect(existsSync(STANDALONE_SERVER)).toBe(true);
  });

  it.skipIf(skipReason !== null)(
    'cold run populates the cache; warm run REUSES it (no new/rewritten files) and reports warm_start=1',
    () => {
      // --- COLD: first start populates NODE_COMPILE_CACHE ---
      const coldMetrics = runServerAndScrapeMetrics();
      const coldSnap = snapshotCacheDir(CACHE_DIR);
      const coldFiles = [...coldSnap.keys()].filter((k) => !k.startsWith('__'));
      expect(coldFiles.length).toBeGreaterThan(0); // V8 wrote bytecode on cold compile
      // Sanity: the metrics route was reachable on the cold process too.
      expect(coldMetrics).toContain('kn_next_bytecode_cache_warm_start');

      // --- WARM: second start against the SAME dir must REUSE, not recompile ---
      const warmMetrics = runServerAndScrapeMetrics();
      const warmSnap = snapshotCacheDir(CACHE_DIR);

      // (a1) No NEW compile-cache files written on the warm start.
      const newFiles = [...warmSnap.keys()].filter((k) => !k.startsWith('__') && !coldSnap.has(k));
      expect(newFiles).toEqual([]);

      // (a2) Existing cache files were NOT rewritten (mtime + size unchanged).
      //      V8 writes a cache file only on a fresh compile; a stable mtime is
      //      direct evidence the warm process read (reused) the existing entry.
      const rewritten: string[] = [];
      for (const [rel, cold] of coldSnap) {
        if (rel.startsWith('__')) continue;
        const warm = warmSnap.get(rel);
        if (!warm) continue; // disappearance covered by newFiles/superset checks
        if (warm.mtimeMs !== cold.mtimeMs || warm.size !== cold.size) {
          rewritten.push(rel);
        }
      }
      expect(rewritten).toEqual([]);

      // (a3) The warm cache is a superset of the cold cache (nothing dropped).
      for (const rel of coldFiles) {
        expect(warmSnap.has(rel)).toBe(true);
      }

      // (b) Warm-start signal the metrics route ITSELF emits on the warm
      //     process: kn_next_bytecode_cache_warm_start{app="..."} 1.
      //     prom-client formats gauges as `name{labels} <value>` — match the
      //     line for our app and assert the value is exactly 1.
      const warmLine = warmMetrics
        .split('\n')
        .find(
          (l) =>
            l.startsWith('kn_next_bytecode_cache_warm_start{') && l.includes(`app="${APP_NAME}"`),
        );
      expect(warmLine, `warm metrics:\n${warmMetrics}`).toBeDefined();
      expect(warmLine?.trim().endsWith(' 1')).toBe(true);
    },
  );
});
