// @vitest-environment node
//
// #1460 — file-manager's SELF-CONTAINED vinext binary serves every
// measurement route from an EMPTY directory: the binary is copied alone into a
// fresh directory, that directory is the cwd, and nothing else is there — no
// `.output/public`, no `native/`, no `node_modules`.
//
// Also pins the lazy sharp contract end to end: boot and `/api/health` leave
// the native temp dir untouched; the first image request unpacks it; with an
// unwritable temp dir, image requests answer 500 while everything else serves.
//
// Needs a built binary: `bun scripts/build-self-contained.mjs` prints its path;
// pass it as KNEXT_SC_EXEC. Without one this SKIPS — unless
// KNEXT_REQUIRE_SC_EXEC=1, which turns the skip into a failure (CI).

import { afterAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePorts } from './e2e-support/child-ports';

const EXEC = process.env.KNEXT_SC_EXEC ?? '';
const skipReason =
  EXEC && existsSync(EXEC) ? null : `no self-contained binary at KNEXT_SC_EXEC='${EXEC}'`;
if (skipReason && process.env.KNEXT_REQUIRE_SC_EXEC === '1') {
  throw new Error(
    `KNEXT_REQUIRE_SC_EXEC=1 but ${skipReason} — run scripts/build-self-contained.mjs`,
  );
}

/** The 13 measurement routes (ADR-0060) plus a second image probe; status as served without a database. */
const ROUTES: [string, number][] = [
  ['/', 200],
  ['/dashboard', 200],
  ['/api/health', 200],
  ['/knext-smoke/isr', 200],
  ['/knext-smoke/stream', 200],
  ['/file.svg', 200],
  ['/_next/image?url=%2Fknext-smoke.png&w=64&q=75', 200],
  ['/does-not-exist-404', 404],
  ['/users', 200],
  ['/observability/web-vitals', 401],
  ['/audit', 200],
  ['/cache', 200],
  ['/setup', 200],
  ['/_next/image?url=%2Fknext-optimize-fixture.png&w=64&q=75', 200],
];
const IMAGE = '/_next/image?url=%2Fknext-smoke.png&w=64&q=75';

const temps: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of temps) {
    try {
      chmodSync(d, 0o755);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});
function temp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}

/** Copy ONLY the binary into an empty dir, boot it there, wait for /api/health. */
async function bootAlone(
  nativeTmp: string,
): Promise<{ base: string; dir: string; log: () => string }> {
  const dir = temp('knext-1460-fm-empty-');
  const bin = join(dir, 'server');
  cpSync(EXEC, bin);
  const [port, metrics] = await freePorts(2);
  let log = '';
  const child = spawn(bin, [], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      PORT: String(port),
      METRICS_PORT: String(metrics),
      HOSTNAME: '127.0.0.1',
      KNEXT_NATIVE_TMPDIR: nativeTmp,
    },
  });
  children.push(child);
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try {
      const r = await fetch(`${base}/api/health`);
      await r.arrayBuffer();
      if (r.status === 200) return { base, dir, log: () => log };
    } catch {}
    await Bun.sleep(25);
  }
  throw new Error(`self-contained binary never answered /api/health:\n${log.slice(-2000)}`);
}

describe.skipIf(skipReason !== null)(
  '#1460 file-manager self-contained binary, from an empty directory',
  () => {
    it('serves every measurement route and every asset / references; sharp unpacks only on the first image', async () => {
      const nt = temp('knext-1460-fm-nt-');
      const { base, dir, log } = await bootAlone(nt);
      // Boot + /api/health (and the eager warm of it) must not have unpacked sharp.
      expect(readdirSync(nt)).toEqual([]);

      const got: [string, number][] = [];
      for (const [route] of ROUTES) {
        const r = await fetch(base + route, { headers: { accept: 'image/avif,image/webp,*/*' } });
        await r.arrayBuffer();
        got.push([route, r.status]);
      }
      expect(got).toEqual(ROUTES);

      const img = await fetch(base + IMAGE, { headers: { accept: 'image/avif' } });
      expect(img.headers.get('content-type')).toMatch(/^image\/(avif|webp)$/);
      expect(readdirSync(nt)).toHaveLength(1);

      const html = await (await fetch(`${base}/`)).text();
      const assets = [
        ...new Set(html.match(/\/_next\/static\/[^"'\s)]+\.(?:js|css|woff2)/g) ?? []),
      ];
      expect(assets.length).toBeGreaterThan(0);
      const bad: string[] = [];
      for (const a of assets) {
        const r = await fetch(base + a);
        const b = await r.arrayBuffer();
        if (r.status !== 200 || b.byteLength === 0) bad.push(`${r.status} ${a}`);
      }
      expect(bad).toEqual([]);

      expect(readdirSync(dir)).toEqual(['server']);
      expect(log()).not.toContain('knext bun-exec:');
    }, 120_000);

    it('an unwritable temp dir fails ONLY image optimization — health and static assets keep serving', async () => {
      const nt = temp('knext-1460-fm-ro-');
      chmodSync(nt, 0o555);
      const { base, log } = await bootAlone(nt);
      for (const _ of [1, 2]) {
        const r = await fetch(base + IMAGE, { signal: AbortSignal.timeout(20_000) });
        await r.arrayBuffer();
        expect(r.status).toBe(500);
      }
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
      expect((await fetch(`${base}/file.svg`)).status).toBe(200);
      expect(log()).toContain("could not unpack sharp's native libraries");
    }, 120_000);
  },
);
