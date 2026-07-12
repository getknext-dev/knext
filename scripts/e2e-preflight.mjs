#!/usr/bin/env node
/**
 * scripts/e2e-preflight.mjs — the fail-fast adapter-tarball gate (#147 A3-3
 * fix round 1, triage of baseline run 28558576615; #255/#256 db packaging).
 *
 * WHAT WENT WRONG (twice):
 *  - run 28558576615: e2e-deploy.sh packed @knext/core with `npm pack`, which
 *    ships pnpm's raw `workspace:^` dep on @knext/lib verbatim. Every fixture's
 *    `npm install <tarball>` failed with EUNSUPPORTEDPROTOCOL, `next build` ran
 *    ZERO times, and 472/473 reported failures were that ONE packaging bug.
 *  - runs 29182334221/29184529993 (#255/#256): @knext/core gained a
 *    `@knext/db: workspace:^` dep (ADR-0021; `kn-next db migrate` dynamically
 *    imports `@knext/db/migrate`), `pnpm pack` rewrote it to `^0.1.0`, but the
 *    workflow only packed lib+core — the preflight npm install 404'd on the
 *    unpublished @knext/db in seconds. The gate worked; the pack set (and this
 *    script's hardcoded pair) did not.
 *
 * THE GATE (now dependency-graph-derived, no hardcoded package list):
 *   1. derive the REQUIRED tarball set from the @knext/* dependency closure of
 *      @knext/core, walking the PACKED tarball manifests (dependencies +
 *      optional + peer). A closure member with no local tarball fails HERE,
 *      with the missing name spelled out — before any npm install. This also
 *      guards dependency confusion: the @knext scope is unclaimed on npmjs
 *      (#53), so a future 4th workspace dep whose tarball is missing must
 *      never be silently satisfiable by a registry squatter.
 *   2. manifest inspection: no packed package.json may carry a `workspace:`
 *      spec (names the run-28558576615 root cause directly);
 *   3. a REAL `npm install` of ALL closure tarballs into a scratch dir (full
 *      dependency resolution), then a lockfile audit: every installed
 *      @knext/* package must have resolved from a LOCAL tarball (file:),
 *      never a registry URL, and must belong to the derived closure;
 *   4. resolve smokes: `@knext/core/adapter` must resolve to real JS (the
 *      exact subpath e2e-deploy.sh resolves for NEXT_ADAPTER_PATH), and
 *      `@knext/db/migrate` must dynamically IMPORT — the exact import
 *      `kn-next db migrate` performs at runtime (db-migrate.ts).
 * Any failure prints a GitHub `::error::` annotation and exits 1 — so a
 * packaging regression aborts ONE job in seconds instead of burning 16 shards
 * on fake failures.
 *
 * Usage (CI and locally identical):
 *   node scripts/e2e-preflight.mjs --tarballs-dir <dir with knext-lib-*.tgz + knext-db-*.tgz + knext-core-*.tgz>
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertLocalKnextResolutions, knextDepsOf, tarballPrefix } from './lib/knext-closure.mjs';
import { findWorkspaceProtocolDeps } from './lib/workspace-protocol.mjs';

const ROOT_PACKAGE = '@knext/core';
const ADAPTER_SUBPATH = '@knext/core/adapter';
const DB_MIGRATE_SUBPATH = '@knext/db/migrate';

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

/**
 * BFS the @knext/* dependency closure of `rootName`, reading each member's
 * PACKED manifest from its local tarball. Fails loudly (naming the member) if
 * a closure member has no tarball in `dir`.
 * @returns {{ names: string[], tarballByName: Record<string, string>, manifestByName: Record<string, object> }}
 */
function resolveClosure(dir, rootName) {
  const tarballByName = {};
  const manifestByName = {};
  const names = [];
  const queue = [rootName];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const name = queue.shift();
    const prefix = tarballPrefix(name);
    const tgz = findTarball(dir, prefix);
    if (!tgz) {
      fail(
        `no ${prefix}-*.tgz found in ${dir}, but ${name} is in ${ROOT_PACKAGE}'s @knext/* ` +
          `dependency closure — pack it with pnpm pack alongside the others (the @knext scope ` +
          `is unpublished, #53: npm cannot and MUST NOT satisfy it from the registry). ` +
          `The #255/#256 incident was exactly this hole for @knext/db.`,
      );
    }
    let manifest;
    try {
      manifest = tarballManifest(tgz);
    } catch (err) {
      fail(`could not read package/package.json from ${tgz}: ${err?.message ?? err}`);
    }
    names.push(name);
    tarballByName[name] = tgz;
    manifestByName[name] = manifest;
    for (const dep of knextDepsOf(manifest)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return { names, tarballByName, manifestByName };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args['tarballs-dir'] ? resolve(args['tarballs-dir']) : null;
  if (!dir || !existsSync(dir)) {
    fail(`--tarballs-dir is required and must exist (got: ${args['tarballs-dir'] ?? '<unset>'})`);
  }

  // 1. Derive the required tarball set from @knext/core's dependency closure.
  const closure = resolveClosure(dir, ROOT_PACKAGE);
  const tarballs = closure.names.map((name) => closure.tarballByName[name]);
  console.log(
    `[e2e-preflight] @knext/* closure of ${ROOT_PACKAGE}: ${closure.names.join(', ')}\n` +
      `[e2e-preflight] tarballs: ${tarballs.join(' + ')}`,
  );

  // 2. Manifest inspection — name a workspace:-protocol leak directly.
  for (const name of closure.names) {
    const leaks = findWorkspaceProtocolDeps(closure.manifestByName[name]);
    if (leaks.length > 0) {
      const detail = leaks.map((l) => `${l.field}.${l.name}=${l.spec}`).join(', ');
      fail(
        `${closure.tarballByName[name]} still ships raw workspace: specs (${detail}) — it was ` +
          'packed with npm pack; use pnpm pack, which rewrites workspace:^ to the real semver ' +
          '(the 472-failure bug of run 28558576615)',
      );
    }
  }

  // 3. Real dependency-resolving npm install into a scratch consumer dir.
  //    NOT --no-save: we want the package-lock.json so the origin of every
  //    installed @knext/* package is auditable (local tarball vs registry).
  scratchDir = mkdtempSync(join(tmpdir(), 'knext-e2e-preflight-'));
  writeFileSync(
    join(scratchDir, 'package.json'),
    `${JSON.stringify({ name: 'knext-preflight-scratch', version: '0.0.0', private: true }, null, 2)}\n`,
  );
  console.log(`[e2e-preflight] npm install of all closure tarballs into ${scratchDir} ...`);
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
    cwd: scratchDir,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (install.status !== 0) {
    const out = `${install.stdout ?? ''}\n${install.stderr ?? ''}`;
    console.error(out);
    const hint = /EUNSUPPORTEDPROTOCOL|Unsupported URL Type "workspace:/.test(out)
      ? ' — the tarball ships a raw workspace: dep; pack with pnpm pack, not npm pack'
      : '';
    fail(`npm install of the packed tarballs exited ${install.status}${hint}`);
  }

  // 3b. Lockfile audit: every @knext/* package must have come from a LOCAL
  // tarball, and only closure members may appear (dependency-confusion guard).
  const lockPath = join(scratchDir, 'package-lock.json');
  if (!existsSync(lockPath)) {
    fail(`scratch install produced no package-lock.json at ${lockPath} — cannot audit origins`);
  }
  const lockfile = JSON.parse(readFileSync(lockPath, 'utf8'));
  const { problems } = assertLocalKnextResolutions(lockfile, new Set(closure.names));
  if (problems.length > 0) {
    fail(`scratch-install origin audit failed:\n${problems.join('\n')}`);
  }
  console.log('[e2e-preflight] origin audit OK: every @knext/* package came from a local tarball');

  // 4a. Resolve smoke: the exact subpath e2e-deploy.sh resolves for NEXT_ADAPTER_PATH.
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

  // 4b. Import probe: the EXACT dynamic import `kn-next db migrate` performs at
  // runtime (packages/kn-next/src/cli/db-migrate.ts:
  // `const { runMigrations } = await import("@knext/db/migrate")`). A resolve-only
  // check would miss an ESM/exports breakage that only bites at import time.
  const probe = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      [
        `const m = await import(${JSON.stringify(DB_MIGRATE_SUBPATH)});`,
        `if (typeof m.runMigrations !== 'function') {`,
        `  console.error('${DB_MIGRATE_SUBPATH} imported but has no runMigrations export');`,
        '  process.exit(3);',
        '}',
        `console.log('${DB_MIGRATE_SUBPATH} import OK (runMigrations present)');`,
      ].join('\n'),
    ],
    { cwd: scratchDir, encoding: 'utf8', timeout: 60_000 },
  );
  if (probe.status !== 0) {
    console.error(`${probe.stdout ?? ''}\n${probe.stderr ?? ''}`);
    fail(
      `dynamic import of ${DB_MIGRATE_SUBPATH} (the kn-next db migrate runner) failed ` +
        `with exit ${probe.status}`,
    );
  }
  console.log(`[e2e-preflight] ${(probe.stdout ?? '').trim()}`);

  console.log(`[e2e-preflight] PASS: ${ADAPTER_SUBPATH} -> ${adapterPath}`);
  rmSync(scratchDir, { recursive: true, force: true });
}

main();
