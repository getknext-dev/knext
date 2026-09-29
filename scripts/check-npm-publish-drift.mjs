#!/usr/bin/env node
/**
 * check-npm-publish-drift — thin CLI over `scripts/lib/npm-publish-drift-check.mjs`
 * (#1638 item 2).
 *
 * Reads two settings back from the live GitHub API and fails closed unless
 * BOTH verify as configured:
 *   1. the `npm-publish` Environment has a `required_reviewers` protection
 *      rule naming at least one reviewer;
 *   2. an enabled repository ruleset targets tags and covers `v*`.
 *
 * This is expected to be RED right now and until the founder configures item 1
 * of #1638 — see the nightly workflow's header comment and
 * `docs/security/npm-publish-drift-check.md`.
 *
 * Usage: node scripts/check-npm-publish-drift.mjs [--owner <o>] [--repo <r>]
 *   Defaults to getknext-dev/knext, overridable for a local dry run against a
 *   fork. Reads GITHUB_TOKEN from the environment if present (unauthenticated
 *   requests are rate-limited to 60/h and will read as `api-error`, never as
 *   a silent pass).
 */

import { githubApi, runDriftCheck } from './lib/npm-publish-drift-check.mjs';

const ENVIRONMENT = 'npm-publish';

function parseArgs(argv) {
  let owner = 'getknext-dev';
  let repo = 'knext';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--owner') owner = argv[++i];
    else if (argv[i] === '--repo') repo = argv[++i];
    else {
      console.error(`unrecognised argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return { owner, repo };
}

async function main() {
  const { owner, repo } = parseArgs(process.argv.slice(2));
  const report = await runDriftCheck({ owner, repo, environment: ENVIRONMENT, api: githubApi });

  console.log(
    `${owner}/${repo} environment "${ENVIRONMENT}" reviewer rule: ${report.reviewer.kind}`,
  );
  console.log(`${owner}/${repo} v*-covering tag ruleset: ${report.tagRuleset.kind}`);

  if (!report.ok) {
    for (const finding of report.findings) {
      console.error(`::error::${finding.message}`);
    }
    process.exit(1);
  }

  console.log('OK: npm-publish environment has a required reviewer AND a tag ruleset covers v*.');
}

main().catch((error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
