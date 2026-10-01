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
 * THE QUESTION THIS ASKS (#1734 review refinement, not "are the two tarballs
 * byte-identical as archives"): does the credential lane's `bun pm pack`
 * tarball actually install to the SAME bytes the registry ships? A real
 * install extracts a tarball (`tar -x`/`npm install`), where a duplicate
 * path's LAST occurrence simply overwrites the earlier one on disk — so the
 * bun-pack side is read in duplicate-TOLERANT mode and compared as "what
 * would actually land on disk" against the registry. A path that occurs
 * more than once and whose copies all agree with each other is reported as
 * a non-failing STRUCTURAL NOTE (named #1562, the measured `bun pm pack`
 * multi-`bin`-key duplicate-entry quirk) — it does not, by itself, fail the
 * check. The check STILL fails if: any duplicate's copies disagree with
 * each other (an internally-inconsistent archive), the extracted (last-wins)
 * content differs from the registry, or the file lists differ. The STRICT
 * reader's own result (which `@getknext/core`'s known duplicate makes
 * UNREADABLE) is also recorded, as an informational line only — never a
 * failure on its own. The npm-pack vs registry comparison is unaffected by
 * any of this: it uses the strict reader on both sides, as before, and
 * fails loudly if it ever sees a duplicate (which would be a different,
 * undocumented problem).
 *
 * Exits 0 only when every comparison passes under the rules above. Any
 * finding (failing or merely a structural note) is listed in the job
 * summary; this never weakens to a skip on drift — a real divergence is the
 * finding this job exists to catch.
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
import {
  comparePackedTarballEntries,
  compareTarballEntriesTolerant,
  formatPackParityReport,
  formatTolerantPackParityReport,
} from './lib/pack-parity-diff.mjs';
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
 * Compare two tarballs with the STRICT reader on both sides (no tolerance
 * for a duplicate path — an unreadable tarball is itself reported as a
 * failure here). Used for the npm-pack vs registry comparison, which is
 * expected to never carry a #1562-shaped duplicate; if it ever does, that
 * is a different, undocumented problem and should fail loudly rather than
 * be absorbed by the bun-side tolerance below.
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

/**
 * Compare the CREDENTIAL-LANE (`bun pm pack`) tarball against the registry's
 * published tarball, #1562-aware (#1734 review refinement).
 *
 * Reads side A TWICE:
 *   - with the STRICT reader (no `allowDuplicates`) — purely informational,
 *     reported as an extra line, never a failure on its own. For
 *     `@getknext/core` this is expected to be UNREADABLE (the duplicate
 *     `dist/cli/<bin>.js` entry), which is exactly what motivates the
 *     tolerant comparison below; keeping this line makes that provenance
 *     visible rather than silently superseded.
 *   - with `{ allowDuplicates: true }`, which is what the TOLERANT
 *     comparison (`compareTarballEntriesTolerant`) actually judges: does a
 *     real install of this tarball (last-wins extraction) end up with the
 *     same files/content the registry ships, and — separately — are any
 *     duplicate copies internally consistent with each other.
 *
 * @param {string} name
 * @param {string} aPath the bun-packed tarball
 * @param {string} bPath the registry's tarball
 * @param {{aLabel: string, bLabel: string}} sides
 * @returns {{ identical: boolean, report: string | null }}
 */
function compareBunTarballToRegistryTolerant(name, aPath, bPath, sides) {
  const lines = [];
  try {
    const n = readTarEntries(aPath).length;
    lines.push(`strict reader: readable (${n} entries, no duplicate paths)`);
  } catch (err) {
    lines.push(`strict reader: UNREADABLE: ${err.message}`);
  }

  let allEntriesA;
  let entriesB;
  try {
    allEntriesA = readTarEntries(aPath, { allowDuplicates: true });
  } catch (err) {
    return {
      identical: false,
      report: [
        `${name}: ${sides.aLabel} tarball is UNREADABLE even in duplicate-tolerant mode ` +
          `(fails closed, itself a drift finding): ${err.message}`,
        ...lines,
      ].join('\n'),
    };
  }
  try {
    entriesB = readTarEntries(bPath);
  } catch (err) {
    return {
      identical: false,
      report: [
        `${name}: ${sides.bLabel} tarball is UNREADABLE (fails closed, itself a drift finding): ${err.message}`,
        ...lines,
      ].join('\n'),
    };
  }

  const result = compareTarballEntriesTolerant(allEntriesA, entriesB);
  const tolerantReport = formatTolerantPackParityReport(name, result, sides);
  const report = tolerantReport ? [tolerantReport, ...lines].join('\n') : null;
  return { identical: result.identical, report };
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
        const { identical, report } = compareBunTarballToRegistryTolerant(
          name,
          bunTarballs.get(name),
          registryTarball,
          {
            aLabel: 'bun pm pack (credential-lane way)',
            bLabel: 'npm registry (published bytes)',
          },
        );
        if (!identical) failures.push(report);
        if (report) {
          summaryLines.push(
            `### ${name}: bun pm pack vs registry — ${identical ? 'identical (with a structural note)' : 'DIFFERS'}`,
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
