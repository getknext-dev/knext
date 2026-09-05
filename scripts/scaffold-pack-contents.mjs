#!/usr/bin/env node
/**
 * #964 — the front door regression, as a fail-fast tripwire on the PACK manifest.
 *
 * WHAT BROKE, MEASURED. The published `@getknext/core@0.3.0` tarball shipped NO
 * `dist/cli/create.js` and ZERO `templates/` entries (`npm pack @getknext/core@0.3.0`
 * then `tar tzf` confirms both absent). So `npm exec --package=@getknext/core@latest --
 * kn-next create` fell through to the deploy parser and died on `--name`, and even
 * with the verb there was nothing to render. Every `npx kn-next create` getting-started
 * path is dead for a stranger on that artifact.
 *
 * HEAD already ships both — `packages/kn-next/package.json` `files` lists `templates`,
 * and `tsup.config.ts` carries the `cli/create` entry. This module is the guard that
 * keeps it that way: given the manifest a `npm pack --dry-run` would emit for the
 * package, return the problems that would make the published CLI unable to scaffold.
 * It is the PR-time "form" half (a packaging regression reds here immediately) that
 * complements the run-time "value" halves — `scripts/install-smoke.mjs` (packs,
 * installs and actually scaffolds) and `scripts/verify-scaffold-install.mjs` (the
 * stranger quickstart against the live registry). Same division of labour as the
 * sibling-range guard (#942): a pure helper, tested red-first on synthetic input,
 * that the heavier scripts can also call between pack and publish.
 *
 * NO SIDE EFFECTS ON IMPORT — the executable behaviour is guarded behind the
 * entrypoint check at the bottom so the test can import the pure helper (the same
 * shape `scripts/audit-published.mjs` uses for `siblingRangeProblems`).
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The runnable bundle the `kn-next` bin dispatches `create` into. The bin
 * (`dist/cli/kn-next.js`) `await import`s `./create` for `sub === "create"`, so
 * this file MUST be in the tarball or the verb cannot run.
 */
export const CREATE_DIST_ENTRY = 'dist/cli/create.js';

/**
 * The scaffold template root. `create` renders these `.hbs` files into a new app,
 * locating them by walking up to the package manifest, so at least one templates/
 * entry MUST ship or every scaffold is empty.
 */
export const TEMPLATES_PREFIX = 'templates/';

/**
 * @param {Iterable<string>} packedFiles - the file paths a `npm pack` would ship,
 *   package-root-relative (e.g. `dist/cli/create.js`, `templates/app/page.tsx.hbs`).
 * @returns {string[]} one human-readable problem per missing requirement; empty
 *   when the tarball can scaffold. Fail-closed: an EMPTY input is itself a problem
 *   (a pack that ships nothing is never "fine").
 */
export function scaffoldPackProblems(packedFiles) {
  const files = [...packedFiles].map((f) => f.replace(/^\.\//, '').replace(/^\/+/, ''));
  const problems = [];

  if (files.length === 0) {
    problems.push('the pack manifest is EMPTY — nothing would be published');
    return problems;
  }

  if (!files.includes(CREATE_DIST_ENTRY)) {
    problems.push(
      `${CREATE_DIST_ENTRY} is not in the tarball — the published CLI has no runnable ` +
        'create verb (this is exactly the 0.3.0 breakage, #964)',
    );
  }

  const templateCount = files.filter((f) => f.startsWith(TEMPLATES_PREFIX)).length;
  if (templateCount === 0) {
    problems.push(
      `no ${TEMPLATES_PREFIX} entries in the tarball — create would render nothing ` +
        '(the other half of the 0.3.0 breakage, #964)',
    );
  }

  return problems;
}

/**
 * Ask `npm pack --dry-run --json` what the given package would ship and return the
 * package-root-relative file list. Throws on a non-zero pack or unparseable output —
 * an unanswerable question is never answered "fine" (the repo's standing ruling).
 *
 * @param {string} pkgDir - absolute path to the package directory to pack.
 * @returns {string[]}
 */
export function packedFileList(pkgDir) {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgDir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status !== 0) {
    throw new Error(
      `npm pack --dry-run exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`npm pack --dry-run emitted unparseable JSON: ${(e && e.message) || e}`);
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (entry && entry.files) || [];
  return files.map((f) => (typeof f === 'string' ? f : f.path));
}

// ── executable entrypoint (guarded so the helper imports side-effect-free) ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkgDir = resolve(REPO_ROOT, 'packages/kn-next');
  const problems = scaffoldPackProblems(packedFileList(pkgDir));
  if (problems.length > 0) {
    console.error(`scaffold-pack-contents: ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('scaffold-pack-contents: the tarball ships the create verb and templates');
}
