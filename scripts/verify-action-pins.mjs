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
 * Usage: node scripts/verify-action-pins.mjs [--root <repo-root>]
 *   --root  repository root to scan (default: cwd). The scan covers
 *           .github/workflows, .github/actions/** and the root action.yml.
 * Exits 1 (with an actionable report) if there is any finding, if it can see NO
 * files to check, or on an unrecognised argument. There is no combination of
 * arguments that makes this script exit 0 without having verified something.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
 * Resolve `<owner>/<repo>` tag `<tag>` to the COMMIT it points at.
 * Returns one of:
 *   { kind: 'commit', sha, annotated }  — resolved
 *   { kind: 'tag-missing' }             — no such tag upstream (or it's a branch)
 *   { kind: 'api-error', status, message }
 *   { kind: 'unexpected-object', type }
 */
export async function resolveTagCommit({ owner, repo, tag, api = githubApi }) {
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

  const ref = await call(`repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.status === 404) return { kind: 'tag-missing' };
  if (ref.status !== 200) {
    return { kind: 'api-error', status: ref.status, message: ref.body?.message };
  }
  const object = ref.body?.object;
  if (object?.type === 'commit') return { kind: 'commit', sha: object.sha, annotated: false };
  if (object?.type === 'tag') {
    // Annotated tag: one more hop to the commit.
    const tagObject = await call(`repos/${owner}/${repo}/git/tags/${object.sha}`);
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
export async function verifyPin(pin, { api = githubApi } = {}) {
  if (!pin.sha) {
    return { ...pin, reason: 'not-sha-pinned' };
  }
  if (!pin.tag) {
    return { ...pin, reason: 'no-version-comment' };
  }
  const resolved = await resolveTagCommit({ owner: pin.owner, repo: pin.repo, tag: pin.tag, api });
  if (resolved.kind === 'tag-missing') return { ...pin, reason: 'tag-missing', pinnedSha: pin.sha };
  if (resolved.kind === 'api-error') {
    return {
      ...pin,
      reason: 'api-error',
      pinnedSha: pin.sha,
      status: resolved.status,
      message: resolved.message,
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
 * Does this text contain a `uses:` key OUTSIDE a comment?
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
export function mentionsUses(text) {
  return text.split('\n').some((line) => {
    if (/^\s*#/.test(line)) return false;
    const match = USES_KEY.exec(line);
    if (!match) return false;
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
    // surrounding pair is stripped, so a stray quote cannot be used to dress a
    // remote ref up as a local one. `docker://` refs stay flagged in both forms,
    // deliberately: that names a container image, and an unpinned one is exactly
    // what the digest-pinning rule wants loud.
    const value = match[1]?.replace(/^(["'])(.*)\1$/, '$2');
    if (value && /^\.{1,2}\//.test(value)) return false;
    return true;
  });
}

/**
 * The shared core: verify `files` (label → absolute path). Everything else is a
 * thin wrapper choosing WHICH files.
 */
async function verifyFileSet(files, api) {
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
      if (mentionsUses(text)) {
        findings.push({ file, line: 0, action: '(none)', reason: 'no-pins-parsed' });
      }
      continue;
    }
    for (const pin of pins) {
      const finding = await verifyPin(pin, { api: memoApi });
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

export async function verifyWorkflows({
  dir = resolve(process.cwd(), '.github/workflows'),
  api = githubApi,
  workflows,
} = {}) {
  const files = workflows ?? discoverWorkflows(dir);
  return verifyFileSet(
    files.map((file) => [file, resolve(dir, file)]),
    api,
  );
}

/**
 * Verify every pinnable file in the repo — workflows AND composite actions
 * (#528 review). This is what the nightly runs; `verifyWorkflows` remains for
 * the narrower directory-scoped case.
 */
export async function verifyPins({ repoRoot = process.cwd(), api = githubApi } = {}) {
  return verifyFileSet(
    discoverPinnableFiles(repoRoot).map((file) => [file, resolve(repoRoot, file)]),
    api,
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
        '  MISMATCH — the pin does not point at the commit this tag names upstream.',
        '  Either the pin is wrong (repoint it at the resolved SHA) or the tag moved',
        '  upstream (a retag on a credentialed path is itself worth investigating).',
      ].join('\n');
    case 'tag-missing':
      return [
        `${head}`,
        `  claimed tag : ${finding.tag} — NOT FOUND upstream (refs/tags/${finding.tag} 404s)`,
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
      return finding.status === 0
        ? `${head}\n  claimed tag : ${finding.tag}\n  Could not REACH the GitHub API: ${finding.message ?? '(no message)'}\n  Treated as a FAILURE, not a pass — an unresolved pin is unverified, not verified.`
        : `${head}\n  claimed tag : ${finding.tag}\n  GitHub API error ${finding.status}: ${finding.message ?? '(no message)'} — treated as a FAILURE, not a pass.`;
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
