import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD TEST for #1644: `release.yml` is the ONLY workflow allowed to run a
 * publish command. `release-ghp.yml` — the ungated second publish workflow —
 * was deleted for exactly this reason (no GA-vs-rc tarball diff, no publish
 * preflight, no group verification, no environment). This scan is what stops
 * a future PR from quietly reintroducing a second, ungated publish path.
 *
 * SCANNED, NEVER ENUMERATED: every tracked workflow file is read and matched
 * against the publish-command patterns, not a hand-maintained allowlist of
 * "workflows known not to publish" — a hardcoded list is exactly how the next
 * ungated publish step goes unnoticed.
 *
 * Two independent signals, because this repo's actual publish path is a
 * GitHub Action, not a raw shell command:
 *   - `uses: changesets/action` — the step that actually runs `changeset
 *     publish` (which itself shells to `npm publish` for a bun workspace).
 *     This is the real, structural signal: release.yml carries it, nothing
 *     else should.
 *   - A raw `npm publish` / `bun publish` / `changeset publish` invocation in
 *     a `run:` step — the defense-in-depth case (a workflow bypassing the
 *     Action and publishing directly).
 *
 * Both are matched as COMMANDS, not prose: full-line YAML comments are
 * stripped first, and the raw-command patterns require a command-like
 * terminator after the verb (end of line, `--flag`, `;`, `&&`, `||`, `|`, a
 * backtick) so documentation text like "release.yml holds a live npm publish
 * credential" does not false-positive (#1644 round 1 — `install-smoke.yml`
 * and `action-pin-resolution-nightly.yml` both mention publishing in prose
 * without running it, and one of those mentions lives inside an alert
 * message body, not a `#` comment, so comment-stripping alone isn't enough).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github/workflows');
const ALLOWED_PUBLISHER = 'release.yml';

const COMMAND_END = String.raw`(?:$|\s+--|[;&|\x60]|\r?\n)`;
const RAW_PUBLISH_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'npm publish', re: new RegExp(String.raw`\bnpm\s+publish${COMMAND_END}`) },
  { label: 'changeset publish', re: new RegExp(String.raw`\bchangeset\s+publish${COMMAND_END}`) },
  { label: 'bun publish', re: new RegExp(String.raw`\bbun\s+publish${COMMAND_END}`) },
];
const CHANGESETS_ACTION_RE = /^\s*(?:-\s*)?uses:\s*changesets\/action(?:@|\s|$)/m;

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

/** Strip full-line YAML comments (a trimmed line starting with `#`). */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

function read(file: string): string {
  return stripLineComments(readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8'));
}

function publishers(text: string): string[] {
  const hits = RAW_PUBLISH_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label);
  if (CHANGESETS_ACTION_RE.test(text)) hits.push('uses: changesets/action');
  return hits;
}

describe('single publish workflow (#1644) — only release.yml may run a publish command', () => {
  const files = workflowFiles();

  it('non-vacuity: the scan sees a real workflow corpus', () => {
    // A collapsed corpus (e.g. a wrong WORKFLOWS_DIR) would make every
    // assertion below pass vacuously over nothing. 15 is well under today's
    // 33 workflows but far above "the directory resolution broke".
    expect(files.length, 'tracked workflow corpus collapsed').toBeGreaterThan(15);
    expect(files, 'release.yml must be part of the scanned corpus').toContain(ALLOWED_PUBLISHER);
  });

  it('non-vacuity: release.yml itself matches at least one publish signal', () => {
    // Proves the patterns actually match something real, not just "nothing
    // ever matches, so nothing is ever flagged" — a scan that can't find the
    // one workflow KNOWN to publish can't be trusted to find a new one either.
    const hits = publishers(read(ALLOWED_PUBLISHER));
    expect(hits, 'release.yml matched none of the publish signals').toContain(
      'uses: changesets/action',
    );
  });

  it('prose mentioning publishing (not an invocation) does not false-positive', () => {
    // Regression pin for #1644 round 1: both files mention "npm publish" in
    // prose without running it. If comment-stripping or the command-boundary
    // lookahead regresses, this goes red long before the real assertion
    // below would mask it as "just another offender".
    expect(publishers(read('install-smoke.yml'))).toEqual([]);
    expect(publishers(read('action-pin-resolution-nightly.yml'))).toEqual([]);
  });

  it('no workflow other than release.yml runs npm publish / changeset publish / bun publish', () => {
    const offenders = files
      .filter((file) => file !== ALLOWED_PUBLISHER)
      .map((file) => ({ file, hits: publishers(read(file)) }))
      .filter(({ hits }) => hits.length > 0);

    expect(
      offenders.map(({ file, hits }) => `${file}: ${hits.join(', ')}`),
      'a workflow other than release.yml can run a publish command — route it through ' +
        "release.yml's gated path instead (see docs/RELEASING.md)",
    ).toEqual([]);
  });
});
