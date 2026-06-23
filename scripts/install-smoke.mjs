#!/usr/bin/env node
/**
 * install-smoke.mjs — PK2 / #115
 *
 * The OUTSIDE-CONSUMER gate. Proves knext works for a user on a fresh machine with
 * plain Node + npm, NO pnpm workspace, NO Bun — exercising BOTH ways a consumer uses
 * knext: (a) the `kn-next` CLI bin, and (b) `import`ing the public app surface
 * (`@knext/core/adapter`, otel-config, cache-handler, the `KnativeNextConfig` type;
 * `@knext/lib/clients`, `@knext/lib/health`, `@knext/lib/logger`). PK1/#114 declared
 * these exports; PK5/#116 froze the public set. This job CATCHES regressions in either
 * (a raw-`.ts` export, a missing dist file, a broken bin) BEFORE the first publish.
 *
 * Why the install is plain `npm` but the PACK uses `pnpm`:
 *   - @knext/core depends on @knext/lib via `workspace:^` (package.json). `npm pack`
 *     leaves that verbatim, which fails to install (EUNSUPPORTEDPROTOCOL). `pnpm pack`
 *     REWRITES `workspace:^` to a real version range — EXACTLY what `changeset publish`
 *     does (release.yml runs under pnpm). So we pack the way we publish, then install +
 *     run the way a CONSUMER would: plain `npm install`, plain `node`, outside the repo.
 *   - Nothing is published to npm yet, so the rewritten `@knext/lib` dep is satisfied by
 *     installing BOTH tarballs together in the fresh consumer dir.
 *
 * Steps:
 *   1. Build (lib then core — core's build/types need lib's dist) and `pnpm pack` both.
 *   2. Fresh temp dir OUTSIDE the workspace. `npm init -y`, `npm install <both tarballs>`.
 *   3. CLI checks:  `node <bin> --help` (exit 0 + expected output) AND drive the config
 *      `validate` path via the public-ish `./internal/cli-validate` export — a VALID
 *      fixture passes and an INVALID one is rejected. The bin is also confirmed present.
 *   4. App-import probe: a child ESM script (install-smoke-probe.mjs) imports every
 *      PUBLIC subpath on plain Node and asserts each resolves to real `.js` (no `.ts`)
 *      with its expected named export. The probe exits non-zero on ANY failure — that
 *      is the guard that fails this job if a public subpath breaks.
 *   5. Exports-completeness: assert EVERY `exports` subpath + the `bin` in each packed
 *      package.json resolves under the clean install.
 *   6. Negative guard: a now-removed bare path (`@knext/core/cli/shared`) must NOT
 *      resolve — proves the export map is actually being enforced.
 *
 * This script is committed so it is locally runnable: `node scripts/install-smoke.mjs`.
 * The install-smoke.yml workflow just calls it (with no bun on PATH).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const corePkgDir = join(repoRoot, 'packages', 'kn-next');
const libPkgDir = join(repoRoot, 'packages', 'lib');
const probeSrc = join(__dirname, 'install-smoke-probe.mjs');

const PASS = 'PASS';
const FAIL = 'FAIL';

let workDir;
let libDest;
let coreDest;

/** Print a final summary line, clean up temp dirs, and exit with the matching code. */
function finish(status, message) {
  console.log(`\n[install-smoke] ${status}: ${message}`);
  for (const dir of [workDir, libDest, coreDest]) {
    try {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  process.exit(status === FAIL ? 1 : 0);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

/**
 * Pack a workspace package with `pnpm pack` into `dest`. pnpm is required (not npm)
 * because @knext/core depends on @knext/lib via `workspace:^`; pnpm rewrites that to a
 * real version (what `changeset publish` does), while `npm pack` leaves it verbatim and
 * the install fails with EUNSUPPORTEDPROTOCOL.
 */
function pnpmPack(pkgDir, dest, label) {
  console.log(`[install-smoke] packing ${label} -> ${dest}`);
  execFileSync('pnpm', ['pack', '--pack-destination', dest], {
    cwd: pkgDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const tgz = readdirSync(dest)
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => join(dest, f))
    .sort()
    .at(-1);
  if (!tgz || !existsSync(tgz)) finish(FAIL, `pnpm pack produced no .tgz for ${label}`);
  return tgz;
}

/** Read the `exports` subpaths + `bin` targets from a workspace package.json. */
function publishedEntrypoints(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const name = pkg.name;
  const subpaths = Object.keys(pkg.exports ?? { '.': true }).map((sub) =>
    sub === '.' ? name : `${name}/${sub.replace(/^\.\//, '')}`,
  );
  const bins = Object.keys(pkg.bin ?? {});
  return { name, subpaths, bins };
}

try {
  // --- 1. build (lib then core) + pack both ---------------------------------
  // @knext/lib ships dist/ only — build before packing or the tarball is empty.
  // @knext/core's build (and its .d.ts) import @knext/lib types, so lib must be first.
  console.log('[install-smoke] building @knext/lib then @knext/core ...');
  execFileSync('pnpm', ['--filter', '@knext/lib', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  execFileSync('pnpm', ['--filter', '@knext/core', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  libDest = mkdtempSync(join(tmpdir(), 'knext-pack-lib-'));
  coreDest = mkdtempSync(join(tmpdir(), 'knext-pack-core-'));
  const libTarball = pnpmPack(libPkgDir, libDest, '@knext/lib');
  const coreTarball = pnpmPack(corePkgDir, coreDest, '@knext/core');

  // --- 2. fresh consumer project OUTSIDE the workspace + install -------------
  // tmpdir() is outside repoRoot, so there is no pnpm workspace / node_modules to leak
  // into resolution. We install with plain `npm` exactly as an outside consumer would.
  workDir = mkdtempSync(join(tmpdir(), 'knext-install-smoke-'));
  console.log(`[install-smoke] fresh consumer dir (outside workspace): ${workDir}`);
  if (workDir.startsWith(repoRoot)) {
    finish(FAIL, `consumer dir ${workDir} is inside the repo — not a clean install`);
  }
  execFileSync('npm', ['init', '-y'], {
    cwd: workDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // ESM probe + fixture config need "type":"module" — set it explicitly.
  const consumerPkgPath = join(workDir, 'package.json');
  const consumerPkg = JSON.parse(readFileSync(consumerPkgPath, 'utf8'));
  consumerPkg.type = 'module';
  writeFileSync(consumerPkgPath, `${JSON.stringify(consumerPkg, null, 2)}\n`);

  console.log('[install-smoke] npm install <lib.tgz> <core.tgz> (plain npm, no bun) ...');
  const install = run('npm', ['install', '--no-audit', '--no-fund', libTarball, coreTarball], {
    cwd: workDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (install.status !== 0) finish(FAIL, `npm install of tarballs exited ${install.status}`);

  // --- 3a. CLI: bin present + `--help` runs under plain node ----------------
  const binPath = join(workDir, 'node_modules', '.bin', 'kn-next');
  if (!existsSync(binPath)) finish(FAIL, `installed bin not found at ${binPath}`);

  console.log('[install-smoke] running `node <bin> --help` ...');
  const help = run('node', [binPath, '--help'], { cwd: workDir });
  const helpOut = `${help.stdout || ''}${help.stderr || ''}`;
  console.log('----- kn-next --help (begin) -----');
  console.log(helpOut.trim());
  console.log('----- kn-next --help (end) -------');
  if (help.status !== 0) finish(FAIL, `kn-next --help exited ${help.status} (expected 0)`);
  if (!/kn-next|Usage|Options/i.test(helpOut)) {
    finish(FAIL, "kn-next --help: exit 0 but output lacked 'kn-next'/'Usage'/'Options'");
  }

  // --- 3b. CLI: exercise the config `validate` path (zero-exit assertion) ----
  // The deploy bin's validate path needs a built Next app + cluster, so it cannot give
  // a clean zero-exit here. Instead drive the SAME validateConfig() the bin uses via the
  // ./internal/cli-validate export against a fixture config: VALID passes, INVALID is
  // rejected. This proves validation is wired and runs on plain Node.
  console.log('[install-smoke] exercising config validate path ...');
  const validate = run(
    'node',
    [
      '--input-type=module',
      '-e',
      [
        "import { validateConfig } from '@knext/core/internal/cli-validate';",
        "validateConfig({ name:'smoke', registry:'us-docker.pkg.dev/p/r', storage:{ provider:'gcs', bucket:'b' } });",
        "console.log('valid-config-accepted');",
        'let rejected = false;',
        "try { validateConfig({ name:'', registry:'', storage: undefined }); }",
        'catch { rejected = true; }',
        "if (!rejected) { console.error('invalid config was NOT rejected'); process.exit(7); }",
        "console.log('invalid-config-rejected');",
      ].join('\n'),
    ],
    { cwd: workDir },
  );
  console.log((validate.stdout || '').trim());
  if (validate.status !== 0) {
    console.error((validate.stderr || '').trim());
    finish(FAIL, `config validate path exited ${validate.status} (expected 0)`);
  }

  // --- 4. App-import probe: every PUBLIC subpath resolves to real JS ---------
  // Copy the committed probe + a .ts fixture config into the consumer dir and run it on
  // plain node. The probe exits non-zero on ANY failed import — the guard for this job.
  const probeDst = join(workDir, 'install-smoke-probe.mjs');
  copyFileSync(probeSrc, probeDst);
  writeFileSync(
    join(workDir, 'kn-next.config.ts'),
    [
      "import type { KnativeNextConfig } from '@knext/core';",
      '',
      'const config: KnativeNextConfig = {',
      "  name: 'smoke-app',",
      "  registry: 'us-central1-docker.pkg.dev/demo/repo',",
      "  storage: { provider: 'gcs', bucket: 'demo-bucket' },",
      '};',
      '',
      'export default config;',
      '',
    ].join('\n'),
  );

  console.log('[install-smoke] running app-import probe on plain node ...');
  const probe = run('node', [probeDst], { cwd: workDir });
  console.log('----- app-import probe (begin) -----');
  console.log(`${probe.stdout || ''}${probe.stderr || ''}`.trim());
  console.log('----- app-import probe (end) -------');
  if (probe.status !== 0) {
    finish(FAIL, `app-import probe exited ${probe.status} — a public subpath failed to resolve`);
  }

  // --- 5. exports-completeness: every exports subpath + bin resolves ---------
  const coreEntry = publishedEntrypoints(corePkgDir);
  const libEntry = publishedEntrypoints(libPkgDir);
  const allSubpaths = [...coreEntry.subpaths, ...libEntry.subpaths];
  console.log(`[install-smoke] resolving ${allSubpaths.length} exports subpaths ...`);
  const resolveCheck = run(
    'node',
    [
      '--input-type=module',
      '-e',
      [
        "import { createRequire } from 'node:module';",
        "const require = createRequire(process.cwd() + '/x.js');",
        `const subs = ${JSON.stringify(allSubpaths)};`,
        'let fail = 0;',
        'for (const s of subs) {',
        '  try {',
        '    const r = require.resolve(s);',
        "    if (r.endsWith('.ts')) { console.error('RESOLVED-TO-TS', s, r); fail++; continue; }",
        "    console.log('exports-ok', s);",
        '  } catch (e) {',
        "    console.error('RESOLVE-FAIL', s, e.message); fail++;",
        '  }',
        '}',
        'process.exit(fail ? 1 : 0);',
      ].join('\n'),
    ],
    { cwd: workDir },
  );
  console.log((resolveCheck.stdout || '').trim());
  if (resolveCheck.status !== 0) {
    console.error((resolveCheck.stderr || '').trim());
    finish(FAIL, 'one or more published exports subpaths failed to resolve');
  }
  // bins: kn-next was already proven runnable above; assert any other declared bin
  // at least has a .bin symlink.
  for (const bin of [...coreEntry.bins, ...libEntry.bins]) {
    if (!existsSync(join(workDir, 'node_modules', '.bin', bin))) {
      finish(FAIL, `declared bin '${bin}' is missing from node_modules/.bin`);
    }
  }

  // --- 6. negative guard: a removed bare path must NOT resolve --------------
  console.log('[install-smoke] negative guard: removed bare path must not resolve ...');
  const neg = run(
    'node',
    [
      '--input-type=module',
      '-e',
      [
        "import { createRequire } from 'node:module';",
        "const require = createRequire(process.cwd() + '/x.js');",
        "try { const r = require.resolve('@knext/core/cli/shared');",
        "  console.error('LEAK: @knext/core/cli/shared resolved to', r); process.exit(9); }",
        "catch { console.log('negative-guard-ok: @knext/core/cli/shared correctly blocked'); }",
      ].join('\n'),
    ],
    { cwd: workDir },
  );
  console.log((neg.stdout || '').trim());
  if (neg.status !== 0) {
    finish(FAIL, 'negative guard failed — a removed/internal bare path is exposed');
  }

  finish(
    PASS,
    'packed @knext/core + @knext/lib install on plain npm/Node; CLI runs and every ' +
      'public app-import subpath resolves to real JS outside the workspace',
  );
} catch (err) {
  finish(FAIL, `unexpected error: ${err?.message ?? err}`);
}
