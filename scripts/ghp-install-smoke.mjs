#!/usr/bin/env node
/**
 * ghp-install-smoke.mjs — plan-v3 P3a
 *
 * The REGISTRY-CHANNEL consumer proof for the interim GitHub Packages channel
 * (@getknext-dev/*). This is the missing counterpart to scripts/install-smoke.mjs:
 * install-smoke PACKS from source (a tarball that never touches a registry), so it
 * proves the package CONTENTS but NOT that the published GitHub Packages channel is
 * installable by a real consumer. This is the v2-incident follow-up: prove a
 * consumer with `GITHUB_TOKEN` + `packages: read` (the packages are repo-linked, so
 * NO new secret) can `npm install @getknext-dev/core@<version>` FROM
 * npm.pkg.github.com and get a working CLI + real (`.js`, not `.ts`) app-import
 * surface.
 *
 * SECURITY — dependency-confusion / endpoint-assert discipline (mirrors the compat
 * preflight's origin audit):
 *   - BEFORE any install: assert the @getknext-dev scope registry resolves to
 *     https://npm.pkg.github.com (a mis-scoped consumer would silently pull from
 *     the public npm registry — the classic dependency-confusion vector).
 *   - AFTER install: audit `npm ls --json` and assert EVERY resolved
 *     @getknext-dev/* tarball URL is on pkg.github.com. If any @getknext-dev/*
 *     package resolved off a different host, FAIL LOUDLY.
 *
 * Usage:
 *   GITHUB_TOKEN=<token-with-read:packages> \
 *     node scripts/ghp-install-smoke.mjs [--version 0.2.0]
 *
 * The version defaults to the workspace @knext/core version (the version this
 * commit would publish); the release-ghp workflow passes the just-published
 * version explicitly via --version.
 *
 * This script never mutates the working tree — it operates entirely in a fresh
 * temp dir OUTSIDE the repo, exactly as an outside consumer would.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const SCOPE = '@getknext-dev';
const REGISTRY = 'https://npm.pkg.github.com';
const REGISTRY_HOST = 'npm.pkg.github.com';
const TARBALL_HOST = 'pkg.github.com'; // resolved tarball URLs live on *.pkg.github.com

const PASS = 'PASS';
const FAIL = 'FAIL';

let workDir;

function finish(status, message) {
  console.log(`\n[ghp-install-smoke] ${status}: ${message}`);
  try {
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  process.exit(status === FAIL ? 1 : 0);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

/** --version <v>, else the workspace @knext/core version (what this commit publishes). */
function resolveVersion() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--version');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const corePkg = JSON.parse(
    readFileSync(join(repoRoot, 'packages', 'kn-next', 'package.json'), 'utf8'),
  );
  return corePkg.version;
}

const token = process.env.GITHUB_TOKEN || process.env.NODE_AUTH_TOKEN || '';
if (!token) {
  finish(
    FAIL,
    'no GITHUB_TOKEN (or NODE_AUTH_TOKEN) in env — a read:packages token is required to install ' +
      'the repo-linked @getknext-dev/* packages from GitHub Packages',
  );
}

const version = resolveVersion();
console.log(`[ghp-install-smoke] target: ${SCOPE}/core@${version} from ${REGISTRY}`);

try {
  // --- fresh consumer dir OUTSIDE the workspace -----------------------------
  workDir = mkdtempSync(join(tmpdir(), 'knext-ghp-smoke-'));
  if (workDir.startsWith(repoRoot)) {
    finish(FAIL, `consumer dir ${workDir} is inside the repo — not a clean install`);
  }
  console.log(`[ghp-install-smoke] fresh consumer dir (outside workspace): ${workDir}`);

  // package.json with "type":"module" so the app-import probe runs as ESM.
  writeFileSync(
    join(workDir, 'package.json'),
    `${JSON.stringify({ name: 'ghp-smoke-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );

  // .npmrc: scope @getknext-dev to GitHub Packages + wire the auth token. This is
  // exactly what an outside consumer writes to install repo-linked packages:
  //     @getknext-dev:registry=https://npm.pkg.github.com
  //     //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
  //     always-auth=true
  const npmrc = [
    `${SCOPE}:registry=${REGISTRY}`, // @getknext-dev:registry=https://npm.pkg.github.com
    `//${REGISTRY_HOST}/:_authToken=${token}`,
    'always-auth=true',
    '',
  ].join('\n');
  writeFileSync(join(workDir, '.npmrc'), npmrc);

  // --- ASSERT-BEFORE-ANYTHING: the scope registry resolves to pkg.github.com --
  // A mis-scoped consumer would silently fetch @getknext-dev/* from the PUBLIC npm
  // registry (dependency confusion). Prove the scope points at GitHub Packages
  // before we install a single byte.
  console.log('[ghp-install-smoke] asserting scope registry resolves to GitHub Packages ...');
  const cfg = run('npm', ['config', 'get', `${SCOPE}:registry`], { cwd: workDir });
  const configuredRegistry = (cfg.stdout || '').trim();
  console.log(`[ghp-install-smoke] npm config get ${SCOPE}:registry => ${configuredRegistry}`);
  if (cfg.status !== 0 || !configuredRegistry.includes(REGISTRY_HOST)) {
    finish(
      FAIL,
      `${SCOPE} scope does not resolve to ${REGISTRY_HOST} (got "${configuredRegistry}") — ` +
        'refusing to install (dependency-confusion guard)',
    );
  }

  // --- install @getknext-dev/core@<version> FROM the registry ---------------
  // Installing core pulls in its @getknext-dev/db + @getknext-dev/lib deps from
  // the SAME registry (that graph is the whole point of the #255/#256 fix).
  console.log(`[ghp-install-smoke] npm install ${SCOPE}/core@${version} (from ${REGISTRY}) ...`);
  const install = run('npm', ['install', '--no-audit', '--no-fund', `${SCOPE}/core@${version}`], {
    cwd: workDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (install.status !== 0) {
    finish(FAIL, `npm install ${SCOPE}/core@${version} exited ${install.status}`);
  }

  // --- endpoint-assert: EVERY resolved @getknext-dev/* tarball is pkg.github.com
  // The dependency-confusion audit AFTER resolution: walk `npm ls --json` and
  // confirm every @getknext-dev/* package resolved off a *.pkg.github.com URL.
  console.log('[ghp-install-smoke] auditing resolved tarball origins ...');
  const ls = run('npm', ['ls', '--all', '--json'], { cwd: workDir });
  // `npm ls` exits non-zero on peer-dep warnings; parse its JSON regardless.
  let tree;
  try {
    tree = JSON.parse(ls.stdout || '{}');
  } catch (e) {
    finish(FAIL, `could not parse 'npm ls --json' output: ${e?.message ?? e}`);
  }

  const getknextResolutions = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    const deps = node.dependencies ?? {};
    for (const [name, info] of Object.entries(deps)) {
      if (name.startsWith(`${SCOPE}/`)) {
        getknextResolutions.push({ name, resolved: info?.resolved, version: info?.version });
      }
      walk(info);
    }
  }
  walk(tree);

  if (getknextResolutions.length === 0) {
    finish(FAIL, `no ${SCOPE}/* packages found in the install tree — nothing was installed`);
  }
  // core MUST be present; db + lib are its transitive deps and should also appear.
  const names = new Set(getknextResolutions.map((r) => r.name));
  if (!names.has(`${SCOPE}/core`)) {
    finish(FAIL, `${SCOPE}/core missing from resolved tree`);
  }
  for (const r of getknextResolutions) {
    // `resolved` may be undefined for the top-level requested spec on some npm
    // versions; when present it MUST be pkg.github.com. When absent, we still have
    // the pre-install scope assertion + the fact the scoped registry is the only
    // configured source for @getknext-dev — but we prefer a present, correct URL.
    if (r.resolved && !r.resolved.includes(TARBALL_HOST)) {
      finish(
        FAIL,
        `${r.name}@${r.version} resolved off ${r.resolved} — NOT ${TARBALL_HOST} ` +
          '(dependency-confusion / wrong-origin guard tripped)',
      );
    }
    console.log(
      `[ghp-install-smoke] origin-ok ${r.name}@${r.version} <= ${r.resolved ?? '(scoped registry)'}`,
    );
  }

  // --- CLI: the kn-next bin runs (`--help`, exit 0 + expected output) --------
  const binPath = join(workDir, 'node_modules', '.bin', 'kn-next');
  if (!existsSync(binPath)) finish(FAIL, `installed bin not found at ${binPath}`);
  console.log('[ghp-install-smoke] running `node <bin> --help` ...');
  const help = run('node', [binPath, '--help'], { cwd: workDir });
  const helpOut = `${help.stdout || ''}${help.stderr || ''}`;
  console.log('----- kn-next --help (begin) -----');
  console.log(helpOut.trim());
  console.log('----- kn-next --help (end) -------');
  if (help.status !== 0) finish(FAIL, `kn-next --help exited ${help.status} (expected 0)`);
  if (!/kn-next|Usage|Options/i.test(helpOut)) {
    finish(FAIL, "kn-next --help: exit 0 but output lacked 'kn-next'/'Usage'/'Options'");
  }

  // --- app-import: public subpaths resolve to real JS (mirrors install-smoke) -
  // Resolve the @getknext-dev/* subpaths against the registry-installed packages.
  // These mirror install-smoke.mjs's public app surface, rewritten to the GHP scope.
  // Scoped to what is PUBLISHED at 0.2.0 (do NOT hard-depend on P3b's ./validate).
  const subpaths = [
    `${SCOPE}/core`,
    `${SCOPE}/core/adapter`,
    `${SCOPE}/core/adapters/otel-config`,
    `${SCOPE}/core/adapters/cache-handler`,
    `${SCOPE}/lib`,
    `${SCOPE}/lib/clients`,
    `${SCOPE}/lib/health`,
    `${SCOPE}/lib/logger`,
    `${SCOPE}/db`,
    `${SCOPE}/db/schema`,
    `${SCOPE}/db/migrate`,
  ];
  console.log(`[ghp-install-smoke] resolving ${subpaths.length} public subpaths to real JS ...`);
  const resolveCheck = run(
    'node',
    [
      '--input-type=module',
      '-e',
      [
        "import { createRequire } from 'node:module';",
        "const require = createRequire(process.cwd() + '/x.js');",
        `const subs = ${JSON.stringify(subpaths)};`,
        'let fail = 0;',
        'for (const s of subs) {',
        '  try {',
        '    const r = require.resolve(s);',
        "    if (r.endsWith('.ts')) { console.error('RESOLVED-TO-TS', s, r); fail++; continue; }",
        "    console.log('resolve-ok', s);",
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
    finish(FAIL, 'one or more public @getknext-dev/* subpaths failed to resolve to real JS');
  }

  finish(
    PASS,
    `${SCOPE}/core@${version} installed from ${REGISTRY_HOST}; every @getknext-dev/* tarball ` +
      'origin verified on pkg.github.com; CLI runs and public app-import subpaths resolve to real JS',
  );
} catch (err) {
  finish(FAIL, `unexpected error: ${err?.message ?? err}`);
}
