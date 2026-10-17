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
 *                 Without it only malicious packages fail (a push to a branch).
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
  discoverLockfiles,
  evaluate,
  loadAllowlist,
  parseOsv,
  renderReport,
} from './lib/osv-gate.mjs';

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
  const outFile = join(mkdtempSync(join(tmpdir(), 'osv-out-')), 'report.json');
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
  if (run.error) die(`could not run ${scanner}: ${run.error.message}`);
  if (run.status !== 0 && run.status !== 1) {
    die(`osv-scanner exited ${run.status} (a scan that did not run is not a pass):\n${run.stderr}`);
  }
  if (!existsSync(outFile)) die('osv-scanner wrote no report');
  try {
    return parseOsv(readFileSync(outFile, 'utf8'), realpathSync(root));
  } catch (err) {
    return die(err.message);
  } finally {
    rmSync(dirname(outFile), { recursive: true, force: true });
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

  const files = discoverLockfiles(REPO_ROOT);
  if (files.length === 0) die('no lockfiles found: refusing to report a scan of nothing as clean');
  console.log(`Scanning ${files.length} lockfile(s):\n${files.map((f) => `  ${f}`).join('\n')}`);

  const head = scan(scanner, REPO_ROOT, files);

  let base = null;
  const baseSha = arg('base');
  if (baseSha && !/^0+$/.test(baseSha) && !flag('full')) {
    const mergeBase = execFileSync('git', ['merge-base', baseSha, 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const { dir, present } = checkoutLockfiles(mergeBase, files);
    try {
      base = present.length ? scan(scanner, dir, present) : [];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    console.log(`Compared against merge base ${mergeBase.slice(0, 12)}.`);
  }

  const maliciousOnly = flag('malicious-only');
  const result = evaluate({
    head: maliciousOnly ? head.filter((f) => f.malicious) : head,
    base,
    allowlist,
    today,
    full: flag('full'),
  });
  console.log(renderReport(result));
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### OSV gate\n\n\`\`\`\n${renderReport(result)}\n\`\`\`\n`,
      {
        flag: 'a',
      },
    );
  }
  process.exit(result.failures.length > 0 ? 1 : 0);
}

main();
