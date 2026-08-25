#!/usr/bin/env node
/**
 * install-smoke.mjs — PK2 / #115
 *
 * The OUTSIDE-CONSUMER gate. Proves knext works for a user on a fresh machine with
 * plain Node + npm, NO pnpm workspace, NO Bun — exercising BOTH ways a consumer uses
 * knext: (a) the `kn-next` CLI bin, and (b) `import`ing the public app surface
 * (`@getknext/core/adapter`, otel-config, cache-handler, the `KnativeNextConfig` type;
 * `@getknext/lib/clients`, `@getknext/lib/health`, `@getknext/lib/logger`). PK1/#114 declared
 * these exports; PK5/#116 froze the public set. This job CATCHES regressions in either
 * (a raw-`.ts` export, a missing dist file, a broken bin) BEFORE the first publish.
 *
 * Why the install is plain `npm` but the PACK uses `pnpm`:
 *   - @getknext/core depends on @getknext/lib AND @getknext/db via `workspace:^` (package.json),
 *     and @getknext/db depends on @getknext/lib. `npm pack` leaves those verbatim, which fails
 *     to install (EUNSUPPORTEDPROTOCOL). `pnpm pack` REWRITES `workspace:^` to a real
 *     version range — EXACTLY what `changeset publish` does (release.yml runs under
 *     pnpm). So we pack the way we publish, then install + run the way a CONSUMER would:
 *     plain `npm install`, plain `node`, outside the repo.
 *   - Nothing is published to npm yet, so the rewritten `@getknext/lib` + `@getknext/db` deps
 *     are satisfied by installing ALL THREE tarballs together in the fresh consumer dir.
 *
 * Steps:
 *   1. Build (lib → db → core — each build/types need the prior's dist) and `pnpm pack` all.
 *   2. Fresh temp dir OUTSIDE the workspace. `npm init -y`, `npm install <all tarballs>`.
 *   3. CLI checks:  `node <bin> --help` (exit 0 + expected output) AND drive the config
 *      `validate` path via the public-ish `./internal/cli-validate` export — a VALID
 *      fixture passes and an INVALID one is rejected. The bin is also confirmed present.
 *   4. App-import probe: a child ESM script (install-smoke-probe.mjs) imports every
 *      PUBLIC subpath on plain Node and asserts each resolves to real `.js` (no `.ts`)
 *      with its expected named export. The probe exits non-zero on ANY failure — that
 *      is the guard that fails this job if a public subpath breaks.
 *   5. Exports-completeness: assert EVERY `exports` subpath + the `bin` in each packed
 *      package.json resolves under the clean install.
 *   6. Negative guard: a now-removed bare path (`@getknext/core/cli/shared`) must NOT
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
import { findWorkspaceProtocolDeps } from './lib/workspace-protocol.mjs';
import { publishablePackages, readWorkspaceManifests } from './publish-preflight.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const corePkgDir = join(repoRoot, 'packages', 'kn-next');
const libPkgDir = join(repoRoot, 'packages', 'lib');
const dbPkgDir = join(repoRoot, 'packages', 'db');
const aliasPkgDir = join(repoRoot, 'packages', 'kn-next-alias');
const probeSrc = join(__dirname, 'install-smoke-probe.mjs');

const PASS = 'PASS';
const FAIL = 'FAIL';

let workDir;
let libDest;
let dbDest;
let coreDest;
let aliasDest;

/** Print a final summary line, clean up temp dirs, and exit with the matching code. */
function finish(status, message) {
  console.log(`\n[install-smoke] ${status}: ${message}`);
  for (const dir of [workDir, libDest, dbDest, coreDest, aliasDest]) {
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
 * because @getknext/core depends on @getknext/lib via `workspace:^`; pnpm rewrites that to a
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
  // --- 1. build (lib → db → core) + pack all three --------------------------
  // @getknext/lib + @getknext/db ship dist/ only — build before packing or the tarball
  // is empty. Dependency order: @getknext/db imports @getknext/lib types, and
  // @getknext/core's build (and its .d.ts) import BOTH @getknext/lib and @getknext/db types
  // (the `kn-next db migrate` runner lives in @getknext/db/migrate, #242), so the
  // order is lib → db → core.
  console.log('[install-smoke] building @getknext/lib then @getknext/db then @getknext/core ...');
  execFileSync('pnpm', ['--filter', '@getknext/lib', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  execFileSync('pnpm', ['--filter', '@getknext/db', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  execFileSync('pnpm', ['--filter', '@getknext/core', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  libDest = mkdtempSync(join(tmpdir(), 'knext-pack-lib-'));
  dbDest = mkdtempSync(join(tmpdir(), 'knext-pack-db-'));
  coreDest = mkdtempSync(join(tmpdir(), 'knext-pack-core-'));
  const libTarball = pnpmPack(libPkgDir, libDest, '@getknext/lib');
  const dbTarball = pnpmPack(dbPkgDir, dbDest, '@getknext/db');
  const coreTarball = pnpmPack(corePkgDir, coreDest, '@getknext/core');
  // The alias needs no build step — it ships one forwarding shim and a manifest.
  aliasDest = mkdtempSync(join(tmpdir(), 'knext-pack-alias-'));
  const aliasTarball = pnpmPack(aliasPkgDir, aliasDest, 'kn-next (the npx alias)');

  // --- 1a. what this gate covers is DERIVED, not enumerated -----------------
  // The `kn-next` alias — the package `npx kn-next` installs — was outside this gate
  // entirely: never packed, never installed, and its `@getknext/core: workspace:^` dep
  // never checked for the protocol leak that makes an install fail with
  // EUNSUPPORTEDPROTOCOL. An enumerated list is how the NEXT publishable package gets
  // missed the same way, so the covered set is derived.
  //
  // Derived from the PUBLISHABLE set, not from the changesets `fixed` group. Review of
  // the first cut caught that distinction, with a reproduction: `fixed` is the
  // LOCKSTEP-VERSIONING group, and `changeset publish` publishes any non-private
  // workspace package with a pending bump — so a new publishable package nobody adds to
  // `fixed` is invisible to both halves of the check, and the gate reports full coverage
  // while never packing it. Deriving from `publishablePackages` — the same helper
  // `scripts/publish-preflight.mjs` gates the actual publish with — closes that, and
  // leaves the `publishable == fixed` cross-check where it belongs, in
  // `tests/publish-preflight.test.ts`.
  //
  // BOTH directions are asserted: a publishable package this gate does not pack fails,
  // and a package this gate packs that is not publishable fails too.
  const changesetConfig = JSON.parse(
    readFileSync(join(repoRoot, '.changeset', 'config.json'), 'utf8'),
  );
  const publishable = publishablePackages(
    readWorkspaceManifests(repoRoot),
    Array.isArray(changesetConfig.ignore) ? changesetConfig.ignore : [],
  ).map((p) => p.name);
  const packed = [
    [libTarball, libPkgDir],
    [dbTarball, dbPkgDir],
    [coreTarball, corePkgDir],
    [aliasTarball, aliasPkgDir],
  ].map(([tgz, dir]) => ({
    tgz,
    dir,
    name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name,
  }));
  const uncovered = publishable.filter((name) => !packed.some((p) => p.name === name));
  if (uncovered.length > 0) {
    finish(
      FAIL,
      `${uncovered.join(', ')} publish(es) to the registry but this gate never packs or ` +
        'installs it — add it above; it is a consumer path nothing else proves',
    );
  }
  const unpublished = packed.filter((p) => !publishable.includes(p.name));
  if (unpublished.length > 0) {
    finish(
      FAIL,
      `this gate packs ${unpublished.map((p) => p.name).join(', ')}, which does not publish ` +
        '(private, unversioned, or changeset-ignored) — the gate and the release set disagree',
    );
  }
  console.log(`[install-smoke] covering the full publishable set: ${publishable.join(', ')}`);

  // --- 1b. manifest guard: no workspace:-protocol spec may survive packing ----
  // #147 A3-3 fix round 1 (run 28558576615): the compat suite burned 16 shards
  // because a tarball packed with `npm pack` (a DIFFERENT pack path this gate
  // never covered) still shipped `@getknext/lib: workspace:^` → EUNSUPPORTEDPROTOCOL
  // in every fixture install. This gate already pnpm-packs + npm-installs with
  // full dependency resolution (which would fail on the leak) — the explicit
  // manifest inspection makes a future regression NAME its cause here instead of
  // surfacing as a downstream npm error.
  console.log('[install-smoke] inspecting packed manifests for workspace: protocol leaks ...');
  for (const { tgz, name: label } of packed) {
    const manifest = JSON.parse(
      execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
    );
    const leaks = findWorkspaceProtocolDeps(manifest);
    if (leaks.length > 0) {
      const detail = leaks.map((l) => `${l.field}.${l.name}=${l.spec}`).join(', ');
      finish(
        FAIL,
        `packed ${label} tarball still ships workspace: specs (${detail}) — ` +
          'npm cannot install it (EUNSUPPORTEDPROTOCOL); the pack path must rewrite the workspace protocol',
      );
    }
    console.log(`[install-smoke] ${label} manifest is workspace:-free`);
  }

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

  // Install all three tarballs together: @getknext/core's rewritten `@getknext/db` +
  // `@getknext/lib` deps (and @getknext/db's rewritten `@getknext/lib` dep) are unpublished,
  // so the local tarballs satisfy them; drizzle-orm/pg (@getknext/db's real deps) come
  // from the registry.
  console.log('[install-smoke] npm install <lib.tgz> <db.tgz> <core.tgz> (plain npm, no bun) ...');
  const install = run(
    'npm',
    ['install', '--no-audit', '--no-fund', libTarball, dbTarball, coreTarball, aliasTarball],
    {
      cwd: workDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
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

  // --- 3a-alias. the alias's OWN shim, which step 3a never touches -----------
  // The check above runs node_modules/.bin/kn-next. Both @getknext/core and the alias
  // declare that bin name, and the first cut of this comment called the outcome npm's
  // to decide. Review measured it instead, and it is DETERMINISTIC: `.bin/kn-next`
  // resolves to `@getknext/core/dist/cli/kn-next.js` in every install shape tried,
  // including the real `npx` one where the alias is installed alone and core arrives as
  // its transitive dep. So step 3a never tested the alias at all — the gap was LARGER
  // than 'might not have', not smaller.
  //
  // Two consequences worth stating plainly, because the obvious misreading is
  // flattering in both directions. There is no coverage LOSS: core still owns the bin
  // link, so 3a covers core's bin and this step covers the alias's shim — complementary,
  // not duplicated. And this step does NOT prove that `npx kn-next` executes the shim,
  // because it does not; it proves the shipped shim is present, intact, and forwards.
  // Whether the shim should be on the `npx` path at all is a question about the alias
  // package, not about this gate.
  const aliasInstallDir = join(workDir, 'node_modules', 'kn-next');
  const aliasManifestPath = join(aliasInstallDir, 'package.json');
  if (!existsSync(aliasManifestPath)) {
    finish(FAIL, 'the kn-next alias did not install — `npx kn-next` would resolve to nothing');
  }
  const aliasBinRel = JSON.parse(readFileSync(aliasManifestPath, 'utf8')).bin?.['kn-next'];
  if (!aliasBinRel) {
    finish(
      FAIL,
      'the installed kn-next alias declares no `kn-next` bin — the command the docs tell ' +
        'every new user to type would not exist',
    );
  }
  // Follow the manifest instead of a hardcoded filename. Renaming the shim and updating
  // `bin` together is legitimate and must stay green; declaring a `bin` the tarball does
  // not contain is the break — and `pnpm pack` exits 0 on exactly that, so nothing
  // upstream catches it and every `npx kn-next` dies with ENOENT after a clean install.
  const aliasBin = join(aliasInstallDir, aliasBinRel);
  if (!existsSync(aliasBin)) {
    finish(
      FAIL,
      `the kn-next alias declares bin '${aliasBinRel}' but the packed tarball ships no such ` +
        'file — every `npx kn-next` would fail with ENOENT',
    );
  }
  console.log(
    `[install-smoke] running the alias shim \`node node_modules/kn-next/${aliasBinRel} --help\` ...`,
  );
  const aliasHelp = run('node', [aliasBin, '--help'], { cwd: workDir });
  const aliasOut = `${aliasHelp.stdout || ''}${aliasHelp.stderr || ''}`;
  if (aliasHelp.status !== 0) {
    console.error(aliasOut.trim());
    finish(
      FAIL,
      `the kn-next alias bin exited ${aliasHelp.status} (expected 0) — \`npx kn-next\` is broken ` +
        'for every consumer',
    );
  }
  if (!/kn-next|Usage/i.test(aliasOut)) {
    finish(
      FAIL,
      'the kn-next alias bin exited 0 but printed no CLI help — it is not forwarding to ' +
        '@getknext/core',
    );
  }
  console.log('[install-smoke] alias shim forwards to the real CLI');

  // --- 3a-bis. CLI: `create` scaffolds from the INSTALLED package (#407) -----
  // `kn-next create` reads its templates from <package>/templates, so it works
  // only if the `files` allowlist actually ships them. A repo-local test cannot
  // observe that — the source tree has the directory either way — so the
  // packed-and-installed path is the only place this can be proven.
  console.log('[install-smoke] running `node <bin> create` against the installed package ...');
  const scaffoldDir = join(workDir, 'scaffolded-app');
  const create = run('node', [binPath, 'create', scaffoldDir, '--name', 'smoke-app'], {
    cwd: workDir,
  });
  const createOut = `${create.stdout || ''}${create.stderr || ''}`;
  console.log(createOut.trim());
  if (create.status !== 0) finish(FAIL, `kn-next create exited ${create.status} (expected 0)`);
  for (const rel of [
    'src/instrumentation.ts',
    'src/instrumentation-node.ts',
    'next-adapter.ts',
    'instrumentation-edge-safe.test.ts',
    'standalone-seam-alive.test.ts',
  ]) {
    if (!existsSync(join(scaffoldDir, rel))) {
      finish(FAIL, `kn-next create did not emit ${rel} — templates missing from the tarball?`);
    }
  }

  // --- 3a-ter. the scaffolded app must actually INSTALL and BUILD -----------
  // Until now the scaffold was checked for FILES and nothing else, so `kn-next create`
  // could emit a complete-looking app that no consumer can build — the first thing a new
  // user does after `create` is `npm install && npm run build`, and nothing in this repo
  // ran it. Measured before writing this: it does build, so the gate starts green and its
  // job is to keep it that way.
  //
  // The scaffold pins `@getknext/*` at the CLI's own version, which by construction is not
  // on the registry yet at gate time — that is what publishing does. Redirecting those
  // pins at the tarballs packed above is what makes this runnable, and it is also the more
  // honest test: it builds against the artifacts THIS commit produces, not against
  // whatever the registry happens to hold.
  console.log('[install-smoke] installing + building the scaffolded app ...');
  const scaffoldPkgPath = join(scaffoldDir, 'package.json');
  const scaffoldPkg = JSON.parse(readFileSync(scaffoldPkgPath, 'utf8'));
  const packedByName = new Map(packed.map((p) => [p.name, p.tgz]));
  let redirected = 0;
  for (const field of ['dependencies', 'devDependencies']) {
    for (const dep of Object.keys(scaffoldPkg[field] ?? {})) {
      if (packedByName.has(dep)) {
        scaffoldPkg[field][dep] = `file:${packedByName.get(dep)}`;
        redirected++;
      }
    }
  }
  if (redirected === 0) {
    finish(
      FAIL,
      'the scaffolded app declares no @getknext/* dependency — either the template stopped ' +
        'depending on the packages this gate builds, or `create` emitted the wrong manifest',
    );
  }
  // `@getknext/core` depends on `@getknext/db` and `@getknext/lib`, and pnpm rewrote those
  // specs to versions that are not published yet, so the packed libraries have to be
  // reachable. Review caught the first attempt doing that by force-adding every packed
  // package to `dependencies`, which made the gate insensitive to the template DROPPING a
  // dependency: with `@getknext/core` removed from the template the gate still passed,
  // because the gate itself had put it back. `overrides` resolves the transitives without
  // touching the declared set, so what is under test is the manifest `create` emitted.
  scaffoldPkg.overrides = Object.fromEntries(
    packed.filter((p) => p.name !== 'kn-next').map((p) => [p.name, `file:${p.tgz}`]),
  );
  writeFileSync(scaffoldPkgPath, `${JSON.stringify(scaffoldPkg, null, 2)}\n`);

  const scaffoldInstall = run('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: scaffoldDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (scaffoldInstall.status !== 0) {
    finish(
      FAIL,
      `npm install in the scaffolded app exited ${scaffoldInstall.status} — the app ` +
        '`kn-next create` generates cannot be installed by the user who just ran it',
    );
  }

  const scaffoldBuild = run('npm', ['run', 'build'], {
    cwd: scaffoldDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (scaffoldBuild.status !== 0) {
    finish(
      FAIL,
      `\`npm run build\` in the scaffolded app exited ${scaffoldBuild.status} — the app ` +
        '`kn-next create` generates does not build',
    );
  }
  // Both halves. A green build is not the claim; the claim is that the build produces what
  // knext deploys. The template sets `output: 'standalone'`, and losing that is a SILENT
  // break — `next build` still exits 0 and the container then has no server to start.
  //
  // WHERE that server lands is not a constant, and the first cut of this check assumed it
  // was. Next nests the standalone output under the app's path relative to the tracing
  // root it infers, so an app scaffolded inside another project emits
  // `.next/standalone/<subdir>/server.js`. `create` already knows this — it resolves a
  // `standalonePrefix` and bakes it into the generated Dockerfile's `WORKDIR /repo/<prefix>`.
  // So the assertion reads the prefix back out of the artifact the user actually builds with.
  //
  // What that is worth, stated accurately — the first version of this comment claimed a
  // `create` computing the wrong prefix "fails here, and nothing else covers that", and
  // review showed BOTH halves were false: `path.join` silently repaired a prefix missing
  // its trailing slash, and `create-scaffold.test.ts` already covers the prefix itself at
  // PR time. The honest claim is narrower and still worth having: an INCONSISTENCY between
  // the prefix `create` bakes into the Dockerfile and where `next build` actually puts the
  // server fails here, and that pairing is not checked anywhere else.
  const scaffoldDockerfile = readFileSync(join(scaffoldDir, 'Dockerfile'), 'utf8');
  const workdir = scaffoldDockerfile.match(/^WORKDIR \/repo\/(.*)$/m);
  if (workdir === null) {
    finish(
      FAIL,
      'the scaffolded Dockerfile declares no `WORKDIR /repo/...` — there is no way to tell ' +
        'where it expects the standalone server, so the build cannot be checked against it',
    );
  }
  const standalonePrefix = workdir[1];
  // The prefix is contractually slash-terminated, or '' when the app IS the tracing root,
  // and every consumer CONCATENATES it — the Dockerfile's COPYs, its CMD's
  // STANDALONE_SERVER_PATH, and the app's `start` script. Assert that directly rather than
  // letting a path lookup decide it: `path.join` normalises a missing separator back in, so
  // a prefix that breaks all three of those would still resolve here.
  if (standalonePrefix !== '' && !standalonePrefix.endsWith('/')) {
    finish(
      FAIL,
      `create emitted a non-slash-terminated standalonePrefix '${standalonePrefix}' — the ` +
        "Dockerfile's COPYs, its CMD and the app's `start` script all concatenate it, so " +
        'every one of them would point at a path that does not exist',
    );
  }
  const scaffoldServer = join(scaffoldDir, '.next', 'standalone', `${standalonePrefix}server.js`);
  if (!existsSync(scaffoldServer)) {
    finish(
      FAIL,
      `the scaffolded app built but emitted no standalone server at ` +
        `.next/standalone/${standalonePrefix}server.js — the Dockerfile \`create\` generated ` +
        'COPYs from exactly that path, so the image would have nothing to run (lost ' +
        '`output: standalone`, or computed the wrong standalonePrefix?)',
    );
  }
  console.log(
    `[install-smoke] the scaffolded app installs, builds, and emits a standalone server where ` +
      `its own Dockerfile expects it (.next/standalone/${standalonePrefix}server.js)`,
  );

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
        "import { validateConfig } from '@getknext/core/internal/cli-validate';",
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
      "import type { KnativeNextConfig } from '@getknext/core';",
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
  // Derived from the same packed set as step 1a — review caught that the derivation
  // stopped at packing, so a newly-covered package was installed but its `exports` and
  // `bin` were never resolution-checked. `publishedEntrypoints` defaults a package with
  // no `exports` map to its bare name, which the alias does not resolve as (it ships a
  // bin and nothing importable), so entries without an explicit `exports` contribute
  // their bins only.
  const entries = packed.map((p) => ({
    ...publishedEntrypoints(p.dir),
    hasExports: JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')).exports !== undefined,
  }));
  // @getknext/db's subpaths include ./migrate — this proves `@getknext/db/migrate` (the
  // `kn-next db migrate` runner) resolves to real JS in a clean install.
  const allSubpaths = entries.filter((e) => e.hasExports).flatMap((e) => e.subpaths);
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
  for (const bin of entries.flatMap((e) => e.bins)) {
    if (!existsSync(join(workDir, 'node_modules', '.bin', bin))) {
      finish(FAIL, `declared bin '${bin}' is missing from node_modules/.bin`);
    }
  }

  // --- 5b. @getknext/db runs with drizzle-kit ABSENT (v3-P3c peer shape) --------
  // ADR-0021 amendment: drizzle-orm is a hard dep, drizzle-kit the sole OPTIONAL
  // peer (lazily consulted only inside defineDrizzleConfig). A clean consumer
  // install pulls @getknext/db's real deps (drizzle-orm + pg) but NOT drizzle-kit
  // (an optional peer is not installed unless the consumer asks). This leg proves
  // that shape holds on a real install: drizzle-kit must be absent, yet
  // `@getknext/db`'s main entry imports and `runMigrations` resolves; and
  // `defineDrizzleConfig()` — the one surface that needs the peer — yields the
  // actionable named error, never a bare module-not-found.
  console.log(
    '[install-smoke] @getknext/db imports + runMigrations resolve without drizzle-kit ...',
  );
  const dbNoKit = run(
    'node',
    [
      '--input-type=module',
      '-e',
      [
        "import { createRequire } from 'node:module';",
        "const require = createRequire(process.cwd() + '/x.js');",
        // drizzle-kit is an OPTIONAL peer — a clean consumer install must NOT have it.
        'let kitAbsent = false;',
        "try { require.resolve('drizzle-kit'); } catch { kitAbsent = true; }",
        "if (!kitAbsent) { console.error('drizzle-kit unexpectedly present — optional peer leaked into the install'); process.exit(2); }",
        // Main entry imports (re-exports drizzle-orm) with no drizzle-kit.
        "const db = await import('@getknext/db');",
        "if (typeof db.getDb !== 'function' || typeof db.eq !== 'function') { console.error('@getknext/db main entry missing getDb/eq'); process.exit(3); }",
        // The migrate runner resolves + guards the DSN (no drizzle-kit needed).
        "const mig = await import('@getknext/db/migrate');",
        "if (typeof mig.runMigrations !== 'function') { console.error('@getknext/db/migrate missing runMigrations'); process.exit(4); }",
        'let guarded = false;',
        "try { mig.resolveWriterDsn({ url: '' }); } catch (e) { guarded = /DATABASE_URL/.test(e.message); }",
        "if (!guarded) { console.error('runMigrations/resolveWriterDsn unreachable without drizzle-kit'); process.exit(5); }",
        // defineDrizzleConfig is the ONLY surface that needs the peer — actionable error.
        'let named = false;',
        "try { mig.defineDrizzleConfig(); console.error('defineDrizzleConfig did not throw without drizzle-kit'); process.exit(6); }",
        "catch (e) { named = /drizzle-kit/.test(e.message) && /devDependency/i.test(e.message) && e.code !== 'ERR_MODULE_NOT_FOUND' && e.code !== 'MODULE_NOT_FOUND'; }",
        "if (!named) { console.error('defineDrizzleConfig error was not the actionable named-peer error'); process.exit(7); }",
        "console.log('db-no-drizzle-kit-ok');",
      ].join('\n'),
    ],
    { cwd: workDir },
  );
  console.log((dbNoKit.stdout || '').trim());
  if (dbNoKit.status !== 0) {
    console.error((dbNoKit.stderr || '').trim());
    finish(FAIL, '@getknext/db does not run cleanly without the optional drizzle-kit peer');
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
        "try { const r = require.resolve('@getknext/core/cli/shared');",
        "  console.error('LEAK: @getknext/core/cli/shared resolved to', r); process.exit(9); }",
        "catch { console.log('negative-guard-ok: @getknext/core/cli/shared correctly blocked'); }",
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
    `packed ${publishable.join(' + ')} install on plain npm/Node; the CLI runs and so does the ` +
      '`npx kn-next` alias shim, ' +
      'the app `create` scaffolds installs and builds into the standalone server its own ' +
      'Dockerfile expects, ' +
      'every public app-import subpath resolves to real JS outside the workspace, and ' +
      '@getknext/db imports + migrates without the optional drizzle-kit peer',
  );
} catch (err) {
  finish(FAIL, `unexpected error: ${err?.message ?? err}`);
}
