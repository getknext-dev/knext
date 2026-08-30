#!/usr/bin/env node
/**
 * Emit a CycloneDX SBOM of a pruned workspace's PRODUCTION dependency closure,
 * read from the installed tree rather than from any lockfile.
 *
 * ## Why not scan the lockfile, which is what this replaced
 *
 * The docs-closure gate scanned `.docs-closure/pnpm-lock.yaml`. Once the repo
 * moved to bun that file stops existing, and the obvious swap — point Trivy at
 * `bun.lock` — is measurably worse, not equivalent:
 *
 *   pnpm-lock.yaml   777 packages   1 HIGH  (CVE-2026-33671 picomatch@2.3.1)
 *   bun.lock         509 packages   0 HIGH
 *
 * `picomatch@2.3.1` IS in `bun.lock`, under a nested `"micromatch/picomatch"`
 * key that Trivy's bun parser does not descend into. So the swap would have
 * moved a security gate from catching that HIGH to missing it while still
 * reporting green — which is the failure mode worth more than the gate itself,
 * because it reports safety it never established.
 *
 * Scanning the installed `node_modules` directly does not work either, and that
 * is worth recording so nobody re-tries it: Trivy's `node-pkg` analyzer, which
 * reads `node_modules/**\/package.json`, does not run for `trivy fs`. Measured
 * on a directory containing exactly one canonical `node_modules/picomatch/
 * package.json`: zero results.
 *
 * An SBOM sidesteps every lockfile parser. It describes what is actually on
 * disk, and `trivy sbom` consumes it natively.
 *
 * ## Why the PRODUCTION closure specifically
 *
 * The gate exists to protect what ships in the docs image. The old lockfile
 * scan could not separate the two, and its own comment in `ci.yml` had to
 * explain that away — "any HIGH there is a pre-existing REPO-WIDE toolchain
 * CVE ... not a docs-runtime issue". A gate you routinely explain away is a
 * gate on its way to being ignored.
 *
 * Measured against the old scan, this traversal:
 *   + ADDS 35 packages it never saw, and they are runtime, not incidental —
 *     `ioredis`, `pino`, `pg-connection-string`, `thread-stream`. The Redis and
 *     Postgres clients were outside the gate entirely.
 *   - DROPS 214 build-time packages (`@types/*`, `@vitejs/*`, `tsx`,
 *     `tailwindcss` and their transitives). None of them carried a
 *     HIGH/CRITICAL, so nothing the gate would have failed on is lost.
 *
 * And it does NOT drop the finding that motivated all this: `picomatch@2.3.1`
 * is reachable at runtime via `fast-glob -> micromatch -> picomatch`, so the
 * `ci.yml` comment calling it dev-toolchain-only was wrong on its own terms.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , workspaceRoot, outFile] = process.argv;
if (!workspaceRoot || !outFile) {
  console.error('usage: sbom-docs-closure.mjs <workspace-root> <out.cdx.json>');
  process.exit(1);
}

/** Every installed package, indexed by `name@version` and by name. */
const byKey = new Map();
const byName = new Map();

/**
 * Index canonical package locations only: `<…>/node_modules/<name>/package.json`
 * or `<…>/node_modules/@scope/<name>/package.json`.
 *
 * The filter is load-bearing. Without it the walk also picks up vendored copies
 * such as `next/dist/compiled/picomatch` — real files, but rebranded and often
 * patched, so the version string in them does not describe the code that is
 * there. Counting them produced 22 additional HIGH findings against versions
 * that are not actually present, which is the fastest way to teach people to
 * ignore this gate.
 */
function index(dir, depth) {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      index(p, depth + 1);
      continue;
    }
    if (e.name !== 'package.json') continue;
    const parts = p.split('/');
    const canonical =
      parts[parts.length - 3] === 'node_modules' ||
      (parts[parts.length - 4] === 'node_modules' && parts[parts.length - 3].startsWith('@'));
    if (!canonical) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (!byKey.has(key)) byKey.set(key, pkg);
    if (!byName.has(pkg.name)) byName.set(pkg.name, new Set());
    byName.get(pkg.name).add(pkg.version);
  }
}

index(join(workspaceRoot, 'node_modules'), 0);

/**
 * The workspace's own manifests are the roots of the traversal. They are also
 * components in their own right — first-party code ships too, even though no
 * advisory database will ever match it.
 */
const roots = [];
const rootManifest = join(workspaceRoot, 'package.json');
if (!existsSync(rootManifest)) {
  console.error(`no package.json at ${workspaceRoot} — is this a pruned workspace?`);
  process.exit(1);
}
roots.push(JSON.parse(readFileSync(rootManifest, 'utf8')));
for (const area of ['apps', 'packages']) {
  const dir = join(workspaceRoot, area);
  if (!existsSync(dir)) continue;
  for (const d of readdirSync(dir)) {
    const m = join(dir, d, 'package.json');
    if (existsSync(m)) roots.push(JSON.parse(readFileSync(m, 'utf8')));
  }
}

// BFS over RUNTIME edges only. `devDependencies` are build-time and do not reach
// the image; following them is what made the old scan need a paragraph of
// explanation for findings nobody was going to act on.
const production = new Set();
const queue = [];
for (const r of roots)
  for (const name of Object.keys({ ...r.dependencies, ...r.optionalDependencies }))
    queue.push(name);

while (queue.length > 0) {
  const name = queue.pop();
  const versions = byName.get(name);
  if (versions === undefined) continue;
  // Every installed version of a required name is included. Resolving which
  // version each edge points at needs the lockfile this exists to avoid, and
  // being over-inclusive here fails toward reporting more, not less.
  for (const version of versions) {
    const key = `${name}@${version}`;
    if (production.has(key)) continue;
    production.add(key);
    const pkg = byKey.get(key);
    for (const dep of Object.keys({ ...pkg?.dependencies, ...pkg?.optionalDependencies }))
      queue.push(dep);
  }
}

const purl = (name, version) => `pkg:npm/${name.replace('@', '%40')}@${version}`;

const components = [
  ...[...production].map((key) => {
    const at = key.lastIndexOf('@');
    return { name: key.slice(0, at), version: key.slice(at + 1) };
  }),
  // Workspace packages are symlinks in `node_modules`, so the walk above skips
  // them; they are added from the manifests that were already read.
  ...roots
    .filter((r) => typeof r.name === 'string' && typeof r.version === 'string')
    .map((r) => ({ name: r.name, version: r.version })),
]
  .filter((c, i, all) => all.findIndex((o) => o.name === c.name && o.version === c.version) === i)
  .sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  )
  .map((c) => ({
    type: 'library',
    name: c.name,
    version: c.version,
    purl: purl(c.name, c.version),
  }));

/**
 * Refuse before writing anything.
 *
 * Measured: `trivy sbom` on a MISSING file exits 1, but on an SBOM with zero
 * components it exits **0**. So an empty SBOM is a silent pass — the gate
 * reports no vulnerabilities and proves nothing. Failing here, before the file
 * exists, means the workflow stops at generation and never reaches a scan that
 * would have looked clean.
 *
 * Writing first and checking after would leave the useless SBOM on disk for a
 * later step or a person to scan. The threshold sits far below the real figure
 * (573 at the time of writing) so ordinary dependency churn never trips it.
 */
if (components.length < 50) {
  console.error(
    `Refusing to emit an SBOM with ${components.length} components. That is not a ` +
      'plausible closure for this workspace — the install probably did not run, or ' +
      'node_modules is not where it was expected.\n' +
      'Scanning it would report no vulnerabilities and prove nothing: `trivy sbom` ' +
      'exits 0 on an empty component list.',
  );
  process.exit(1);
}

writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      metadata: { component: { type: 'application', name: 'knext-docs-closure' } },
      components,
    },
    null,
    2,
  )}\n`,
);

console.log(`installed (canonical): ${byKey.size}`);
console.log(`production closure:    ${components.length}`);
console.log(`wrote ${outFile}`);
