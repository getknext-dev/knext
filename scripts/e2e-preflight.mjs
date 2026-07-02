#!/usr/bin/env node
/**
 * scripts/e2e-preflight.mjs — the fail-fast adapter-tarball gate (#147 A3-3
 * fix round 1, triage of baseline run 28558576615).
 *
 * WHAT WENT WRONG: the compat suite's e2e-deploy.sh packed @knext/core with
 * `npm pack`, which ships pnpm's raw `workspace:^` dep on @knext/lib verbatim.
 * Every fixture's `npm install <tarball>` then failed with EUNSUPPORTEDPROTOCOL,
 * `next build` ran ZERO times, and 472/473 reported failures were that ONE
 * packaging bug — a full 16-shard run with no adapter signal.
 *
 * THE GATE THAT SHOULD HAVE EXISTED (this script): right after packing, prove
 * the tarballs are actually consumable the way every fixture will consume them —
 *   1. manifest inspection: neither packed package.json may carry a
 *      `workspace:` spec (names the root cause directly);
 *   2. a REAL `npm install` of BOTH tarballs into a scratch dir (full
 *      dependency resolution — npm satisfies the rewritten `@knext/lib@^x`
 *      dep from the local lib tarball, since @knext/lib is not on npm yet, #53);
 *   3. a resolve smoke: `@knext/core/adapter` must resolve from the scratch
 *      install to real JS (the exact subpath e2e-deploy.sh resolves for
 *      NEXT_ADAPTER_PATH).
 * Any failure prints a GitHub `::error::` annotation and exits 1 — so a
 * packaging regression aborts ONE job in seconds instead of burning 16 shards
 * on 472 fake failures.
 *
 * Usage (CI and locally identical):
 *   node scripts/e2e-preflight.mjs --tarballs-dir <dir-with-knext-lib-*.tgz + knext-core-*.tgz>
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findWorkspaceProtocolDeps } from './lib/workspace-protocol.mjs';

const ADAPTER_SUBPATH = '@knext/core/adapter';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key) args[key] = argv[i + 1];
  }
  return args;
}

let scratchDir;
function fail(message) {
  console.error(`::error::adapter-tarball preflight FAILED: ${message}`);
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  process.exit(1);
}

/** Newest tarball matching `<prefix>-*.tgz` in dir (pnpm/npm naming for @knext/*). */
function findTarball(dir, prefix) {
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.tgz'))
    .sort()
    .map((f) => join(dir, f))
    .at(-1);
}

/** Extract the packed package.json out of a tarball (npm layout: package/package.json). */
function tarballManifest(tarball) {
  const raw = execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args['tarballs-dir'] ? resolve(args['tarballs-dir']) : null;
  if (!dir || !existsSync(dir)) {
    fail(`--tarballs-dir is required and must exist (got: ${args['tarballs-dir'] ?? '<unset>'})`);
  }

  const libTgz = findTarball(dir, 'knext-lib');
  const coreTgz = findTarball(dir, 'knext-core');
  if (!libTgz) fail(`no knext-lib-*.tgz found in ${dir} — pack @knext/lib with pnpm pack first`);
  if (!coreTgz) fail(`no knext-core-*.tgz found in ${dir} — pack @knext/core with pnpm pack first`);
  console.log(`[e2e-preflight] tarballs: ${libTgz} + ${coreTgz}`);

  // 1. Manifest inspection — name a workspace:-protocol leak directly.
  for (const tgz of [libTgz, coreTgz]) {
    let manifest;
    try {
      manifest = tarballManifest(tgz);
    } catch (err) {
      fail(`could not read package/package.json from ${tgz}: ${err?.message ?? err}`);
    }
    const leaks = findWorkspaceProtocolDeps(manifest);
    if (leaks.length > 0) {
      const detail = leaks.map((l) => `${l.field}.${l.name}=${l.spec}`).join(', ');
      fail(
        `${tgz} still ships raw workspace: specs (${detail}) — it was packed with npm pack; ` +
          'use pnpm pack, which rewrites workspace:^ to the real semver (the 472-failure bug ' +
          'of run 28558576615)',
      );
    }
  }

  // 2. Real dependency-resolving npm install into a scratch consumer dir.
  scratchDir = mkdtempSync(join(tmpdir(), 'knext-e2e-preflight-'));
  writeFileSync(
    join(scratchDir, 'package.json'),
    `${JSON.stringify({ name: 'knext-preflight-scratch', version: '0.0.0', private: true }, null, 2)}\n`,
  );
  console.log(`[e2e-preflight] npm install of both tarballs into ${scratchDir} ...`);
  const install = spawnSync(
    'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', libTgz, coreTgz],
    { cwd: scratchDir, encoding: 'utf8', timeout: 300_000 },
  );
  if (install.status !== 0) {
    const out = `${install.stdout ?? ''}\n${install.stderr ?? ''}`;
    console.error(out);
    const hint = /EUNSUPPORTEDPROTOCOL|Unsupported URL Type "workspace:/.test(out)
      ? ' — the tarball ships a raw workspace: dep; pack with pnpm pack, not npm pack'
      : '';
    fail(`npm install of the packed tarballs exited ${install.status}${hint}`);
  }

  // 3. Resolve smoke: the exact subpath e2e-deploy.sh resolves for NEXT_ADAPTER_PATH.
  const require = createRequire(join(scratchDir, 'x.js'));
  let adapterPath;
  try {
    adapterPath = require.resolve(ADAPTER_SUBPATH);
  } catch (err) {
    fail(`installed ${ADAPTER_SUBPATH} does not resolve: ${err?.message ?? err}`);
  }
  if (adapterPath.endsWith('.ts')) {
    fail(`${ADAPTER_SUBPATH} resolved to raw TypeScript (${adapterPath}) — not consumable by node`);
  }

  console.log(`[e2e-preflight] PASS: ${ADAPTER_SUBPATH} -> ${adapterPath}`);
  rmSync(scratchDir, { recursive: true, force: true });
}

main();
