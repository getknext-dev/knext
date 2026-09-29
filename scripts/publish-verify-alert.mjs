#!/usr/bin/env node
/**
 * publish-verify-alert.mjs — #1639(c).
 *
 * Nothing previously alerted when a version bump landed on `main` and did NOT
 * end up published — the same silent-skip class as #1622 (a publish-blocking
 * job crashed with no install step and nobody noticed until the compat
 * credential window came up short), generalized to "publish was attempted
 * and, for ANY reason (crash, red CI, environment approval never given,
 * registry outage), did not happen".
 *
 * This re-asks the EXACT question `scripts/publish-preflight.mjs` asked
 * before the release run: is there a publishable `name@version` in the tree
 * the registry does not have? It deliberately reuses that script's
 * `readWorkspaceManifests`/`publishablePackages`/`readIgnoreList`/
 * `npmViewSucceeds`/`preflight` rather than re-implementing the registry
 * probe — this is the SAME decision, asked a second time, after the release
 * run instead of before it.
 *
 * Wired as a job in `release.yml` that runs `if: always()` after `release`
 * (and needs `publish-preflight` to have decided `should_publish: true` —
 * otherwise there was nothing to publish and a gap is not news), so it fires
 * whether `release` succeeded-but-partially-failed, hard-failed, or never
 * ran at all (e.g. `ga-tarball-diff` blocked it).
 *
 * Reuses the standing nightly-alert pattern (`scripts/lib/nightly-alert-issue.mjs`'s
 * `ensureAlertIssue`) rather than a bespoke `gh issue create` — same dedup-by-title
 * behavior every other nightly alert gets, never pinned (#1347).
 *
 * FAILS CLOSED on an unreachable registry, same as `publish-preflight.mjs`:
 * an unanswerable "did it publish?" is never silently read as "yes".
 *
 * Usage:  GITHUB_REPOSITORY=owner/repo node scripts/publish-verify-alert.mjs
 * Env:    PUBLISH_PREFLIGHT_REGISTRY (default https://registry.npmjs.org/)
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAlertIssue } from './lib/nightly-alert-issue.mjs';
import {
  DEFAULT_REGISTRY,
  npmViewSucceeds,
  preflight,
  publishablePackages,
  RegistryUnreachableError,
  readIgnoreList,
  readWorkspaceManifests,
} from './publish-preflight.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TITLE = 'main is ahead of the npm registry after a release run';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function summarise(lines) {
  const text = lines.join('\n');
  console.log(text);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${text}\n`);
}

/**
 * @param {{
 *   repoRoot?: string,
 *   registry?: string,
 *   repo: string,
 *   viewSucceeds?: (spec: string, registry: string) => boolean,
 *   gh?: (args: string[]) => string,
 *   runUrl?: string,
 * }} opts
 * @returns {{ lagging: boolean, rows: Array<{name: string, version: string, published: boolean}>, alert?: { number: number, created: boolean } }}
 */
export function verifyAndAlert({
  repoRoot = REPO_ROOT,
  registry = process.env.PUBLISH_PREFLIGHT_REGISTRY || DEFAULT_REGISTRY,
  repo,
  viewSucceeds = npmViewSucceeds,
  gh: ghFn = gh,
  runUrl,
} = {}) {
  const packages = publishablePackages(readWorkspaceManifests(repoRoot), readIgnoreList(repoRoot));
  if (packages.length === 0) {
    throw new Error(
      'no publishable packages found — either the workspace layout moved or every package ' +
        'became private, either way this check would pass vacuously',
    );
  }

  const { shouldPublish, rows } = preflight({
    packages,
    viewSucceeds: (spec) => viewSucceeds(spec, registry),
  });

  if (!shouldPublish) {
    summarise(['✅ main matches the registry — nothing is lagging.']);
    return { lagging: false, rows };
  }

  const laggingRows = rows.filter((row) => !row.published);
  const body = [
    `A release run completed on \`main\`, but the following package(s) are still NOT on ${registry}:`,
    '',
    ...laggingRows.map((row) => `- \`${row.name}@${row.version}\``),
    '',
    'This means the publish was skipped or failed. Check the release run' +
      (runUrl ? ` (${runUrl})` : '') +
      " — the `release` job's own logs (and the `ga-tarball-diff`/`audit` jobs it depends on) " +
      'are the first place to look.',
    '',
    'This issue is filed by `scripts/publish-verify-alert.mjs` (#1639) and is dedup-by-title, ' +
      'never pinned.',
  ].join('\n');

  summarise([
    `🚨 main is ahead of the registry: ${laggingRows.map((r) => `${r.name}@${r.version}`).join(', ')}`,
  ]);

  const alert = ensureAlertIssue({ gh: ghFn, repo, title: TITLE, body });
  return { lagging: true, rows, alert };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) {
      console.error('::error::GITHUB_REPOSITORY is required');
      process.exit(1);
    }
    const runUrl =
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined;
    const result = verifyAndAlert({ repo, runUrl });
    if (result.lagging) {
      console.log(
        `${result.alert.created ? 'created' : 'updated'} alert issue #${result.alert.number}`,
      );
    }
  } catch (err) {
    if (err instanceof RegistryUnreachableError) {
      console.error(`::error::${err.message}`);
      process.exit(1);
    }
    console.error(`::error::publish-verify-alert failed closed: ${err.message}`);
    process.exit(1);
  }
}
