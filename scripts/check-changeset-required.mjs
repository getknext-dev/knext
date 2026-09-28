#!/usr/bin/env node
/**
 * Require a changeset (or an explicit opt-out) on a PR that changes a
 * PUBLISHED package's shipped surface (#1615).
 *
 * WHY THIS EXISTS. Three PRs changed published-package behaviour and merged
 * with no `.changeset/*.md` (#1569 KNEXT_BUILD_ID, #1588 `init-ci`/
 * `ci-preflight`, #1575 the compile-cache cold-boot deadline). None showed up
 * in `packages/kn-next/CHANGELOG.md` or the rc.1 release notes until #1591
 * hand-backfilled them during a pre-merge sweep. Nothing caught the gap at
 * review time — a human has to separately notice "this touches shipped code"
 * and "where is the changeset?" This mirrors
 * `check-escalation-triggers.mjs`'s pattern for the same class of problem:
 * mechanically detect what can be detected, and require an explicit,
 * auditable opt-out (a label) for the rest — "rather than relying on someone
 * to self-report against their own interest" (`.claude/rules/workflow.md`).
 *
 * WHAT COUNTS AS "SHIPPED SURFACE". Derived from `.changeset/config.json`'s
 * `fixed` group (the packages changesets version together) and each of those
 * packages' `package.json` `files` allowlist — not hand-enumerated beyond
 * that:
 *   - a `files` entry of `"dist"` means the package SHIPS BUILD OUTPUT
 *     compiled from `src/`; `dist/` itself is not committed, so the watched
 *     root is `<pkg>/src/`.
 *   - any other `files` entry (`templates`, `bin`, ...) ships as-is, so the
 *     watched root is that directory verbatim.
 *   - a package's own `package.json` is always watched, but only fires when
 *     its PUBLIC surface changes (`bin`/`exports`/`files`/`main`/`types`/
 *     `typesVersions` — shared with `check-escalation-triggers.mjs`, which
 *     already carries the "a version bump alone must not fire" rationale).
 *
 * WHAT DOES NOT FIRE, deliberately (a guard that cries wolf gets worked
 * around): `__tests__/`, `*.test.*`/`*.spec.*`, and markdown files under a
 * watched root; anything under `dist/` itself (build output, not source);
 * a package's `CHANGELOG.md` (not under any watched root, so this is
 * self-consistent by construction — the changeset tooling's own generated
 * file never has to carry a changeset about itself); a package outside the
 * `fixed` group (e.g. `@getknext/ui`, which is `ignore`d in
 * `.changeset/config.json` and never publishes).
 *
 * ESCAPE HATCH, DELIBERATELY: the `no-changeset` label, mirroring
 * `design-gate:cleared` (`check-escalation-triggers.mjs`). It is auditable
 * (shows in the PR timeline with who added it and when) and cheap. The PR
 * should also carry a one-line reason in its description — that half is a
 * REVIEW convention (the spec reviewer's job, the same way the docs-delta
 * claim in workflow.md step 5 is verified by a human, not grepped), not
 * something this script parses; NLP-grading a "reason" would be a check that
 * looks precise and is not.
 *
 * SCOPE, per the issue: this is a NUDGE/GATE ON THE PR, not a release-lane
 * gate — the release lane (`version-pr`/`publish-preflight`) already has its
 * own coherent-group checks. This closes the earlier, cheaper catch point.
 *
 * PRE-RELEASE CAUTION: once `.changeset/pre.json` exists (changesets "pre"
 * mode, entered after #1591), adding a NEW changeset here bumps the *next*
 * prerelease (e.g. rc.2), not a stable release — see docs/RELEASING.md. The
 * check is still correct to require one: an rc that ships a behaviour change
 * with no changelog entry is the exact gap this closes, prerelease or not.
 *
 * Usage:
 *   node scripts/check-changeset-required.mjs --base <ref> [--head <ref>] [--json]
 *   (labels are read from $GITHUB_EVENT_PATH's pull_request.labels when set,
 *   or from --labels "a,b" for local/manual runs)
 *
 * Exit 0 = no fixed-group package touched, or touched-and-satisfied.
 * Exit 1 = a fixed-group package's shipped surface changed with neither a
 * changeset nor the `no-changeset` label.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNameStatus, publicSurfaceChanged } from './check-escalation-triggers.mjs';

/** The opt-out label, recorded on the PR the same way `design-gate:cleared` is. */
export const NO_CHANGESET_LABEL = 'no-changeset';

/**
 * `.changeset/config.json`'s `fixed` group is an array of arrays (changesets'
 * own schema); flatten and de-dupe it to the set of package names that
 * version together.
 *
 * @param {{ fixed?: string[][] }} changesetConfig
 * @returns {string[]}
 */
export function fixedGroupNames(changesetConfig) {
  return [...new Set((changesetConfig?.fixed ?? []).flat())];
}

/**
 * Derive the watched roots for every fixed-group package from its manifest's
 * `files` allowlist — the "do not hand-enumerate more than the roots" rule
 * from #1615.
 *
 * @param {{ fixed?: string[][] }} changesetConfig
 * @param {Record<string, { name?: string, files?: string[] }>} packageManifestsByDir
 *   keyed by repo-relative package directory (e.g. `"packages/kn-next"`)
 * @returns {Array<{ name: string, dir: string, watchDir?: string, manifestPath?: string }>}
 */
export function derivePackageRoots(changesetConfig, packageManifestsByDir) {
  const fixedNames = new Set(fixedGroupNames(changesetConfig));
  const roots = [];
  for (const [dir, manifest] of Object.entries(packageManifestsByDir ?? {})) {
    if (!manifest?.name || !fixedNames.has(manifest.name)) continue;
    for (const entry of manifest.files ?? []) {
      // "dist" is BUILD OUTPUT compiled from "src" and is not committed —
      // watch the source. Everything else in `files` ships verbatim.
      const watchDir = entry === 'dist' ? `${dir}/src/` : `${dir}/${entry}/`;
      roots.push({ name: manifest.name, dir, watchDir });
    }
    roots.push({ name: manifest.name, dir, manifestPath: `${dir}/package.json` });
  }
  return roots;
}

const TEST_DIR_RE = /(^|\/)__tests__\//;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const MARKDOWN_RE = /\.mdx?$/i;

/** Tests-only / docs-only paths never require a changeset, even under a watched root. */
export function isTestOrDocsOnly(path) {
  return TEST_DIR_RE.test(path) || TEST_FILE_RE.test(path) || MARKDOWN_RE.test(path);
}

/**
 * Which fixed-group packages does this diff touch on their SHIPPED surface?
 *
 * @param {string[]} changedPaths
 * @param {Array<{ name: string, watchDir?: string }>} roots
 * @param {Record<string, boolean>} manifestChanged package name -> did its
 *   package.json's PUBLIC surface change (see `publicSurfaceChanged`)
 * @returns {Set<string>}
 */
export function touchedPackages(changedPaths, roots, manifestChanged) {
  const hit = new Set();
  for (const path of changedPaths) {
    if (isTestOrDocsOnly(path)) continue;
    for (const root of roots) {
      if (root.watchDir && path.startsWith(root.watchDir)) hit.add(root.name);
    }
  }
  for (const [name, changed] of Object.entries(manifestChanged ?? {})) {
    if (changed) hit.add(name);
  }
  return hit;
}

/** A real changeset entry — `.changeset/*.md`, excluding the tool's own README. */
export function hasChangesetEntry(changedPaths) {
  return changedPaths.some((p) => /^\.changeset\/(?!README\.md$)[^/]+\.md$/.test(p));
}

export function hasNoChangesetLabel(labels) {
  return (labels ?? []).some((l) => l.trim().toLowerCase() === NO_CHANGESET_LABEL);
}

/**
 * Pure decision. No filesystem, no git, no process — the tests drive this
 * directly.
 *
 * @param {{
 *   changedPaths: string[],
 *   roots: Array<{ name: string, watchDir?: string }>,
 *   manifestChanged: Record<string, boolean>,
 *   labels: string[],
 *   hasChangeset: boolean,
 * }} input
 */
export function decide({ changedPaths, roots, manifestChanged, labels, hasChangeset }) {
  const packages = [...touchedPackages(changedPaths, roots, manifestChanged)].sort();
  if (packages.length === 0) {
    return { required: false, ok: true, packages };
  }
  if (hasChangeset) return { required: true, ok: true, via: 'changeset', packages };
  if (hasNoChangesetLabel(labels)) return { required: true, ok: true, via: 'label', packages };
  return { required: true, ok: false, packages };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function showJson(ref, path, cwd) {
  try {
    return JSON.parse(git(['show', `${ref}:${path}`], cwd));
  } catch {
    return null; // absent on that side is a legitimate answer
  }
}

function readJsonSafe(absPath) {
  try {
    return JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function discoverPackageDirs(repoRoot) {
  const pkgsDir = resolve(repoRoot, 'packages');
  if (!existsSync(pkgsDir)) return [];
  return readdirSync(pkgsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `packages/${e.name}`)
    .sort();
}

/**
 * Labels come from the PR event payload, not from `${{ }}`-interpolated shell
 * text — the same injection concern `check-escalation-triggers.mjs`'s workflow
 * step documents. Falls back to `--labels a,b` for local/manual runs, where
 * there is no event payload to read.
 */
function readLabels() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    const event = readJsonSafe(eventPath);
    const labels = event?.pull_request?.labels;
    if (Array.isArray(labels)) {
      return labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
    }
  }
  return (arg('labels', '') || '').split(',').filter(Boolean);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const base = arg('base');
  const head = arg('head', 'HEAD');
  if (!base) {
    console.error(
      'usage: check-changeset-required.mjs --base <ref> [--head <ref>] [--labels a,b] [--json]',
    );
    process.exit(2);
  }

  const changedPaths = parseNameStatus(
    git(['diff', '--name-status', `${base}...${head}`], repoRoot),
  ).map((c) => c.path);

  const changesetConfig = readJsonSafe(resolve(repoRoot, '.changeset/config.json')) ?? {};
  const dirs = discoverPackageDirs(repoRoot);
  const headManifests = {};
  for (const dir of dirs) {
    const manifest = readJsonSafe(resolve(repoRoot, dir, 'package.json'));
    if (manifest) headManifests[dir] = manifest;
  }
  const roots = derivePackageRoots(changesetConfig, headManifests);
  const fixedNames = new Set(fixedGroupNames(changesetConfig));

  const manifestChanged = {};
  for (const dir of dirs) {
    const manifestPath = `${dir}/package.json`;
    if (!changedPaths.includes(manifestPath)) continue;
    const name = headManifests[dir]?.name;
    if (!name || !fixedNames.has(name)) continue;
    const before = showJson(base, manifestPath, repoRoot);
    manifestChanged[name] = publicSurfaceChanged(before, headManifests[dir]);
  }

  const labels = readLabels();
  const hasChangeset = hasChangesetEntry(changedPaths);
  const verdict = decide({ changedPaths, roots, manifestChanged, labels, hasChangeset });
  const preReleaseActive = existsSync(resolve(repoRoot, '.changeset/pre.json'));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...verdict, preReleaseActive }, null, 2));
    process.exit(verdict.ok ? 0 : 1);
  }

  if (!verdict.required) {
    console.log('No published-package shipped surface touched in this diff.');
    process.exit(0);
  }

  console.log(`Shipped surface touched in: ${verdict.packages.join(', ')}`);

  if (verdict.ok) {
    console.log(
      verdict.via === 'changeset'
        ? '\n.changeset/*.md present. Passing.'
        : `\nAcknowledged: the \`${NO_CHANGESET_LABEL}\` label is present. Passing.`,
    );
    process.exit(0);
  }

  console.error(
    `\nThis PR changes a published package's shipped surface and carries no changeset:\n` +
      `  ${verdict.packages.join(', ')}\n\n` +
      'Add one with `pnpm changeset` (describe the change, commit the generated ' +
      '`.changeset/*.md`), or, if this genuinely does not need one, add the ' +
      `\`${NO_CHANGESET_LABEL}\` label AND a one-line reason in the PR description.\n\n` +
      (preReleaseActive
        ? 'NOTE: this repo is in changesets "pre" mode (`.changeset/pre.json` present) — a ' +
          'new changeset here versions the NEXT prerelease (e.g. rc.2), not a stable release. ' +
          'That is still the right outcome: an rc that ships a behaviour change with no ' +
          'changelog entry is exactly the gap this check exists to close. See docs/RELEASING.md.\n\n'
        : '') +
      'This check does not judge the change, only that it was recorded. See ' +
      'docs/RELEASING.md.',
  );
  process.exit(1);
}
