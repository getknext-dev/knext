#!/usr/bin/env node
/**
 * audit-published.mjs — the npm/JS supply-chain gate (v4-P3).
 *
 * Container images are Trivy-gated before push (.github/workflows/supply-chain.yml,
 * operator-supply-chain.yml). The npm TARBALLS the release workflows publish —
 * `@getknext/{core,lib,db}` on npmjs (release.yml) and `@getknext-dev/{core,lib,db}`
 * on GitHub Packages (release-ghp.yml) — had NO equivalent gate. This script is
 * that gate, run as a publish-BLOCKING job in BOTH workflows (the publish job
 * `needs:` the audit job), closing a real .claude/rules/security.md gap ("scan
 * every image, fail on HIGH/CRITICAL; SBOM per image") extended to the published
 * JS dependency closure.
 *
 * WHAT IT AUDITS — the ACTUALLY-PUBLISHED PRODUCTION closure, not root devDeps:
 *   1. `bun pm pack` each published package (lib → db → core), then ASSERT the
 *      packed sibling ranges are coherent. bun (not npm) pack rewrites the
 *      `workspace:^` deps between them to a real range — but MEASURED (#942
 *      review, F1): it rewrites from the version BUN.LOCK records for the
 *      sibling, not from its package.json, and `changeset version` bumps only
 *      the manifests while `--frozen-lockfile` never refreshes the lock. So on
 *      the release after any bump the raw pack output would declare the
 *      PREVIOUS sibling range and npm would quietly satisfy it from the
 *      registry. `siblingRangeProblems` below dies loud on exactly that, so
 *      what we audit is provably the graph consumers are about to resolve.
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
 * SCOPE = the PUBLISHED set {@getknext/core, @getknext/lib, @getknext/db} (ADR-0020).
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
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const allowlistPath = resolve(repoRoot, 'security/npm-audit-allowlist.json');
const sbomOutDir = resolve(repoRoot, 'sbom');

// The PUBLISHED package set (ADR-0020), in dependency order (lib → db → core).
// The private UI package is excluded — it is in the changeset ignore list, never shipped.
const PUBLISHED = [
  { name: '@getknext/lib', dir: join(repoRoot, 'packages', 'lib') },
  { name: '@getknext/db', dir: join(repoRoot, 'packages', 'db') },
  { name: '@getknext/core', dir: join(repoRoot, 'packages', 'kn-next') },
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

/**
 * Pack a workspace package with `bun pm pack`. Was `pnpm pack` until the
 * workspace moved to bun (#926): without pnpm-workspace.yaml pnpm cannot
 * resolve `workspace:^` at all, so the old command was dead the moment the
 * lockfile left — the same class as the `pnpm install --frozen-lockfile`
 * steps this lane died on.
 *
 * NOTE the trade this makes (#942 review, F1): bun rewrites `workspace:^`
 * from bun.lock's recorded sibling version, where pnpm resolved from the
 * workspace manifests. The post-pack `siblingRangeProblems` assertion in
 * main() is what makes that difference loud instead of silent.
 */
function packPublished(dir, dest) {
  execFileSync('bun', ['pm', 'pack', '--destination', dest], {
    cwd: dir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

/** The scope whose sibling edges the post-pack assertion vouches for. */
const SIBLING_SCOPE = '@getknext/';

/** Parse `x.y.z` (an optional leading v tolerated); null when not that shape. */
function parseSemver(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Caret satisfaction for plain `^x.y.z` ranges — npm's rule: same major (same
 * minor when major is 0, same patch when major and minor are both 0), and the
 * version is >= the range's floor. Deliberately NOT a general semver engine:
 * anything the packer legitimately emits for a workspace sibling is a caret
 * over a release version, and any other shape is a question the caller must
 * fail closed on rather than have this function guess.
 */
function caretSatisfies(range, version) {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  const v = parseSemver(version);
  if (!m || !v) return false;
  const floor = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  if (v.major !== floor.major) return false;
  if (floor.major === 0 && v.minor !== floor.minor) return false;
  if (floor.major === 0 && floor.minor === 0 && v.patch !== floor.patch) return false;
  const cmp = v.major - floor.major || v.minor - floor.minor || v.patch - floor.patch;
  return cmp >= 0;
}

/**
 * The post-pack tripwire (#942 review, F1). Every packed manifest's
 * `@getknext/*` dependency must be satisfied by the CO-PACKED sibling —
 * otherwise the closure npm is about to install (and the audit + SBOM are
 * about to describe) contains a REGISTRY copy of some previous release, and
 * the publish-blocking gate certifies a graph nobody is publishing.
 *
 * Pure and exported so the drifted-lock shape stays pinned by
 * `tests/audit-published-sibling-ranges.test.ts`; fail-closed on any range
 * shape it cannot vouch for (a surviving `workspace:^` included). It also
 * guards FUTURE packer changes: whatever tool packs next, an incoherent
 * sibling edge dies here rather than in a consumer's install.
 *
 * @param {Array<{name: string, version: string,
 *   dependencies?: Record<string,string>,
 *   optionalDependencies?: Record<string,string>,
 *   peerDependencies?: Record<string,string>}>} manifests the PACKED manifests
 * @returns {string[]} human-readable problems; empty means coherent
 */
export function siblingRangeProblems(manifests) {
  const problems = [];
  const packedVersions = new Map(manifests.map((m) => [m.name, m.version]));
  for (const manifest of manifests) {
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dep, range] of Object.entries(manifest[group] ?? {})) {
        if (!dep.startsWith(SIBLING_SCOPE)) continue;
        const sibling = packedVersions.get(dep);
        if (sibling === undefined) {
          problems.push(
            `${manifest.name}@${manifest.version} ${group} on ${dep} (${range}), but ${dep} is ` +
              'not in the packed set — the #255/#256 shape: consumers can only 404 or fetch a ' +
              'stale registry copy',
          );
          continue;
        }
        if (!/^\^\d+\.\d+\.\d+$/.test(String(range).trim())) {
          problems.push(
            `${manifest.name}@${manifest.version} ${group} on ${dep} has range '${range}', which ` +
              'this gate cannot vouch for (expected ^x.y.z after pack rewriting) — a surviving ' +
              'workspace: spec or an unexpected packer output; investigate, do not widen this check',
          );
          continue;
        }
        if (!caretSatisfies(range, sibling)) {
          problems.push(
            `${manifest.name}@${manifest.version} declares ${dep}@'${range}' but the co-packed ` +
              `${dep} is ${sibling} — the drifted-bun.lock shape: npm would satisfy this from the ` +
              'REGISTRY and the audit/SBOM would describe the previous release. Refresh bun.lock ' +
              '(bun install) so the pack rewrites against the versions being published',
          );
        }
      }
    }
  }
  return problems;
}

/** Read `package/package.json` out of a packed tarball. */
function packedManifest(tarball) {
  const out = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  if (out.status !== 0 || !out.stdout) {
    die(
      `could not read package/package.json from ${tarball}: ${out.stderr || `exit ${out.status}`}`,
    );
  }
  try {
    return JSON.parse(out.stdout);
  } catch (err) {
    die(`packed manifest in ${tarball} is not valid JSON: ${err.message}`);
  }
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
  for (const pkg of PUBLISHED) packPublished(pkg.dir, tarballDir);
  const tarballs = readdirSync(tarballDir)
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => join(tarballDir, f));
  if (tarballs.length !== PUBLISHED.length) {
    die(`expected ${PUBLISHED.length} tarballs, got ${tarballs.length}`);
  }

  // #942 F1 — BEFORE anything installs: the packed sibling edges must point at
  // the tarballs beside them, not at some previous release on the registry.
  console.log('[audit-published] asserting packed sibling ranges are coherent…');
  const problems = siblingRangeProblems(tarballs.map(packedManifest));
  if (problems.length > 0) {
    die(
      `packed sibling ranges are INCOHERENT — auditing this closure would describe a graph ` +
        `nobody is publishing:\n  - ${problems.join('\n  - ')}`,
    );
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

// Entrypoint-guarded so the sibling-range test can import the pure helper
// without triggering a full pack+install+audit run. The workflows invoke this
// file directly (`node scripts/audit-published.mjs`), which still runs main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
