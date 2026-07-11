#!/usr/bin/env node
/**
 * smoke-pack-cli.mjs — E1-1 / #68
 *
 * Proves the packed @knext/core artifact installs and exposes a working `kn-next` bin
 * for plain Node (no Bun required — issue #68). Since #68 the bin is bundled, Node-only
 * JS (`dist/cli/kn-next.js`) with a `#!/usr/bin/env node` shebang, so `node <bin>` runs
 * it directly. A Bun leg is kept as an OPTIONAL extra check when bun is on PATH.
 *
 * Steps:
 *   1. `pnpm pack` @knext/lib + @knext/core -> tarballs.
 *   2. Fresh temp dir, `npm init -y`, `npm i <tarballs>`.
 *   3. Run the installed bin's `--help` under NODE. Assert exit 0 and that output
 *      mentions "kn-next" or "Usage".
 *   4. If bun is present, ALSO run `--help` under bun (optional leg; failure there
 *      is reported but does not change the primary node result).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const corePkgDir = join(repoRoot, 'packages', 'kn-next');
const libPkgDir = join(repoRoot, 'packages', 'lib');
const dbPkgDir = join(repoRoot, 'packages', 'db');

const PASS = 'PASS';
const FAIL = 'FAIL';

/** Print a final summary line and exit with the matching code. */
function finish(status, message) {
  const banner = `\n[smoke:cli] ${status}: ${message}`;
  console.log(banner);
  process.exit(status === FAIL ? 1 : 0);
}

function hasBun() {
  const r = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

/**
 * Pack a workspace package with `pnpm pack` (NOT `npm pack`) into `dest` and return
 * the resulting .tgz path. pnpm is required because it rewrites the `workspace:`
 * protocol (@knext/core depends on @knext/lib via `workspace:^`) to a real version —
 * exactly what `changeset publish` does, since the release runs under pnpm. `npm pack`
 * leaves `workspace:^` verbatim, which fails to install with EUNSUPPORTEDPROTOCOL.
 */
function pnpmPack(pkgDir, dest, label) {
  console.log(`[smoke:cli] packing ${label} into ${dest} ...`);
  execFileSync('pnpm', ['pack', '--pack-destination', dest], {
    cwd: pkgDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const tgz = readdirSync(dest)
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => join(dest, f))
    .sort()
    .at(-1);
  if (!tgz || !existsSync(tgz)) {
    finish(FAIL, `pnpm pack produced no .tgz tarball for ${label}`);
  }
  return tgz;
}

let workDir;
let libDest;
let dbDest;
let coreDest;
try {
  // --- 1. pack @knext/lib → @knext/db → @knext/core -------------------------
  // Pack ALL THREE: @knext/core declares `@knext/lib` AND `@knext/db` as (rewritten)
  // versioned deps, and @knext/db declares `@knext/lib` — but nothing is published to
  // npm yet (E1-4 — publish is gated until NPM_TOKEN is set). Installing the tarballs
  // together lets the local deps resolve without hitting npm, so the smoke proves the
  // packed CLI artifact works pre-publish.
  // @knext/lib + @knext/db ship only dist/ — build before packing or the tarball is
  // empty. Order lib → db → core: @knext/db imports @knext/lib types, and @knext/core's
  // build imports both (the `kn-next db migrate` runner lives in @knext/db/migrate, #242).
  console.log('[smoke:cli] building @knext/lib (ships dist/ only) ...');
  execFileSync('pnpm', ['--filter', '@knext/lib', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  console.log('[smoke:cli] building @knext/db (ships dist/ only) ...');
  execFileSync('pnpm', ['--filter', '@knext/db', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // #68: @knext/core now ships a bundled dist/ bin — build it before packing or the
  // tarball has no dist/cli/kn-next.js and the bin symlink is broken.
  console.log('[smoke:cli] building @knext/core (ships dist/ bin) ...');
  execFileSync('pnpm', ['--filter', '@knext/core', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  libDest = mkdtempSync(join(tmpdir(), 'knext-pack-lib-'));
  dbDest = mkdtempSync(join(tmpdir(), 'knext-pack-db-'));
  coreDest = mkdtempSync(join(tmpdir(), 'knext-pack-core-'));
  const libTarball = pnpmPack(libPkgDir, libDest, '@knext/lib');
  const dbTarball = pnpmPack(dbPkgDir, dbDest, '@knext/db');
  const coreTarball = pnpmPack(corePkgDir, coreDest, '@knext/core');
  console.log(`[smoke:cli] core tarball: ${coreTarball}`);
  console.log(`[smoke:cli] db   tarball: ${dbTarball}`);
  console.log(`[smoke:cli] lib  tarball: ${libTarball}`);

  // --- 2. fresh project + install -------------------------------------------
  workDir = mkdtempSync(join(tmpdir(), 'knext-smoke-'));
  console.log(`[smoke:cli] fresh project: ${workDir}`);
  execFileSync('npm', ['init', '-y'], {
    cwd: workDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  console.log('[smoke:cli] installing tarballs (@knext/lib + @knext/db + @knext/core) ...');
  execFileSync('npm', ['install', libTarball, dbTarball, coreTarball], {
    cwd: workDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const binPath = join(workDir, 'node_modules', '.bin', 'kn-next');
  if (!existsSync(binPath)) {
    finish(FAIL, `installed bin not found at ${binPath}`);
  }

  // --- 3. run --help under NODE (primary — #68) -----------------------------
  console.log('[smoke:cli] running `node <bin> --help` ...');
  const run = spawnSync('node', [binPath, '--help'], {
    cwd: workDir,
    encoding: 'utf8',
  });
  const out = `${run.stdout || ''}${run.stderr || ''}`;
  console.log('----- bin output (begin) -----');
  console.log(out.trim());
  console.log('----- bin output (end) -------');

  if (run.status !== 0) {
    finish(
      FAIL,
      `node kn-next --help exited ${run.status} (expected 0). ` +
        "If this is a 'no config'-type error, the --help handler is not wired yet.",
    );
  }

  const mentionsHelp = /kn-next|Usage/i.test(out);
  if (!mentionsHelp) {
    finish(FAIL, "exit 0 but output did not contain 'kn-next' or 'Usage'");
  }

  // --- 4. optional bun leg --------------------------------------------------
  // Bun is no longer required; run it only as a bonus check when present.
  if (hasBun()) {
    console.log('[smoke:cli] (optional) running `bun <bin> --help` ...');
    const bunRun = spawnSync('bun', [binPath, '--help'], {
      cwd: workDir,
      encoding: 'utf8',
    });
    if (bunRun.status !== 0) {
      console.log(
        `[smoke:cli] WARNING: optional bun leg exited ${bunRun.status} (node leg already passed)`,
      );
    } else {
      console.log('[smoke:cli] optional bun leg also passed');
    }
  } else {
    console.log('[smoke:cli] bun not on PATH — skipping optional bun leg');
  }

  finish(PASS, 'packed @knext/core installs and `kn-next --help` works under node');
} catch (err) {
  finish(FAIL, `unexpected error: ${err?.message ? err.message : err}`);
} finally {
  // --- cleanup ---------------------------------------------------------------
  for (const dir of [workDir, libDest, coreDest]) {
    try {
      if (dir && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // best-effort cleanup
    }
  }
}
