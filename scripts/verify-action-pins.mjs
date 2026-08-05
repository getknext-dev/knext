#!/usr/bin/env node
/**
 * verify-action-pins — resolve every publish-path action pin against the tag
 * its comment claims, UPSTREAM, at run time (#539).
 *
 * WHY THIS IS NOT A UNIT TEST
 * ---------------------------
 * `tests/release-action-pins.test.ts` asserts a pin's FORM and SCOPE: a 40-hex
 * SHA, an auditable `# vX.Y.Z` comment, and an allowlist of which actions may
 * appear on a workflow that holds a registry-write credential. It deliberately
 * does NOT assert the SHA VALUE — an earlier revision did, and it reddened
 * every CORRECT Dependabot bump (#530/#532 preserved the pin form exactly and
 * still failed), so the routine way to get green became "edit the supply-chain
 * guard". That is how a control decays into a rubber stamp.
 *
 * The property actually worth having is different: does the pinned SHA BELONG
 * to the tag the comment names? That answer lives upstream and legitimately
 * changes, so it cannot be frozen into a committed assertion — it has to be
 * resolved against the GitHub API at run time. Hence a NIGHTLY workflow rather
 * than a PR gate: making it PR-blocking would couple every merge to a
 * third-party API's availability.
 *
 * WHAT IT CATCHES
 * ---------------
 *  - a pin that is well-formed but is not the commit that tag points at;
 *  - a pin naming a tag that does not exist upstream (deleted, or never a tag:
 *    `changesets/action@v1` is a BRANCH, `git/ref/tags/v1` 404s) — a legitimate
 *    finding, not an error to swallow;
 *  - an unpinned `docker://` container image IN A FILE WHERE NOTHING ELSE PARSED
 *    AS A PIN — reported as itself rather than as a regex-breakage alarm (#630
 *    review). Read that scope literally: the detection sits inside the
 *    `pins.length === 0` branch below, so ONE normally-pinned action anywhere in
 *    the same file makes this path unreachable and the docker ref is reported
 *    NOWHERE. Measured, not inferred — a file holding
 *    `actions/checkout@<40-hex> # v4.0.0` next to `docker://alpine:3.18` yields
 *    ZERO findings. The gap is PRE-EXISTING (this reporting split changed which
 *    finding carries the case, never which cases are seen) and is left open
 *    deliberately: hoisting the check naively would false-red a correctly
 *    DIGEST-pinned image, because `unreadableUsesValues` returns
 *    `docker://img@sha256:…` too. Closing it properly needs an `@`/digest guard,
 *    its own mutation proof, and a fixture where `pins.length > 0`;
 *  - a FORK-NETWORK commit. security.md notes GitHub serves any SHA in a repo's
 *    fork network from the parent path, so "does this SHA exist in the repo"
 *    proves nothing. This check never asks that question: it compares the pin
 *    against the commit the TAG dereferences to in the canonical repository, so
 *    a commit pushed to a fork can never match.
 *
 * WHAT IT DOES NOT CATCH
 * ----------------------
 * It trusts the version COMMENT as the statement of intent. A pin that
 * correctly names, and correctly resolves to, a tag whose content is itself
 * malicious is out of scope — that is what the action allowlist and human
 * review of the Dependabot diff are for. It also cannot distinguish "we pinned
 * the wrong SHA" from "upstream moved the tag"; both are reported, and both
 * warrant a human look at a credentialed path.
 *
 * Annotated tags MUST be dereferenced: `git/ref/tags/<tag>` returns an object
 * of type `tag` whose own sha is the tag object, not the commit. Comparing that
 * to the pin would red every correct annotated-tag pin.
 *
 * TWO ROUTES TO THE SAME ANSWER (#640)
 * ------------------------------------
 * The nightly was permanently red for four pins because `aquasecurity` (the
 * Trivy actions) enables an organisation IP ALLOW LIST, and a GitHub-hosted
 * runner's address is not on it:
 *
 *   403: … the `aquasecurity` organization has an IP allow list enabled, and
 *        your IP address is not permitted to access this resource.
 *
 * The check was right to fail — an unreachable API is a failure, never a pass —
 * but it had no way to resolve those pins AT ALL from CI, and a permanently-red
 * gate is one people learn to ignore, which is worse than the failure it was
 * built to catch. The fix is a SECOND ROUTE, never a downgraded verdict: on a
 * 403/451 only, resolve the same tag with an anonymous `git ls-remote` (the git
 * protocol is not behind the org's API allow list). `refs/tags/<tag>^{}` is the
 * annotated-tag dereference, and the refs come from the canonical repository, so
 * the guarantee is identical — including the fork-network immunity below. If
 * that route fails too, the 403 stands and BOTH causes are reported.
 *
 * Deliberately NOT done: downgrading a 403 to a pass, or allowlisting "API
 * errors" in general. Either would silently cover a real mismatch on every other
 * repo. The diversion set is `GIT_FALLBACK_STATUSES` and nothing else reaches
 * it. Note that GitHub also returns 403 for an exhausted rate limit, which
 * therefore diverts too — that is still a genuine RESOLUTION, not a skip.
 * Requires `git` on PATH; the nightly checks out the repo, so it has one.
 *
 * Usage: node scripts/verify-action-pins.mjs [--root <repo-root>]
 *   --root  repository root to scan (default: cwd). The scan covers
 *           .github/workflows, .github/actions/** and the root action.yml.
 * Exits 1 (with an actionable report) if there is any finding, if it can see NO
 * files to check, or on an unrecognised argument. There is no combination of
 * arguments that makes this script exit 0 without having verified something.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The credential-bearing workflows. Kept in sync with the publish path by
 * tests/action-pin-sha-tag-nightly.test.ts, which SCANS every workflow for
 * `secrets.NPM_TOKEN` and requires each hit to appear here — so a third
 * credentialed workflow cannot escape the nightly by being forgotten.
 *
 * NOTE (#528): this is no longer the SCOPE of the check — every workflow in the
 * directory is resolved now. It remains the named subset that holds a live npm
 * publish credential, which is what the credentialed-coverage test asserts on.
 */
export const PINNED_WORKFLOWS = ['release.yml', 'release-ghp.yml'];

/**
 * Every workflow in `dir`, DISCOVERED rather than enumerated (#528). A list is
 * how the twelfth workflow gets missed; a directory scan means a workflow added
 * tomorrow is resolved tonight without anyone editing this file.
 */
export function discoverWorkflows(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
}

const YAML = (file) => file.endsWith('.yml') || file.endsWith('.yaml');

/**
 * Every file in the repo that may carry a `uses:`, relative to `repoRoot`
 * (#528 review). `.github/workflows` is NOT the whole boundary:
 *
 *   - `.github/workflows/*.yml`      — the workflows themselves;
 *   - `.github/actions/** /action.yml` — local composite actions;
 *   - `action.yml` at the repo root  — the published `Deploy with knext` action.
 *
 * A composite action's steps run INSIDE the caller's job, with the caller's
 * token, so a floating ref there is as credential-adjacent as one in a
 * workflow. Leaving it outside the scan would make "pinned by default" false
 * for a whole class of file while every guard stayed green.
 *
 * This is the single definition of the boundary — the form guard imports it
 * rather than re-deriving one, because two definitions drift.
 */
export function discoverPinnableFiles(repoRoot) {
  const found = [];

  const workflowDir = resolve(repoRoot, '.github/workflows');
  if (existsSync(workflowDir)) {
    for (const file of readdirSync(workflowDir).filter(YAML)) {
      found.push(`.github/workflows/${file}`);
    }
  }

  // Composite actions nest arbitrarily deep under .github/actions.
  //
  // SYMLINKED directories are descended, which `entry.isDirectory()` alone does
  // NOT do — that predicate is false for a symlink Dirent, so a symlinked
  // directory would be silently skipped. Skipping is safe-by-omission but it is
  // still a hole in a boundary we describe as complete, and "the scan quietly
  // ignores this shape" is the failure mode this whole file exists to avoid.
  // Following symlinks means cycles are possible, so track REAL paths and never
  // visit one twice.
  const visited = new Set();
  const walk = (absolute, relative) => {
    let real;
    try {
      real = realpathSync(absolute);
    } catch {
      return; // broken symlink: nothing to read, and not a finding about pins
    }
    if (visited.has(real)) return;
    visited.add(real);

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childAbs = join(absolute, entry.name);
      const childRel = `${relative}/${entry.name}`;
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(childAbs).isDirectory(); // statSync FOLLOWS the link
        } catch {
          continue; // broken link
        }
      }
      if (isDirectory) walk(childAbs, childRel);
      else if (YAML(entry.name)) found.push(childRel);
    }
  };
  const actionsDir = resolve(repoRoot, '.github/actions');
  if (existsSync(actionsDir) && statSync(actionsDir).isDirectory()) {
    walk(actionsDir, '.github/actions');
  }

  for (const name of ['action.yml', 'action.yaml']) {
    if (existsSync(resolve(repoRoot, name))) found.push(name);
  }

  return found.sort();
}

/** `uses: owner/repo[/path]@<ref>` with an optional trailing `# comment`. */
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(\S+?)@(\S+)\s*(?:#\s*(.*))?$/;
/**
 * The `uses:` KEY plus whatever value follows, quoted or not. Used only by
 * `mentionsUses`, which must stay independent of (and weaker than) `USES_LINE`.
 */
const USES_KEY = /["']?\buses["']?\s*:\s*(\S+)?/;
/** The auditable version comment the form guard already requires. */
const VERSION_COMMENT = /^(v\d+\.\d+\.\d+[\w.+-]*)/;

const GITHUB_API_BASE = 'https://api.github.com/';

/**
 * Extract every `uses:` pin from a workflow's text. Malformed entries (no SHA,
 * no version comment) are RETAINED with the offending field left undefined —
 * dropping them here would let an unpinned or uncommented ref pass by never
 * being looked at, which is the opposite of the intent.
 */
export function parsePins(text, file) {
  const pins = [];
  for (const [index, line] of text.split('\n').entries()) {
    const match = USES_LINE.exec(line);
    if (!match) continue;
    const [, action, ref, comment] = match;
    if (!action || !ref) continue;
    const [owner, repo] = action.split('/');
    const tagMatch = VERSION_COMMENT.exec((comment ?? '').trim());
    pins.push({
      file,
      line: index + 1,
      action,
      owner,
      repo,
      sha: /^[0-9a-f]{40}$/.test(ref) ? ref : undefined,
      ref,
      tag: tagMatch ? tagMatch[1] : undefined,
    });
  }
  return pins;
}

/** Default API transport: authenticated with GITHUB_TOKEN when present. */
export async function githubApi(path) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'knext-verify-action-pins',
    'x-github-api-version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${GITHUB_API_BASE}${path}`, { headers });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/**
 * The ONLY API statuses that may divert to the git fallback below (#640).
 *
 * 403 is what an organisation IP allow list returns to an authenticated request
 * from an address it does not permit; 451 is the unavailable-for-legal-reasons
 * sibling. Both mean "this identity, from here, may not ask" — NOT "the answer
 * is fine". Anything else keeps its existing verdict exactly: a 404 is still a
 * missing tag, a 429/5xx and a thrown transport are still failures. Widening
 * this set to "API errors" would silently cover a real mismatch on every other
 * repo, which is the hole security.md names.
 */
export const GIT_FALLBACK_STATUSES = new Set([403, 451]);

/** A plain GitHub owner/repo segment. Anything else never becomes argv. */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A plain tag. Deliberately narrower than git allows — this is a command line. */
const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Block for `ms`. Synchronous on purpose: `gitLsRemoteTag` is a synchronous
 * function called from an async one, and making it async to hold a backoff
 * would ripple through every caller and every test double for no gain.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * An empty directory, outside any repository, to run `git` from.
 *
 * THIS IS THE ANONYMITY MECHANISM, not a tidiness detail (#666 review).
 * `actions/checkout` defaults to `persist-credentials: true`, which writes into
 * the CHECKOUT'S LOCAL `.git/config`:
 *
 *   [http "https://github.com/"]
 *       extraheader = AUTHORIZATION: basic <token>
 *
 * A `run:` step's cwd is `$GITHUB_WORKSPACE`, `spawnSync` inherits it, and git
 * reads local config from the repository it discovers there. That header is
 * keyed on the `https://github.com/` PREFIX, so it applies to EVERY github.com
 * URL — `aquasecurity/trivy-action` included. Measured on git 2.51: the round-1
 * resolver, run from such a checkout, returned
 * `fatal: could not read Username for 'https://github.com'` — an AUTHENTICATED
 * request, which is precisely the identity the org IP allow list had already
 * 403'd. The fallback was a no-op in the one environment it was built for.
 *
 * `-c credential.helper=` does NOT cover this: it clears HELPERS, not
 * `http.extraheader`. Neither does `-c http.extraheader=` — on git 2.51 that
 * leaves an EMPTY entry in the list rather than resetting it, and the
 * authenticated request still goes out (measured, not assumed). The thing that
 * works is denying git the repository: run from a directory that contains none,
 * with a ceiling so discovery cannot walk up into one.
 *
 * The workflow ALSO sets `persist-credentials: false`. Belt and braces on
 * purpose — either alone is one edit away from silently re-authenticating the
 * request, and the failure is invisible (it looks like a transport error, or on
 * an allow-listed repo like the 403 this exists to route around).
 */
let anonymousGitCwd;
function anonymousGitDir() {
  if (!anonymousGitCwd) {
    anonymousGitCwd = mkdtempSync(join(tmpdir(), 'knext-verify-action-pins-'));
  }
  return anonymousGitCwd;
}

/**
 * Default `git` runner: argv in, `{ status, stdout, stderr }` out.
 *
 * EXPORTED so a guard can execute it and assert on what git actually saw. The
 * round-1 anonymity test asserted argv against an injected double, which cannot
 * observe ambient config — and ambient config is what decides anonymity. See
 * `tests/action-pin-sha-tag-nightly.test.ts`, "anonymous IN FACT".
 */
export function runGit(args) {
  const cwd = anonymousGitDir();
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 30_000,
    // No repository here, so no local config — see `anonymousGitDir`.
    cwd,
    env: {
      ...process.env,
      // Never let git wait for, or find, a credential. See the anonymity note
      // in `gitLsRemoteTag`.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
      // ALL FOUR config scopes, not one: a credential in ANY of them
      // de-anonymises the request identically. Local is closed by the repo-less
      // `cwd` above, system and global here — and `env` below, which is the one
      // that outranks all three.
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
      // The ENV scope — git's HIGHEST-PRECEDENCE config source, and the one the
      // other three lines do not touch. MEASURED on git 2.51: both forms put an
      // `http.…extraheader` into the supposedly anonymous request. Nothing on a
      // GitHub runner sets these today, which is exactly the status the LOCAL
      // scope had before #666 found it live in the one environment this targets.
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_PARAMETERS: '',
      // NOT config at all, and therefore untouched by everything above: git sets
      // libcurl's `CURLOPT_NETRC` to OPTIONAL, so `~/.netrc` answers a 401
      // challenge for the host. MEASURED against real github.com — a repo that
      // does not exist is answered 401 rather than confirmed absent, and one
      // `Authorization: Basic` header went out. Reachable from here: a private
      // or deleted `uses:` repo challenges exactly this way. HOME has no config
      // override, so redirecting it at the empty dir is the only lever.
      HOME: cwd,
      // Discovery must not climb out of the empty directory and find a
      // repository above it (a temp dir nested under a checkout, say).
      GIT_CEILING_DIRECTORIES: cwd,
    },
  });
  if (result.error) {
    return { status: -1, stdout: '', stderr: result.error.message };
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Resolve `<owner>/<repo>` tag `<tag>` to a commit over the ANONYMOUS git
 * protocol (#640) — the second resolver, reached only from
 * `GIT_FALLBACK_STATUSES`.
 *
 * WHY THIS IS EQUIVALENT, NOT WEAKER
 * ----------------------------------
 *  - `refs/tags/<tag>^{}` IS the annotated-tag dereference: git peels the tag
 *    object to the commit and advertises it under that suffix. A lightweight tag
 *    has no `^{}` line and its own line is already the commit. So this path
 *    makes the same distinction the API path makes with its second hop.
 *  - The refs come from the CANONICAL repository URL, so the fork-network
 *    immunity is preserved verbatim: this never asks "does this SHA exist", it
 *    asks "what does this tag point at, there".
 *
 * ANONYMITY IS THE POINT, not an incidental detail. The org's IP allow list is
 * evaluated against an AUTHENTICATED identity; the whole reason this route works
 * from a GitHub-hosted runner is that it carries no credential. Hence
 * `-c credential.helper=` (an EMPTY value clears any inherited helper) and the
 * prompt-suppressing environment in `runGit`.
 *
 * INJECTION: this is the one place repository content becomes a command line,
 * and a `uses:` line is attacker-influenced in a fork PR. `owner`, `repo` and
 * `tag` are validated against plain-identifier patterns FIRST; anything else is
 * refused, and refusing is a `transport-error` — a failure, never a pass.
 *
 * Returns { kind: 'commit', sha, annotated } | { kind: 'tag-missing' }
 *       | { kind: 'transport-error', message }
 *       | { kind: 'unreadable-listing', message } — exited 0, output unparseable
 */
export function gitLsRemoteTag({
  owner,
  repo,
  tag,
  run = runGit,
  attempts = 2,
  sleep = sleepSync,
}) {
  if (!SAFE_PATH_SEGMENT.test(owner ?? '') || !SAFE_PATH_SEGMENT.test(repo ?? '')) {
    return {
      kind: 'transport-error',
      message: `refusing to resolve unsafe repo ref: ${owner}/${repo}`,
    };
  }
  if (!SAFE_TAG.test(tag ?? '')) {
    return { kind: 'transport-error', message: `refusing to resolve unsafe tag ref: ${tag}` };
  }

  const url = `https://github.com/${owner}/${repo}`;
  const argv = [
    '-c',
    'credential.helper=',
    'ls-remote',
    '--tags',
    url,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ];

  let failure;
  // MEASURED flakiness, not a hypothetical: on this branch the same `ls-remote`
  // that answers in ~0.7 s intermittently timed out when called repeatedly in
  // quick succession (upstream throttling of anonymous git). One transient
  // timeout would re-red the entire nightly, which is the very failure mode this
  // change exists to end. A retry is not a softened verdict — a second failure
  // still fails, and only a TRANSPORT failure is retried: `tag-missing` is an
  // ANSWER and is returned immediately.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) sleep(2_000);
    const result = run(argv);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      failure = {
        kind: 'transport-error',
        message: detail || `git ls-remote exited ${result.status}`,
      };
      continue;
    }

    // Exact ref match only: `refs/tags/v1.2.3` must never be answered by
    // `refs/tags/v1.2.30`. git's own pattern matching is looser than that, so
    // the filtering happens here rather than being trusted to the refspec.
    let lightweight;
    let peeled;
    let readableLines = 0;
    for (const line of result.stdout.split('\n')) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (!sha || !ref || !/^[0-9a-f]{40}$/.test(sha)) continue;
      readableLines += 1;
      if (ref === `refs/tags/${tag}`) lightweight = sha;
      else if (ref === `refs/tags/${tag}^{}`) peeled = sha;
    }
    if (peeled) return { kind: 'commit', sha: peeled, annotated: true };
    if (lightweight) return { kind: 'commit', sha: lightweight, annotated: false };
    // An exit-0 listing that parses into NOTHING is an unreadable ANSWER, not an
    // upstream fact (#666 review). Reporting it as `tag-missing` printed "the
    // tag was deleted, renamed, or never existed" about a tag that may be
    // perfectly present — a confident claim derived from noise. The verdict is
    // red either way (this maps to the fail-closed `api-error` + both-causes
    // rendering, exactly like a transport failure); only the story changes.
    //
    // An EMPTY listing keeps `tag-missing`: an empty advertisement IS git's
    // answer to "is this ref there", and so is a listing whose lines parsed but
    // held some other ref (`v1.2.30` for `v1.2.3`). Conflating those with noise
    // would lose the only conclusive negative this resolver can give.
    //
    // Deliberately NOT retried, like `tag-missing`: the audited property is
    // that ONLY a non-zero exit is retried, and a retry loop here would be one
    // more path a future edit could turn into a mask.
    if (readableLines === 0 && result.stdout.trim() !== '') {
      return {
        kind: 'unreadable-listing',
        message: `git ls-remote exited 0 but its output was UNREADABLE (no ref line parsed): ${JSON.stringify(result.stdout.slice(0, 200))}`,
      };
    }
    return { kind: 'tag-missing' };
  }
  return failure ?? { kind: 'transport-error', message: 'git ls-remote was never attempted' };
}

/**
 * Resolve `<owner>/<repo>` tag `<tag>` to the COMMIT it points at.
 * Returns one of:
 *   { kind: 'commit', sha, annotated, via? } — resolved (`via` names the git
 *                                              fallback when the API was blocked)
 *   { kind: 'tag-missing', via? }       — no such tag upstream (or it's a branch);
 *                                         `via` likewise names the fallback
 *   { kind: 'api-error', status, message }
 *   { kind: 'unexpected-object', type }
 */
export async function resolveTagCommit({
  owner,
  repo,
  tag,
  api = githubApi,
  lsRemote = gitLsRemoteTag,
}) {
  /**
   * A transport can THROW rather than return a status — DNS failure, TLS
   * failure, an offline runner: `fetch` rejects, it does not hand back a 5xx.
   * Left uncaught that still exits non-zero (an unhandled top-level-await
   * rejection), so the VERDICT was never wrong, but the operator got a raw
   * stack trace instead of the per-pin report. Normalise it to the same
   * `api-error` shape so every failure mode reads identically — and, as ever,
   * a failure, NEVER a pass.
   */
  const call = async (path) => {
    try {
      return await api(path);
    } catch (error) {
      return { status: 0, body: { message: error instanceof Error ? error.message : `${error}` } };
    }
  };

  /**
   * The API said "not from this address" (#640). That is not an answer, so this
   * does NOT downgrade to a pass — it asks the SAME question over a route the
   * allow list does not govern, and keeps the original 403 as the verdict if
   * that route cannot answer either. Both causes are reported, because "the API
   * blocked us AND git failed" is a different operational problem from either
   * alone.
   */
  const viaGit = (status, message) => {
    const resolved = lsRemote({ owner, repo, tag });
    if (resolved.kind === 'commit') return { ...resolved, via: 'git-ls-remote' };
    if (resolved.kind === 'tag-missing') return { kind: 'tag-missing', via: 'git-ls-remote' };
    // Everything else — a transport failure, or an exit-0 listing that could
    // not be READ (#666 review) — is not an answer, so the 403 stands and the
    // fallback's own message rides along. Only `commit` and `tag-missing` are
    // answers; keeping this an else-branch rather than an enumerated set means
    // a kind added later fails closed instead of silently resolving.
    return {
      kind: 'api-error',
      status,
      message,
      gitFallbackMessage: resolved.message,
    };
  };

  const ref = await call(`repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.status === 404) return { kind: 'tag-missing' };
  if (GIT_FALLBACK_STATUSES.has(ref.status)) return viaGit(ref.status, ref.body?.message);
  if (ref.status !== 200) {
    return { kind: 'api-error', status: ref.status, message: ref.body?.message };
  }
  const object = ref.body?.object;
  if (object?.type === 'commit') return { kind: 'commit', sha: object.sha, annotated: false };
  if (object?.type === 'tag') {
    // Annotated tag: one more hop to the commit.
    const tagObject = await call(`repos/${owner}/${repo}/git/tags/${object.sha}`);
    // The second hop is as blockable as the first, and a fallback wired to only
    // one of them leaves the same permanently-red gate one API call further in.
    if (GIT_FALLBACK_STATUSES.has(tagObject.status)) {
      return viaGit(tagObject.status, tagObject.body?.message);
    }
    if (tagObject.status !== 200) {
      return { kind: 'api-error', status: tagObject.status, message: tagObject.body?.message };
    }
    const target = tagObject.body?.object;
    if (target?.type !== 'commit') return { kind: 'unexpected-object', type: target?.type };
    return { kind: 'commit', sha: target.sha, annotated: true };
  }
  return { kind: 'unexpected-object', type: object?.type };
}

/** Verify one parsed pin. Returns a finding, or undefined when it checks out. */
export async function verifyPin(pin, { api = githubApi, lsRemote = gitLsRemoteTag } = {}) {
  if (!pin.sha) {
    return { ...pin, reason: 'not-sha-pinned' };
  }
  if (!pin.tag) {
    return { ...pin, reason: 'no-version-comment' };
  }
  const resolved = await resolveTagCommit({
    owner: pin.owner,
    repo: pin.repo,
    tag: pin.tag,
    api,
    lsRemote,
  });
  if (resolved.kind === 'tag-missing') {
    // `via` must survive to the finding here too (#666 round 3). Dropping it
    // made `formatFinding` render "refs/tags/X 404s" for a tag the API had
    // 403'd and the FALLBACK could not find — a confident claim about the route
    // that was never taken.
    return { ...pin, reason: 'tag-missing', pinnedSha: pin.sha, via: resolved.via };
  }
  if (resolved.kind === 'api-error') {
    return {
      ...pin,
      reason: 'api-error',
      pinnedSha: pin.sha,
      status: resolved.status,
      message: resolved.message,
      gitFallbackMessage: resolved.gitFallbackMessage,
    };
  }
  if (resolved.kind === 'unexpected-object') {
    return { ...pin, reason: 'unexpected-object', pinnedSha: pin.sha, objectType: resolved.type };
  }
  if (resolved.sha !== pin.sha) {
    return {
      ...pin,
      reason: 'sha-mismatch',
      pinnedSha: pin.sha,
      actualSha: resolved.sha,
      annotated: resolved.annotated,
      // Which resolver answered. A mismatch found through the git fallback is
      // the same finding, but the reader should know the API never answered.
      via: resolved.via,
    };
  }
  return undefined;
}

/**
 * Verify every workflow in `dir`. Silent (empty) when all pins hold.
 *
 * The API transport is MEMOISED per request path: ~100 pins across the repo's
 * workflows resolve to well under 20 distinct `<owner>/<repo>@<tag>` pairs, and
 * one request per pin would rate-limit the nightly into a flaky red. The cache
 * stores the RESPONSE, including a failure — an unreachable API must stay a
 * failure for every pin that depends on it, never quietly a pass for the second
 * one (security.md).
 */
/**
 * Every `uses:` value in `text` that `USES_LINE` could NOT read, as
 * `{ value, line }` — the raw material for both the regex-breakage alarm and
 * the `docker://` finding, which need to be told apart (#630 review).
 *
 * Deliberately WEAKER than `USES_LINE`, and independent of it: this is the
 * alarm that says "something here looks like a step but the extractor read
 * nothing", so implementing it in terms of the extractor would make it
 * self-referential and permanently silent.
 *
 * It accepts QUOTED keys — `- "uses": evil/action@main` and `- 'uses' : …` are
 * valid Actions steps that `USES_LINE` cannot read. An earlier revision matched
 * only the bare `uses:` literal, so a file written entirely in quoted-key form
 * produced ZERO findings from both guards instead of a `no-pins-parsed` alarm.
 */
export function unreadableUsesValues(text) {
  const values = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue;
    const match = USES_KEY.exec(line);
    if (!match) continue;
    // A LOCAL composite-action ref (`uses: ./.github/actions/foo`) invokes this
    // repository's own code at the commit already checked out. There is no
    // upstream tag to resolve and no SHA to pin — pinning it is impossible, not
    // merely unnecessary. `USES_LINE` requires an `@` so it parses nothing,
    // which without this exclusion made the pair report a `no-pins-parsed`
    // FALSE RED. Keyed on the REF, never on the line merely containing `./`, so
    // `uses: evil/action@main # ./x` is still caught.
    //
    // The ref is UNQUOTED before that test (#630). Keying on the raw token left
    // the identical false red one quoting level away — `uses:
    // './.github/actions/foo'` is a valid step with nothing to pin and still
    // reported `no-pins-parsed`. This file already read a quoted KEY, so the
    // quoted VALUE was the same class of gap, unclosed. Only a MATCHED
    // surrounding pair is stripped — `/^["']?(.*?)["']?$/` would treat
    // `uses: "./x` as local, letting a stray quote dress a ref up as one. That
    // is asserted, not merely claimed: the mismatched-pair cases in
    // tests/action-pin-sha-tag-nightly.test.ts red on exactly that relaxation.
    const value = match[1]?.replace(/^(["'])(.*)\1$/, '$2');
    if (value && /^\.{1,2}\//.test(value)) continue;
    values.push({ value: value ?? '', line: index + 1 });
  }
  return values;
}

/** Does this text contain a `uses:` key, outside a comment, that nothing read? */
export function mentionsUses(text) {
  return unreadableUsesValues(text).length > 0;
}

/**
 * The shared core: verify `files` (label → absolute path). Everything else is a
 * thin wrapper choosing WHICH files.
 */
async function verifyFileSet(files, api, lsRemote = gitLsRemoteTag) {
  // A checker that goes green when it cannot SEE its subject is worse than none
  // (security.md, quoted at the head of this file). An earlier revision guarded
  // the directory reads with `existsSync` and therefore reported
  // `✔ 0 file(s)` + exit 0 when pointed anywhere without a `.github` — so a
  // `working-directory:`, a checkout with `path:`, or moving this script would
  // have left the nightly permanently and silently green. The PR-time form
  // guard cannot cover this: it asserts over the repo tree at PR time, not over
  // whatever the runner actually sees at 05:11 UTC.
  if (files.length === 0) {
    return [{ file: '(scan)', line: 0, action: '(none)', reason: 'no-files-discovered' }];
  }

  const cache = new Map();
  const memoApi = (path) => {
    if (!cache.has(path)) cache.set(path, api(path));
    return cache.get(path);
  };
  // The git fallback is memoised on the same terms and for the same reasons
  // (#640): four workflows pin the same allow-listed-out action today, and one
  // subprocess per pin would make the nightly pay for the block four times over.
  // The cache stores the RESULT, INCLUDING a failure — an unreachable fallback
  // must stay a failure for every pin that depends on it, never quietly a pass
  // for the second one.
  const gitCache = new Map();
  const memoLsRemote = ({ owner, repo, tag }) => {
    const key = `${owner}/${repo}@${tag}`;
    if (!gitCache.has(key)) gitCache.set(key, lsRemote({ owner, repo, tag }));
    return gitCache.get(key);
  };
  const findings = [];
  for (const [file, absolute] of files) {
    const text = readFileSync(absolute, 'utf8');
    const pins = parsePins(text, file);
    if (pins.length === 0) {
      // `no-pins-parsed` is a REGEX-BREAKAGE alarm, not a coverage rule: it must
      // fire when a file plainly says `uses:` yet nothing extracts (the silent-
      // vacuum failure), and must NOT fire on a file that legitimately has
      // nothing to pin — the repo's root composite action is all `run:` steps
      // today. A false red here is how a nightly gets ignored.
      //
      // A `docker://` ref gets its OWN finding (#630 review). It used to be
      // carried by `no-pins-parsed`, whose text says "the extraction regex or
      // the file changed shape" — sending the reader after a regex bug when the
      // real finding is an unpinned container image. This file has already been
      // corrected twice for that class of misdirection. Both findings are
      // emitted when a file holds both, so neither can mask the other.
      //
      // SCOPE, stated where it can be checked against the code beside it: this
      // whole branch runs only when NOTHING in the file parsed as a pin, so a
      // docker ref sharing a file with one ordinary pinned action is reported
      // nowhere. See the header bullet — pre-existing, deliberately not fixed
      // here, and not fixable by hoisting alone.
      //
      // A DIGEST-pinned `docker://image@sha256:…` never reaches here — it
      // carries an `@`, so `parsePins` reads it as a pin. Do NOT read that as
      // "handled": what it then emits is `not-sha-pinned`, rendering as "Not a
      // 40-hex SHA — this ref is MUTABLE, so whoever can move it decides what
      // runs here", i.e. it tells a maintainer their CORRECTLY digest-pinned
      // image is mutable. Verified on this branch, not inferred. Also
      // pre-existing (a `sha256:` digest is simply not a 40-hex git SHA, and
      // `verifyPin` has no notion of a container digest), also out of scope for
      // a reporting-split change — but it is a false red on a correct input,
      // which is the class this file keeps having to correct, so it is written
      // down rather than left to be rediscovered.
      const unreadable = unreadableUsesValues(text);
      const docker = unreadable.filter((entry) => entry.value.startsWith('docker://'));
      for (const entry of docker) {
        // `action` carries the ref because that is what `formatFinding` renders
        // in the head line. No separate `ref` field: it duplicated `action`
        // exactly and nothing ever read it, and a field that looks meaningful
        // but is dead is how the next reader is misled.
        findings.push({
          file,
          line: entry.line,
          action: entry.value,
          reason: 'docker-ref-unpinned',
        });
      }
      if (unreadable.length > docker.length) {
        findings.push({ file, line: 0, action: '(none)', reason: 'no-pins-parsed' });
      }
      continue;
    }
    for (const pin of pins) {
      const finding = await verifyPin(pin, { api: memoApi, lsRemote: memoLsRemote });
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

export async function verifyWorkflows({
  dir = resolve(process.cwd(), '.github/workflows'),
  api = githubApi,
  lsRemote = gitLsRemoteTag,
  workflows,
} = {}) {
  const files = workflows ?? discoverWorkflows(dir);
  return verifyFileSet(
    files.map((file) => [file, resolve(dir, file)]),
    api,
    lsRemote,
  );
}

/**
 * Verify every pinnable file in the repo — workflows AND composite actions
 * (#528 review). This is what the nightly runs; `verifyWorkflows` remains for
 * the narrower directory-scoped case.
 */
export async function verifyPins({
  repoRoot = process.cwd(),
  api = githubApi,
  lsRemote = gitLsRemoteTag,
} = {}) {
  return verifyFileSet(
    discoverPinnableFiles(repoRoot).map((file) => [file, resolve(repoRoot, file)]),
    api,
    lsRemote,
  );
}

/**
 * Render a finding so the person reading a red nightly can act without
 * re-deriving anything: which action, which workflow and line, the tag it
 * claims, the SHA it pins, and what that tag actually resolves to.
 */
export function formatFinding(finding) {
  const where = `${finding.file}:${finding.line}`;
  const head = `${where} — ${finding.action}`;
  switch (finding.reason) {
    case 'sha-mismatch':
      return [
        `${head}`,
        `  claimed tag : ${finding.tag}`,
        `  pinned SHA  : ${finding.pinnedSha}`,
        `  ${finding.tag} resolves to : ${finding.actualSha}${finding.annotated ? ' (annotated tag, dereferenced)' : ''}`,
        // WHICH resolver produced that number (#666 review). `via` was recorded
        // and rendered nowhere, under a comment promising the reader would know
        // the API never answered. Printed only when the fallback was used —
        // printing it unconditionally would assert a block on every ordinary
        // mismatch, the same misdirection pointing the other way.
        ...(finding.via === 'git-ls-remote'
          ? [
              '  resolved via : anonymous `git ls-remote` — the GitHub API never answered',
              '                 (403/451, e.g. an organisation IP allow list), so the tag was',
              '                 resolved over the git protocol from the SAME canonical repo.',
            ]
          : []),
        '  MISMATCH — the pin does not point at the commit this tag names upstream.',
        '  Either the pin is wrong (repoint it at the resolved SHA) or the tag moved',
        '  upstream (a retag on a credentialed path is itself worth investigating).',
      ].join('\n');
    case 'tag-missing':
      return [
        `${head}`,
        // WHICH resolver failed to find it (#666 round 3). Saying "404s" when the
        // API was BLOCKED and it was git that advertised nothing sends the reader
        // to the wrong upstream. The verdict is red either way — only the triage
        // story differs, and it has to be the true one.
        finding.via === 'git-ls-remote'
          ? `  claimed tag : ${finding.tag} — NOT FOUND upstream (\`git ls-remote\` advertised no\n                refs/tags/${finding.tag}; the GitHub API never answered — 403/451, e.g. an\n                organisation IP allow list — so this is the fallback's verdict)`
          : `  claimed tag : ${finding.tag} — NOT FOUND upstream (refs/tags/${finding.tag} 404s)`,
        `  pinned SHA  : ${finding.pinnedSha}`,
        '  The tag was deleted, renamed, or never existed (a moving major like `v1`',
        '  is often a BRANCH, not a tag). The comment no longer documents anything.',
      ].join('\n');
    case 'no-version-comment':
      return `${head}\n  pinned SHA  : ${finding.ref}\n  No \`# vX.Y.Z\` comment — nothing to resolve the pin against.`;
    case 'not-sha-pinned':
      // Says MUTABLE, not "on a credentialed workflow": since #528 this runs
      // over every workflow and composite action, so asserting a credential is
      // in scope would overstate a finding on a build/lint file.
      return `${head}\n  ref         : ${finding.ref}\n  Not a 40-hex SHA — this ref is MUTABLE, so whoever can move it decides what runs here.`;
    case 'unexpected-object':
      return `${head}\n  claimed tag : ${finding.tag}\n  refs/tags/${finding.tag} resolves to a \`${finding.objectType}\` object, not a commit.`;
    case 'api-error':
      // status 0 = the transport THREW (DNS, TLS, offline). Rendering that as
      // "API error 0" sends the reader looking for an HTTP status that does not
      // exist; name the actual failure instead.
      if (finding.status === 0) {
        return `${head}\n  claimed tag : ${finding.tag}\n  Could not REACH the GitHub API: ${finding.message ?? '(no message)'}\n  Treated as a FAILURE, not a pass — an unresolved pin is unverified, not verified.`;
      }
      return [
        `${head}`,
        `  claimed tag : ${finding.tag}`,
        `  GitHub API error ${finding.status}: ${finding.message ?? '(no message)'} — treated as a FAILURE, not a pass.`,
        // Both causes, never one (#640). A 403/451 diverts to the anonymous git
        // protocol; reaching this line means THAT failed too, and "the API
        // blocked us AND git could not answer" is a different operational
        // problem from either alone.
        ...(finding.gitFallbackMessage
          ? [
              `  The anonymous \`git ls-remote\` fallback ALSO failed: ${finding.gitFallbackMessage}`,
              '  Both routes to the upstream tag are unavailable, so this pin is UNVERIFIED.',
            ]
          : []),
      ].join('\n');
    case 'docker-ref-unpinned':
      return [
        `${head}`,
        '  A container IMAGE, not an action — and it is not pinned to a digest.',
        '  Pin it as `docker://<image>@sha256:<digest>`: a tag is mutable, so whoever can',
        '  push it decides what runs in this job (security.md: pin by digest, reject :latest).',
      ].join('\n');
    case 'no-pins-parsed':
      return `${finding.file} — mentions \`uses:\` but no pins parsed; the extraction regex or the file changed shape (a quoted key, say).`;
    case 'no-files-discovered':
      return [
        'Discovered NO workflow or action files to check.',
        '  Nothing was verified, so this is a FAILURE, not a pass — a checker that goes',
        '  green when it cannot see its subject is worse than no checker at all.',
        '  Most likely the working directory is wrong (pass --root <repo-root>), the',
        '  checkout landed under a `path:`, or this script moved relative to the tree.',
      ].join('\n');
    default:
      return `${head} — ${finding.reason}`;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let repoRoot = process.cwd();

  // Strict parsing: an unrecognised argument is a FAILURE, never something to
  // ignore. `--dir` was the round-1 flag; silently ignoring it would scan the
  // wrong tree and print green — the same fail-open family as scanning zero
  // files.
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        console.error('✖ --root requires a path argument.');
        return 1;
      }
      repoRoot = resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--dir') {
      console.error(
        '✖ --dir is no longer supported: the scan covers .github/workflows, .github/actions/**\n' +
          '  and the root action.yml, so it takes a REPOSITORY ROOT. Use --root <repo-root>.',
      );
      return 1;
    }
    console.error(
      `✖ unrecognised argument: ${arg}\n  Usage: verify-action-pins.mjs [--root <repo-root>]`,
    );
    return 1;
  }

  const files = discoverPinnableFiles(repoRoot);
  const findings = await verifyPins({ repoRoot });
  if (findings.length === 0) {
    console.log(
      `✔ every pin across ${files.length} workflow/action file(s) resolves to the tag its comment claims`,
    );
    return 0;
  }
  console.error(
    `✖ ${findings.length} action-pin finding(s) across ${files.length} workflow/action file(s):\n`,
  );
  for (const finding of findings) console.error(`${formatFinding(finding)}\n`);
  // The severity footer is about PINS. Printing it under a "nothing was scanned"
  // failure would tell the reader to go inspect a pin that was never read — the
  // same misdirection the alert body was corrected for.
  if (!findings.every((finding) => finding.reason === 'no-files-discovered')) {
    // Deliberately does NOT assert that a credential is in scope: since #528
    // this covers every workflow, so a finding on a build/lint workflow would
    // have that claim overstate its severity. Name where the credentials
    // actually are and let the per-finding file name decide which case applies.
    console.error(
      'A pin that does not resolve to its claimed tag is a supply-chain finding, not a typo.\n' +
        `Severity depends on which file tripped: ${PINNED_WORKFLOWS.join(', ')} hold a live npm\n` +
        'publish credential; supply-chain.yml / operator-supply-chain.yml sign artifacts under\n' +
        "this repo's OIDC identity; the root action.yml is PUBLISHED and runs in every\n" +
        'downstream consumer job; the rest are build/test/lint (#528).',
    );
  }
  return 1;
}

// Only run when executed directly; importing for tests must have no side effects.
//
// Both normalisations below are load-bearing, and each is its own fail-open:
// when the comparison is wrong, main() never runs and the process exits 0
// having verified NOTHING — silently contradicting this file's own header.
//
//  1. `pathToFileURL`, not a `file://${argv[1]}` template: `import.meta.url` is
//     PERCENT-ENCODED, so any space or non-ASCII character in the path breaks a
//     raw string compare.
//  2. `realpathSync`: Node resolves a module's REAL path for `import.meta.url`,
//     while `argv[1]` is the path as typed. Invoked through a symlinked
//     directory — macOS's own `/var` → `/private/var`, or a symlinked bin — the
//     two differ even with correct encoding.
//
// Neither is reachable on the GH runner today, which is exactly why they need
// the correct comparison rather than a note.
function invokedDirectly() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    // Last-resort net. A thrown transport is already normalised into an
    // `api-error` finding; anything reaching here is a bug in this script, and
    // it must still exit NON-ZERO — a checker that cannot run is never a pass.
    console.error(`✖ verify-action-pins failed to complete: ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}
