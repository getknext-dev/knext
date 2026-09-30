#!/usr/bin/env node
/**
 * pack-release-tarballs.mjs — the `pack` job's CLI entrypoint (#1614/#1616).
 *
 * `release.yml` used to pack the `@getknext/*` publishable group in THREE
 * separate places — the `audit` job (`bun pm pack`), the `ga-tarball-diff`
 * job (its own `npm pack`, from its own worktree-built HEAD), and the
 * `release` job itself (`verify-published-group.mjs --pre`, also its own
 * `npm pack`) — each from an independent `bun install` + build of the same
 * commit. The bytes were MEASURED byte-identical (#1616), but "measured
 * identical today" is not "provably the same artifact", and one of the three
 * (`audit`'s `bun pm pack`) was measurably NOT the same tool the real publish
 * uses (#1614).
 *
 * This script packs the fixed group EXACTLY ONCE, with `npm pack` (the tool
 * `changeset publish` shells to for a bun workspace — see
 * `rewrite-workspace-ranges.mjs`), and writes a `manifest.json` alongside the
 * tarballs recording each member's sha256 — so every downstream consumer
 * (`ga-tarball-diff`'s ga/HEAD side, `verify-published-group.mjs --pre`'s
 * drift check) verifies against the SAME bytes instead of re-packing its own.
 *
 * Assumes the caller already built the group (lib -> db -> core) in the SAME
 * checkout — this script only rewrites `workspace:` ranges and packs; it does
 * not build. Locally runnable: `node scripts/pack-release-tarballs.mjs --dest <dir>`.
 *
 * Usage:
 *   node scripts/pack-release-tarballs.mjs --dest <dir> [--manifest <path>]
 *   node scripts/pack-release-tarballs.mjs --dest <dir> --dirs packages/lib,packages/db,packages/kn-next
 *
 * `--dirs` is a comma-separated list of package directories (relative to the
 * repo root, or absolute) for lanes that pack a SUBSET of the fixed group
 * (the compat/e2e credential lanes pack lib+db+core only, never the
 * `kn-next` alias). Omit it to pack the canonical 4-member release group.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalPublishableGroup, packPublishableGroup } from './lib/pack-publishable-group.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/**
 * @param {string[]} argv
 * @returns {{dest: string, dirs: string | null, manifest: string | null}}
 */
export function parseArgs(argv) {
  /** @type {{dest: string | null, dirs: string | null, manifest: string | null}} */
  const opts = { dest: null, dirs: null, manifest: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dest') {
      i += 1;
      opts.dest = argv[i];
    } else if (arg === '--dirs') {
      i += 1;
      opts.dirs = argv[i];
    } else if (arg === '--manifest') {
      i += 1;
      opts.manifest = argv[i];
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  if (!opts.dest) throw new Error('--dest <dir> is required');
  return opts;
}

/**
 * Resolve the group to pack: the canonical 4-member release group by
 * default, or a `--dirs a,b,c` subset (each entry a package directory whose
 * `package.json` names it — the name is read from disk, never guessed from
 * the path, so it stays correct if a directory is ever renamed).
 *
 * @param {string | null} dirsArg
 * @param {string} repoRoot
 * @returns {Array<{name: string, dir: string}>}
 */
export function resolveGroup(dirsArg, repoRoot = REPO_ROOT) {
  if (!dirsArg) return canonicalPublishableGroup(repoRoot);
  return dirsArg.split(',').map((entry) => {
    const dir = resolve(repoRoot, entry.trim());
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (typeof pkg.name !== 'string') {
      throw new Error(`${dir}/package.json has no "name"`);
    }
    return { name: pkg.name, dir };
  });
}

/**
 * @param {Array<{name: string, dir: string, tarball: string, sha256: string}>} packed
 * @param {string} repoRoot
 * @returns {{packedAt: string, gitSha: string, packages: Array<{name: string, tarball: string, sha256: string}>}}
 */
export function buildManifest(packed, repoRoot = REPO_ROOT) {
  let gitSha = 'unknown';
  try {
    gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    // Best-effort only — an unresolvable git SHA (e.g. no .git present, a
    // packed-tarball-only environment) must not fail packing itself; the
    // consumer-side integrity check keys on sha256, not on gitSha.
  }
  return {
    packedAt: new Date().toISOString(),
    gitSha,
    packages: packed.map((p) => ({
      name: p.name,
      tarball: basename(p.tarball),
      sha256: p.sha256,
    })),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const group = resolveGroup(opts.dirs, REPO_ROOT);
  if (group.length === 0) {
    console.error('[pack-release-tarballs] ERROR: resolved an empty publishable group');
    process.exit(1);
  }
  mkdirSync(opts.dest, { recursive: true });

  console.log(
    `[pack-release-tarballs] packing ${group.length} package(s) with npm pack -> ${opts.dest}`,
  );
  const packed = packPublishableGroup(group, opts.dest, { cwd: REPO_ROOT });

  const manifest = buildManifest(packed, REPO_ROOT);
  const manifestPath = opts.manifest ?? join(opts.dest, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  for (const p of packed) {
    console.log(`[pack-release-tarballs] ${p.name} -> ${basename(p.tarball)} (sha256 ${p.sha256})`);
  }
  console.log(`[pack-release-tarballs] wrote ${manifestPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
