import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #1403: quay.io/minio/minio and docker.io/minio/minio (and their `mc` client
 * counterparts) now UNAUTHORIZE every anonymous pull, repo-wide — verified
 * with `crane manifest`/`crane ls` against several tags AND the previously
 * pinned "last-good" digest, not a transient flake or rate limit. Every kind
 * -based CI job and local drill that stood up a throwaway MinIO fixture broke
 * at once. Fixed by repinning to Bitnami's post-license-change "legacy" free
 * mirror (unmaintained but genuine MinIO software, proven S3-API-compatible:
 * bucket create, anonymous-read bucket policy, GetObject all verified live).
 *
 * This guard SCANS the repo (never a hand-maintained call-site list — that is
 * exactly how the drift class this file guards against gets missed) for any
 * `minio/minio` or `minio/mc` image reference and asserts it is either:
 *   (a) one of the two pinned, known-working Bitnami digests below, or
 *   (b) one of the deliberate exceptions below — szpg's LIVE production
 *       manifests, left for szpg's own review process (getknext-dev/knext#1423),
 *       each scoped to its ONE offending line (never a whole-file skip) and each
 *       required to carry a WHY comment (asserted below, not a silent skip).
 *
 * Mutation-prove: change either PINNED_MINIO_DIGEST/PINNED_MC_DIGEST, or add a
 * new unpinned/differently-pinned minio reference anywhere in the repo, and
 * this test goes red.
 */

const ROOT = join(import.meta.dirname, '..');

const PINNED_MINIO_DIGEST =
  'sha256:451fe6858cb770cc9d0e77ba811ce287420f781c7c1b806a386f6896471a349c';
const PINNED_MC_DIGEST = 'sha256:00dcc4e58ada0df45bb7d9ee435af98295f96c27c3c68292ce78ec700a87b511';

const ALLOWED_MINIO_REFS = new Set([
  `docker.io/bitnamilegacy/minio@${PINNED_MINIO_DIGEST}`,
  `docker.io/bitnamilegacy/minio-client@${PINNED_MC_DIGEST}`,
]);

/**
 * Deliberately-unfixed references — szpg's LIVE production manifests, tracked
 * for szpg's own review at getknext-dev/knext#1423. Each exemption is scoped
 * to its ONE offending line, not the whole file — a second, different broken
 * ref landing anywhere else in these files must still fail.
 */
const EXEMPTIONS: Array<{ file: string; lineSubstring: string }> = [
  {
    file: 'packages/scale-zero-pg/deploy/50-minio.yaml',
    lineSubstring:
      'quay.io/minio/minio:RELEASE.2022-10-20T00-55-09Z@sha256:cc144348ad1e4126766279b042804fa4f130da531cc811e91fdbcb12c6bc8881',
  },
  {
    file: 'packages/scale-zero-pg/deploy/62-backup.yaml',
    lineSubstring: 'image: minio/mc:RELEASE.2023-01-28T20-29-38Z # pinned — UNPULLABLE, see #1423',
  },
  {
    file: 'packages/scale-zero-pg/deploy/55-storage-init.yaml',
    lineSubstring:
      'image: minio/mc:RELEASE.2023-01-28T20-29-38Z # pinned (matches backup mirror) — UNPULLABLE, see #1423',
  },
];

function isExemptLine(relPath: string, line: string): boolean {
  return EXEMPTIONS.some((e) => e.file === relPath && line.includes(e.lineSubstring));
}

// Scan via git ls-files (tracked files only — never node_modules/.git/worktrees)
// and grep, so this can never silently skip a directory the way a hand-picked
// glob could.
function grepRepo(pattern: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '-lE', pattern, '--', ':(exclude).claude/worktrees'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    // git grep exits 1 when there are no matches — that's a valid "found
    // nothing", not a tool failure. Any other exit code is a real error.
    const err = e as { status?: number };
    if (err.status === 1) return [];
    throw e;
  }
}

describe('MinIO image references are lockstep-pinned to the working mirror (#1403)', () => {
  it('finds at least one reference (the guard itself is alive)', () => {
    const files = grepRepo('docker\\.io/bitnamilegacy/minio(-client)?[:@]');
    expect(files.length).toBeGreaterThan(0);
  });

  it('no REAL image reference still points at the broken quay.io/docker.io minio/minio or minio/mc registries, QUALIFIED OR BARE', () => {
    // A REAL reference has an actual tag or a real 64-hex digest attached —
    // this is what distinguishes an `image:`/`IMG_MC=`/const value from a
    // comment or a regex-pattern STRING that merely mentions the broken
    // registry name in prose (e.g. _validate.sh's own grep pattern, which
    // contains literal bracket-class syntax like `[0-9a-f]{64}`, never real
    // hex, and so never matches this).
    //
    // Covers BOTH forms: fully-qualified (quay.io/minio/minio,
    // docker.io/minio/mc) AND the bare, registry-implicit Docker Hub form
    // (`image: minio/mc:...`, `image: minio/minio`) — the exact bare form a
    // reviewer landed in this file while the qualified-only pattern stayed
    // green (#1413 review).
    const qualifiedBroken =
      /(quay\.io|docker\.io)\/minio\/(minio|mc)(:[A-Za-z0-9][A-Za-z0-9._-]*)?@sha256:[0-9a-f]{64}|(quay\.io|docker\.io)\/minio\/(minio|mc):[A-Za-z0-9][A-Za-z0-9._-]*(?!["'`]?\s*(is|are|and|UNAUTHORIZ))/g;
    // Bare form: `minio/minio` or `minio/mc` NOT preceded by a registry host
    // segment (i.e. not immediately preceded by `/`, `.`, or a word char —
    // which is what rules out matching the tail of `quay.io/minio/mc`) and NOT
    // wrapped in Markdown/shell-comment backticks (a prose MENTION of the
    // broken tag, e.g. this guard's own drill-doc comments explaining the
    // break, never a live `image:` directive), and carrying a REAL tag or
    // digest (never a bare prose mention with no tag at all).
    const bareBroken =
      /(?<![\w./`-])minio\/(minio|mc)(:[A-Za-z0-9][A-Za-z0-9._-]*@sha256:[0-9a-f]{64}|:[A-Za-z0-9][A-Za-z0-9._-]*|@sha256:[0-9a-f]{64})(?!`)/g;

    const files = grepRepo('minio/(minio|mc)[:@]');
    const offenders: string[] = [];
    for (const relPath of files) {
      if (relPath === 'tests/minio-image-pin-lockstep.test.ts') continue; // this guard's own source mentions these strings in comments/patterns
      const text = readFileSync(join(ROOT, relPath), 'utf8');
      for (const line of text.split('\n')) {
        if (isExemptLine(relPath, line)) continue; // szpg's own review owns this one line (getknext-dev/knext#1423)
        const qualifiedMatches = line.match(qualifiedBroken);
        if (qualifiedMatches) offenders.push(`${relPath}: ${line.trim()}`);
        const bareMatches = line.match(bareBroken);
        if (bareMatches) offenders.push(`${relPath}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every `docker.io/bitnamilegacy/minio(-client)?` reference uses one of the two pinned digests, never a mutable tag', () => {
    const files = grepRepo('docker\\.io/bitnamilegacy/minio(-client)?[:@]');
    const offenders: string[] = [];
    for (const relPath of files) {
      // Go source sometimes splits a long string literal across two lines
      // (`"...sha256:" + \n "<hex>"`) — join a quote-plus-newline-quote
      // continuation before scanning so that split doesn't look unpinned.
      const raw = readFileSync(join(ROOT, relPath), 'utf8');
      const text = raw.replace(/"\s*\+\s*\n\s*"/g, '');
      for (const line of text.split('\n')) {
        const refs = line.match(/docker\.io\/bitnamilegacy\/minio(-client)?[@:][A-Za-z0-9._:-]+/g);
        if (!refs) continue;
        for (const ref of refs) {
          const isPinned = [...ALLOWED_MINIO_REFS].some((allowed) => ref.startsWith(allowed));
          if (!isPinned) offenders.push(`${relPath}: ${ref}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every exempt file documents WHY it is exempt (not a silent skip)', () => {
    for (const { file } of EXEMPTIONS) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text).toContain('#1403');
      expect(text).toContain('UNPULLABLE');
    }
  });

  it('the two pinned digests are well-formed sha256 hex', () => {
    expect(PINNED_MINIO_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(PINNED_MC_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(PINNED_MINIO_DIGEST).not.toBe(PINNED_MC_DIGEST);
  });
});
