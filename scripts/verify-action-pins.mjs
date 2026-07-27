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
 * Usage: node scripts/verify-action-pins.mjs [--dir <workflow-dir>]
 * Exits 1 (with an actionable report) if there is any finding.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The credential-bearing workflows. Kept in sync with the publish path by
 * tests/action-pin-sha-tag-nightly.test.ts, which SCANS every workflow for
 * `secrets.NPM_TOKEN` and requires each hit to appear here — so a third
 * credentialed workflow cannot escape the nightly by being forgotten.
 */
export const PINNED_WORKFLOWS = ['release.yml', 'release-ghp.yml'];

/** `uses: owner/repo[/path]@<ref>` with an optional trailing `# comment`. */
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(\S+?)@(\S+)\s*(?:#\s*(.*))?$/;
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
  const ref = await api(`repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.status === 404) return { kind: 'tag-missing' };
  if (ref.status !== 200) {
    return { kind: 'api-error', status: ref.status, message: ref.body?.message };
  }
  const object = ref.body?.object;
  if (object?.type === 'commit') return { kind: 'commit', sha: object.sha, annotated: false };
  if (object?.type === 'tag') {
    // Annotated tag: one more hop to the commit.
    const tagObject = await api(`repos/${owner}/${repo}/git/tags/${object.sha}`);
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

/** Verify every publish-path workflow in `dir`. Silent (empty) when all pins hold. */
export async function verifyWorkflows({
  dir = resolve(process.cwd(), '.github/workflows'),
  api = githubApi,
  workflows = PINNED_WORKFLOWS,
} = {}) {
  const findings = [];
  for (const file of workflows) {
    const text = readFileSync(resolve(dir, file), 'utf8');
    const pins = parsePins(text, file);
    if (pins.length === 0) {
      findings.push({ file, line: 0, action: '(none)', reason: 'no-pins-parsed' });
      continue;
    }
    for (const pin of pins) {
      const finding = await verifyPin(pin, { api });
      if (finding) findings.push(finding);
    }
  }
  return findings;
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
      return `${head}\n  ref         : ${finding.ref}\n  Not a 40-hex SHA — this ref is MUTABLE on a credentialed workflow.`;
    case 'unexpected-object':
      return `${head}\n  claimed tag : ${finding.tag}\n  refs/tags/${finding.tag} resolves to a \`${finding.objectType}\` object, not a commit.`;
    case 'api-error':
      return `${head}\n  claimed tag : ${finding.tag}\n  GitHub API error ${finding.status}: ${finding.message ?? '(no message)'} — treated as a FAILURE, not a pass.`;
    case 'no-pins-parsed':
      return `${finding.file} — no \`uses:\` pins parsed at all; the extraction regex or the workflow changed shape.`;
    default:
      return `${head} — ${finding.reason}`;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf('--dir');
  const dir =
    dirFlag === -1 ? resolve(process.cwd(), '.github/workflows') : resolve(argv[dirFlag + 1] ?? '');

  const findings = await verifyWorkflows({ dir });
  if (findings.length === 0) {
    console.log(
      `✔ every pin on ${PINNED_WORKFLOWS.join(', ')} resolves to the tag its comment claims`,
    );
    return 0;
  }
  console.error(`✖ ${findings.length} action-pin finding(s) on the publish path:\n`);
  for (const finding of findings) console.error(`${formatFinding(finding)}\n`);
  console.error(
    'Each of these workflows runs with a registry-write credential in scope, so a pin\n' +
      'that does not resolve to its claimed tag is a supply-chain finding, not a typo.',
  );
  return 1;
}

// Only run when executed directly; importing for tests must have no side effects.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
