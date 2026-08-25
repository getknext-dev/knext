#!/usr/bin/env node
/**
 * Does the tree contain a publishable version the registry does not have yet?
 *
 * WHY THIS EXISTS — the release lane starved itself for a month.
 * ------------------------------------------------------------
 * `release.yml` used to run ONE job that both opened the "Version Packages" PR
 * and published, and that job declared `environment: npm-publish`. That
 * environment carries a `required_reviewers` rule, so EVERY push to `main`
 * parked a run in `waiting` until a human clicked approve — including the pushes
 * that had nothing to publish and only wanted to open a Version PR.
 *
 * Run 30207128316 (2026-07-26) is the one that parked. With workflow-level
 * `concurrency: {group: release-refs/heads/main, cancel-in-progress: false}` it
 * held the group, every later push queued behind it as `pending`, and GitHub
 * keeps at most ONE pending run per group — so each new push cancelled the
 * previous one. 99 of the last 100 release runs are `cancelled` with ZERO jobs,
 * each cancelled at the exact second the next push arrived.
 *
 * Splitting version-from-publish only helps if the publish job can decide
 * WITHOUT starting, because the environment gate is evaluated when a job starts,
 * not when a step runs. A job-level `if:` is evaluated first — so the decision
 * has to be an OUTPUT of an earlier, ungated job. That is this script.
 *
 * THE DECISION
 * ------------
 * For every publishable workspace package (not `private`, not in changesets'
 * `ignore`), ask the registry whether `name@version` already exists. If any does
 * not, there is something to publish. This mirrors what `changeset publish`
 * itself does, so the gate cannot disagree with the command it gates.
 *
 * FAIL-CLOSED ON AN UNREACHABLE REGISTRY. `npm view` exits non-zero for BOTH
 * "404, no such version" and "the network is down", and grepping stderr to tell
 * them apart is exactly the output-parsing this repo has been burned by. So the
 * script probes a package that certainly exists FIRST (`npm` itself). If that
 * probe fails, the registry is unreachable and the script EXITS NON-ZERO rather
 * than guessing — an unreachable API is a failure, never a pass, and never a
 * silent "nothing to publish".
 *
 * Every verdict below is a process EXIT CODE. Nothing here reads command output.
 *
 * Usage:  node scripts/publish-preflight.mjs
 * Env:    PUBLISH_PREFLIGHT_REGISTRY  (default https://registry.npmjs.org/)
 * Writes: `should-publish=true|false` to $GITHUB_OUTPUT, a table to
 *         $GITHUB_STEP_SUMMARY, and both to stdout.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The workspace globs, kept as literal directory roots rather than parsed from
 * `pnpm-workspace.yaml`: this script must run with NO dependencies installed
 * (the preflight job deliberately skips `pnpm install` — it is a registry read,
 * not a build), so it cannot import a YAML parser.
 *
 * `assertWorkspaceRootsMatchPnpm` in the spec keeps this honest against
 * `pnpm-workspace.yaml` rather than trusting the comment.
 */
export const WORKSPACE_ROOTS = ['apps', 'packages'];

/** A package that certainly exists — the registry-reachability probe. */
export const REACHABILITY_PROBE = 'npm';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/**
 * Read every workspace manifest as `{ dir, name, version, private }`.
 *
 * @param {string} root repo root
 */
export function readWorkspaceManifests(root) {
  /** @type {Array<{dir: string, name: string, version: string, private: boolean}>} */
  const manifests = [];
  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const base = join(root, workspaceRoot);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(base, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof pkg.name !== 'string') continue;
      manifests.push({
        dir: `${workspaceRoot}/${entry.name}`,
        name: pkg.name,
        version: typeof pkg.version === 'string' ? pkg.version : '',
        private: pkg.private === true,
      });
    }
  }
  return manifests.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The set `changeset publish` would consider: public, versioned, not ignored.
 *
 * `ignore` is read from `.changeset/config.json` rather than re-listed here so
 * that a package moved into `ignore` leaves this gate at the same moment it
 * leaves the publish command's scope.
 *
 * @param {Array<{name: string, version: string, private: boolean}>} manifests
 * @param {string[]} ignore
 */
export function publishablePackages(manifests, ignore) {
  const ignored = new Set(ignore);
  return manifests.filter((m) => !m.private && !ignored.has(m.name) && m.version !== '');
}

/**
 * The pure decision, separated from every process spawn so it is testable
 * without a network.
 *
 * @param {Array<{name: string, version: string}>} packages
 * @param {(name: string, version: string) => boolean} isPublished
 * @returns {{shouldPublish: boolean, rows: Array<{name: string, version: string, published: boolean}>}}
 */
export function decide(packages, isPublished) {
  const rows = packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    published: isPublished(pkg.name, pkg.version),
  }));
  return { shouldPublish: rows.some((row) => !row.published), rows };
}

/** Thrown when the registry cannot be reached, so a 404 cannot be trusted. */
export class RegistryUnreachableError extends Error {}

/**
 * The whole gate, with the process spawn injected — so the fail-closed branch is
 * reachable from a test rather than only from a real outage.
 *
 * THROWS rather than returning `{shouldPublish: false}` when the registry is
 * unreachable. The difference is the point: a `false` SKIPS the publish job
 * silently (a skipped job is not a failed job and nothing reports it), so an
 * outage would look exactly like "already published". A throw fails the
 * preflight job, which fails the `needs` edge, which is loud.
 *
 * @param {{packages: Array<{name: string, version: string}>, viewSucceeds: (spec: string) => boolean}} input
 */
export function preflight({ packages, viewSucceeds }) {
  if (!viewSucceeds(REACHABILITY_PROBE)) {
    throw new RegistryUnreachableError(
      `cannot reach the registry — \`npm view ${REACHABILITY_PROBE} version\` exited non-zero. ` +
        'Refusing to report "nothing to publish" from an unreachable registry.',
    );
  }
  return decide(packages, (name, version) => viewSucceeds(`${name}@${version}`));
}

/**
 * `npm view <spec> version` — TRUE iff npm exited 0.
 *
 * Branching on the exit code is the whole contract: npm's stderr wording has
 * changed between majors and a message match would rot silently.
 *
 * @param {string} spec
 * @param {string} registry
 */
function npmViewSucceeds(spec, registry) {
  const run = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['view', spec, 'version', '--registry', registry],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (run.error) return false;
  return run.status === 0;
}

function readIgnoreList(root) {
  const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8'));
  return Array.isArray(config.ignore) ? config.ignore : [];
}

function emit(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  console.log(`${name}=${value}`);
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

function summarise(lines) {
  const text = lines.join('\n');
  console.log(text);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${text}\n`);
}

function main() {
  const registry = process.env.PUBLISH_PREFLIGHT_REGISTRY || DEFAULT_REGISTRY;

  const packages = publishablePackages(
    readWorkspaceManifests(REPO_ROOT),
    readIgnoreList(REPO_ROOT),
  );
  if (packages.length === 0) {
    console.error(
      '[publish-preflight] FATAL: no publishable packages found. Either the workspace layout ' +
        'moved or every package became private — either way this gate would pass vacuously.',
    );
    process.exit(1);
  }

  let result;
  try {
    result = preflight({ packages, viewSucceeds: (spec) => npmViewSucceeds(spec, registry) });
  } catch (err) {
    if (!(err instanceof RegistryUnreachableError)) throw err;
    console.error(`[publish-preflight] FATAL: ${registry}: ${err.message}`);
    process.exit(1);
  }
  const { shouldPublish, rows } = result;

  summarise([
    '### npm publish preflight',
    '',
    `Registry: \`${registry}\``,
    '',
    '| package | version in tree | on registry |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| \`${r.name}\` | ${r.version} | ${r.published ? 'yes' : '**no**'} |`),
    '',
    shouldPublish
      ? '**Verdict: publish needed** — at least one version above is absent from the registry.'
      : 'Verdict: nothing to publish — every version in the tree is already on the registry.',
  ]);

  emit('should-publish', shouldPublish ? 'true' : 'false');
}

// Only run when invoked directly, so the spec can import the pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
