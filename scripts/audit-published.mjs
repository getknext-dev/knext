#!/usr/bin/env node
/**
 * audit-published.mjs — the npm/JS supply-chain gate (v4-P3).
 *
 * Container images are Trivy-gated before push (.github/workflows/supply-chain.yml,
 * operator-supply-chain.yml). The npm TARBALLS the release workflows publish —
 * `@knext/{core,lib,db}` on npmjs (release.yml) and `@getknext-dev/{core,lib,db}`
 * on GitHub Packages (release-ghp.yml) — had NO equivalent gate. This script is
 * that gate, run as a publish-BLOCKING job in BOTH workflows (the publish job
 * `needs:` the audit job), closing a real .claude/rules/security.md gap ("scan
 * every image, fail on HIGH/CRITICAL; SBOM per image") extended to the published
 * JS dependency closure.
 *
 * WHAT IT AUDITS — the ACTUALLY-PUBLISHED PRODUCTION closure, not root devDeps:
 *   1. `pnpm pack` each published package (lib → db → core). pnpm (not npm) pack
 *      rewrites the `workspace:^` deps between them to a real version range,
 *      EXACTLY what `changeset publish` does — so we audit the graph consumers
 *      actually resolve.
 *   2. Install all three tarballs together in a scratch dir OUTSIDE the repo with
 *      `--omit=dev` (auditing root devDeps — drizzle-kit, esbuild, vitest, biome,
 *      tsx — would be FALSE CONFIDENCE: none of it ships to consumers).
 *   3. `npm audit --omit=dev --audit-level=high --json` over that prod closure and
 *      FAIL on any HIGH/CRITICAL advisory (mirrors the Trivy HIGH/CRITICAL rule),
 *      minus advisories in the DATED + JUSTIFIED allowlist
 *      (security/npm-audit-allowlist.json — mirrors the Trivy triage discipline
 *      so the gate can't be silently neutered).
 *   4. Generate a CycloneDX JS SBOM (`@cyclonedx/cyclonedx-npm`, prod-only) per
 *      published package into sbom/ for the workflow to upload as an artifact.
 *
 * SCOPE = the PUBLISHED set {@knext/core, @knext/lib, @knext/db} (ADR-0020).
 * The private/changeset-ignored UI package (packages/ui) is deliberately OUT of
 * scope — it is never published, so it carries no consumer supply-chain risk.
 *
 * Locally runnable: `node scripts/audit-published.mjs`. The workflows just call it.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const allowlistPath = resolve(repoRoot, 'security/npm-audit-allowlist.json');
const sbomOutDir = resolve(repoRoot, 'sbom');

// The PUBLISHED package set (ADR-0020), in dependency order (lib → db → core).
// The private UI package is excluded — it is in the changeset ignore list, never shipped.
const PUBLISHED = [
  { name: '@knext/lib', dir: join(repoRoot, 'packages', 'lib') },
  { name: '@knext/db', dir: join(repoRoot, 'packages', 'db') },
  { name: '@knext/core', dir: join(repoRoot, 'packages', 'kn-next') },
];

// The audit threshold — HIGH and CRITICAL fail the gate (mirror security.md +
// the Trivy severity: HIGH,CRITICAL rule). Kept as string literals the
// contract test asserts verbatim.
const AUDIT_LEVEL = '--audit-level=high';
const OMIT_DEV = '--omit=dev';
const FAILING_SEVERITIES = new Set(['high', 'critical']);

let workDir;

function cleanup() {
  try {
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function die(message) {
  console.error(`\n[audit-published] FAIL: ${message}`);
  cleanup();
  process.exit(1);
}

function ok(message) {
  console.log(`\n[audit-published] PASS: ${message}`);
  cleanup();
  process.exit(0);
}

/** Load the dated+justified allowlist of accepted advisories. */
function loadAllowlist() {
  if (!existsSync(allowlistPath)) return new Set();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch (err) {
    die(`could not parse ${allowlistPath}: ${err.message}`);
  }
  const allow = Array.isArray(parsed.allow) ? parsed.allow : [];
  const today = new Date().toISOString().slice(0, 10);
  const ids = new Set();
  for (const entry of allow) {
    if (!entry || typeof entry.id !== 'string') {
      die('every allowlist entry must have a string `id` (a GHSA/advisory id)');
    }
    if (typeof entry.justification !== 'string' || entry.justification.length === 0) {
      die(`allowlist entry ${entry.id} must carry a non-empty justification`);
    }
    if (typeof entry.added !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.added)) {
      die(`allowlist entry ${entry.id} must carry an ISO added date (YYYY-MM-DD)`);
    }
    // An expired allowlist entry stops suppressing — an accepted risk must be
    // re-justified, not left to rot (mirror the Trivy dated-triage pattern).
    if (typeof entry.expires === 'string' && entry.expires < today) {
      console.log(
        `[audit-published] allowlist entry ${entry.id} EXPIRED (${entry.expires}) — no longer suppressed`,
      );
      continue;
    }
    ids.add(entry.id);
  }
  return ids;
}

/** Pack a workspace package with `pnpm pack` (rewrites workspace:^ like publish). */
function pnpmPack(dir, dest) {
  execFileSync('pnpm', ['pack', '--pack-destination', dest], {
    cwd: dir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function main() {
  const allowed = loadAllowlist();
  workDir = mkdtempSync(join(tmpdir(), 'knext-audit-'));
  const tarballDir = join(workDir, 'tarballs');
  const consumerDir = join(workDir, 'consumer');
  mkdirSync(tarballDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  mkdirSync(sbomOutDir, { recursive: true });

  console.log('[audit-published] packing the published set (lib → db → core)…');
  for (const pkg of PUBLISHED) pnpmPack(pkg.dir, tarballDir);
  const tarballs = readdirSync(tarballDir)
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => join(tarballDir, f));
  if (tarballs.length !== PUBLISHED.length) {
    die(`expected ${PUBLISHED.length} tarballs, got ${tarballs.length}`);
  }

  // Install the PROD closure only — outside the repo, no scripts, no audit yet.
  console.log('[audit-published] installing the production closure (--omit=dev)…');
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'knext-audit-consumer', private: true }),
  );
  const install = spawnSync(
    'npm',
    ['install', ...tarballs, OMIT_DEV, '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: consumerDir, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (install.status !== 0) die('installing the production closure failed');

  // ── Audit the prod closure. Fail on HIGH/CRITICAL (minus allowlist). ──────
  console.log(`[audit-published] npm audit ${OMIT_DEV} ${AUDIT_LEVEL} over the prod closure…`);
  const audit = spawnSync('npm', ['audit', OMIT_DEV, AUDIT_LEVEL, '--json'], {
    cwd: consumerDir,
    encoding: 'utf8',
  });
  // npm audit exits non-zero when it finds advisories at/above --audit-level.
  // We STILL parse the JSON either way — the allowlist may clear the finding.
  let report;
  try {
    report = JSON.parse(audit.stdout || '{}');
  } catch {
    die(`could not parse npm audit output:\n${audit.stdout}\n${audit.stderr}`);
  }
  const vulns = report.vulnerabilities ?? {};
  const failing = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (!FAILING_SEVERITIES.has(v.severity)) continue;
    // `via` entries carry the advisory. Object entries have a source id/url.
    const advisories = (Array.isArray(v.via) ? v.via : []).filter((x) => typeof x === 'object');
    // A vuln is suppressed only if EVERY contributing advisory is allowlisted.
    const ids = advisories.map((a) => advisoryId(a)).filter(Boolean);
    const allSuppressed = ids.length > 0 && ids.every((id) => allowed.has(id));
    if (allSuppressed) {
      console.log(
        `[audit-published] ${name} (${v.severity}) suppressed by allowlist: ${ids.join(', ')}`,
      );
      continue;
    }
    failing.push({ name, severity: v.severity, ids, advisories });
  }

  // ── SBOM per published package (CycloneDX, prod-only). ────────────────────
  console.log('[audit-published] generating CycloneDX SBOMs (prod-only) per published package…');
  for (const pkg of PUBLISHED) {
    const outFile = join(sbomOutDir, `${pkg.name.replace('@', '').replace('/', '-')}.cdx.json`);
    const sbom = spawnSync(
      'npx',
      [
        '--yes',
        '@cyclonedx/cyclonedx-npm@latest',
        '--omit',
        'dev',
        '--output-format',
        'JSON',
        '--output-file',
        outFile,
      ],
      { cwd: pkg.dir, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (sbom.status !== 0) die(`CycloneDX SBOM generation failed for ${pkg.name}`);
    console.log(`[audit-published] wrote SBOM ${outFile}`);
  }

  if (failing.length > 0) {
    console.error(
      '\n[audit-published] HIGH/CRITICAL advisories in the PUBLISHED production closure:',
    );
    for (const f of failing) {
      console.error(`  - ${f.name} [${f.severity}] ${f.ids.join(', ')}`);
    }
    die(
      `${failing.length} HIGH/CRITICAL advisory group(s) in the published prod closure. ` +
        'Bump the dependency, or add a DATED + JUSTIFIED entry to security/npm-audit-allowlist.json.',
    );
  }

  ok(
    'no un-allowlisted HIGH/CRITICAL advisories in the published production closure; SBOMs written to sbom/.',
  );
}

/** Extract a stable advisory id (GHSA/url) from an npm-audit `via` object. */
function advisoryId(a) {
  if (typeof a?.url === 'string') {
    const m = a.url.match(/GHSA-[0-9a-z-]+/i);
    if (m) return m[0];
    return a.url;
  }
  if (typeof a?.source === 'number' || typeof a?.source === 'string') return String(a.source);
  return '';
}

main();
