#!/usr/bin/env node
/**
 * npm dist-tag rollback — for a broken `1.0.0`.
 *
 * WHY THIS EXISTS
 * ----------------
 * `docs/RELEASING.md`'s rollback runbook says: never unpublish (npm versions are
 * immutable and unpublishing breaks every consumer pinned to it); move `latest`
 * back to the last known-good version on ALL FOUR publishable packages
 * TOGETHER (`@getknext/core`, `@getknext/lib`, `@getknext/db`, `kn-next` — the
 * same `fixed` group `.changeset/config.json` ships as a set, per #255/#256);
 * `npm deprecate` the broken version with a pointer; fix forward.
 *
 * Moving the tag on three of four and forgetting the fourth reproduces exactly
 * the #255/#256 partial-group incident this repo has already been bitten by
 * once, just via a dist-tag move instead of a publish. This script makes "move
 * all four together" a property of the TOOL, not of the operator's memory:
 *
 *   - it always acts on the full four-package group (never a subset — there is
 *     no per-package invocation);
 *   - it REFUSES before touching anything if the rollback target version is not
 *     published for every one of the four (a target that was never a real
 *     release, or a typo, would otherwise point `latest` at nothing);
 *   - it prints the exact commands it will run and only RUNS them with the
 *     explicit `--execute` flag — the default is a dry run, because a `dist-tag
 *     add` against the public registry is exactly the kind of irreversible
 *     action `docs/RELEASING.md` already treats as the one human-gated step in
 *     the release lane.
 *
 * This script is NEVER run against the real registry by an agent. The `rc`
 * dist-tag rehearsal (issue #1673) needs npm credentials and is a founder
 * action — see the "Rehearsal" section this file's usage comment points at in
 * `docs/RELEASING.md`.
 *
 * Usage:
 *   node scripts/npm-dist-tag-rollback.mjs --to 0.4.3 --broken 1.0.0 [--dist-tag latest] [--execute]
 *
 *   node scripts/npm-dist-tag-rollback.mjs --to 0.4.3 --broken 1.0.0-rc.2 --dist-tag rc
 *     # the rehearsal shape (issue #1673) — same tool, a non-`latest` tag, so a
 *     # botched rehearsal cannot touch real users. Still requires --execute and
 *     # npm credentials to actually run; without --execute it only prints.
 *
 * Flags:
 *   --to <version>        REQUIRED. The known-good version to roll the tag back to.
 *   --broken <version>    REQUIRED. The broken version to `npm deprecate`.
 *   --dist-tag <tag>      Default: "latest". The dist-tag to move.
 *   --registry <url>      Default: https://registry.npmjs.org/
 *   --execute             Actually run the commands. Default: print only (dry run).
 *
 * Exit codes: 0 = printed (dry run) or executed successfully. 1 = refused
 * (missing flag, rollback target not published for all four, or a command
 * failed while executing).
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  npmViewSucceeds,
  publishablePackages,
  readIgnoreList,
  readWorkspaceManifests,
} from './publish-preflight.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
export const DEFAULT_DIST_TAG = 'latest';

/** The `fixed` group's size — a hard invariant, not a convenience default. */
export const EXPECTED_GROUP_SIZE = 4;

/**
 * Discover the publishable package NAMES this repo ships as one group — the
 * same set `publish-preflight.mjs` and `changeset publish` consider, so this
 * script cannot silently disagree with either about who's in the group.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function discoverGroupPackageNames(root) {
  return publishablePackages(readWorkspaceManifests(root), readIgnoreList(root)).map((p) => p.name);
}

/**
 * Which of the target group's packages are (or are not) published at
 * `targetVersion`. Pure — the registry probe is injected.
 *
 * @param {{packageNames: string[], targetVersion: string, viewSucceeds: (spec: string) => boolean}} input
 * @returns {{allPublished: boolean, missing: string[]}}
 */
export function validateTargetPublished({ packageNames, targetVersion, viewSucceeds }) {
  const missing = packageNames.filter((name) => !viewSucceeds(`${name}@${targetVersion}`));
  return { allPublished: missing.length === 0, missing };
}

/**
 * The pure plan: one `npm dist-tag add` and one `npm deprecate` per package,
 * for the FULL group — never a subset. Argv arrays, not shell strings, so
 * nothing here is a shell-injection surface and printing is just `.join(' ')`.
 *
 * @param {{packageNames: string[], target: string, broken: string, distTag: string, registry: string}} input
 * @returns {Array<{name: string, kind: 'dist-tag'|'deprecate', argv: string[], description: string}>}
 */
export function buildRollbackCommands({ packageNames, target, broken, distTag, registry }) {
  /** @type {Array<{name: string, kind: 'dist-tag'|'deprecate', argv: string[], description: string}>} */
  const commands = [];
  for (const name of packageNames) {
    commands.push({
      name,
      kind: 'dist-tag',
      argv: ['npm', 'dist-tag', 'add', `${name}@${target}`, distTag, '--registry', registry],
      description: `move ${name}'s "${distTag}" dist-tag back to ${target}`,
    });
  }
  for (const name of packageNames) {
    commands.push({
      name,
      kind: 'deprecate',
      argv: [
        'npm',
        'deprecate',
        `${name}@${broken}`,
        `Deprecated: ${broken} was rolled back. Install ${name}@${target} (dist-tag "${distTag}") instead.`,
        '--registry',
        registry,
      ],
      description: `deprecate ${name}@${broken} with a pointer to ${target}`,
    });
  }
  return commands;
}

function formatArgv(argv) {
  return argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

function parseArgs(argv) {
  /** @type {{to?: string, broken?: string, distTag: string, registry: string, execute: boolean}} */
  const out = { distTag: DEFAULT_DIST_TAG, registry: DEFAULT_REGISTRY, execute: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--to') out.to = argv[++i];
    else if (arg === '--broken') out.broken = argv[++i];
    else if (arg === '--dist-tag') out.distTag = argv[++i];
    else if (arg === '--registry') out.registry = argv[++i];
    else if (arg === '--execute') out.execute = true;
    else {
      console.error(`[npm-dist-tag-rollback] unrecognized argument: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

/**
 * Run every command in order with a real `spawnSync`. Aborts at the FIRST
 * non-zero exit rather than pressing on, and reports which commands already
 * ran successfully — npm has no cross-package transaction, so a mid-run
 * failure leaves a real partial state, and hiding that would be worse than
 * reporting it plainly.
 *
 * @param {Array<{name: string, kind: string, argv: string[], description: string}>} commands
 * @param {(argv: string[]) => {status: number|null}} run
 */
export function executeCommands(commands, run) {
  const completed = [];
  for (const cmd of commands) {
    const result = run(cmd.argv);
    if (result.status !== 0) {
      return { ok: false, completed, failed: cmd };
    }
    completed.push(cmd);
  }
  return { ok: true, completed, failed: null };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.to) {
    console.error(
      '[npm-dist-tag-rollback] FATAL: --to <version> is required (the rollback target).',
    );
    process.exit(1);
  }
  if (!args.broken) {
    console.error(
      '[npm-dist-tag-rollback] FATAL: --broken <version> is required (the version being deprecated).',
    );
    process.exit(1);
  }

  const packageNames = discoverGroupPackageNames(REPO_ROOT);
  if (packageNames.length !== EXPECTED_GROUP_SIZE) {
    console.error(
      `[npm-dist-tag-rollback] FATAL: discovered ${packageNames.length} publishable package(s), ` +
        `expected ${EXPECTED_GROUP_SIZE} (${packageNames.join(', ') || 'none'}). Refusing to move ` +
        'dist-tags for a group that does not match the known fixed group — check ' +
        '.changeset/config.json and the workspace layout before retrying.',
    );
    process.exit(1);
  }

  const { allPublished, missing } = validateTargetPublished({
    packageNames,
    targetVersion: args.to,
    viewSucceeds: (spec) => npmViewSucceeds(spec, args.registry),
  });
  if (!allPublished) {
    console.error(
      `[npm-dist-tag-rollback] FATAL: rollback target ${args.to} is not published for: ` +
        `${missing.join(', ')}. Refusing to move any dist-tag toward an unpublished version — ` +
        'all four packages must move together, and they cannot move to a version that does not exist.',
    );
    process.exit(1);
  }

  const commands = buildRollbackCommands({
    packageNames,
    target: args.to,
    broken: args.broken,
    distTag: args.distTag,
    registry: args.registry,
  });

  console.log(`### npm dist-tag rollback plan`);
  console.log('');
  console.log(
    `Moving "${args.distTag}" back to ${args.to} for all ${packageNames.length} packages,`,
  );
  console.log(`deprecating ${args.broken} on each with a pointer to ${args.to}.`);
  console.log('');
  for (const cmd of commands) {
    console.log(`  ${cmd.description}:`);
    console.log(`    ${formatArgv(cmd.argv)}`);
  }
  console.log('');

  if (!args.execute) {
    console.log('DRY RUN — pass --execute to actually run the commands above.');
    process.exit(0);
  }

  const { ok, completed, failed } = executeCommands(commands, (argv) =>
    spawnSync(argv[0], argv.slice(1), { cwd: REPO_ROOT, stdio: 'inherit' }),
  );
  if (!ok) {
    console.error('');
    console.error(
      `[npm-dist-tag-rollback] FATAL: command failed: ${formatArgv(failed.argv)}. ` +
        `${completed.length} of ${commands.length} command(s) already succeeded — the group is now ` +
        'partial. Re-run the remaining commands printed above manually; do not re-run this script ' +
        'blindly, since it does not skip already-applied steps.',
    );
    process.exit(1);
  }
  console.log('All commands succeeded.');
}

// Only run when invoked directly, so the spec can import the pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
