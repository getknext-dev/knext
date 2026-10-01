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

/** Pack the publishable group the way the CREDENTIAL LANES do: bun pm pack. */
function bunPackMembers(worktreeDir) {
  execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: worktreeDir, stdio: 'inherit' });
  for (const m of BUN_PACKED_MEMBERS) {
    execFileSync('bun', ['run', '--filter', m.buildFilter, 'build'], {
      cwd: worktreeDir,
      stdio: 'inherit',
    });
  }
  const dest = scratchDir('knext-pack-parity-bun-dest-');
  const byName = new Map();
  for (const m of BUN_PACKED_MEMBERS) {
    const pkgDir = join(worktreeDir, m.dir);
    execFileSync('bun', ['pm', 'pack', '--destination', dest], { cwd: pkgDir, stdio: 'inherit' });
  }
  for (const m of BUN_PACKED_MEMBERS) {
    byName.set(m.name, findTarballFor(dest, m.name));
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

/** Find the single .tgz in `dir` that belongs to `name`, by reading its package.json. */
function findTarballFor(dir, name) {
  const candidates = readdirSync(dir).filter((f) => f.endsWith('.tgz'));
  for (const f of candidates) {
    const tgz = join(dir, f);
    const entries = readTarEntries(tgz);
    const pkgEntry = entries.find((e) => e.name === 'package/package.json' && e.type === 'file');
    if (!pkgEntry) continue;
    const pkg = JSON.parse(pkgEntry.data.toString('utf8'));
    if (pkg.name === name) return tgz;
  }
  throw new Error(
    `no tarball for ${name} found in ${dir} (candidates: ${candidates.join(', ') || '<none>'})`,
  );
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
      const registryEntries = readTarEntries(registryTarball);

      if (bunTarballs.has(name)) {
        const result = comparePackedTarballEntries(
          readTarEntries(bunTarballs.get(name)),
          registryEntries,
        );
        const report = formatPackParityReport(name, result, {
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
        const result = comparePackedTarballEntries(
          readTarEntries(npmTarballs.get(name)),
          registryEntries,
        );
        const report = formatPackParityReport(name, result, {
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
