// @vitest-environment node
/**
 * Self-contained standalone executable e2e (#1456): file-manager, compiled with
 * `--self-contained`, serves every route its manifests list from a directory
 * holding ONLY the binary, `public/` and `.next/static/` — judged against the
 * disk-mode executable compiled from the same build, route by route.
 *
 * Needs `next build` output (`.next/standalone`) in this app — webpack
 * (`next build --webpack`) or turbopack (`next build`); the builder is whatever
 * produced it. Skips (does not fail) only when that build is absent: file-manager's
 * default build is vinext, which has no standalone tree.
 *
 * Postgres-backed routes answer 500 without a database in BOTH arms; set
 * DATABASE_URL to a reachable Postgres with an `audit_logs` table to see them
 * serve 200. Equality with disk mode is the assertion either way.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boot,
  firstStaticAsset,
  isServed,
  measureArm,
  type RouteResult,
  routesFromManifests,
  stageDisk,
  stageSelfContained,
  stop,
} from './e2e-support/self-contained-empty-dir.mjs';

const APP = dirname(fileURLToPath(import.meta.url));
const NEXT_DIR = join(APP, '.next');
const SERVER = join(NEXT_DIR, 'standalone', 'apps', 'file-manager', 'server.js');
const COMPILE = resolve(APP, '../../packages/kn-next/src/adapters/standalone-compile.mjs');
const HAVE_BUILD = existsSync(SERVER) && existsSync(join(NEXT_DIR, 'static'));

// LANE-BACKED (#1456 round 2): the `self-contained-exec-e2e` ci.yml job builds
// file-manager's `.next/standalone` tree on BOTH builders (webpack and
// turbopack) and sets KNEXT_REQUIRE_SC_EXEC=1, so a missing build there FAILS
// this lane rather than skipping silently (the #932 defect class). Off the
// flag — a local checkout with no `next build` output — the case still skips.
const REQUIRE_SC_EXEC = process.env.KNEXT_REQUIRE_SC_EXEC === '1';
const skipReason = HAVE_BUILD ? null : `no standalone build found at ${SERVER}`;
if (REQUIRE_SC_EXEC && skipReason !== null) {
  throw new Error(`KNEXT_REQUIRE_SC_EXEC=1 but ${skipReason}`);
}

const statusOf = (r: RouteResult | undefined) => (r && 'status' in r ? r.status : undefined);

const cleanup: string[] = [];
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

function compile(outfile: string, selfContained: boolean): string {
  const r = spawnSync(
    'bun',
    [
      'run',
      COMPILE,
      '--server',
      SERVER,
      '--root',
      join(NEXT_DIR, 'standalone'),
      '--outfile',
      outfile,
      ...(selfContained ? ['--self-contained', '1'] : []),
    ],
    { encoding: 'utf8', timeout: 600_000 },
  );
  if (r.status !== 0) throw new Error(`compile failed (exit ${r.status}):\n${r.stdout}${r.stderr}`);
  return `${r.stdout}`;
}

describe.skipIf(skipReason !== null)(
  'file-manager self-contained executable from an empty dir',
  () => {
    it('serves every manifest route with the same status as disk mode, and .next/static from disk', async () => {
      const out = mkdtempSync(join(tmpdir(), 'knext-sc-e2e-'));
      cleanup.push(out);
      const log = compile(join(out, 'sc'), true);
      expect(log).toMatch(
        /self-contained: embedded \d+ module\(s\) .* route chunk\(s\) bytecode-verified/,
      );
      compile(join(out, 'disk'), false);

      const routes = routesFromManifests(NEXT_DIR);
      const staticAsset = firstStaticAsset(NEXT_DIR);
      expect(routes.length).toBeGreaterThan(10);
      expect(staticAsset).toBeDefined();

      const env: Record<string, string> = process.env.DATABASE_URL
        ? { DATABASE_URL: process.env.DATABASE_URL }
        : {};
      const publicDir = join(APP, 'public');
      const a = stageDisk({ nextDir: NEXT_DIR, binary: join(out, 'disk'), publicDir });
      const b = stageSelfContained({ nextDir: NEXT_DIR, binary: join(out, 'sc'), publicDir });
      cleanup.push(a.dir, b.dir);

      // The empty dir holds only what the self-contained image ships.
      expect(
        spawnSync('ls', ['-A', b.dir], { encoding: 'utf8' }).stdout.trim().split('\n').sort(),
      ).toEqual(['.next', 'app', 'public']);

      const A = await measureArm(a, { routes, staticAsset, runs: 1, env });
      const B = await measureArm(b, { routes, staticAsset, runs: 1, env });

      const mismatches = Object.keys(A.served).filter(
        (k) => statusOf(A.served[k]) !== statusOf(B.served[k]),
      );
      expect(mismatches).toEqual([]);
      expect(statusOf(B.served[staticAsset as string])).toBe(200);
      // Every route disk mode serves, the self-contained binary serves.
      const servedA = Object.keys(A.served).filter((k) => isServed(A.served[k]));
      expect(servedA.filter((k) => !isServed(B.served[k]))).toEqual([]);
      expect(servedA.length).toBeGreaterThan(routes.length / 2);

      // The request-body cap is COMPILED INTO the executable (standalone-compile
      // embeds the preload — the binary takes no `--require`). Boot the
      // self-contained binary with a small cap and prove the 413 behaviourally:
      // a source scan of the preload list cannot tell whether the embed runs.
      const capped = await boot(b.exec, { env: { ...env, KNEXT_MAX_REQUEST_BYTES: '4096' } });
      try {
        expect(capped.output()).toContain('REQUEST_BYTE_CAP:4096 (env)');
        const post = (bytes: number) =>
          fetch(`http://127.0.0.1:${capped.port}/api/health`, {
            method: 'POST',
            body: 'x'.repeat(bytes),
            signal: AbortSignal.timeout(20_000),
          });
        expect((await post(4097)).status).toBe(413);
        expect((await post(100)).status).not.toBe(413);
      } finally {
        await stop(capped.child);
      }

      // The reference app's REAL upload path under the DEFAULT cap (no env).
      // file-manager uploads through the `uploadFile` Server Action (multipart,
      // buffered in-app, then put to object storage), so Next's own 1 MB
      // `serverActions.bodySizeLimit` binds long before knext's 8 MiB: a
      // realistic 900 KB file must REACH the action with its file intact, a
      // 2 MB one is refused by Next (not knext), and only a body over 8 MiB
      // gets knext's 413.
      const refs = JSON.parse(
        readFileSync(join(NEXT_DIR, 'server', 'server-reference-manifest.json'), 'utf8'),
      ) as { node: Record<string, { exportedName?: string; filename?: string }> };
      const uploadAction = Object.entries(refs.node).find(
        (
          [, v], // webpack records `app/actions.ts`, turbopack the workspace-relative
        ) =>
          // `apps/file-manager/src/app/actions.ts` — match the path suffix.
          v.exportedName === 'uploadFile' && /(^|\/)app\/actions\.ts$/.test(v.filename ?? ''),
      )?.[0];
      expect(uploadAction).toBeDefined();
      const plain = await boot(b.exec, { env });
      try {
        expect(plain.output()).toContain('REQUEST_BYTE_CAP:8388608 (default)');
        const upload = async (bytes: number) => {
          // The React Server Actions reply encoding a browser sends for
          // `uploadFile(formData)`: root `0` = ["$K1"], FormData fields `_1_<name>`.
          const fd = new FormData();
          fd.append(
            '_1_file',
            new File([new Uint8Array(bytes)], 'photo.jpg', { type: 'image/jpeg' }),
          );
          fd.append('0', '["$K1"]');
          const r = await fetch(`http://127.0.0.1:${plain.port}/`, {
            method: 'POST',
            body: fd,
            headers: { 'Next-Action': uploadAction as string, Accept: 'text/x-component' },
            signal: AbortSignal.timeout(30_000),
          });
          return { status: r.status, text: await r.text() };
        };
        const ok = await upload(900 * 1024);
        expect(ok.status).toBe(200);
        // The action ran AND saw the file (without a database it then reports
        // a storage/DB failure, which is the action's own answer, not a cap).
        expect(ok.text).not.toContain('No file provided');
        expect(ok.text).toContain('"error":"Failed to upload file"');
        // #1777 round 3: `"Failed to upload file"` is ALSO what the outer
        // catch reports when `db.query` fails with no real Postgres — it
        // cannot distinguish that from `require('minio')` itself failing to
        // resolve in this standalone build (the webpack-standalone defect
        // this round fixes: `getMinioClient()`'s error is swallowed by
        // `actions.ts`'s own inner catch before the outer one ever runs).
        // `actions.ts` logs a DISTINCT, greppable marker only on a
        // module-resolution failure (`code === 'MODULE_NOT_FOUND'`), never on
        // an ordinary storage/network error (expected here — no live MinIO
        // target) — so asserting its ABSENCE is the unambiguous proof that
        // the minio SDK loaded, independent of whether storage is reachable.
        expect(plain.output()).not.toContain('[minio-sdk-load-failed]');
        // Over Next's 1 MB action limit: Next refuses it, knext does not.
        expect((await upload(2 * 1024 * 1024)).status).not.toBe(413);
        // Over knext's default cap: 413 before Next sees it.
        expect((await upload(9 * 1024 * 1024)).status).toBe(413);
      } finally {
        await stop(plain.child);
      }
    }, 900_000);
  },
);
