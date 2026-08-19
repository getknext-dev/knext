/**
 * precompile-closure.mjs — the pre-compile-closure supply-chain gate's logic
 * (ADR-0042 Consequence 6, #764).
 *
 * WHY THIS EXISTS. The vinext build target is `bun build --compile --bytecode`:
 * one ~120 MB executable with every JS dependency inlined. syft and Trivy can
 * read an Alpine package database out of that image; they cannot read anything
 * out of the binary. With `resolve.noExternal: true` there is not even a
 * `.output/server/node_modules` left, so an image scan of a vinext image is
 * green because there is nothing in it to scan — the same vacuity ADR-0042 used
 * to REJECT `FROM scratch`, reached by another route.
 *
 * ADR-0042 C6 binds the vinext path to an SBOM + HIGH/CRITICAL scan of the
 * PRE-COMPILE DEPENDENCY CLOSURE: the resolved node_modules tree that feeds
 * `vite build`. That is the last honest scannable surface, so the gate's whole
 * credibility rests on one claim — THE SCAN SAW THE CLOSURE. Two measured ways
 * that claim fails silently, both of which this module makes red:
 *
 *   1. `syft scan dir:node_modules` with DEFAULT catalogers emits 18
 *      components, ZERO of them npm (the package.json cataloger is not enabled
 *      for a directory source). A perfectly valid, perfectly empty SBOM.
 *   2. `trivy fs` over `examples/bun-exec` finds `bun.lock` and catalogues 60
 *      npm packages. Measured against the same tree: `installedPackages()`
 *      walks 210 installed packages and syft emits 409 npm components (more
 *      than 210 because it also catalogues nested copies and the package.json
 *      files inside published packages — `find … -name package.json` returns
 *      527). Whichever of the three you compare against, trivy never looked at
 *      most of the tree, and what it missed included a HIGH (nanoid 3.3.17). A
 *      lockfile is a claim about what should be installed; the installed tree
 *      is what the compiler actually swallows, including whatever install
 *      scripts materialised.
 *
 * Hence: SBOM from the INSTALLED tree, coverage checked against the tree on
 * disk, absolute floors on BOTH sides (an empty closure has trivially perfect
 * coverage), and named toolchain anchors that must appear or the scan was
 * pointed somewhere else.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The severities that fail the gate — the same threshold as the image Trivy
 * gate (`severity: HIGH,CRITICAL`) and the npm audit gate
 * (`--audit-level=high`). Sorted, because a test asserts it verbatim.
 */
export const FAILING_SEVERITIES = new Set(['critical', 'high']);

/**
 * Floors. Below the measured reality so that a legitimate dependency removal
 * does not redden the gate and make editing this file the routine way to get
 * green — but far ABOVE zero, which is the number every silent-vacuity failure
 * produces. Measured on examples/bun-exec (2026-08-19), stated as what each
 * number counts:
 *
 *   - syft npm COMPONENTS in the SBOM: 409  → MIN_NPM_COMPONENTS has ~4×
 *     headroom;
 *   - packages the walker below finds INSTALLED in the tree: 210 →
 *     MIN_INSTALLED_PACKAGES has ~2× headroom, not more. It is the tighter of
 *     the two, deliberately: it is the floor that catches an empty tree.
 */
export const MIN_NPM_COMPONENTS = 100;
export const MIN_INSTALLED_PACKAGES = 100;

/**
 * The fraction of the installed tree the SBOM must account for. The lockfile
 * shape scores 0.15 here; a correctly catalogued tree scores ~1.0.
 */
export const MIN_COVERAGE = 0.9;

/**
 * Toolchain packages that MUST be in the SBOM. These are what makes the closure
 * the VINEXT closure rather than some other tree: if `vinext` or `vite` is
 * absent, the scan was pointed at the wrong directory and every count above can
 * still look healthy.
 */
export const ANCHOR_PACKAGES = ['vinext', 'vite', 'nitro', 'next', 'react', 'react-dom'];

/** The npm components of a CycloneDX document. */
export function npmComponents(sbom) {
  const components = sbom?.components ?? [];
  return components
    .filter((c) => typeof c?.purl === 'string' && c.purl.startsWith('pkg:npm/'))
    .map((c) => ({ name: c.name, version: c.version, purl: c.purl }));
}

/**
 * Every package present in an installed `node_modules` tree, as `name` (scoped
 * names included), walking nested `node_modules` too — a transitively-nested
 * copy is in the tree the compiler reads, so it is in the closure.
 *
 * A missing directory yields an EMPTY set rather than throwing: the caller's
 * floors then red, which is the honest answer. Never invent coverage.
 */
export function installedPackages(nodeModulesDir) {
  const found = new Set();
  if (!existsSync(nodeModulesDir)) return found;

  const walkModulesDir = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === '.bin' || entry.name === '.cache') continue;
      const full = join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        // Scope directory: its children are the packages.
        let scoped;
        try {
          scoped = readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of scoped) {
          const childPath = join(full, child.name);
          if (!existsSync(join(childPath, 'package.json'))) continue;
          found.add(`${entry.name}/${child.name}`);
          walkNested(childPath);
        }
        continue;
      }
      if (!existsSync(join(full, 'package.json'))) continue;
      found.add(entry.name);
      walkNested(full);
    }
  };

  const walkNested = (pkgDir) => {
    const nested = join(pkgDir, 'node_modules');
    if (existsSync(nested)) walkModulesDir(nested);
  };

  walkModulesDir(nodeModulesDir);
  return found;
}

/**
 * Does the SBOM actually describe the installed closure?
 *
 * Returns every problem found, not the first — a report that stops at the first
 * failure hides the shape of the failure.
 */
export function verifyClosureCoverage({
  sbom,
  installed,
  minComponents = MIN_NPM_COMPONENTS,
  minInstalled = MIN_INSTALLED_PACKAGES,
  minCoverage = MIN_COVERAGE,
  anchors = ANCHOR_PACKAGES,
}) {
  const problems = [];
  const npm = npmComponents(sbom);
  const sbomNames = new Set(npm.map((c) => c.name));

  if (npm.length === 0) {
    problems.push(
      'the SBOM contains ZERO npm components — the closure was not catalogued at all ' +
        '(syft needs `--select-catalogers +javascript-package-cataloger` for a directory source)',
    );
  } else if (npm.length < minComponents) {
    problems.push(
      `the SBOM contains ${npm.length} npm components, below the floor of ${minComponents} — ` +
        'a closure this small is not the vinext dependency graph',
    );
  }

  if (installed.size < minInstalled) {
    problems.push(
      `the installed closure directory holds ${installed.size} packages, below the floor of ` +
        `${minInstalled} — there is nothing here to scan (an empty tree has perfect coverage)`,
    );
  }

  const covered = [...installed].filter((name) => sbomNames.has(name)).length;
  const coverage = installed.size === 0 ? 1 : covered / installed.size;
  if (coverage < minCoverage) {
    problems.push(
      `the SBOM covers ${covered}/${installed.size} (${(coverage * 100).toFixed(1)}%) of the ` +
        `installed packages, below the required ${(minCoverage * 100).toFixed(0)}% — this is the ` +
        'lockfile-scan shape, which was measured to miss a HIGH the installed tree carries',
    );
  }

  const missingAnchors = anchors.filter((a) => !sbomNames.has(a));
  if (missingAnchors.length > 0) {
    problems.push(
      `the SBOM is missing toolchain anchors [${missingAnchors.join(', ')}] — it does not ` +
        'describe the vinext pre-compile closure',
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    npmComponentCount: npm.length,
    installedCount: installed.size,
    coverage,
    missingAnchors,
  };
}

/**
 * The dated + justified allowlist, mirroring `security/npm-audit-allowlist.json`
 * and the Trivy triage discipline: an accepted HIGH/CRITICAL is suppressed ONLY
 * by an entry carrying an id, a justification and an `added` date, and an
 * `expires` date in the past stops suppressing. A malformed entry THROWS rather
 * than being ignored — an ignored allowlist entry is a gate that silently
 * changed meaning.
 */
export const ALLOWLIST_ENTRY_KEYS = new Set(['id', 'justification', 'added', 'expires', 'note']);

export function readAllowlist(doc, now = new Date()) {
  const active = new Set();
  const entries = doc?.allow ?? [];
  if (!Array.isArray(entries)) throw new Error('allowlist: `allow` must be an array');
  for (const entry of entries) {
    if (!entry?.id) throw new Error(`allowlist: an entry has no \`id\`: ${JSON.stringify(entry)}`);
    // Unknown keys THROW rather than being ignored. A typo'd `expiress` is
    // otherwise accepted as an entry that never expires while READING as one
    // that does — the expiry is the only thing forcing re-justification, so
    // silently dropping it is the quietest way to neuter this gate.
    const unknown = Object.keys(entry).filter((k) => !ALLOWLIST_ENTRY_KEYS.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `allowlist: entry ${entry.id} has unknown key(s) [${unknown.join(', ')}] — allowed keys are ` +
          `[${[...ALLOWLIST_ENTRY_KEYS].join(', ')}]. A misspelled \`expires\` never expires.`,
      );
    }
    if (!entry.justification) {
      throw new Error(`allowlist: entry ${entry.id} has no \`justification\``);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.added ?? '')) {
      throw new Error(`allowlist: entry ${entry.id} has no valid \`added\` date (YYYY-MM-DD)`);
    }
    if (entry.expires) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
        throw new Error(`allowlist: entry ${entry.id} has a malformed \`expires\` date`);
      }
      if (new Date(`${entry.expires}T00:00:00Z`) <= now) continue; // expired — no longer suppresses
    }
    active.add(entry.id);
  }
  return active;
}

/**
 * Split a grype report into blocking and suppressed findings.
 *
 * Grype output with no `matches` key THROWS: a scanner that crashed and printed
 * something else must never read as "zero findings". That is the same emptiness
 * rule as above, one layer down.
 */
export function evaluateFindings(report, { allowlist = new Set() } = {}) {
  const matches = report?.matches;
  if (!Array.isArray(matches)) {
    throw new Error(
      'grype report has no `matches` array — the scan did not complete, which is NOT a pass',
    );
  }
  const blocking = [];
  const suppressed = [];
  for (const match of matches) {
    const id = match?.vulnerability?.id ?? '(unknown id)';
    const severity = String(match?.vulnerability?.severity ?? '').toLowerCase();
    if (!FAILING_SEVERITIES.has(severity)) continue;
    const finding = {
      id,
      severity,
      package: match?.artifact?.name,
      version: match?.artifact?.version,
      fixedIn: (match?.vulnerability?.fix?.versions ?? []).join(', '),
    };
    if (allowlist.has(id)) suppressed.push(finding);
    else blocking.push(finding);
  }
  return { blocking, suppressed };
}
