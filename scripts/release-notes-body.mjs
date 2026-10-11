#!/usr/bin/env node
/**
 * The body of the ONE readable GitHub release per version (#2153).
 *
 * `changesets/action` used to create four near-identical releases per version
 * (`@getknext/core@X`, `lib`, `db`, `kn-next`), each with a one-line body, while the
 * readable notes lived only in `docs/release/vX.Y.Z.md`. `release.yml` now turns the
 * per-package releases off and its `github-release` job publishes a single release on
 * the tag `vX.Y.Z`, whose body is generated here:
 *
 *   1. the notes file, verbatim;
 *   2. a rule, then a "Packages" table linking each package on npm and its
 *      CHANGELOG at the tag;
 *   3. a link to the notes file at the tag.
 *
 * It also decides the two flags `gh release create/edit` needs. `latest` is true
 * only for a STABLE version with no higher stable `vX.Y.Z` tag, so a 1.0.1 patch cut
 * after 1.3.0 does not steal the Latest badge, and a prerelease never gets it.
 *
 * Usage:
 *   node scripts/release-notes-body.mjs --repo <owner/repo> --out <file>
 *        [--tags-file <file>] [--root <repo root>] [--version <semver>]
 *   node scripts/release-notes-body.mjs --check [--root <repo root>] [--version <semver>]
 *
 * `--version` defaults to the version of `packages/kn-next` (the four publishable
 * packages are a changesets `fixed` group, so they carry one version).
 * `--tags-file` lists existing tags, one per line (`git tag --list 'v[0-9]*'`); it is
 * REQUIRED with `--out`, because assuming "no other tags" would mark any version latest.
 * `--check` verifies the notes file exists and is non-empty and writes nothing; the
 * credentialed `release` job runs it BEFORE publishing so a missing file fails while
 * nothing irreversible has happened yet.
 *
 * Outputs (appended to $GITHUB_OUTPUT when set): tag, title, prerelease, latest.
 * Exit 0 = ok. Exit 1 = refused (missing/empty notes, bad version). Exit 2 = usage.
 *
 * Node builtins only: the `github-release` job runs it with no install step
 * (`tests/workflow-script-install-guard.test.ts` scans for that).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The rows of the Packages table. `kn-next` (the `npx kn-next` forwarding alias) is
 * deliberately not a row: it carries no functionality of its own and the hand-made
 * releases this mirrors list the three real packages. `tests/release-notes-body.test.ts`
 * checks every `dir` holds a CHANGELOG.
 */
export const PACKAGES = [
  { name: '@getknext/core', dir: 'packages/kn-next' },
  { name: '@getknext/lib', dir: 'packages/lib' },
  { name: '@getknext/db', dir: 'packages/db' },
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;

function assertSemver(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(
      `version ${JSON.stringify(version)} is not plain semver (X.Y.Z or X.Y.Z-pre.N); it is used in a file path and in URLs`,
    );
  }
}

export function isPrerelease(version) {
  assertSemver(version);
  return version.includes('-');
}

/** Numeric X.Y.Z comparison (prerelease suffixes are not compared; callers pass stable versions). */
export function compareSemver(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * @param {string} version
 * @param {string[]} existingTags every tag in the repo; only `vX.Y.Z` (stable) ones count.
 */
export function releaseFlags(version, existingTags) {
  const prerelease = isPrerelease(version);
  if (prerelease) return { prerelease: true, latest: false };
  const higherStable = existingTags
    .map((tag) => STABLE_TAG.exec(tag.trim()))
    .filter((m) => m !== null)
    .some((m) => compareSemver(m[1], version) > 0);
  return { prerelease: false, latest: !higherStable };
}

export function notesRelPath(version) {
  assertSemver(version);
  return `docs/release/v${version}.md`;
}

/**
 * @param {{ version: string, notes: string, repo: string }} input
 */
export function buildBody({ version, notes, repo }) {
  assertSemver(version);
  const base = `https://github.com/${repo}/blob/v${version}`;
  const rows = PACKAGES.map(
    (p) =>
      `| \`${p.name}\` | [${version}](https://www.npmjs.com/package/${p.name}/v/${version}) | [CHANGELOG](${base}/${p.dir}/CHANGELOG.md) |`,
  );
  return [
    `${notes.trimEnd()}`,
    '',
    '---',
    '',
    '## Packages',
    '',
    '| Package | npm | Changelog |',
    '|---|---|---|',
    ...rows,
    '',
    `These notes are also in the repository at [\`${notesRelPath(version)}\`](${base}/${notesRelPath(version)}).`,
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (['--repo', '--out', '--tags-file', '--root', '--version'].includes(a)) {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      args[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      i += 1;
    } else throw new UsageError(`unknown argument ${a}`);
  }
  return args;
}

class UsageError extends Error {}

function readNotes(root, version) {
  const rel = notesRelPath(version);
  const full = join(root, rel);
  if (!existsSync(full)) {
    throw new Error(
      `release notes missing: ${rel} not found. Every published version needs readable notes there; they become the GitHub release body (see docs/RELEASING.md).`,
    );
  }
  const notes = readFileSync(full, 'utf8');
  if (notes.trim() === '') throw new Error(`release notes empty: ${rel} has no content`);
  return notes;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
    if (!args.check && (!args.repo || !args.out)) {
      throw new UsageError('--repo and --out are required (or pass --check)');
    }
  } catch (err) {
    console.error(`release-notes-body: ${err.message}`);
    return 2;
  }

  try {
    const root = resolve(args.root ?? REPO_ROOT);
    const version =
      args.version ??
      JSON.parse(readFileSync(join(root, 'packages/kn-next/package.json'), 'utf8')).version;
    assertSemver(version);
    const notes = readNotes(root, version);
    if (args.check) {
      console.log(`release notes present for v${version}: ${notesRelPath(version)}`);
      return 0;
    }
    if (!args.tagsFile) {
      throw new UsageError(
        '--tags-file is required with --out (assuming no other tags would mark any version latest)',
      );
    }
    const tags = readFileSync(args.tagsFile, 'utf8').split('\n');
    const flags = releaseFlags(version, tags);
    writeFileSync(args.out, buildBody({ version, notes, repo: args.repo }));
    const lines = [
      `tag=v${version}`,
      `title=knext v${version}`,
      `prerelease=${flags.prerelease}`,
      `latest=${flags.latest}`,
    ];
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
    console.log(lines.join('\n'));
    return 0;
  } catch (err) {
    console.error(`release-notes-body: ${err.message}`);
    return err instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
