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
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TEMPLATE = join(REPO, 'packages/kn-next/templates/app/package.json.hbs');
const CORE_PKG = join(REPO, 'packages/kn-next/package.json');
const NPM_MAJOR = '10'; // the stranger's npm; the version whose arborist crashes on a bad peer

function fail(msg) {
  console.error(`FAIL [scaffold-resolves-npm10] ${msg}`);
  process.exit(1);
}

const version = JSON.parse(readFileSync(CORE_PKG, 'utf8')).version ?? '0.0.0';
const rendered = readFileSync(TEMPLATE, 'utf8')
  .replace(/\{\{\s*name\s*\}\}/g, 'scaffold-resolve-probe')
  .replace(/\{\{\s*version\s*\}\}/g, version);

const dir = mkdtempSync(join(tmpdir(), 'knext-scaffold-npm10-'));
try {
  writeFileSync(join(dir, 'package.json'), rendered);
  console.log(`resolving the repo scaffold template (pinned @getknext/* = ${version}) on npm ${NPM_MAJOR}.x …`);
  const r = spawnSync(
    'npx',
    ['-y', '-p', `npm@${NPM_MAJOR}`, 'npm', 'install', '--package-lock-only', '--no-audit', '--no-fund'],
    { cwd: dir, encoding: 'utf8', timeout: 300_000 },
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error) fail(`could not run npm@${NPM_MAJOR}: ${r.error.message}`);
  if (/edgesOut/.test(out)) {
    fail(
      `the scaffold template CRASHES npm ${NPM_MAJOR} with the arborist edgesOut bug — a dependency ` +
        `pins a peer another pin cannot satisfy (the #985 class). A stranger on npm ${NPM_MAJOR} ` +
        `cannot install a scaffolded app. Align the offending peer (e.g. keep vitest's Vite peer ` +
        `range covering the pinned vite). npm output:\n${out.trim().slice(0, 600)}`,
    );
  }
  if (r.status !== 0) {
    fail(`npm ${NPM_MAJOR} install --package-lock-only exited ${r.status}:\n${out.trim().slice(0, 600)}`);
  }
  console.log(`ok — the repo scaffold template resolves cleanly on npm ${NPM_MAJOR}.x`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
