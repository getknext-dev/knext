#!/usr/bin/env node
/**
 * ga-tarball-diff.mjs — GA/rc-bump check (#1306, wired into `release.yml`'s
 * publish-blocking gate by #1562): the published `@getknext/*` tarballs must
 * differ from the rc.N tarballs the compat credential measured ONLY in
 * version fields.
 *
 * WHY: the v1.0 compatibility credential is a property of the `rc.N` tarballs
 * that were actually installed and exercised by the compat suite. Nothing
 * connects that measurement to what `npm publish` later ships under the GA
 * tag — if the GA tarball for `@getknext/core` (or `lib`/`db`, or the unscoped
 * `kn-next` npx alias, which is in the same changesets `fixed` group) differs from
 * its rc counterpart in anything beyond the version bump, the credential does
 * not cover the artifact users install. `scripts/ga-tarball-diff-gate.mjs` is
 * the `release.yml` wiring that decides WHEN to invoke this script; see that
 * file and `scripts/lib/ga-tarball-diff.mjs`'s `decideGaTarballDiffGate`
 * for why a mid-window rc bump is deliberately NOT gated by it even though
 * this script itself will happily compare one (see `validateVersionBump`).
 *
 * WHAT'S ALLOWED between an rc tree and its GA-or-later-rc counterpart
 * (`scripts/lib/ga-tarball-diff.mjs` has the precise rules): the top-level
 * `version` field in each package's `package.json`; a `@getknext/*` sibling
 * dependency RANGE that equals the rc range with the version substituted
 * (nothing looser); and the exact rc version string substituted for the
 * exact target version string, boundary-aware, at EVERY site it is embedded
 * in a built file's bytes. Anything else — an extra/missing/reordered
 * manifest key, a type/mode/symlink-target change on ANY tar entry, an entry
 * outside `package/`, a partial substitution, unexplained binary drift — is a
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
import { compareTarEntries, validateVersionBump } from './lib/ga-tarball-diff.mjs';
import { readTarEntries } from './lib/tar-entries.mjs';
import { publishablePackages, readWorkspaceManifests } from './publish-preflight.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// The scope is the PUBLISHED set (ADR-0020): @getknext/{lib,db,core} AND the
// unscoped `kn-next` npx alias (#1562 round 2 — it is in the changesets
// `fixed` group and ships at GA; its `bin/` forwarder is exactly what
// `npx kn-next` runs, so it must not drift from the rc undetected). Derived
// from the workspace manifests, same helper `install-smoke.mjs` and
// `audit-published.mjs` use, so a new publishable package is covered by
// construction rather than needing to be added to a list here.
function publishedPackageNames() {
  const manifests = readWorkspaceManifests(repoRoot);
  const changesetConfig = JSON.parse(
    readFileSync(join(repoRoot, '.changeset', 'config.json'), 'utf8'),
  );
  const ignore = Array.isArray(changesetConfig.ignore) ? changesetConfig.ignore : [];
  return publishablePackages(manifests, ignore).map((p) => p.name);
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
 * mirroring the REAL publish lane's tool choice (`release.yml`'s `release`
 * job) rather than `install-smoke.mjs`'s: build with `bun` (lib -> db ->
 * core), then run `scripts/rewrite-workspace-ranges.mjs` to resolve
 * `workspace:` sibling ranges to concrete versions, then pack with **`npm
 * pack`** — never `bun pm pack` — against a detached worktree checkout of
 * `ref` so the currently-checked-out tree is never touched.
 *
 * TWO REASONS `npm pack` IS DELIBERATE HERE, not a style choice
 * (rehearsal-discovered, #1562):
 *
 *   1. `changeset publish` shells to `npm publish` for a bun workspace
 *      (`getPublishTool` only knows npm/pnpm/yarn) — see
 *      `rewrite-workspace-ranges.mjs`'s own header for the measured
 *      `workspace:` leak this already fixes. Packing the SAME way the real
 *      publish does is the entire point of this script: it exists to prove
 *      what SHIPS, not what a different tool would have shipped.
 *   2. `bun pm pack` was measured (rehearsal, #1562) to emit
 *      `@getknext/core`'s `dist/cli/kn-next.js` as a DUPLICATE tar entry —
 *      `bin` maps both the `knext` and `kn-next` command names to that one
 *      file, and bun's packer adds the target once per bin key without
 *      de-duplicating. `assertEntrySafe`'s `readTarEntries` correctly
 *      REJECTS a duplicate path (by design, review round 2) — so packing
 *      with `bun pm pack` here made this gate permanently, incorrectly RED
 *      on every real GA cut, for a duplicate that plain `npm pack` never
 *      produces (measured: `npm pack` emits the file exactly once). The real
 *      published artifact was always fine; only this tool's packing choice
 *      was not faithful to it.
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
    // The `kn-next` npx alias has no build step (it ships its source `bin/`
    // forwarder verbatim) — packed, never built.
    const packOnly = [['kn-next', join(worktreeDir, 'packages', 'kn-next-alias')]];
    const byName = new Map();
    let built = false;
    for (const [, pkgDir] of order) {
      if (!existsSync(pkgDir)) continue; // ref predates this package
      if (!built) {
        execFileSync('bun', ['install', '--frozen-lockfile'], {
          cwd: worktreeDir,
          stdio: 'inherit',
        });
      }
      execFileSync('bun', ['run', 'build'], { cwd: pkgDir, stdio: 'inherit' });
      built = true;
    }

    // Rewrite `workspace:` ranges to concrete versions BEFORE packing — same
    // fix, same reason, as the real publish job (`release.yml`). Skipped
    // when nothing built at all (an empty-tree ref, see the CLI test for
    // that path) — the script would otherwise find nothing publishable and
    // no-op harmlessly either way, but there is nothing to rewrite for.
    if (built) {
      execFileSync('node', ['scripts/rewrite-workspace-ranges.mjs'], {
        cwd: worktreeDir,
        stdio: 'inherit',
      });
    }

    for (const [name, pkgDir] of [...order, ...packOnly]) {
      if (!existsSync(pkgDir)) continue; // ref predates this package
      const packDest = mkdtempSync(join(tmpdir(), `knext-ga-diff-pack-${label}-`));
      registry.push(packDest);
      execFileSync('npm', ['pack', '--pack-destination', packDest], {
        cwd: pkgDir,
        stdio: 'inherit',
      });
      const tgz = readdirSync(packDest)
        .filter((f) => f.endsWith('.tgz'))
        .map((f) => join(packDest, f))
        .sort()
        .at(-1);
      if (!tgz) throw new Error(`npm pack produced no .tgz for ${name} (${label})`);
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
  // Each SIDE (rc, ga) independently needs exactly one of {dir, ref} — NOT
  // "both sides use the same mode". #1616 needs a MIXED call
  // (`--rc-ref <tag> --ga-dir <pack-once artifact>`): the rc side still needs
  // a worktree build (a different commit than HEAD), but the ga/HEAD side
  // can consume the SAME pre-packed tarballs `release.yml`'s `pack` job
  // already produced for this exact commit, instead of building+packing HEAD
  // a second time. `runInner`, below, already resolves each side
  // independently (`opts.rcDir ? loadTarballDir(...) : packRef(...)`, same
  // for ga) — this was only ever a `parseArgs` restriction, not a `runInner`
  // one.
  const rcModes = [opts.rcDir, opts.rcRef].filter(Boolean).length;
  const gaModes = [opts.gaDir, opts.gaRef].filter(Boolean).length;
  if (rcModes !== 1) throw new Error('pass exactly one of --rc-dir or --rc-ref');
  if (gaModes !== 1) throw new Error('pass exactly one of --ga-dir or --ga-ref');
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

  // Lockstep (#1306 review item 6; shape widened to GA-or-rc-bump by #1562):
  // every package's rc/target version pair must itself be well-formed
  // ("X.Y.Z-rc.N" -> "X.Y.Z", "X.Y.Z-rc.N" -> "X.Y.Z-rc.M" with M > N, or an
  // identical pair), and every package in the set must carry the SAME pair —
  // otherwise "compared as one release" is false, and the sibling-range
  // substitution rule above has no fixed point.
  const versionPairs = new Map();
  for (const name of expected) {
    const rcVersion = rcByName.get(name).version;
    const gaVersion = gaByName.get(name).version;
    const err = validateVersionBump(rcVersion, gaVersion);
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
      log(`[ga-tarball-diff] FAIL: ${name} (rc ${rcVersion} -> target ${gaVersion})`);
      for (const v of result.violations) log(`  - ${v}`);
      allViolations.push(...result.violations.map((v) => `${name}: ${v}`));
    } else {
      log(
        `[ga-tarball-diff] OK: ${name} (rc ${rcVersion} -> target ${gaVersion}), ` +
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
