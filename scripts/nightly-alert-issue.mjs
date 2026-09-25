#!/usr/bin/env node
/**
 * nightly-alert-issue — thin CLI wrapper around `scripts/lib/nightly-alert-issue.mjs`'s
 * `ensureAlertIssue` (#1347). Every migrated nightly workflow's alert step
 * now ends with this instead of its own inline `gh issue list`/`create`/
 * `comment`/`pin` block.
 *
 * The workflow-specific `title`/`body` (heredoc bodies, run-specific
 * triage text) stay exactly where they were — built as shell variables in
 * the SAME `run:` step, immediately above the call to this script — so this
 * migration touches only the previously-duplicated TAIL of each alert step,
 * never its bespoke content.
 *
 * Required env: GH_TOKEN (or gh's own auth), GITHUB_REPOSITORY (set by
 * GitHub Actions automatically for every job — never declared explicitly),
 * TITLE, BODY.
 *
 * Usage:  TITLE="$title" BODY="$body" node scripts/nightly-alert-issue.mjs
 */

import { execFileSync } from 'node:child_process';
import { ensureAlertIssue } from './lib/nightly-alert-issue.mjs';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const title = process.env.TITLE;
  const body = process.env.BODY;

  if (!repo || !title || !body) {
    console.error('FATAL: GITHUB_REPOSITORY, TITLE, BODY are all required');
    process.exit(1);
  }

  const result = ensureAlertIssue({ gh, repo, title, body });
  console.log(
    `${result.created ? 'created' : 'updated'} alert issue #${result.number} (never pinned — #1347)`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${message}`);
  process.exit(1);
}
