#!/usr/bin/env node
/**
 * ga-tarball-diff-gate.mjs — `release.yml`'s publish-blocking wiring for
 * `scripts/ga-tarball-diff.mjs` (#1562, implementing the design gate #1306).
 *
 * WHAT THIS DECIDES, separately from the diff script itself:
 *
 *   1. Is there a credentialed rc to compare against at all? `rcTag` in
 *      `.github/compat-credential-ref.json` (ADR-0056) is `null` until a
 *      founder cuts + credentials the first one. `null` is a deliberate
 *      NO-OP — printed loudly, never a silent pass that could be mistaken
 *      for "the tarballs were compared and are clean" (per the assignment:
 *      "never a silent pass that looks like a check").
 *   2. Given a credentialed rc, is THIS publish one the content diff should
 *      even attempt? `shouldRunGaTarballDiffGate`
 *      (`scripts/lib/ga-tarball-diff.mjs`) answers that — a GA cut or the
 *      credentialed rc's own re-publish get diffed; an ordinary mid-window
 *      rc bump is a deliberate SKIP (also printed loudly), because it is
 *      expected to carry real code changes relative to the credentialed rc.
 *   3. Only then does it invoke `scripts/ga-tarball-diff.mjs`'s `run()`
 *      against `--rc-ref <rcTag> --ga-ref HEAD` — HEAD, not a second tag,
 *      because `release.yml` runs this BEFORE `changeset publish` creates
 *      the GA/rc git tag; the commit about to be published already is HEAD.
 *
 * The target version is read from the checked-out tree itself (the fixed
 * `@getknext/*` group, which must already be at one version — see
 * `verify-published-group.mjs` for the coherence check that also enforces
 * that; this script re-asserts it defensively rather than assuming another
 * job's guard already ran) — never from `github.ref_name`, because this
 * workflow triggers on `push: branches: [main]`, not on a tag push.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as runGaTarballDiff } from './ga-tarball-diff.mjs';
import { shouldRunGaTarballDiffGate } from './lib/ga-tarball-diff.mjs';
import { publishablePackages, readWorkspaceManifests } from './publish-preflight.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(__dirname, '..');

/**
 * The credentialed rc tag, or `null` when no rc has been cut+credentialed
 * yet. Throws on a missing/unparseable pin file — an unreadable answer must
 * never be mistaken for "nothing credentialed".
 *
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function readCredentialRcTag(repoRoot) {
  const path = join(repoRoot, '.github', 'compat-credential-ref.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return typeof parsed.rcTag === 'string' ? parsed.rcTag : null;
}

/**
 * The single version the publishable `@getknext/*` fixed group is at in the
 * checked-out tree. Throws when the group is not coherent (not present, or
 * not all at one version) — this gate cannot answer "differs only in
 * version fields from WHAT" without a single target version.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function readTargetVersion(repoRoot) {
  const manifests = readWorkspaceManifests(repoRoot);
  const changesetConfig = JSON.parse(
    readFileSync(join(repoRoot, '.changeset', 'config.json'), 'utf8'),
  );
  const ignore = Array.isArray(changesetConfig.ignore) ? changesetConfig.ignore : [];
  const packages = publishablePackages(manifests, ignore).filter((p) =>
    p.name.startsWith('@getknext/'),
  );
  if (packages.length === 0) {
    throw new Error('no publishable @getknext/* package found in the checked-out tree');
  }
  const versions = new Set(packages.map((p) => p.version));
  if (versions.size !== 1) {
    const rows = packages.map((p) => `${p.name}@${p.version}`).join(', ');
    throw new Error(
      `the publishable @getknext/* group is not at one version (${rows}) — cannot determine a ` +
        'single target version for the GA-tarball-diff gate',
    );
  }
  return [...versions][0];
}

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {(...args: unknown[]) => void} [opts.log]
 * @param {(argv: string[], opts?: { log?: typeof console.log }) => number} [opts.runDiff]
 *   injectable so unit tests never spawn `git worktree`/`bun`.
 * @returns {number} process exit code
 */
export function main({
  repoRoot = defaultRepoRoot,
  log = console.log,
  runDiff = runGaTarballDiff,
} = {}) {
  const rcTag = readCredentialRcTag(repoRoot);
  if (rcTag === null) {
    log(
      '[ga-tarball-diff-gate] NO-OP: .github/compat-credential-ref.json has rcTag=null — no rc ' +
        'has been credentialed yet, so there is nothing to compare this publish against. This is ' +
        'a deliberate no-op, not a silent pass: once a founder cuts + credentials an rc, this gate ' +
        'starts comparing every GA cut / credentialed-rc re-publish against it.',
    );
    return 0;
  }

  const rcVersion = rcTag.replace(/^v/, '');
  const targetVersion = readTargetVersion(repoRoot);
  const decision = shouldRunGaTarballDiffGate(rcVersion, targetVersion);

  if (!decision.run) {
    log(`[ga-tarball-diff-gate] SKIP: ${decision.reason}`);
    return 0;
  }

  log(
    `[ga-tarball-diff-gate] RUN: ${decision.reason} — comparing credentialed rc ${JSON.stringify(rcTag)} ` +
      `against HEAD (target version ${JSON.stringify(targetVersion)})`,
  );
  return runDiff(['--rc-ref', rcTag, '--ga-ref', 'HEAD'], { log });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`[ga-tarball-diff-gate] ERROR: ${err.message}`);
    process.exit(1);
  }
}
