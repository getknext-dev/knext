#!/usr/bin/env node
/**
 * osv-gate — run OSV-Scanner over every tracked bun.lock, Cargo.lock and go.mod,
 * and fail on a malicious package or a NEW high-severity vulnerability.
 *
 * The policy lives in `scripts/lib/osv-gate.mjs` (and is pinned by
 * `tests/osv-gate.test.ts`); this file only runs the scanner and wires I/O.
 *
 * Usage:
 *   node scripts/osv-gate.mjs --scanner <path-to-osv-scanner> [--base <sha>] [--full]
 *
 *   --base <sha>  the PR's base. Lockfiles are re-read at the MERGE BASE of <sha>
 *                 and HEAD, and a vulnerability only fails if it is absent there.
 *                 Empty, all-zero (a first push to a new branch) or unresolvable: fall
 *                 back to origin/integration/v2, then origin/main, so a HIGH still blocks.
 *                 If even those are missing the gate fails closed.
 *   --full        fail on EVERY HIGH/CRITICAL, not only new ones (the nightly view).
 *   --malicious-only  fail on malicious packages and ignore vulnerabilities (the
 *                 nightly lockfile re-scan, which must not red on known advisories).
 *
 * `go.sum` is not scanned: OSV-Scanner has no extractor for it. `go.mod` lists the
 * full module graph for modern Go, and `go.sum` only carries hashes for it.
 *
 * Exit: 0 clean; 1 findings; 2 the scan itself could not run or be read. An
 * unreachable OSV API surfaces as exit 2. It is never a pass.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluate,
  loadAllowlist,
  parseOsv,
  pickBase,
  renderReport,
  selectLockfiles,
} from './lib/osv-gate.mjs';
import { parseLockfile, renderUnscannable } from './lib/release-age.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);

function die(message) {
  console.error(`::error::osv-gate: ${message}`);
  process.exit(2);
}

/**
 * Run the scanner over `files` (paths relative to `root`) and return the findings.
 * osv-scanner exits 0 (clean) or 1 (vulnerabilities found); anything else, or a
 * missing/unparseable report, is a scan that did not happen.
 */
function scan(scanner, root, files) {
  // Every failure in here is a thrown Error, never process.exit, so the scratch
  // directory is always removed; main() maps the throw to exit code 2.
  const outDir = mkdtempSync(join(tmpdir(), 'osv-out-'));
  const outFile = join(outDir, 'report.json');
  try {
    const args = [
      'scan',
      'source',
      ...files.flatMap((f) => ['-L', f]),
      '--format',
      'json',
      '--output-file',
      outFile,
    ];
    const run = spawnSync(scanner, args, { cwd: root, encoding: 'utf8', timeout: 600_000 });
    if (run.error) throw new Error(`could not run ${scanner}: ${run.error.message}`);
    if (run.status !== 0 && run.status !== 1) {
      throw new Error(
        `osv-scanner exited ${run.status} (a scan that did not run is not a pass):\n${run.stderr}`,
      );
    }
    if (!existsSync(outFile)) throw new Error('osv-scanner wrote no report');
    return parseOsv(readFileSync(outFile, 'utf8'), realpathSync(root));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Materialise the lockfiles as they were at `ref` into a scratch tree. */
function checkoutLockfiles(ref, files) {
  const dir = mkdtempSync(join(tmpdir(), 'osv-base-'));
  const present = [];
  for (const f of files) {
    let content;
    try {
      content = execFileSync('git', ['show', `${ref}:${f}`], {
        cwd: REPO_ROOT,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue; // a lockfile the PR adds has no base side: everything in it is new
    }
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), content);
    present.push(f);
  }
  return { dir, present };
}

function main() {
  const scanner = arg('scanner');
  if (!scanner) die('--scanner <path> is required');
  const today = new Date().toISOString().slice(0, 10);

  let allowlist;
  try {
    allowlist = loadAllowlist(
      JSON.parse(readFileSync(resolve(REPO_ROOT, 'security/osv-allowlist.json'), 'utf8')),
      today,
    );
  } catch (err) {
    die(`security/osv-allowlist.json is unusable: ${err.message}`);
  }

  const files = selectLockfiles(
    execFileSync('git', ['ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean),
  );
  if (files.length === 0) die('no lockfiles found: refusing to report a scan of nothing as clean');
  console.log(`Scanning ${files.length} lockfile(s):\n${files.map((f) => `  ${f}`).join('\n')}`);

  const head = scan(scanner, REPO_ROOT, files);

  let base = null;
  if (!flag('full') && !flag('malicious-only')) {
    const resolves = (ref) => {
      try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
          cwd: REPO_ROOT,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    };
    const picked = pickBase({
      supplied: arg('base'),
      resolves,
      currentRef: process.env.GITHUB_REF_NAME ?? '',
    });
    if (picked === null) {
      throw new Error(
        'no base to compare against (not even origin/integration/v2 or origin/main): ' +
          'refusing to treat "nothing to compare" as "nothing new"',
      );
    }
    const mergeBase = execFileSync('git', ['merge-base', picked, 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const { dir, present } = checkoutLockfiles(mergeBase, files);
    try {
      base = present.length ? scan(scanner, dir, present) : [];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    console.log(`Compared against ${picked} (merge base ${mergeBase.slice(0, 12)}).`);
  }

  const maliciousOnly = flag('malicious-only');
  const result = evaluate({
    head: maliciousOnly ? head.filter((f) => f.malicious) : head,
    base,
    allowlist,
    today,
    full: flag('full'),
  });
  // OSV matches advisories by package name and version. A source dependency, a tarball
  // or a package from another registry is not reliably matched that way, so say what
  // this scan did NOT cover. The release-age gate fails a NEW one of these.
  const unscannable = renderUnscannable(
    files.flatMap((f) =>
      parseLockfile(f, readFileSync(resolve(REPO_ROOT, f), 'utf8')).map((e) => ({
        ...e,
        lockfile: f,
      })),
    ),
  );
  const report = [renderReport(result), unscannable].filter(Boolean).join('\n\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### OSV gate\n\n\`\`\`\n${report}\n\`\`\`\n`, {
      flag: 'a',
    });
  }
  process.exit(result.failures.length > 0 ? 1 : 0);
}

try {
  main();
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
}
