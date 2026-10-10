#!/usr/bin/env node
/**
 * check-npm-publish-drift — thin CLI over `scripts/lib/npm-publish-drift-check.mjs`
 * (#1638 item 2).
 *
 * Reads three settings back from the live GitHub API:
 *   1. the `npm-publish` Environment's `required_reviewers` protection rule
 *      — read and logged for information ONLY. By founder decision
 *      (#1638, 2026-10-02) this is deliberately absent and NOT a pass/fail
 *      criterion: the sole maintainer is pre-authorized to publish and asked
 *      not to be a blocking step.
 *   2. an enabled repository ruleset that targets tags and covers `v*` —
 *      THIS is the only setting that fails the check when missing. A
 *      repository ruleset ("release tags (v*) immutable") protects
 *      `refs/tags/v*` today, so this is expected to pass on a healthy run.
 *   3. the environment's `deployment_branch_policy` (#2109) — FAILS when null
 *      or when it admits any ref outside `scripts/publish-lane-guard.mjs`'s
 *      allowlist. Red until the founder applies it; that red is the reminder.
 *
 * See the nightly workflow's header comment and
 * `docs/security/npm-publish-drift-check.md`.
 *
 * Usage: node scripts/check-npm-publish-drift.mjs [--owner <o>] [--repo <r>] [--fixture <json>]
 *   --fixture serves `{ "<api path>": {status, body} }` instead of the network (offline proof).
 *   Defaults to getknext-dev/knext, overridable for a local dry run against a
 *   fork. Reads GITHUB_TOKEN from the environment if present (unauthenticated
 *   requests are rate-limited to 60/h and will read as `api-error`, never as
 *   a silent pass).
 */

import { readFileSync } from 'node:fs';
import { githubApi, runDriftCheck } from './lib/npm-publish-drift-check.mjs';

const ENVIRONMENT = 'npm-publish';

function fixtureApi(file) {
  const routes = JSON.parse(readFileSync(file, 'utf8'));
  return async (path) => {
    if (!(path in routes)) throw new Error(`fixture has no route for ${path}`);
    return routes[path];
  };
}

function parseArgs(argv) {
  let owner = 'getknext-dev';
  let repo = 'knext';
  let fixture;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--owner') owner = argv[++i];
    else if (argv[i] === '--repo') repo = argv[++i];
    else if (argv[i] === '--fixture') fixture = argv[++i];
    else {
      console.error(`unrecognised argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return { owner, repo, fixture };
}

async function main() {
  const { owner, repo, fixture } = parseArgs(process.argv.slice(2));
  const api = fixture ? fixtureApi(fixture) : githubApi;
  const report = await runDriftCheck({ owner, repo, environment: ENVIRONMENT, api });

  console.log(
    `${owner}/${repo} environment "${ENVIRONMENT}" reviewer rule: ${report.reviewer.kind} ` +
      '(informational only — not required by founder decision, #1638)',
  );
  console.log(`${owner}/${repo} v*-covering tag ruleset: ${report.tagRuleset.kind}`);
  console.log(`${owner}/${repo} deployment-branch policy: ${report.branchPolicy.kind}`);

  if (!report.ok) {
    for (const finding of report.findings) {
      console.error(`::error::${finding.message}`);
    }
    process.exit(1);
  }

  console.log(
    'OK: a tag ruleset covers v*; the environment admits only the publish-lane allowlist.',
  );
}

main().catch((error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
