#!/usr/bin/env node
/**
 * verify-rc-pack-parity.mjs — G3 nightly check (#1734, residual of #1614).
 *
 * WHY: the compat CREDENTIAL lanes (`test-e2e-deploy.yml`, `compat-vinext.yml`)
 * pack the `@getknext/*` publishable group with `bun pm pack`, while
 * `changeset publish` ships `npm pack` bytes (see `scripts/lib/pack-
 * publishable-group.mjs`'s header for the measured divergence). #1614 fixed
 * every lane this repo controls to pack with `npm pack` instead; the two
 * credential lanes above are deliberately OUT of scope — ADR-0056/ADR-0039
 * freeze them for the length of the compat-credential window, so changing
 * their packer would restart the 14-night window. This script MEASURES,
 * nightly, whether that frozen divergence is actually present in the bytes a
 * real user installs from npm for the pinned rc tag — it does not assume an
 * answer either way, and it never touches the credential harness itself.
 *
 * WHAT IT DOES, for the `rcTag` pinned in `.github/compat-credential-ref.json`:
 *   1. `git worktree add --detach` that tag into a scratch dir (never
 *      touches the caller's checkout).
 *   2. Packs the publishable group the way the CREDENTIAL LANES do — build
 *      with `bun run --filter <pkg> build` (lib -> db -> core), then
 *      `bun pm pack --destination` each of `packages/{lib,db,kn-next}` —
 *      copied verbatim from `test-e2e-deploy.yml`'s "Pack knext tarballs"
 *      step, so a future change to that step's exact commands is a prompt to
 *      update this one, not silent drift.
 *   3. Packs the SAME tree the npm way, reusing
 *      `scripts/lib/pack-publishable-group.mjs` (`rewrite-workspace-ranges`
 *      + `npm pack`) over the canonical 4-member group (adds the `kn-next`
 *      npx alias, which the credential lanes never pack).
 *   4. Downloads each published tarball for that exact version from the npm
 *      registry (`npm pack <name>@<version>`) — the real bytes a user
 *      installs.
 *   5. Compares (bun-packed vs registry) and (npm-packed vs registry),
 *      file-by-file, via `scripts/lib/pack-parity-diff.mjs` — byte content
 *      plus file list, ignoring tar metadata (mtime, mode, order).
 *
 * Exits 0 only when every comparison is byte-identical. Any non-identical
 * file is listed in the job summary AND on stderr; this never weakens to a
 * skip on drift — a real divergence is the finding this job exists to catch.
 *
 * Usage: node scripts/verify-rc-pack-parity.mjs [--rc-tag vX.Y.Z-rc.N]
 * (default: rcTag from .github/compat-credential-ref.json)
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePackedTarballEntries, formatPackParityReport } from './lib/pack-parity-diff.mjs';
import { canonicalPublishableGroup, packPublishableGroup } from './lib/pack-publishable-group.mjs';
import { readTarEntries } from './lib/tar-entries.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PIN_FILE = join(REPO_ROOT, '.github', 'compat-credential-ref.json');

// The exact three packages + exact `bun pm pack` invocation the credential
// lanes use (`test-e2e-deploy.yml` / `compat-vinext.yml`, "Pack knext
// tarballs" step). Kept in this literal shape — not derived — so a change to
// either workflow's step is a prompt to look here, not silent drift.
const BUN_PACKED_MEMBERS = [
  { name: '@getknext/lib', buildFilter: '@getknext/lib', dir: 'packages/lib' },
  { name: '@getknext/db', buildFilter: '@getknext/db', dir: 'packages/db' },
  { name: '@getknext/core', buildFilter: '@getknext/core', dir: 'packages/kn-next' },
];

const registry = [];
function cleanup() {
  for (const dir of registry) {
    try {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registry.push(dir);
  return dir;
}

function readRcTag(cliArg) {
  if (cliArg) return cliArg;
  const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'));
  if (typeof pin.rcTag !== 'string' || pin.rcTag.length === 0) {
    throw new Error(`${PIN_FILE}: rcTag is null or missing — nothing to verify`);
  }
  return pin.rcTag;
}

function versionFromRcTag(rcTag) {
  if (!rcTag.startsWith('v'))
    throw new Error(`rcTag ${JSON.stringify(rcTag)} does not start with "v"`);
  return rcTag.slice(1);
}

/** `git worktree add --detach` the tag into a fresh scratch dir. */
function checkoutTag(rcTag) {
  const worktreeDir = scratchDir('knext-pack-parity-wt-');
  rmSync(worktreeDir, { recursive: true, force: true }); // git worktree add requires it absent
  execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, rcTag], { cwd: REPO_ROOT });
  return worktreeDir;
}

/**
 * Pack the publishable group the way the CREDENTIAL LANES do: `bun pm pack`.
 *
 * Each member is packed into its OWN scratch dest dir, identified by a
 * before/after `readdirSync` diff (the same "did this actually produce a
 * tarball" pattern `npmPackOne` uses) — NOT by reading the tarball's
 * `package.json` with `readTarEntries`. `@getknext/core`'s `bun pm pack`
 * output is the measured #1562 bug itself (a duplicate `dist/cli/kn-next.js`
 * entry for its two `bin` keys), which `readTarEntries` fail-closed REJECTS;
 * identifying tarballs by filename, rather than by parsing their
 * (deliberately malformed) contents, means that bug surfaces later as a
 * reported comparison finding, never as a crash before the comparison runs.
 */
function bunPackMembers(worktreeDir) {
  execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: worktreeDir, stdio: 'inherit' });
  for (const m of BUN_PACKED_MEMBERS) {
    execFileSync('bun', ['run', '--filter', m.buildFilter, 'build'], {
      cwd: worktreeDir,
      stdio: 'inherit',
    });
  }
  const byName = new Map();
  for (const m of BUN_PACKED_MEMBERS) {
    const dest = scratchDir('knext-pack-parity-bun-dest-');
    const pkgDir = join(worktreeDir, m.dir);
    const before = new Set(readdirSync(dest).filter((f) => f.endsWith('.tgz')));
    execFileSync('bun', ['pm', 'pack', '--destination', dest], { cwd: pkgDir, stdio: 'inherit' });
    const created = readdirSync(dest).filter((f) => f.endsWith('.tgz') && !before.has(f));
    if (created.length !== 1) {
      throw new Error(
        `bun pm pack in ${pkgDir} produced ${created.length} new tarball(s) in ${dest} ` +
          `(expected exactly 1): ${created.join(', ') || '<none>'}`,
      );
    }
    byName.set(m.name, join(dest, created[0]));
  }
  return byName;
}

/**
 * The npm-pack side, reusing the one shared packer (#1614). Deliberately
 * does NOT use `packPublishableGroup`'s own `rewrite: true` default:
 * `rewriteWorkspaceRanges` shells to THIS CHECKOUT's own
 * `scripts/rewrite-workspace-ranges.mjs` by absolute path regardless of the
 * `cwd` it is given (that script resolves its own repo root from
 * `import.meta.url`, by design — see its header), so calling it with
 * `cwd: worktreeDir` would silently rewrite THIS repo's own manifests, not
 * the worktree's. Instead, invoke the WORKTREE's OWN copy via a RELATIVE
 * script path with `cwd` set to the worktree (the same trick
 * `scripts/ga-tarball-diff.mjs`'s `packRef` uses) so Node resolves
 * `import.meta.url` inside the worktree, then pack with `rewrite: false`
 * since the rewrite already happened.
 */
function npmPackMembers(worktreeDir) {
  execFileSync('node', ['scripts/rewrite-workspace-ranges.mjs'], {
    cwd: worktreeDir,
    stdio: 'inherit',
  });
  const group = canonicalPublishableGroup(worktreeDir);
  const dest = scratchDir('knext-pack-parity-npm-dest-');
  const packed = packPublishableGroup(group, dest, { cwd: worktreeDir, rewrite: false });
  const byName = new Map();
  for (const p of packed) byName.set(p.name, p.tarball);
  return byName;
}

/** Download the real published tarball for name@version from the npm registry. */
function downloadPublished(name, version) {
  const dest = scratchDir('knext-pack-parity-registry-dest-');
  execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', dest], {
    cwd: dest,
    stdio: 'inherit',
  });
  const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack ${name}@${version} produced no .tgz`);
  return join(dest, tgz);
}

/**
 * Compare two tarballs, tolerating a tarball that `readTarEntries` itself
 * refuses to read (e.g. the measured #1562 `bun pm pack` bug: a duplicate
 * tar entry for `@getknext/core`'s `dist/cli/kn-next.js`, which the multi-
 * `bin`-key target produces and `readTarEntries` fail-closed REJECTS rather
 * than silently de-duplicating). An unreadable tarball is itself a drift
 * finding — never a crash, and never silently skipped.
 *
 * @param {string} name
 * @param {string} aPath
 * @param {string} bPath
 * @param {{aLabel: string, bLabel: string}} sides
 * @returns {string | null} a report, or null when identical
 */
function compareTarballsSafely(name, aPath, bPath, sides) {
  let aEntries;
  let bEntries;
  try {
    aEntries = readTarEntries(aPath);
  } catch (err) {
    return `${name}: ${sides.aLabel} tarball is UNREADABLE (fails closed, itself a drift finding): ${err.message}`;
  }
  try {
    bEntries = readTarEntries(bPath);
  } catch (err) {
    return `${name}: ${sides.bLabel} tarball is UNREADABLE (fails closed, itself a drift finding): ${err.message}`;
  }
  const result = comparePackedTarballEntries(aEntries, bEntries);
  return formatPackParityReport(name, result, sides);
}

function writeSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const text = lines.join('\n');
  if (summaryPath) {
    appendFileSync(summaryPath, `${text}\n`);
  } else {
    console.log(text);
  }
}

function main() {
  const cliArg = process.argv.includes('--rc-tag')
    ? process.argv[process.argv.indexOf('--rc-tag') + 1]
    : undefined;
  const rcTag = readRcTag(cliArg);
  const version = versionFromRcTag(rcTag);

  console.log(`[verify-rc-pack-parity] rcTag=${rcTag} version=${version}`);

  const worktreeDir = checkoutTag(rcTag);
  try {
    const bunTarballs = bunPackMembers(worktreeDir);
    const npmTarballs = npmPackMembers(worktreeDir);

    const summaryLines = [
      '## RC pack parity (bun pm pack vs npm pack vs npm registry)',
      '',
      `rcTag: \`${rcTag}\` (version \`${version}\`)`,
      '',
    ];
    const failures = [];

    const allNames = new Set([...bunTarballs.keys(), ...npmTarballs.keys()]);
    for (const name of allNames) {
      const registryTarball = downloadPublished(name, version);

      if (bunTarballs.has(name)) {
        const report = compareTarballsSafely(name, bunTarballs.get(name), registryTarball, {
          aLabel: 'bun pm pack (credential-lane way)',
          bLabel: 'npm registry (published bytes)',
        });
        if (report) {
          failures.push(report);
          summaryLines.push(
            `### ${name}: bun pm pack vs registry — DIFFERS`,
            '',
            '```',
            report,
            '```',
            '',
          );
        } else {
          summaryLines.push(`### ${name}: bun pm pack vs registry — identical`, '');
        }
      }

      if (npmTarballs.has(name)) {
        const report = compareTarballsSafely(name, npmTarballs.get(name), registryTarball, {
          aLabel: 'npm pack (publish-tool way)',
          bLabel: 'npm registry (published bytes)',
        });
        if (report) {
          failures.push(report);
          summaryLines.push(
            `### ${name}: npm pack vs registry — DIFFERS`,
            '',
            '```',
            report,
            '```',
            '',
          );
        } else {
          summaryLines.push(`### ${name}: npm pack vs registry — identical`, '');
        }
      }
    }

    writeSummary(summaryLines);

    if (failures.length > 0) {
      console.error('\nFINDING: pack-byte drift detected:\n');
      for (const f of failures) console.error(f, '\n');
      process.exitCode = 1;
      return;
    }
    console.log('\nAll comparisons identical.');
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: REPO_ROOT });
    cleanup();
  }
}

main();
