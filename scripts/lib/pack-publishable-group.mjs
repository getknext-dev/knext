#!/usr/bin/env node
/**
 * pack-publishable-group.mjs — THE single packer implementation for the
 * `@getknext/*` publishable-group credential lanes (#1614/#1616).
 *
 * BACKGROUND: `verify-published-group.mjs` and `ga-tarball-diff.mjs` already
 * pack with `npm pack` after `rewrite-workspace-ranges.mjs` — the SAME tool
 * `changeset publish` shells to for a bun workspace (`getPublishTool` only
 * knows npm/pnpm/yarn). Several OTHER lanes (`install-smoke.mjs`, and the
 * inline pack steps in `compat-vinext.yml` / `test-e2e-deploy.yml` /
 * `standalone-deploy-kind-e2e.yml`) instead pack with `bun pm pack`, which:
 *
 *   1. rewrites `workspace:^` from `bun.lock`'s recorded sibling version, not
 *      from the manifest `rewrite-workspace-ranges.mjs` derives from — a
 *      DIFFERENT (and, per #942 F1, sometimes stale) source of truth than the
 *      real publish tool uses;
 *   2. emits `@getknext/core`'s multi-`bin` target (`knext` + `kn-next`) as a
 *      DUPLICATE tar entry — measured during the #1562 rehearsal — which
 *      `npm pack` never produces.
 *
 * So those lanes install and exercise tarballs whose bytes differ from what
 * actually ships (#1614). This module gives every lane that does not need
 * bun's OWN staleness-detecting divergence (see `audit-published.mjs`'s
 * `packPublished`, which keeps `bun pm pack` on purpose, for exactly that
 * reason, and is therefore NOT migrated to this helper) one shared
 * implementation, so "which tool packs" cannot silently drift lane-by-lane
 * again.
 *
 * Locally runnable pieces; no workflow calls this file directly — see
 * `scripts/pack-release-tarballs.mjs` for the CLI entrypoint that wraps it.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Run `scripts/rewrite-workspace-ranges.mjs` against `cwd` — the SAME fix the
 * real publish job (`release.yml`) applies before `changeset publish`, so
 * whatever this module packs afterwards ships a resolvable `@getknext/*`
 * sibling range rather than a raw `workspace:` spec.
 *
 * @param {string} [cwd]
 */
export function rewriteWorkspaceRanges(cwd = REPO_ROOT) {
  execFileSync('node', [join(REPO_ROOT, 'scripts', 'rewrite-workspace-ranges.mjs')], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

/**
 * Pack ONE workspace package directory with `npm pack` into `destDir`.
 * Fails closed (throws) unless exactly one NEW `.tgz` appears — the same
 * "did this actually produce a tarball" assertion `install-smoke.mjs` and
 * `audit-published.mjs` already make for their own packers, generalized so a
 * silent `npm pack` no-op can never be mistaken for success.
 *
 * @param {string} pkgDir
 * @param {string} relOrAbsDestDir resolved against process.cwd() when relative
 * @returns {string} the absolute path of the tarball just produced
 */
export function npmPackOne(pkgDir, relOrAbsDestDir) {
  // npm resolves --pack-destination against ITS cwd (pkgDir), so a relative
  // destination must be anchored to the caller's cwd first.
  const destDir = resolve(relOrAbsDestDir);
  mkdirSync(destDir, { recursive: true });
  const before = new Set(readdirSync(destDir).filter((f) => f.endsWith('.tgz')));
  execFileSync('npm', ['pack', '--pack-destination', destDir, '--ignore-scripts'], {
    cwd: pkgDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const created = readdirSync(destDir).filter((f) => f.endsWith('.tgz') && !before.has(f));
  if (created.length !== 1) {
    throw new Error(
      `npm pack in ${pkgDir} produced ${created.length} new tarball(s) in ${destDir} ` +
        `(expected exactly 1): ${created.join(', ') || '<none>'}`,
    );
  }
  return join(destDir, created[0]);
}

/**
 * @param {string} path
 * @returns {string} lowercase hex sha256 of the file's bytes
 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * THE single packer for a publishable group: rewrite `workspace:` ranges
 * once, then `npm pack` every member into `destDir`.
 *
 * @param {Array<{name: string, dir: string}>} pkgs in the order they should
 *   be packed (build order matters for the caller; this function does not
 *   build)
 * @param {string} relOrAbsDestDir resolved against process.cwd() when relative
 * @param {{cwd?: string, rewrite?: boolean}} [opts] `rewrite: false` skips
 *   the workspace-range rewrite (e.g. when the caller already ran it, or the
 *   packages carry no `workspace:` ranges — never used by the real lanes
 *   today, kept for tests that want to isolate the pack step).
 * @returns {Array<{name: string, dir: string, tarball: string, sha256: string}>}
 */
export function packPublishableGroup(pkgs, destDir, opts = {}) {
  const { cwd = REPO_ROOT, rewrite = true } = opts;
  if (rewrite) rewriteWorkspaceRanges(cwd);
  return pkgs.map(({ name, dir }) => {
    const tarball = npmPackOne(dir, destDir);
    return { name, dir, tarball, sha256: sha256File(tarball) };
  });
}

/**
 * Read a `pack-release-tarballs.mjs`-written `manifest.json` from `dir`.
 * Fail-closed: a missing/unparseable manifest or one without a `packages`
 * array throws rather than being treated as "nothing to compare against".
 *
 * @param {string} dir
 * @returns {{packedAt?: string, gitSha?: string, packages: Array<{name: string, tarball: string, sha256: string}>}}
 */
export function readPackManifest(dir) {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`no manifest.json found in ${dir} — the pack-once artifact is missing`);
  }
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(parsed.packages)) {
    throw new Error(`${manifestPath}: no "packages" array`);
  }
  return parsed;
}

/**
 * Pure comparator (#1616): does a freshly-packed set of tarballs match the
 * shared pack-once artifact byte-for-byte? Used BEFORE the credentialed
 * publish to prove there is no drift between what was audited/diffed and
 * what is about to ship, without literally forwarding the artifact's bytes
 * into `changeset publish` (which packs from the live directory, not a
 * tarball file — see `release.yml`'s `release` job for why that gap is a
 * deliberate, documented deferral rather than an oversight).
 *
 * @param {Map<string, string>} freshByName package name -> sha256 of the
 *   JUST-packed tarball
 * @param {{packages: Array<{name: string, sha256: string}>}} manifest the
 *   pack-once artifact's manifest (see `readPackManifest`)
 * @returns {string[]} human-readable problems; empty means no drift
 */
export function tarballDriftProblems(freshByName, manifest) {
  const problems = [];
  const manifestByName = new Map(manifest.packages.map((p) => [p.name, p]));
  for (const [name, sha256] of freshByName) {
    const recorded = manifestByName.get(name);
    if (!recorded) {
      problems.push(`${name}: not present in the pack-once manifest`);
      continue;
    }
    if (recorded.sha256 !== sha256) {
      problems.push(
        `${name}: fresh sha256 ${sha256} does not match the pack-once manifest's ` +
          `${recorded.sha256} — DRIFT between what was audited/diffed and what is about to ship`,
      );
    }
  }
  for (const name of manifestByName.keys()) {
    if (!freshByName.has(name)) {
      problems.push(`${name}: present in the pack-once manifest but missing from the fresh pack`);
    }
  }
  return problems;
}

/**
 * The canonical `@getknext/*` changesets fixed group, in build order
 * (lib -> db -> core -> the unscoped `kn-next` alias, which has no build
 * step of its own). Mirrors the package list `install-smoke.mjs` and
 * `audit-published.mjs` hardcode, given one shared home so a new publishable
 * package needs updating in only one place going forward.
 *
 * @param {string} [repoRoot]
 * @returns {Array<{name: string, dir: string}>}
 */
export function canonicalPublishableGroup(repoRoot = REPO_ROOT) {
  return [
    { name: '@getknext/lib', dir: join(repoRoot, 'packages', 'lib') },
    { name: '@getknext/db', dir: join(repoRoot, 'packages', 'db') },
    { name: '@getknext/core', dir: join(repoRoot, 'packages', 'kn-next') },
    { name: 'kn-next', dir: join(repoRoot, 'packages', 'kn-next-alias') },
  ].filter((p) => existsSync(p.dir));
}
