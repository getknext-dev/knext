#!/usr/bin/env node
/**
 * precompile-closure-audit.mjs — the vinext pre-compile-closure supply-chain
 * gate (ADR-0042 Consequence 6, #764).
 *
 * A `bun build --compile --bytecode` binary is opaque to syft and Trivy. Scan
 * the vinext image and you see Alpine packages and nothing else — every JS
 * dependency (react, vinext, nitro, the app) is inside one executable. ADR-0042
 * rejected `FROM scratch` for exactly this vacuity; full `noExternal` inlining
 * completes it by deleting the last externalised sliver. C6 therefore binds the
 * vinext path to an SBOM + HIGH/CRITICAL scan of the PRE-COMPILE CLOSURE: the
 * resolved node_modules tree that feeds `vite build`.
 *
 * WHAT THIS DOES, in order (each step gates the next):
 *   1. Walk the INSTALLED closure directory — not the lockfile. A lockfile is a
 *      claim about what should be installed; the tree is what `vite build`
 *      actually reads, including anything install scripts materialised.
 *      MEASURED on examples/bun-exec: `trivy fs` sees `bun.lock` and 60
 *      packages, the tree holds 408, and the 348 it never looked at included a
 *      HIGH (nanoid 3.3.17, since bumped via a `nanoid` override).
 *   2. syft → CycloneDX JSON over that tree, WITH
 *      `--select-catalogers +javascript-package-cataloger`. That flag is
 *      load-bearing and its absence is silent: syft's default catalogers for a
 *      directory source produce a valid SBOM with ZERO npm components.
 *   3. VERIFY the SBOM actually covers the tree (scripts/lib/precompile-closure.mjs):
 *      floors on both the component count and the installed count, a coverage
 *      ratio, and named toolchain anchors. This is the "a scan that went green
 *      because it scanned nothing must red" guard — the repo's standing rule
 *      that a guard which stays green when its subject is removed is decoration.
 *   4. grype over that exact SBOM (not over the directory again — scanning the
 *      same artifact is what makes "the scan covered the closure" provable
 *      rather than asserted), failing on HIGH/CRITICAL minus the dated +
 *      justified allowlist in security/precompile-closure-allowlist.json.
 *
 * grype rather than Trivy for step 4 for a measured reason: `trivy sbom`
 * refuses a syft directory SBOM (`unsupported type` — syft sets the root
 * component type to `file`), and normalising the document before the scan would
 * mean the scanner no longer reads the artifact that was attached. grype
 * consumes it as-is. security.md says "Trivy/Grype"; the image gate stays Trivy.
 *
 * Locally runnable:
 *   node scripts/precompile-closure-audit.mjs --closure examples/bun-exec
 * (the closure must already be installed: `bun install --frozen-lockfile`).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANCHOR_PACKAGES,
  evaluateFindings,
  installedPackages,
  readAllowlist,
  verifyClosureCoverage,
} from './lib/precompile-closure.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const allowlistPath = resolve(repoRoot, 'security/precompile-closure-allowlist.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const closureRoot = resolve(repoRoot, arg('closure', 'examples/bun-exec'));
const nodeModules = join(closureRoot, 'node_modules');
const sbomPath = resolve(repoRoot, arg('sbom-out', 'sbom/precompile-closure.cdx.json'));

function fail(message) {
  console.error(`\n::error::${message}`);
  process.exit(1);
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.error) fail(`${cmd} could not be run: ${res.error.message}`);
  if (res.status !== 0) {
    console.error(res.stderr ?? '');
    fail(`${cmd} exited ${res.status} — a failed scanner is NEVER a pass`);
  }
  return res.stdout;
}

// ── 1. the installed closure ────────────────────────────────────────────────
console.log(`Pre-compile closure: ${nodeModules}`);
const installed = installedPackages(nodeModules);
console.log(`  installed packages on disk: ${installed.size}`);

// ── 2. SBOM (CycloneDX) over the installed tree ─────────────────────────────
mkdirSync(dirname(sbomPath), { recursive: true });
run('syft', [
  'scan',
  `dir:${nodeModules}`,
  // Load-bearing: without it syft catalogues ZERO npm packages here.
  '--select-catalogers',
  '+javascript-package-cataloger',
  '-o',
  `cyclonedx-json=${sbomPath}`,
  '-q',
]);
if (!existsSync(sbomPath)) fail(`syft produced no SBOM at ${sbomPath}`);
const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
console.log(`  SBOM: ${sbomPath}`);

// ── 3. the emptiness / coverage guard ───────────────────────────────────────
const coverage = verifyClosureCoverage({ sbom, installed });
console.log(
  `  SBOM npm components: ${coverage.npmComponentCount} · coverage of installed tree: ` +
    `${(coverage.coverage * 100).toFixed(1)}% · anchors: ${ANCHOR_PACKAGES.join(', ')}`,
);
if (!coverage.ok) {
  for (const problem of coverage.problems) console.error(`  - ${problem}`);
  fail(
    'the closure SBOM does not describe the pre-compile closure — a scan of this SBOM would be ' +
      'vacuously green (ADR-0042 C6)',
  );
}

// ── 4. HIGH/CRITICAL scan of that exact SBOM ────────────────────────────────
const allowlistDoc = existsSync(allowlistPath)
  ? JSON.parse(readFileSync(allowlistPath, 'utf8'))
  : { allow: [] };
const allowlist = readAllowlist(allowlistDoc);

const grypeOut = run('grype', [`sbom:${sbomPath}`, '-o', 'json', '-q']);
let report;
try {
  report = JSON.parse(grypeOut);
} catch (err) {
  fail(`grype output is not JSON (${err.message}) — the scan did not complete`);
}
const { blocking, suppressed } = evaluateFindings(report, { allowlist });

for (const f of suppressed) {
  console.log(
    `  SUPPRESSED (allowlisted) ${f.severity.toUpperCase()} ${f.id} in ${f.package}@${f.version}`,
  );
}
if (blocking.length > 0) {
  console.error('\nHIGH/CRITICAL findings in the vinext pre-compile closure:');
  for (const f of blocking) {
    console.error(
      `  ${f.severity.toUpperCase()} ${f.id} — ${f.package}@${f.version}` +
        (f.fixedIn ? ` (fixed in ${f.fixedIn})` : ' (no fix available)'),
    );
  }
  fail(
    `${blocking.length} HIGH/CRITICAL finding(s) in the pre-compile closure. Bump the dependency ` +
      `first; allowlist (dated + justified) in ${allowlistPath} only when there is no fix.`,
  );
}

console.log(
  `\nPre-compile closure clean: ${coverage.npmComponentCount} npm components scanned, ` +
    `0 blocking HIGH/CRITICAL${suppressed.length ? `, ${suppressed.length} allowlisted` : ''}.`,
);
