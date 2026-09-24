#!/usr/bin/env node
/**
 * ga-tarball-diff.mjs — GA check (#1306): the published v1.0 `@getknext/*`
 * tarballs must differ from the rc.N tarballs the compat credential measured
 * ONLY in version fields.
 *
 * WHY: the v1.0 compatibility credential is a property of the `rc.N` tarballs
 * that were actually installed and exercised by the compat suite. Nothing
 * connects that measurement to what `npm publish` later ships under the GA
 * tag — if the GA tarball for `@getknext/core` (or `lib`/`db`) differs from
 * its rc counterpart in anything beyond the version bump, the credential does
 * not cover the artifact users install. This script is that proof, not yet
 * wired into any release workflow (a release-workflow change is trigger-class
 * per `.claude/rules/workflow.md` — see the PR for the deferral note).
 *
 * WHAT'S ALLOWED between an rc tree and its GA counterpart
 * (`scripts/lib/ga-tarball-diff.mjs` has the precise rules): the top-level
 * `version` field in each package's `package.json`; a `@getknext/*` sibling
 * dependency RANGE that equals the rc range with the version substituted
 * (nothing looser); and the exact rc version string substituted for the
 * exact GA version string, boundary-aware, at EVERY site it is embedded in a
 * built file's bytes. Anything else — an extra/missing/reordered manifest
 * key, a type/mode/symlink-target change on ANY tar entry, an entry outside
 * `package/`, a partial substitution, unexplained binary drift — is a
 * failure, printed with a precise diff.
 *
 * This reads every entry with `node-tar` (`scripts/lib/tar-entries.mjs`) —
 * the SAME library `npm`/`pacote` use to extract — in list-only mode, rather
 * than a hand-written parser (a from-scratch reader disagreed with node-tar
 * on a crafted tarball in review; that class of parser-differential bug is
 * eliminated by construction by not having a second parser) or extracting to
 * disk and walking the result (a disk walk cannot see a symlink's target or
 * a file's mode, and a walk rooted at `<dest>/package` never even looks at
 * an entry the tarball placed OUTSIDE `package/`). Every entry, from every
 * tarball, is validated safe (`assertEntrySafe`, in
 * `scripts/lib/ga-tarball-diff.mjs`) before any comparison runs, so an unsafe
 * entry — an absolute path, a `..` traversal, a duplicate path, or a
 * symlink/hardlink target that escapes `package/` — is REJECTED outright,
 * not merely diffed.
 *
 * USAGE
 * -----
 *   # Compare two directories of already-packed tarballs (each containing the
 *   # @getknext/{core,lib,db} .tgz files for one side):
 *   node scripts/ga-tarball-diff.mjs --rc-dir <dir> --ga-dir <dir>
 *
 *   # Or pack two git refs (each ref is `git worktree add`-checked out and
 *   # built+packed the same way scripts/install-smoke.mjs does) and compare:
 *   node scripts/ga-tarball-diff.mjs --rc-ref v1.0.0-rc.3 --ga-ref v1.0.0
 *
 * Exits 0 on a clean diff (only version-field deltas found), 1 otherwise. An
 * unreadable/unsafe tarball entry, a missing/extra package, a non-lockstep
 * version pair, or an extra/missing tar entry is a failure, never a skip.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareTarEntries, validateVersionPair } from './lib/ga-tarball-diff.mjs';
import { readTarEntries } from './lib/tar-entries.mjs';
import { publishablePackages, readWorkspaceManifests } from './publish-preflight.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// The scope is the PUBLISHED set (ADR-0020): @getknext/{lib,db,core}. Derived
// from the workspace manifests, same helper `install-smoke.mjs` and
// `audit-published.mjs` use, so a new publishable package is covered by
// construction rather than needing to be added to a list here.
function publishedPackageNames() {
  const manifests = readWorkspaceManifests(repoRoot);
  const changesetConfig = JSON.parse(
    readFileSync(join(repoRoot, '.changeset', 'config.json'), 'utf8'),
  );
  const ignore = Array.isArray(changesetConfig.ignore) ? changesetConfig.ignore : [];
  // The npx alias (`kn-next`) is out of scope here — it ships no built code of
  // its own (one forwarding shim), so it carries no embedded-version surface
  // beyond its manifest, which the package.json rules already cover uniformly.
  return publishablePackages(manifests, ignore)
    .map((p) => p.name)
    .filter((name) => name.startsWith('@getknext/'));
}

const registry = [];
function cleanup() {
  for (const dir of registry) {
    try {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Read a .tgz's full tar-entry inventory PLUS its package name/version,
 * using `node-tar` (the same library `npm`/`pacote` extract with) in
 * list-only mode — no filesystem extraction. Every entry is
 * `assertEntrySafe`-validated later, inside `compareTarEntries`; this only
 * needs the one legitimate `package/package.json` entry to identify the
 * package.
 */
function loadTarball(tgzPath) {
  const entries = readTarEntries(tgzPath);
  const pkgEntry = entries.find((e) => e.name === 'package/package.json' && e.type === 'file');
  if (!pkgEntry) {
    throw new Error(`${tgzPath}: no "package/package.json" entry found`);
  }
  let pkg;
  try {
    pkg = JSON.parse(pkgEntry.data.toString('utf8'));
  } catch (err) {
    throw new Error(`${tgzPath}: unreadable package.json: ${err.message}`);
  }
  if (typeof pkg.name !== 'string') throw new Error(`${tgzPath}: package.json has no "name"`);
  if (typeof pkg.version !== 'string') throw new Error(`${tgzPath}: package.json has no "version"`);
  return { name: pkg.name, version: pkg.version, entries };
}

/** Group every .tgz in `dir` by the package name read from inside it. */
function loadTarballDir(dir, label) {
  if (!existsSync(dir)) throw new Error(`${label} directory does not exist: ${dir}`);
  const tgzFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => join(dir, f));
  if (tgzFiles.length === 0) throw new Error(`${label} directory has no .tgz files: ${dir}`);

  const byName = new Map();
  for (const tgz of tgzFiles) {
    const loaded = loadTarball(tgz);
    if (byName.has(loaded.name)) {
      throw new Error(`${label}: more than one tarball claims package "${loaded.name}" (${dir})`);
    }
    byName.set(loaded.name, loaded);
  }
  return byName;
}

/**
 * Pack the three publishable packages from a git ref into fresh tarballs,
 * mirroring `scripts/install-smoke.mjs`'s build (lib -> db -> core) + `bun pm
 * pack` sequence, but against a detached worktree checkout of `ref` so the
 * currently-checked-out tree is never touched.
 */
function packRef(ref, label) {
  const worktreeDir = mkdtempSync(join(tmpdir(), `knext-ga-diff-wt-${label}-`));
  registry.push(worktreeDir);
  // Remove the empty dir `mkdtemp` created — `git worktree add` requires the
  // target not already exist.
  rmSync(worktreeDir, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, ref], { cwd: repoRoot });

  try {
    const order = [
      ['@getknext/lib', join(worktreeDir, 'packages', 'lib')],
      ['@getknext/db', join(worktreeDir, 'packages', 'db')],
      ['@getknext/core', join(worktreeDir, 'packages', 'kn-next')],
    ];
    const byName = new Map();
    for (const [name, pkgDir] of order) {
      if (!existsSync(pkgDir)) continue; // ref predates this package
      execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: worktreeDir, stdio: 'inherit' });
      execFileSync('bun', ['run', 'build'], { cwd: pkgDir, stdio: 'inherit' });
      const packDest = mkdtempSync(join(tmpdir(), `knext-ga-diff-pack-${label}-`));
      registry.push(packDest);
      execFileSync('bun', ['pm', 'pack', '--destination', packDest], {
        cwd: pkgDir,
        stdio: 'inherit',
      });
      const tgz = readdirSync(packDest)
        .filter((f) => f.endsWith('.tgz'))
        .map((f) => join(packDest, f))
        .sort()
        .at(-1);
      if (!tgz) throw new Error(`bun pm pack produced no .tgz for ${name} (${label})`);
      byName.set(name, loadTarball(tgz));
    }
    return byName;
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: repoRoot });
  }
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--rc-dir') opts.rcDir = argv[++i];
    else if (arg === '--ga-dir') opts.gaDir = argv[++i];
    else if (arg === '--rc-ref') opts.rcRef = argv[++i];
    else if (arg === '--ga-ref') opts.gaRef = argv[++i];
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  const hasDirMode = opts.rcDir && opts.gaDir;
  const hasRefMode = opts.rcRef && opts.gaRef;
  if (hasDirMode === hasRefMode) {
    throw new Error('pass exactly one of --rc-dir/--ga-dir or --rc-ref/--ga-ref');
  }
  return opts;
}

export function run(argv, { log = console.log } = {}) {
  try {
    return runInner(argv, log);
  } finally {
    cleanup();
  }
}

function runInner(argv, log) {
  const opts = parseArgs(argv);
  const expected = publishedPackageNames();

  const rcByName = opts.rcDir ? loadTarballDir(opts.rcDir, 'rc') : packRef(opts.rcRef, 'rc');
  const gaByName = opts.gaDir ? loadTarballDir(opts.gaDir, 'ga') : packRef(opts.gaRef, 'ga');

  const rcNames = new Set(rcByName.keys());
  const gaNames = new Set(gaByName.keys());
  const allViolations = [];

  for (const name of expected) {
    if (!rcNames.has(name)) allViolations.push(`missing from rc set: ${name}`);
    if (!gaNames.has(name)) allViolations.push(`missing from GA set: ${name}`);
  }
  for (const name of rcNames) {
    if (!expected.includes(name))
      allViolations.push(`rc set contains an unexpected package: ${name}`);
  }
  for (const name of gaNames) {
    if (!expected.includes(name))
      allViolations.push(`GA set contains an unexpected package: ${name}`);
  }

  if (allViolations.length > 0) {
    for (const v of allViolations) log(`[ga-tarball-diff] FAIL: ${v}`);
    return 1;
  }

  const siblingNames = new Set(expected);

  // Lockstep (#1306 review item 6): every package's rc/GA version must itself
  // be well-formed ("X.Y.Z-rc.N" -> "X.Y.Z"), and every package in the set
  // must carry the SAME pair — otherwise "compared as one release" is false,
  // and the sibling-range substitution rule above has no fixed point.
  const versionPairs = new Map();
  for (const name of expected) {
    const rcVersion = rcByName.get(name).version;
    const gaVersion = gaByName.get(name).version;
    const err = validateVersionPair(rcVersion, gaVersion);
    if (err) {
      allViolations.push(`${name}: ${err}`);
      continue;
    }
    versionPairs.set(name, { rcVersion, gaVersion });
  }
  if (allViolations.length > 0) {
    for (const v of allViolations) log(`[ga-tarball-diff] FAIL: ${v}`);
    return 1;
  }
  const distinctPairs = new Set(
    [...versionPairs.values()].map((p) => `${p.rcVersion}=>${p.gaVersion}`),
  );
  if (distinctPairs.size > 1) {
    log(
      `[ga-tarball-diff] FAIL: packages are not moving in lockstep: ${[...distinctPairs].join(', ')}`,
    );
    return 1;
  }

  let anyEmbedded = 0;

  for (const name of expected) {
    const { rcVersion, gaVersion } = versionPairs.get(name);
    const rcEntries = rcByName.get(name).entries;
    const gaEntries = gaByName.get(name).entries;

    let result;
    try {
      result = compareTarEntries(rcEntries, gaEntries, { rcVersion, gaVersion, siblingNames });
    } catch (err) {
      log(`[ga-tarball-diff] FAIL: ${name}: ${err.message}`);
      allViolations.push(`${name}: ${err.message}`);
      continue;
    }

    if (!result.ok) {
      log(`[ga-tarball-diff] FAIL: ${name} (rc ${rcVersion} -> GA ${gaVersion})`);
      for (const v of result.violations) log(`  - ${v}`);
      allViolations.push(...result.violations.map((v) => `${name}: ${v}`));
    } else {
      log(
        `[ga-tarball-diff] OK: ${name} (rc ${rcVersion} -> GA ${gaVersion}), ` +
          `${result.embeddedVersionSites.length} embedded-version site(s): ` +
          `${result.embeddedVersionSites.join(', ') || 'none'}`,
      );
      anyEmbedded += result.embeddedVersionSites.length;
    }
  }

  if (allViolations.length > 0) {
    log(`[ga-tarball-diff] FAIL: ${allViolations.length} violation(s) found`);
    return 1;
  }
  log(
    `[ga-tarball-diff] PASS: GA tarballs differ from rc only in version fields ` +
      `(${anyEmbedded} total embedded-version site(s) across ${expected.length} package(s))`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    console.error(`[ga-tarball-diff] ERROR: ${err.message}`);
    process.exit(1);
  }
}
