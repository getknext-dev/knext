import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A tracked text file must not contain a control byte.
 *
 * Why this exists (#569): `fake-redis.ts` was committed with a raw NUL (0x00)
 * inside a string literal. Git classifies any file with a NUL in its first 8000
 * bytes as **binary**, and a binary-classified file produces **no reviewable
 * diff** — on GitHub, in `git show`, in `gh pr diff`, everywhere.
 *
 * PR #568 then passed an architect sign-off and two review rounds in which
 * nobody could see a single line of a 339-line file — the file defining the very
 * test seam the PR's central claim rested on. Two type errors inside it survived
 * every human and gate review and were caught only by a package-level `tsc`.
 *
 * The byte was harmless. The invisibility was not, and **nothing announced it**:
 * the file appeared in the changed-files list and its diff was simply absent. A
 * reviewer who does not already know to look for `Bin` in `--stat` gets no signal.
 *
 * So this guard exists to make the condition loud rather than silent. It does not
 * reformat or normalise anything — it fails and lets a human decide, which is this
 * repo's standing preference for gates that block over expectations that degrade.
 *
 * ESCAPE HATCH, deliberately explicit: mark the path `binary` or `-diff` in
 * `.gitattributes`. That is a recorded, reviewable decision. There is no silent
 * allowlist inside this file, because an allowlist here would recreate exactly the
 * invisibility the guard is meant to remove.
 *
 * KNOWN GAP, stated rather than hidden: this scans TRACKED files, so a brand-new
 * file carrying the defect passes locally until it is committed. That is not
 * hypothetical — the first version of THIS file wrote the control bytes literally
 * into the character class below instead of escaping them, so it was itself
 * committed as `Bin 0 -> 5462 bytes`: the guard against unreviewable files was
 * unreviewable, and its own test had passed because it was untracked at the time.
 * CI catches this on the pushed commit, which is the gate that matters, but a
 * pre-commit hook over staged files would close the local window.
 */

const REPO_ROOT = join(__dirname, '..');

/** Extensions we assert on. A file with no extension is not assumed to be text. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
  '.bash',
  '.go',
  '.css',
  '.scss',
  '.html',
  '.sql',
  '.env',
]);

/**
 * Control bytes that break review, excluding the three that are legitimate in
 * text: TAB (0x09), LF (0x0A), CR (0x0D).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control bytes IS the subject of this guard
const CONTROL_BYTE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

/** Paths git has been told are binary / non-diffable — an explicit, reviewed decision. */
function explicitlyBinary(): Set<string> {
  let out = '';
  try {
    out = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8');
  } catch {
    return new Set();
  }
  const paths = out.split('\0').filter(Boolean);
  const flagged = new Set<string>();
  try {
    const check = execFileSync('git', ['check-attr', '--stdin', '-z', 'binary', 'diff'], {
      cwd: REPO_ROOT,
      input: paths.join('\0'),
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8');
    // NUL-separated triples: <path> <attr> <value>
    const parts = check.split('\0');
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const [path, attr, value] = [parts[i], parts[i + 1], parts[i + 2]];
      if (!path) continue;
      if ((attr === 'binary' && value === 'set') || (attr === 'diff' && value === 'unset')) {
        flagged.add(path);
      }
    }
  } catch {
    // check-attr unavailable — fall through with an empty set, which makes the
    // guard STRICTER, never weaker. Failing open here would defeat the point.
  }
  return flagged;
}

describe('no control bytes in tracked text files (#569)', () => {
  const files = trackedFiles();
  const exempt = explicitlyBinary();

  it('finds tracked files to check (a guard over an empty set proves nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no tracked text file contains a control byte', () => {
    const offenders: string[] = [];

    for (const rel of files) {
      const dot = rel.lastIndexOf('.');
      const ext = dot === -1 ? '' : rel.slice(dot).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      if (exempt.has(rel)) continue;

      let content: string;
      try {
        content = readFileSync(join(REPO_ROOT, rel), 'latin1');
      } catch {
        continue; // deleted or unreadable in this working tree
      }

      const m = CONTROL_BYTE.exec(content);
      if (m) {
        const idx = m.index;
        const line = content.slice(0, idx).split('\n').length;
        const code = `0x${content.charCodeAt(idx).toString(16).padStart(2, '0')}`;
        offenders.push(`${rel}:${line} contains ${code}`);
      }
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Control byte(s) in tracked text file(s):\n  ${offenders.join('\n  ')}\n\n` +
            'Git classifies a file containing NUL as BINARY, which means it produces NO ' +
            'reviewable diff anywhere — GitHub, `git show`, `gh pr diff`. A reviewer sees ' +
            'the file in the changed list and no content at all.\n' +
            'Fix the byte (e.g. use an escape such as \\u0000 in a string literal), or, if ' +
            'the file genuinely must be binary, say so explicitly in .gitattributes.',
    ).toEqual([]);
  });
});
