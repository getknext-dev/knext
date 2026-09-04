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
 *      MEASURED on examples/bun-exec: `trivy fs` sees `bun.lock` and catalogues
 *      60 npm packages; the installed tree holds 210 packages by this repo's
 *      walker and yields 409 npm components under syft (nested copies and the
 *      package.json files inside published packages are counted too — `find …
 *      -name package.json` returns 527). What trivy never looked at included a
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
 * TWO CLOSURE SHAPES, because the repo has two (C1, #785).
 *
 *   --closure <dir>   the dir is its OWN install root (examples/bun-exec has its
 *                     own bun.lock). syft scans `<dir>/node_modules` directly.
 *   --app <dir>       the dir is a WORKSPACE MEMBER (apps/file-manager). Its
 *                     `node_modules` is symlinks into the shared isolated store,
 *                     which syft refuses to follow (MEASURED: 0 npm components),
 *                     so the workspace root is scanned once and the SBOM is
 *                     projected onto the app's own transitive closure —
 *                     see scripts/lib/bun-app-closure.mjs for why the whole
 *                     workspace is the wrong subject (90 HIGH/CRITICAL, mostly
 *                     other packages' dev tooling and vendored Go CLIs).
 *
 * `--app` is what the PUBLISH lane runs, and it is the half ADR-0042 C6 left
 * open: the image `supply-chain.yml` pushes and cosign-attests is
 * apps/file-manager's compiled binary, and until this existed the SBOM in that
 * attestation described an Alpine package DB and one opaque 70 MB blob. A signed
 * attestation asserting nothing is worse than no attestation, because it makes
 * an absent control look audited.
 *
 * Locally runnable:
 *   node scripts/precompile-closure-audit.mjs --closure examples/bun-exec
 *   node scripts/precompile-closure-audit.mjs --app apps/file-manager
 * (the closure must already be installed: `bun install --frozen-lockfile`).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterSbomToClosure, resolveAppClosure } from './lib/bun-app-closure.mjs';
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

const appArg = arg('app', undefined);
const closureRoot = resolve(repoRoot, arg('closure', 'examples/bun-exec'));
// `--app` scans the workspace root (the only tree syft can traverse) and
// projects; `--closure` scans the install root directly.
const scanRoot = appArg === undefined ? closureRoot : repoRoot;
const nodeModules = join(scanRoot, 'node_modules');
const sbomPath = resolve(
  repoRoot,
  arg(
    'sbom-out',
    appArg === undefined ? 'sbom/precompile-closure.cdx.json' : 'sbom/app-closure.cdx.json',
  ),
);

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
//
// `--app`: the app's OWN transitive closure, resolved by following declared
// dependency edges through bun's isolated store (the app's `node_modules` is
// symlinks, so neither syft nor the plain tree walker can see past it).
// `--closure`: the tree on disk, walked directly.
let appClosure = null;
let installed;
if (appArg === undefined) {
  console.log(`Pre-compile closure: ${nodeModules}`);
  installed = installedPackages(nodeModules);
  console.log(`  installed packages on disk: ${installed.size}`);
} else {
  const appDir = resolve(repoRoot, appArg);
  console.log(`Pre-compile closure of app: ${appDir}`);
  const resolved = resolveAppClosure(appDir);
  appClosure = new Set(resolved.packages.keys());
  installed = new Set([...appClosure].map((key) => key.slice(0, key.lastIndexOf('@'))));
  console.log(`  packages in the app's transitive closure: ${appClosure.size}`);
  if (resolved.unresolved.length > 0) {
    // A REQUIRED edge that does not resolve means the tree is not the tree the
    // manifests describe — scanning it would report on something else.
    for (const miss of resolved.unresolved.slice(0, 20)) console.error(`  - ${miss}`);
    fail(
      `${resolved.unresolved.length} declared dependency(ies) of ${appArg} could not be resolved ` +
        'in the installed tree — run `bun install --frozen-lockfile` first',
    );
  }
}

// ── 2. SBOM (CycloneDX) over the installed tree ─────────────────────────────
mkdirSync(dirname(sbomPath), { recursive: true });
const rawSbomPath = appArg === undefined ? sbomPath : `${sbomPath}.workspace`;
run('syft', [
  'scan',
  `dir:${nodeModules}`,
  // Load-bearing: without it syft catalogues ZERO npm packages here.
  '--select-catalogers',
  '+javascript-package-cataloger',
  '-o',
  `cyclonedx-json=${rawSbomPath}`,
  '-q',
]);
if (!existsSync(rawSbomPath)) fail(`syft produced no SBOM at ${rawSbomPath}`);
let sbom = JSON.parse(readFileSync(rawSbomPath, 'utf8'));

if (appClosure !== null) {
  // Project the workspace SBOM onto the app's closure and WRITE THAT — the
  // document grype reads below is byte-for-byte the document that gets
  // cosign-attested onto the pushed digest, so "the scan covered the closure"
  // stays provable rather than asserted.
  const projected = filterSbomToClosure(sbom, appClosure);
  sbom = projected.sbom;
  writeFileSync(sbomPath, JSON.stringify(sbom, null, 2));
  console.log(
    `  projected onto the app closure: ${projected.kept.length} components kept, ` +
      `${projected.missing.length} closure member(s) syft did not catalogue`,
  );
  // Named, not just counted: the workspace's own `@getknext/*` packages resolve
  // to source directories outside `node_modules`, so syft does not catalogue
  // them. They are first-party code, covered by the npm-audit gate over the
  // published closure — say which ones rather than leaving a bare number.
  for (const key of projected.missing) console.log(`    not catalogued: ${key}`);
}
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
