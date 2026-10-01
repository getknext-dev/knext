#!/usr/bin/env node
/**
 * verify-scaffold-resolves-npm10.mjs — a PR-time guard that the CURRENT repo scaffold
 * template `npm install`s cleanly on npm 10.x, the version a large share of strangers run
 * (it is what ubuntu-24.04 GitHub runners ship, and the LTS-adjacent default on many
 * machines).
 *
 * Why pin npm 10 specifically: npm 10's arborist ABORTS on an unsatisfiable peer with an
 * internal `Cannot read properties of null (reading 'edgesOut')` crash instead of a clean
 * ERESOLVE; npm 11 resolves the same tree. So a peer misalignment in the template (the #985
 * class: `vitest@^4` peering below the `vite@8` the template also pins) is INVISIBLE on a
 * dev's npm 11 and only surfaces for the stranger. This guard reproduces the stranger's npm
 * at PR time, on the REPO template — so a bad bump reds BEFORE merge, not only in the nightly
 * against the already-published artifact.
 *
 * Resolve-only (`--package-lock-only`): builds the ideal tree (where the crash happens)
 * without downloading tarballs. Network is required (registry metadata + `npx npm@10`).
 * Exits 0 when the tree resolves, 1 on the crash / any resolve failure.
 *
 * #1771: a release-prep PR (changeset version bump to e.g. `1.0.0-rc.4`) bakes that EXACT
 * version into the template's `@getknext/*` ranges, and that version is not on npm until
 * THIS PR merges and publishes — so plain registry resolution ETARGETs on every release-prep
 * PR, every time, even though the tree is fine. When that happens — and ONLY when every
 * ETARGET is for a `@getknext/*` package at exactly the workspace version
 * (`decideResolveStrategy`'s `release-prep-etarget`, see `scripts/lib/scaffold-npm10-resolve.mjs`)
 * — retry by packing the current workspace `@getknext/*` sources into real tarballs
 * (`packPublishableGroup`, the same packer the publish lanes use) and resolving the
 * template's `@getknext/*` entries against those `file:` paths instead, while every OTHER
 * dependency still resolves against the real registry under npm 10. Any other ETARGET, or
 * any other failure (including the `edgesOut` crash), stays red exactly as before.
 *
 * #1795: the template only names `@getknext/core` and `@getknext/lib` directly, but
 * `@getknext/core` itself depends on `@getknext/lib` and `@getknext/db` at the SAME
 * unpublished release-prep version — so packing only the package(s) the FIRST ETARGET
 * named just moved the failure one level down, onto the TRANSITIVE `@getknext/lib`/
 * `@getknext/db` reference inside `@getknext/core`'s own packed `package.json`. The fix:
 * on a `release-prep-etarget` decision, pack the WHOLE fixed publishable group
 * (`canonicalPublishableGroup` — core, lib, db, the `kn-next` alias) up front, and resolve
 * ALL of them via npm `overrides` (`applyLocalResolutions`), which apply tree-wide
 * regardless of nesting depth — not just the name(s) the first ETARGET happened to report.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPublishableGroup, packPublishableGroup } from './lib/pack-publishable-group.mjs';
import { applyLocalResolutions, decideResolveStrategy } from './lib/scaffold-npm10-resolve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TEMPLATE = join(REPO, 'packages/kn-next/templates/app/package.json.hbs');
const CORE_PKG = join(REPO, 'packages/kn-next/package.json');
const NPM_MAJOR = '10'; // the stranger's npm; the version whose arborist crashes on a bad peer
const NPM_INSTALL_ARGS = ['install', '--package-lock-only', '--no-audit', '--no-fund'];

function fail(msg) {
  console.error(`FAIL [scaffold-resolves-npm10] ${msg}`);
  process.exit(1);
}

function runNpm10Install(dir) {
  const r = spawnSync('npx', ['-y', '-p', `npm@${NPM_MAJOR}`, 'npm', ...NPM_INSTALL_ARGS], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (r.error) fail(`could not run npm@${NPM_MAJOR}: ${r.error.message}`);
  return { exitStatus: r.status ?? 1, output: `${r.stdout || ''}${r.stderr || ''}` };
}

const version = JSON.parse(readFileSync(CORE_PKG, 'utf8')).version ?? '0.0.0';
const rendered = readFileSync(TEMPLATE, 'utf8')
  .replace(/\{\{\s*name\s*\}\}/g, 'scaffold-resolve-probe')
  .replace(/\{\{\s*version\s*\}\}/g, version);

const dir = mkdtempSync(join(tmpdir(), 'knext-scaffold-npm10-'));
try {
  writeFileSync(join(dir, 'package.json'), rendered);
  console.log(
    `resolving the repo scaffold template (pinned @getknext/* = ${version}) on npm ${NPM_MAJOR}.x …`,
  );
  const first = runNpm10Install(dir);
  const decision = decideResolveStrategy({
    exitStatus: first.exitStatus,
    output: first.output,
    workspaceVersion: version,
  });

  if (decision.kind === 'ok') {
    console.log(`ok — the repo scaffold template resolves cleanly on npm ${NPM_MAJOR}.x`);
    process.exit(0);
  }

  if (decision.kind === 'edgesOut') {
    fail(
      `the scaffold template CRASHES npm ${NPM_MAJOR} with the arborist edgesOut bug — a dependency ` +
        `pins a peer another pin cannot satisfy (the #985 class). A stranger on npm ${NPM_MAJOR} ` +
        `cannot install a scaffolded app. Align the offending peer (e.g. keep vitest's Vite peer ` +
        `range covering the pinned vite). npm output:\n${first.output.trim().slice(0, 600)}`,
    );
  }

  if (decision.kind !== 'release-prep-etarget') {
    fail(
      `npm ${NPM_MAJOR} install --package-lock-only exited ${first.exitStatus}:\n` +
        `${first.output.trim().slice(0, 600)}`,
    );
  }

  // release-prep-etarget: every unresolved package is @getknext/* at exactly the
  // workspace version — but it may be a TRANSITIVE reference (e.g. @getknext/core
  // depending on @getknext/lib/@getknext/db at the same unpublished version), so
  // pack the WHOLE fixed publishable group up front and resolve all of them via
  // `overrides`, which apply tree-wide regardless of nesting depth (#1795) — not
  // just the name(s) this first ETARGET happened to report.
  console.log(
    `npm ${NPM_MAJOR} could not resolve ${decision.packages.join(', ')} at the unpublished ` +
      `release-prep version ${version} — packing the whole @getknext/* publishable group ` +
      `locally and retrying …`,
  );
  const packDir = join(dir, '.local-pack');
  const group = canonicalPublishableGroup(REPO);
  const groupNames = new Set(group.map((p) => p.name));
  const uncovered = decision.packages.filter((name) => !groupNames.has(name));
  if (uncovered.length > 0) {
    fail(
      `release-prep-etarget named ${uncovered.join(', ')}, but the canonical publishable ` +
        `group only covers ${[...groupNames].join(', ')} — cannot pack a local tarball for ` +
        `the rest.`,
    );
  }
  const packed = packPublishableGroup(group, packDir);
  const tarballsByName = new Map(packed.map((p) => [p.name, p.tarball]));

  const pkgPath = join(dir, 'package.json');
  const localResolved = applyLocalResolutions(
    JSON.parse(readFileSync(pkgPath, 'utf8')),
    tarballsByName,
  );
  writeFileSync(pkgPath, JSON.stringify(localResolved, null, 2));

  const second = runNpm10Install(dir);
  const secondDecision = decideResolveStrategy({
    exitStatus: second.exitStatus,
    output: second.output,
    workspaceVersion: version,
  });
  if (secondDecision.kind === 'ok') {
    console.log(
      `ok — the repo scaffold template resolves cleanly on npm ${NPM_MAJOR}.x ` +
        `(release-prep PR: ${decision.packages.join(', ')} resolved against local tarballs)`,
    );
    process.exit(0);
  }
  if (secondDecision.kind === 'edgesOut') {
    fail(
      `the scaffold template CRASHES npm ${NPM_MAJOR} with the arborist edgesOut bug even after ` +
        `local-tarball resolution — a dependency pins a peer another pin cannot satisfy. npm ` +
        `output:\n${second.output.trim().slice(0, 600)}`,
    );
  }
  fail(
    `npm ${NPM_MAJOR} install --package-lock-only still failed after resolving ` +
      `${decision.packages.join(', ')} against local tarballs (exit ${second.exitStatus}):\n` +
      `${second.output.trim().slice(0, 600)}`,
  );
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
