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

/**
 * Strip shell/YAML comments per line: a full-line comment, or a trailing
 * `# ...` — but only when the `#` is preceded by whitespace (or is the
 * first character), matching bash's own comment rule (`echo foo#bar` is
 * NOT a comment, `echo foo #bar` is). A `#` inside a single/double-quoted
 * string, or inside a `${{ ... }}` expression, is never treated as a
 * comment start — otherwise a real command after it (e.g. `&& npm
 * publish`) would silently vanish from the scanned text.
 */
function stripLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let exprDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!inSingle && !inDouble && line.startsWith('${{', i)) {
      exprDepth++;
      i += 2;
      continue;
    }
    if (exprDepth > 0 && ch === '}' && line[i + 1] === '}') {
      exprDepth--;
      i += 1;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && exprDepth === 0 && ch === '#') {
      const prev = i === 0 ? undefined : line[i - 1];
      if (prev === undefined || prev === ' ' || prev === '\t') {
        return line.slice(0, i).replace(/[ \t]+$/, '');
      }
    }
  }
  return line;
}

function stripLineComments(text: string): string {
  return text.split('\n').map(stripLineComment).join('\n');
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

  it('a bare publish command with a trailing inline `#` comment is still detected (round 2 regression pin)', () => {
    // #1646 round 1 gap: `npm publish # ship it now` (no other args) matched
    // none of COMMAND_END's terminators, so it slipped past the scan.
    expect(publishers(stripLineComments('run: npm publish # ship it now'))).toContain(
      'npm publish',
    );
    expect(publishers(stripLineComments('run: npm publish  #x'))).toContain('npm publish');
    expect(publishers(stripLineComments('run: bun publish # x'))).toContain('bun publish');
    expect(publishers(stripLineComments('run: npx changeset publish #x'))).toContain(
      'changeset publish',
    );
    // Neighbour that already worked (the `--` satisfies COMMAND_END on its
    // own) — pinned so a future refactor can't silently regress it.
    expect(publishers(stripLineComments('run: npm publish --access public # note'))).toContain(
      'npm publish',
    );
  });

  it('a `#` inside a quoted string or a GitHub Actions expression is not treated as a comment start', () => {
    // If comment-stripping over-matched here, the real command after the
    // `#` would be silently cut off, producing a FALSE NEGATIVE.
    expect(
      publishers(stripLineComments('run: echo "prefix #not-a-comment" && npm publish')),
    ).toContain('npm publish');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions `${{ }}` expression syntax under test, not an unintended template placeholder.
    const exprFixture = "run: echo ${{ 'safe #1644 marker' }} && npm publish";
    expect(publishers(stripLineComments(exprFixture))).toContain('npm publish');
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
