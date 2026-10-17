#!/usr/bin/env node
/**
 * audit-shipped-npm — re-scan the `@getknext/*` versions that are PUBLISHED, from
 * the registry, not from this checkout.
 *
 * `audit-published.mjs` gates the tarballs at publish time. An advisory filed next
 * week against a dependency we shipped last month is invisible to it, and the
 * version keeps being installed. This is the nightly half: for every distinct
 * version on every dist-tag of `@getknext/core` it installs the fixed group from
 * the registry into a scratch directory (production closure only, no scripts) and
 * runs three checks:
 *
 *   1. `npm audit --omit=dev`: fail on HIGH/CRITICAL, minus the dated and justified
 *      `security/npm-audit-allowlist.json` (the SAME file the publish gate uses);
 *   2. OSV-Scanner over the resolved `package-lock.json`: fail on a malicious
 *      package (`MAL-…`) or any HIGH/CRITICAL, minus `security/osv-allowlist.json`;
 *   3. `npm audit signatures`: fail if a registry signature or provenance
 *      attestation does not verify.
 *
 * FAIL LOUD. An unreachable registry, an install that fails, an `npm audit` error
 * document, a scanner that errors: all are failures, never a pass (exit 1 for
 * findings, 2 when a scan could not run). See `scripts/lib/shipped-scan.mjs`.
 *
 * Usage: node scripts/audit-shipped-npm.mjs --scanner <path-to-osv-scanner>
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
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
import { evaluate, loadAllowlist, parseOsv } from './lib/osv-gate.mjs';
import {
  failingNpmFindings,
  loadNpmAllowlist,
  NPM_GROUP,
  parseNpmAudit,
  parseNpmView,
  versionsToScan,
} from './lib/shipped-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org/';
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

class ScanCouldNotRun extends Error {}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function npm(args, cwd) {
  const res = spawnSync(npmBin, [...args, '--registry', REGISTRY], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  if (res.error) throw new ScanCouldNotRun(`npm ${args[0]} could not run: ${res.error.message}`);
  return res;
}

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));
}

/** Scan one published version. Returns a list of problem strings (empty = clean). */
function scanVersion({ version, tags }, scanner, npmAllowed, osvAllow, today) {
  const label = `${version} (${tags.join(', ')})`;
  const problems = [];
  const dir = mkdtempSync(join(tmpdir(), 'shipped-npm-'));
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'shipped-scan', version: '0.0.0', private: true }),
    );

    // The alias may not exist at an old version; only a POSITIVE not-found skips it.
    const pkgs = [];
    for (const name of NPM_GROUP) {
      const view = npm(['view', `${name}@${version}`, 'version', '--json'], dir);
      if (view.status === 0) {
        pkgs.push(`${name}@${version}`);
      } else if (name === 'kn-next' && /E404|code E404/.test(`${view.stdout}${view.stderr}`)) {
        console.log(`  ${name}@${version}: not published at this version, skipped`);
      } else {
        throw new ScanCouldNotRun(
          `npm view ${name}@${version} failed (exit ${view.status}): ${view.stderr || view.stdout}`,
        );
      }
    }

    const install = npm(
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...pkgs],
      dir,
    );
    if (install.status !== 0) {
      throw new ScanCouldNotRun(`npm install of ${label} failed:\n${install.stderr}`);
    }

    // 1. npm audit
    const audit = npm(['audit', '--omit=dev', '--audit-level=high', '--json'], dir);
    const report = parseNpmAudit(audit.stdout);
    const { failing, suppressed } = failingNpmFindings(report, npmAllowed);
    for (const s of suppressed) {
      console.log(
        `  ${label}: ${s.name} (${s.severity}) suppressed by allowlist: ${s.ids.join(', ')}`,
      );
    }
    for (const f of failing) {
      problems.push(`npm audit: ${f.name} [${f.severity}] ${f.ids.join(', ') || '(transitive)'}`);
    }

    // 2. OSV over the resolved lockfile
    const lock = join(dir, 'package-lock.json');
    if (!existsSync(lock)) throw new ScanCouldNotRun(`npm install of ${label} wrote no lockfile`);
    const outDir = mkdtempSync(join(tmpdir(), 'shipped-osv-'));
    const outFile = join(outDir, 'report.json');
    try {
      const osv = spawnSync(
        scanner,
        ['scan', 'source', '-L', 'package-lock.json', '--format', 'json', '--output-file', outFile],
        { cwd: dir, encoding: 'utf8', timeout: 600_000 },
      );
      if (osv.error) throw new ScanCouldNotRun(`osv-scanner could not run: ${osv.error.message}`);
      if (osv.status !== 0 && osv.status !== 1) {
        throw new ScanCouldNotRun(`osv-scanner exited ${osv.status}:\n${osv.stderr}`);
      }
      const findings = parseOsv(readFileSync(outFile, 'utf8'), realpathSync(dir));
      const result = evaluate({
        head: findings,
        base: null,
        allowlist: osvAllow,
        today,
        full: true,
      });
      for (const f of result.failures) {
        problems.push(
          `OSV: ${f.id}${f.malicious ? ' [MALICIOUS]' : ''} ${f.name}@${f.version}` +
            `${f.severity === null ? '' : ` CVSS ${f.severity}`}`,
        );
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }

    // 3. registry signatures and provenance attestations
    const sigs = npm(['audit', 'signatures'], dir);
    if (sigs.status !== 0) {
      problems.push(
        `npm audit signatures failed (exit ${sigs.status}): ${(sigs.stdout + sigs.stderr).trim().split('\n').slice(-6).join(' | ')}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { label, problems };
}

function main() {
  const scanner = arg('scanner');
  if (!scanner) throw new ScanCouldNotRun('--scanner <path> is required');
  const today = new Date().toISOString().slice(0, 10);
  const npmAllowed = loadNpmAllowlist(readJson('security/npm-audit-allowlist.json'), today);
  const osvAllow = loadAllowlist(readJson('security/osv-allowlist.json'), today);

  const view = npm(['view', '@getknext/core', 'dist-tags', '--json'], tmpdir());
  if (view.status !== 0) {
    throw new ScanCouldNotRun(
      `registry unreachable or package missing: ${view.stderr || view.stdout}`,
    );
  }
  const versions = versionsToScan(parseNpmView(view.stdout));
  console.log(
    `Re-scanning ${versions.length} published version(s) of @getknext/*: ` +
      versions.map((v) => `${v.version} [${v.tags.join(',')}]`).join(', '),
  );

  const results = [];
  for (const v of versions) {
    console.log(`\n== ${v.version} (${v.tags.join(', ')})`);
    results.push(scanVersion(v, scanner, npmAllowed, osvAllow, today));
  }

  const lines = [];
  let bad = 0;
  for (const r of results) {
    if (r.problems.length === 0) lines.push(`PASS ${r.label}`);
    else {
      bad += 1;
      lines.push(`FAIL ${r.label}`, ...r.problems.map((p) => `    - ${p}`));
    }
  }
  const text = lines.join('\n');
  console.log(`\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Published npm re-scan\n\n\`\`\`\n${text}\n\`\`\`\n`,
    );
  }
  process.exit(bad > 0 ? 1 : 0);
}

try {
  mkdirSync(tmpdir(), { recursive: true });
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`::error::audit-shipped-npm: ${message}`);
  process.exit(2);
}
