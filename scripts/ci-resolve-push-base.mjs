#!/usr/bin/env node
/**
 * Resolve the base commit a ci.yml job compares against (#2381).
 *
 * ci.yml runs on push to `main` and `integration/**`. A push that CREATES a
 * branch carries an all-zero `github.event.before`, and the two jobs that diff
 * against a base (`grpc-contracts`'s buf breaking, `file-manager-e2e-round`'s
 * path scoping) fail closed on it. So every new release line's first push was
 * red for a reason that says nothing about the tree.
 *
 * On a branch-creation push (event `push`, `github.event.created` true, an
 * all-zero before) this returns the merge-base of HEAD with `origin/main`,
 * fetching `main` when the checkout does not have it. That is the commit the
 * new line forked from, which is what "the change this push introduces" means
 * for a branch that has no previous tip.
 *
 * Everything else PASSES THROUGH unchanged, including an empty, all-zero or
 * unresolvable base on any other event. The consumers keep their own
 * fail-closed checks, and this script must not launder those cases into a
 * plausible-looking sha. A fallback that cannot be computed is an error.
 *
 * CLI: reads EVENT_NAME, PUSH_CREATED and RAW_BASE_SHA from the environment and
 * writes `sha=<base>` to $GITHUB_OUTPUT. Tested by
 * tests/ci-resolve-push-base.test.ts.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const ZERO_SHA = /^0{40}$/;
const MAIN_REF = 'refs/remotes/origin/main';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/**
 * @param {object} input
 * @param {string} input.eventName `github.event_name`
 * @param {string} input.created `github.event.created` as the string Actions renders
 * @param {string} input.before the raw base expression's value
 * @param {string} [input.cwd] the checkout
 * @returns {{ sha: string, reason: string }}
 */
export function resolvePushBase({ eventName, created, before, cwd = process.cwd() }) {
  const isCreation = eventName === 'push' && created === 'true' && ZERO_SHA.test(before ?? '');
  if (!isCreation) {
    return { sha: before ?? '', reason: 'pass-through: not a branch-creation push' };
  }

  if (!git(cwd, ['rev-parse', '--verify', '--quiet', `${MAIN_REF}^{commit}`]).ok) {
    const fetched = git(cwd, [
      'fetch',
      '--no-tags',
      '--quiet',
      'origin',
      `+refs/heads/main:${MAIN_REF}`,
    ]);
    if (!fetched.ok) {
      throw new Error(`branch-creation push: could not fetch origin/main: ${fetched.err}`);
    }
  }

  const mb = git(cwd, ['merge-base', MAIN_REF, 'HEAD']);
  if (!mb.ok || !/^[0-9a-f]{40}$/.test(mb.out)) {
    throw new Error(
      `branch-creation push: no merge-base between HEAD and origin/main${mb.err ? `: ${mb.err}` : ''}`,
    );
  }
  return { sha: mb.out, reason: `branch-creation push: merge-base with origin/main ${mb.out}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let result;
  try {
    result = resolvePushBase({
      eventName: process.env.EVENT_NAME ?? '',
      created: process.env.PUSH_CREATED ?? '',
      before: process.env.RAW_BASE_SHA ?? '',
    });
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
  console.log(`base: ${result.sha || '(empty)'} — ${result.reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${result.sha}\n`);
}
