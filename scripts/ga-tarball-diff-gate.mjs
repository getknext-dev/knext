#!/usr/bin/env node
/**
 * ga-tarball-diff-gate.mjs — `release.yml`'s publish-blocking wiring for
 * `scripts/ga-tarball-diff.mjs` (#1562, implementing the design gate #1306).
 *
 * WHAT THIS DECIDES, separately from the diff script itself (#1562 round 2):
 *
 *   1. WHICH rc a publish is compared against — keyed on the GIT TAGS the
 *      founder pushed for the target's own `X.Y.Z` tuple (`vX.Y.Z-rc.N`), not
 *      on `rcTag` in `.github/compat-credential-ref.json`. `rcTag` is the
 *      credential window's LIVE pin and is legitimately cleared when a window
 *      closes — exactly when GA is cut — so keying on it made 1.0.0 a green
 *      no-op and blocked every later release while it stayed set.
 *      `decideGaTarballDiffGate` (`scripts/lib/ga-tarball-diff.mjs`) is the
 *      pure decision; `rcTag` is only consulted to FAIL an ambiguous
 *      credential (pinned at a same-tuple rc other than the highest).
 *   2. Only on RUN does it invoke `scripts/ga-tarball-diff.mjs`'s `run()`
 *      against `--rc-ref <highest vX.Y.Z-rc.N> --ga-ref HEAD` — HEAD, not a
 *      second tag, because `release.yml` runs this BEFORE `changeset publish`;
 *      the commit about to be published already is HEAD.
 *   3. EVERY outcome — RUN (with its PASS/FAIL), SKIP, FAIL — is announced
 *      as a `::notice::`/`::error::` annotation AND a `$GITHUB_STEP_SUMMARY`
 *      line, so a green check that compared nothing is never mistaken for
 *      "compared and clean".
 *
 * The target version is read from the checked-out tree itself (the fixed
 * `@getknext/*` group, which must already be at one version — see
 * `verify-published-group.mjs` for the coherence check that also enforces
 * that; this script re-asserts it defensively rather than assuming another
 * job's guard already ran) — never from `github.ref_name`, because this
 * workflow triggers on `push: branches: [main]`, not on a tag push.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideGaTarballDiffGate } from './lib/ga-tarball-diff.mjs';
import { publishablePackages, readWorkspaceManifests } from './publish-preflight.mjs';

// `./ga-tarball-diff.mjs` is deliberately NOT imported at module scope here
// (unlike the two imports above). It pulls in `lib/tar-entries.mjs`, which
// imports the `tar` npm devDependency — a real package that must be
// `bun install`ed. A SKIP or FAIL decision below never touches that code path
// and must be answerable from git tags + package.json alone; a top-level (or
// even a decision-gated dynamic `import()`, which would still bind `tar` into
// THIS process's module graph the moment it resolves) import would make even
// those outcomes depend on `node_modules` existing — exactly what crashed
// `release.yml`'s `ga-tarball-diff` job (no install step there) on a decision
// that never needed the diff at all. `defaultRunDiff`, below, instead runs
// `ga-tarball-diff.mjs` as a SEPARATE `node` process, spawned only on a RUN
// decision — the `tar` dependency chain never enters this script's own module
// graph, in any outcome. (This also keeps `main` fully synchronous, matching
// the sync contract its existing unit tests already assume.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(__dirname, '..');

/**
 * Runs `scripts/ga-tarball-diff.mjs` as a child `node` process rather than
 * importing its `run()` export in-process — see the comment above for why.
 *
 * @param {string[]} argv forwarded verbatim to `ga-tarball-diff.mjs`'s CLI.
 * @param {{ log?: typeof console.log, repoRoot?: string }} [opts]
 * @returns {number} the child process's exit code
 */
export function defaultRunDiff(argv, { log = console.log, repoRoot = defaultRepoRoot } = {}) {
  const diffScript = join(__dirname, 'ga-tarball-diff.mjs');
  const result = spawnSync(process.execPath, [diffScript, ...argv], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.stdout) log(result.stdout.replace(/\n$/, ''));
  if (result.stderr) log(result.stderr.replace(/\n$/, ''));
  if (result.status === null) {
    throw new Error(`ga-tarball-diff.mjs was terminated by signal ${result.signal}`);
  }
  return result.status;
}

/**
 * The credential window's live rc pin, or `null` (no window open). Used only
 * to detect an AMBIGUOUS credential — never to decide whether to diff. Throws on a missing/unparseable pin file — an unreadable answer must
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
 * Every git tag in `repoRoot`. Throws outside a git repo — an unanswerable
 * "which rc tags exist?" must fail closed, never read as "none".
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function listGitTagsDefault(repoRoot) {
  const out = execFileSync('git', ['tag', '--list'], { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\n').filter((t) => t.length > 0);
}

const TITLE = 'GA-tarball-diff gate';

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {(...args: unknown[]) => void} [opts.log]
 * @param {(argv: string[], opts?: { log?: typeof console.log, repoRoot?: string }) => number} [opts.runDiff]
 *   injectable so unit tests never spawn `git worktree`/`bun`/a child `node` process.
 * @param {(repoRoot: string) => string[]} [opts.listGitTags] injectable tag lister.
 * @param {string | undefined} [opts.summaryPath] `$GITHUB_STEP_SUMMARY`; unset locally.
 * @param {string | undefined} [opts.gaDir] a directory of already-packed
 *   tarballs for the ga/HEAD side (#1616) — `release.yml`'s `pack` job's
 *   downloaded artifact. When set, the diff compares against THOSE tarballs
 *   (`--ga-dir`) instead of building+packing HEAD a second time
 *   (`--ga-ref HEAD`). Defaults to `PACK_ONCE_GA_DIR` so the live workflow
 *   needs no code change beyond setting that env var; omitted (unset env,
 *   unset opt) reproduces the exact pre-#1616 behavior.
 * @returns {number} process exit code
 */
export function main({
  repoRoot = defaultRepoRoot,
  log = console.log,
  runDiff = defaultRunDiff,
  listGitTags = listGitTagsDefault,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  gaDir = process.env.PACK_ONCE_GA_DIR,
} = {}) {
  const announce = (level, verdict, reason) => {
    log(`::${level} title=${TITLE}::${verdict}: ${reason}`);
    if (summaryPath) appendFileSync(summaryPath, `- **${TITLE} — ${verdict}**: ${reason}\n`);
  };

  const pinnedRcTag = readCredentialRcTag(repoRoot);
  const targetVersion = readTargetVersion(repoRoot);
  const decision = decideGaTarballDiffGate({
    targetVersion,
    pinnedRcTag,
    gitTags: listGitTags(repoRoot),
  });

  if (decision.action === 'skip') {
    announce('notice', 'SKIP (nothing compared)', decision.reason);
    return 0;
  }
  if (decision.action === 'fail') {
    announce('error', 'FAIL', decision.reason);
    return 1;
  }

  const gaArgs = gaDir ? ['--ga-dir', gaDir] : ['--ga-ref', 'HEAD'];
  announce(
    'notice',
    'RUN',
    `${decision.reason} — comparing ${JSON.stringify(decision.rcTag)} against ` +
      (gaDir ? `the pack-once artifact (${gaDir})` : 'HEAD'),
  );
  const code = runDiff(['--rc-ref', decision.rcTag, ...gaArgs], { log, repoRoot });
  if (code === 0) {
    announce(
      'notice',
      'PASS',
      `the ${targetVersion} tarballs differ from ${decision.rcTag} only in version fields`,
    );
  } else {
    announce(
      'error',
      'FAIL',
      `the ${targetVersion} tarballs differ from ${decision.rcTag} beyond version fields (see the log above)`,
    );
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`[ga-tarball-diff-gate] ERROR: ${err.message}`);
    process.exit(1);
  }
}
